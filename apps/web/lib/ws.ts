/**
 * WS 클라이언트(9.5절 · 11.4절 · 계약서 §1): hello → welcome → subscribe(bbox) → snapshot/diff.
 * - 세션별 seq 연속성: diff 의 seq 가 lastSeq+1 이 아니면 적용하지 않고 resync 를 (스냅샷이 올 때까지 한 번만) 요청.
 * - 없는 키 = 모름. stale 은 항공기별 seen_at(워커)과 피드별 지연(sources/status)에서만 나온다(diff 가 덮어쓰지 않는다).
 * - 알림: alerts(전체, version) / alerts_batch(증분, version) — 오래된 버전은 무시. LOST·LEFT·PREDICTION_CLEARED 는 목록에서 뺀다.
 * - select → selected: 선택 항공기의 full 상태·예측 가능 여부를 스토어에 둔다.
 * - 탭 숨김 pause/resume: 연결이 실제로 열려 있을 때만 상태를 바꾸고, 재접속 후에도 숨김 상태면 구독을 미룬다.
 * - 송신 예산 16 msg/10 s(서버 한도 20) — 넘치면 종류별 최신 1개만 남겨 뒤로 미룬다.
 * - 지수 백오프 재접속(1→30 s, WS-1): 시도 횟수는 연결이 건강함이 확인된 뒤에만(첫 스냅샷 또는 welcome 뒤 30 s) 0 으로 되돌린다.
 *   1013(연결 상한)·1008(rate limit)로 닫히면 상한 30 s 부터. ping/pong.
 * - 수신 감시(WS-2): 75 s(ping 2.5 회) 동안 아무것도 오지 않으면 반쯤 열린 연결로 보고 닫고 다시 잇는다(onclose 를 기다리지 않는다).
 * - 서버 시계(WS-3): welcome·status·작은 diff/snapshot(≤ 32 KiB)의 시각으로 오프셋을 추정해(store) 워커에도 보낸다 — 경과·stale·외삽이 한 기준을 쓴다.
 * - 레이어(계약 v2 §B3): {type:"layers", aircraft, ships} — 서버 기본값(항공기 켬·선박 끔)과 다를 때만 welcome 에서, 바뀔 때마다 보낸다.
 *   선박: ships_snapshot/ships_diff(세션별 연속 sseq — 항공기 seq 와 같은 규칙, 틈이면 resync) · ships_grid(줌 < 7·상한 초과) · select_ship → ship_selected.
 *   받은 값은 lib/ships.ts 로 검증한다(MMSI·위치가 틀리면 버림, 필드는 모르면 null). 메인 스레드 선박 수 상한 MAX_SHIPS.
 * - 수요(계약 v2 §A3): {type:"demand"} 를 그대로 스토어에 — 연결이 끊기면 지운다(서버 임대는 60 s 안에 만료되므로 "추적 중"이라 말하지 않는다).
 */
import {
  applyAlertsBatch, applyAlertsFull, attemptAfterClose, HEALTHY_AFTER_MS, needsResync, nextBackoffMs, ResyncGate, RX_DEAD_MS, SendBudget, toFeed,
} from "./ws-protocol";
import { applyDiff } from "./interpolate";
import { aircraftStates, clockOffsetMs, getData, observeServerTime, setData, shipStates, SHIPS_OFF, type ShipsView } from "./store";
import { parseDemand } from "./demand";
import { isMmsi, MAX_SHIPS, parseAisStatus, parseGridCells, parseMmsiList, parseShipLite, parseShipState, parseShipStatic } from "./ships";
import type { AircraftState, Alert, PredictionReason, PublicStatus, RadarFrames, SigmetCollection, SourceInfo } from "./types";

export type WorkerLike = { postMessage: (m: unknown) => void };

/** WebSocket 의 필요한 부분만(테스트에서 가짜로 바꾼다) */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface WsClientOptions {
  url?: string;
  /** 탭 숨김 여부(기본: document.hidden) */
  isHidden?: () => boolean;
  now?: () => number;
  /** 단조 시계(기본 performance.now) — 브라우저 벽시계 변경 감지용 */
  mono?: () => number;
  createSocket?: (url: string) => SocketLike;
}

const WS_OPEN = 1;
/** 수신 감시 점검 주기 */
const WATCHDOG_TICK_MS = 10_000;
/** 스토어의 lastRxAt 갱신 간격(메시지마다 리렌더하지 않도록) */
const RX_STORE_EVERY_MS = 5_000;
/** 서버 시각 표본으로 쓰는 메시지 크기 상한(문자) — 큰 메시지는 전송 시간만큼 오프셋을 낮춘다 */
const CLOCK_SAMPLE_MAX_CHARS = 32_768;
/** 워커에 시계 오프셋을 다시 보내는 최소 변화(ms) */
const CLOCK_POST_EPS_MS = 250;
/** 감시가 죽은 연결을 닫을 때 쓰는 코드(애플리케이션 영역 4000–4999) */
const CLOSE_RX_TIMEOUT = 4000;
type Msg = Record<string, unknown>;

function defaultUrl() {
  return typeof location === "undefined" ? "ws://localhost/ws/v1" : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/v1`;
}
const isObj = (v: unknown): v is Msg => typeof v === "object" && v !== null && !Array.isArray(v);
const PREDICTION_REASONS: ReadonlySet<string> = new Set(["turning", "slow", "on_ground", "no_track", "stale"]);

export class WakelineWsClient {
  private ws: SocketLike | null = null;
  private welcomed = false;
  private attempt = 0;
  /** 이 연결에서 마지막으로 받은 시각(브라우저 ms). 연결을 만들 때·열릴 때·메시지마다 갱신 */
  private lastRxAt = 0;
  private lastRxStored = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private healthyTimer: ReturnType<typeof setTimeout> | null = null;
  /** 이 연결이 이미 건강 판정을 받았는가(시도 횟수 초기화는 연결당 한 번) */
  private healthy = false;
  /** 워커에 마지막으로 보낸 시계 오프셋 */
  private postedOffset: number | null = null;
  private lastSeq: number | null = null;
  private readonly resyncGate = new ResyncGate();
  private readonly budget = new SendBudget();
  private bbox: [number, number, number, number] | null = null;
  private zoom = 7;
  private selected: string | null = null;
  private selectedShip: string | null = null;
  /** 켜진 레이어(서버 기본: 항공기 켬 · 선박 끔) */
  private layers = { aircraft: true, ships: false };
  /** 선박 스트림의 세션별 seq(ships_snapshot 마다 다시 시작) */
  private lastSseq: number | null = null;
  private readonly shipsResyncGate = new ResyncGate();
  private shipsOverflowWarned = false;
  private paused = false;
  /** 이 연결에서 현재 bbox 로 subscribe 했는가(아니면 resume 대신 subscribe 를 보낸다) */
  private subscribedOnConn = false;
  private closedByUser = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 예산 초과로 미룬 메시지(종류별 최신 1개, 삽입 순서 유지) */
  private readonly pending = new Map<string, Msg>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly url: string;
  private readonly isHidden: () => boolean;
  private readonly now: () => number;
  private readonly mono: (() => number) | null;
  private readonly createSocket: (url: string) => SocketLike;

  constructor(private worker: WorkerLike, opts: WsClientOptions = {}) {
    this.url = opts.url ?? defaultUrl();
    this.isHidden = opts.isHidden ?? (() => typeof document !== "undefined" && document.hidden);
    this.now = opts.now ?? Date.now;
    this.mono = opts.mono ?? (typeof performance !== "undefined" ? () => performance.now() : null);
    this.createSocket = opts.createSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike);
    this.syncWorkerClock(); // 이전 화면에서 이미 추정한 오프셋이 있으면 새 워커에도
  }

  connect() {
    this.closedByUser = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.stopConnTimers();
    setData({ conn: "connecting", reconnectAttempt: this.attempt });
    const ws = this.createSocket(this.url);
    this.ws = ws;
    this.welcomed = false;
    this.healthy = false;
    this.lastRxAt = this.now(); // 열리지도 않는 연결(SYN 무응답)도 감시가 끊는다
    this.watchdog = setInterval(() => this.checkRx(), WATCHDOG_TICK_MS);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      // 시도 횟수는 여기서 초기화하지 않는다(WS-1) — 열린 뒤 곧바로 닫히는 서버에 1 s 마다 붙지 않게
      this.lastRxAt = this.now();
      this.lastSeq = null;
      this.resyncGate.clear();
      this.lastSseq = null;
      this.shipsResyncGate.clear();
      this.subscribedOnConn = false;
      this.raw({ type: "hello", proto: 1, client: "web/0.4" });
    };
    ws.onmessage = (ev) => { if (this.ws === ws) this.onMessage(String(ev.data)); };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.connectionDown(ws, isObj(ev) && typeof ev.code === "number" ? ev.code : null, false);
    };
    ws.onerror = () => { /* onclose 가 이어서 처리 */ };
  }

  close() {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopConnTimers();
    this.clearPending();
    this.ws?.close(1000);
  }

  /**
   * 연결 하나가 끝났다(onclose 또는 수신 감시). 한 경로로 정리하고 재접속을 예약한다.
   * 감시가 끊는 경우 반쯤 열린 소켓의 닫기 핸드셰이크(최대 수십 초)를 기다리지 않는다 — 늦게 오는 이벤트는 `this.ws !== ws` 로 무시된다.
   */
  private connectionDown(ws: SocketLike, code: number | null, closeSocket: boolean) {
    this.ws = null;
    this.welcomed = false;
    this.stopConnTimers();
    this.clearPending();
    if (closeSocket) { try { ws.close(CLOSE_RX_TIMEOUT); } catch { /* 이미 닫힘 */ } }
    // 수요 임대는 이 연결이 살아 있을 때만 갱신된다 — 끊긴 뒤에도 "집중 추적 중"이라고 말하지 않는다
    setData({ conn: "closed", demand: null });
    if (this.closedByUser) return;
    this.attempt = attemptAfterClose(this.attempt, code);
    const delay = nextBackoffMs(this.attempt++);
    this.timer = setTimeout(() => this.connect(), delay);
    setData({ reconnectAttempt: this.attempt });
  }

  private stopConnTimers() {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    if (this.healthyTimer) { clearTimeout(this.healthyTimer); this.healthyTimer = null; }
  }

  /** 수신 감시(WS-2): 서버는 30 s 마다 ping 을 보낸다 — 75 s 동안 아무것도 없으면 연결은 죽었다. */
  private checkRx() {
    const ws = this.ws;
    if (!ws || this.now() - this.lastRxAt <= RX_DEAD_MS) return;
    console.warn(`ws: no message for ${Math.round((this.now() - this.lastRxAt) / 1000)} s — reconnecting`);
    this.connectionDown(ws, null, true);
  }

  /** 연결이 건강함이 확인됨(첫 스냅샷 또는 welcome 뒤 30 s 유지) → 백오프를 처음부터 */
  private markHealthy() {
    if (this.healthy) return;
    this.healthy = true;
    if (this.healthyTimer) { clearTimeout(this.healthyTimer); this.healthyTimer = null; }
    this.attempt = 0;
    if (getData().reconnectAttempt !== 0) setData({ reconnectAttempt: 0 });
  }

  /** 서버 시각 표본 → 오프셋이 바뀌면 워커에도(0.25 s 넘게 바뀔 때만) */
  private observeClock(serverIso: unknown, receivedAt: number) {
    if (observeServerTime(serverIso, receivedAt, this.mono ? this.mono() : null)) this.syncWorkerClock();
  }

  private syncWorkerClock() {
    const o = clockOffsetMs();
    if (o == null) return;
    if (this.postedOffset != null && Math.abs(o - this.postedOffset) <= CLOCK_POST_EPS_MS) return;
    this.postedOffset = o;
    this.worker.postMessage({ type: "clock", offsetMs: o });
  }

  subscribe(bbox: [number, number, number, number], zoom: number) {
    this.bbox = bbox;
    this.zoom = zoom;
    if (!this.welcomed) return; // welcome 에서 보낸다
    if (this.paused) { this.subscribedOnConn = false; return; } // resume 때 subscribe 로 보낸다
    this.sendControlled("subscribe", { type: "subscribe", bbox, zoom, detail: "lite" });
    this.subscribedOnConn = true;
  }

  select(hex: string | null) {
    this.selected = hex;
    if (getData().selected?.hex !== hex) setData({ selected: null });
    if (this.welcomed) this.sendControlled("select", { type: "select", hex });
  }

  /** 선박 선택(계약 v2 §B3 select_ship). 형식이 틀린 MMSI 는 선택 해제로 다룬다. */
  selectShip(mmsi: string | null) {
    const v = isMmsi(mmsi) ? mmsi : null;
    this.selectedShip = v;
    if (getData().shipSelected?.mmsi !== v) setData({ shipSelected: null });
    if (this.welcomed) this.sendControlled("select_ship", { type: "select_ship", mmsi: v });
  }

  /**
   * 켜진 레이어를 서버에 알린다(선박은 켠 세션에만 보낸다). 선박을 끄면 받은 선박을 모두 지우고, 켜면 첫 메시지를 기다린다("waiting").
   * 항공기를 끄면 서버가 항공기 목록을 보내지 않으므로 받은 항공기를 지우고(워커에는 빈 스냅샷) 수를 모름(null)으로 — 멈춘 수를 지금 값처럼 보이지 않는다.
   * 다시 켜면 서버가 seq 1 스냅샷부터 보낸다.
   */
  setLayers(aircraft: boolean, ships: boolean) {
    if (aircraft === this.layers.aircraft && ships === this.layers.ships) return;
    const shipsChanged = ships !== this.layers.ships;
    const aircraftOff = !aircraft && this.layers.aircraft;
    this.layers = { aircraft, ships };
    if (aircraftOff) {
      aircraftStates.clear();
      this.lastSeq = null;
      this.resyncGate.clear();
      this.worker.postMessage({ type: "snapshot", aircraft: [] });
      setData({ aircraftCount: null });
    }
    if (shipsChanged) {
      shipStates.clear();
      this.lastSseq = null;
      this.shipsResyncGate.clear();
      this.setShips({ ...SHIPS_OFF, mode: ships ? "waiting" : "off" });
    }
    if (this.welcomed) this.sendControlled("layers", { type: "layers", aircraft, ships });
  }

  private setShips(v: Omit<ShipsView, "version">) {
    setData({ ships: { ...v, version: getData().ships.version + 1 } });
  }

  pause() {
    this.paused = true;
    if (!this.welcomed) return; // 연결 중·끊김이면 상태를 그대로 둔다
    this.sendVisibility("pause");
    setData({ conn: "paused" });
  }

  /** 서버는 resume 에 전체 초기 세트(스냅샷·알림·SIGMET·레이더·status)를 다시 보낸다(계약서 §1). */
  resume() {
    this.paused = false;
    if (!this.welcomed) return; // 소켓이 닫혀 있으면 "open" 으로 표시하지 않는다(GAP-3)
    setData({ conn: "open" });
    if (!this.subscribedOnConn && this.bbox) {
      this.pending.delete("visibility");
      this.subscribe(this.bbox, this.zoom);
      return;
    }
    this.sendVisibility("resume");
  }

  get isOpen() { return this.ws != null && this.ws.readyState === WS_OPEN; }

  // ---- 송신 ----
  private raw(o: Msg) {
    if (this.isOpen) this.ws!.send(JSON.stringify(o));
  }

  /** 예산 안이면 바로, 넘치면 같은 종류는 최신 것만 남겨 두었다가 슬롯이 열리면 보낸다(순서 유지). */
  private sendControlled(key: string, o: Msg) {
    if (!this.isOpen) return; // 닫혀 있으면 welcome 에서 상태(subscribe·select)를 다시 보낸다
    if (this.pending.size === 0 && this.budget.tryTake(this.now())) { this.raw(o); return; }
    this.pending.set(key, o);
    this.scheduleFlush();
  }

  private sendVisibility(type: "pause" | "resume") {
    const p = this.pending.get("visibility");
    if (p && p.type !== type) { this.pending.delete("visibility"); return; } // 아직 안 보낸 반대 동작과 상쇄
    this.sendControlled("visibility", { type });
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    const wait = Math.max(50, this.budget.waitMs(this.now()));
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, wait);
  }

  private flush() {
    if (!this.isOpen) { this.pending.clear(); return; }
    for (const [k, o] of this.pending) {
      if (!this.budget.tryTake(this.now())) break;
      this.pending.delete(k);
      this.raw(o);
    }
    if (this.pending.size > 0) this.scheduleFlush();
  }

  private clearPending() {
    this.pending.clear();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private requestResync() {
    if (this.resyncGate.request(this.now())) this.sendControlled("resync", { type: "resync" });
  }

  /** 선박 sseq 틈 → resync(서버는 전체 초기 세트를 다시 보낸다 — 선박을 켠 세션에는 ships_snapshot 포함). 스냅샷이 올 때까지 한 번만. */
  private requestShipsResync() {
    if (this.shipsResyncGate.request(this.now())) this.sendControlled("resync", { type: "resync" });
  }

  private warnShipsOverflow() {
    if (this.shipsOverflowWarned) return;
    this.shipsOverflowWarned = true;
    console.warn(`ws: more than ${MAX_SHIPS} ships — extra ships ignored until the next snapshot`);
  }

  // ---- 수신 ----
  private onMessage(rawMsg: string) {
    const now = this.now();
    this.lastRxAt = now; // 해석할 수 없는 메시지라도 연결은 살아 있다
    if (now - this.lastRxStored >= RX_STORE_EVERY_MS) { this.lastRxStored = now; setData({ lastRxAt: now }); }
    let m: Msg;
    try { m = JSON.parse(rawMsg); } catch { return; }
    if (!isObj(m)) return;
    switch (m.type) {
      case "welcome": {
        this.welcomed = true;
        this.observeClock(m.server_time, now);
        if (this.isHidden()) this.paused = true;
        this.lastRxStored = now;
        setData({ conn: this.paused ? "paused" : "open", alertsVersion: null, lastRxAt: now });
        const ws = this.ws;
        if (this.healthyTimer) clearTimeout(this.healthyTimer);
        this.healthyTimer = setTimeout(() => { this.healthyTimer = null; if (this.ws === ws) this.markHealthy(); }, HEALTHY_AFTER_MS);
        // 서버 기본값과 다를 때만(항공기 켬·선박 끔이 기본) — 구독 전에 보내 첫 구독에 선박이 함께 오게 한다
        if (!this.layers.aircraft || this.layers.ships) this.sendControlled("layers", { type: "layers", ...this.layers });
        if (this.selected) this.sendControlled("select", { type: "select", hex: this.selected });
        if (this.selectedShip) this.sendControlled("select_ship", { type: "select_ship", mmsi: this.selectedShip });
        // 숨김 상태면 구독을 미룬다 — resume 이 subscribe 를 보낸다
        if (this.bbox && !this.paused) this.subscribe(this.bbox, this.zoom);
        break;
      }
      case "snapshot": {
        if (!this.layers.aircraft) break; // 끈 뒤 늦게 온 메시지
        const aircraft = (Array.isArray(m.aircraft) ? m.aircraft : []) as AircraftState[];
        aircraftStates.clear();
        for (const a of aircraft) aircraftStates.set(a.hex, a);
        this.worker.postMessage({ type: "snapshot", aircraft });
        this.lastSeq = typeof m.seq === "number" ? m.seq : null;
        this.resyncGate.clear();
        this.markHealthy();
        // 큰 스냅샷의 ts 는 시계 표본으로 쓰지 않는다 — 전송 시간(수 초)만큼 오프셋을 낮춘다(WS-3)
        if (rawMsg.length <= CLOCK_SAMPLE_MAX_CHARS) this.observeClock(m.ts, now);
        const src = isObj(m.sources) ? (m.sources as { region?: SourceInfo | null; global?: SourceInfo | null }) : null;
        setData({
          snapshotVersion: typeof m.v === "number" ? m.v : getData().snapshotVersion,
          snapshotAt: typeof m.ts === "string" ? m.ts : null,
          feeds: src ? { region: toFeed(src.region, now, true), global: toFeed(src.global, now) } : getData().feeds,
          aircraftCount: aircraftStates.size,
        });
        break;
      }
      case "diff": {
        if (!this.layers.aircraft) break;
        if (needsResync(this.lastSeq, m.seq)) { this.requestResync(); return; }
        this.lastSeq = m.seq as number;
        const upsert = (Array.isArray(m.upsert) ? m.upsert : []) as AircraftState[];
        const remove = (Array.isArray(m.remove) ? m.remove : []) as string[];
        applyDiff(aircraftStates, upsert, remove);
        this.worker.postMessage({ type: "diff", upsert, remove });
        if (rawMsg.length <= CLOCK_SAMPLE_MAX_CHARS) this.observeClock(m.ts, now);
        setData({
          snapshotVersion: typeof m.v === "number" ? m.v : getData().snapshotVersion,
          snapshotAt: typeof m.ts === "string" ? m.ts : getData().snapshotAt,
          aircraftCount: aircraftStates.size,
        });
        break;
      }
      case "sigmets":
        setData({
          sigmets: m.collection as SigmetCollection,
          sigmetsVersion: typeof m.v === "number" ? m.v : 0,
          sigmetsFetchedAt: typeof m.fetched_at === "string" ? m.fetched_at : null,
          sigmetsProvider: typeof m.provider === "string" ? m.provider : "—",
        });
        break;
      case "radar":
        setData({ radar: { host: m.host as string, generated: m.generated as number, past: (m.past ?? []) as RadarFrames["past"], fetched_at: m.fetched_at as string, provider: m.provider as string } });
        break;
      case "alerts": {
        const d = getData();
        const r = applyAlertsFull({ alerts: d.alerts, version: d.alertsVersion }, m.version, (Array.isArray(m.alerts) ? m.alerts : []) as Alert[]);
        if (r) setData({ alerts: r.alerts, alertsVersion: r.version });
        break;
      }
      case "alerts_batch": {
        const d = getData();
        const r = applyAlertsBatch({ alerts: d.alerts, version: d.alertsVersion }, m.version, (Array.isArray(m.items) ? m.items : []) as { event: string; alert: Alert }[]);
        if (r) setData({ alerts: r.alerts, alertsVersion: r.version, ...(r.last ? { lastEvent: { ...r.last, at: now } } : {}) });
        break;
      }
      case "selected": {
        const hex = typeof m.hex === "string" ? m.hex : null;
        if (!hex || hex !== this.selected) break; // 이전 선택에 대한 늦은 응답
        const p = isObj(m.prediction) ? m.prediction : null;
        const reason = p && typeof p.reason === "string" && PREDICTION_REASONS.has(p.reason) ? (p.reason as PredictionReason) : null;
        setData({
          selected: {
            hex,
            state: isObj(m.state) ? (m.state as unknown as AircraftState) : null,
            prediction: p ? { available: p.available === true, reason } : null,
            received_at: now,
          },
        });
        break;
      }
      case "status": {
        if (!isObj(m.status)) break;
        const st = m.status as unknown as PublicStatus;
        this.observeClock(st.server_time, now);
        setData({ status: st, feeds: { region: toFeed(st.region, now, true), global: toFeed(st.global, now) }, ais: parseAisStatus(m.status, now) });
        break;
      }
      case "demand":
        setData({ demand: parseDemand(m, now) });
        break;
      case "ships_snapshot": {
        if (!this.layers.ships) break; // 끈 뒤 늦게 온 메시지
        shipStates.clear();
        let overflow = false;
        for (const o of Array.isArray(m.ships) ? m.ships : []) {
          if (shipStates.size >= MAX_SHIPS) { overflow = true; break; }
          const s = parseShipLite(o);
          if (s) shipStates.set(s.mmsi, s);
        }
        if (overflow) this.warnShipsOverflow();
        this.lastSseq = typeof m.sseq === "number" ? m.sseq : null;
        this.shipsResyncGate.clear();
        if (rawMsg.length <= CLOCK_SAMPLE_MAX_CHARS) this.observeClock(m.ts, now);
        this.setShips({ mode: "points", count: shipStates.size, total: shipStates.size, ts: typeof m.ts === "string" ? m.ts : null, cell_deg: null, capped: m.capped === true, grid: [] });
        break;
      }
      case "ships_diff": {
        if (!this.layers.ships) break;
        if (needsResync(this.lastSseq, m.sseq)) { this.requestShipsResync(); return; }
        this.lastSseq = m.sseq as number;
        for (const k of parseMmsiList(m.remove)) shipStates.delete(k);
        let overflow = false;
        for (const o of Array.isArray(m.upsert) ? m.upsert : []) {
          const s = parseShipLite(o);
          if (!s) continue;
          if (!shipStates.has(s.mmsi) && shipStates.size >= MAX_SHIPS) { overflow = true; continue; }
          shipStates.set(s.mmsi, s);
        }
        if (overflow) { this.warnShipsOverflow(); this.requestShipsResync(); }
        if (rawMsg.length <= CLOCK_SAMPLE_MAX_CHARS) this.observeClock(m.ts, now);
        const cur = getData().ships;
        this.setShips({ ...cur, mode: "points", count: shipStates.size, total: shipStates.size, ts: typeof m.ts === "string" ? m.ts : cur.ts, grid: [] });
        break;
      }
      case "ships_grid": {
        if (!this.layers.ships) break;
        const grid = parseGridCells(m.cells);
        // 개별 선박은 더 이상 갱신되지 않는다 — 지우고, 다음 개별 표시는 새 ships_snapshot 부터
        shipStates.clear();
        this.lastSseq = null;
        if (rawMsg.length <= CLOCK_SAMPLE_MAX_CHARS) this.observeClock(m.ts, now);
        const cellDeg = typeof m.cell_deg === "number" && Number.isFinite(m.cell_deg) && m.cell_deg > 0 ? m.cell_deg : null;
        this.setShips({ mode: "grid", count: grid.length, total: grid.reduce((n, c) => n + c.count, 0), ts: typeof m.ts === "string" ? m.ts : null, cell_deg: cellDeg, capped: m.capped === true, grid });
        break;
      }
      case "ship_selected": {
        const mmsi = isMmsi(m.mmsi) ? m.mmsi : null;
        if (!mmsi || mmsi !== this.selectedShip) break; // 이전 선택에 대한 늦은 응답
        let state = parseShipState(isObj(m.state) ? { mmsi, ...m.state } : null);
        let stat = parseShipStatic(isObj(m.static) ? { mmsi, ...m.static } : null);
        if (state && state.mmsi !== mmsi) state = null;
        if (stat && stat.mmsi !== mmsi) stat = null;
        setData({ shipSelected: { mmsi, state, static: stat, received_at: now } });
        break;
      }
      case "ping":
        this.raw({ type: "pong" });
        break;
      case "error":
        console.warn("ws error", m.code, m.detail);
        break;
    }
  }
}
