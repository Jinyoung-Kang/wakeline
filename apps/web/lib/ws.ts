/**
 * WS 클라이언트(9.5절 · 11.4절 · 계약서 §1): hello → welcome → subscribe(bbox) → snapshot/diff.
 * - 세션별 seq 연속성: diff 의 seq 가 lastSeq+1 이 아니면 적용하지 않고 resync 를 (스냅샷이 올 때까지 한 번만) 요청.
 * - 없는 키 = 모름. stale 은 항공기별 seen_at(워커)과 피드별 지연(sources/status)에서만 나온다(diff 가 덮어쓰지 않는다).
 * - 알림: alerts(전체, version) / alerts_batch(증분, version) — 오래된 버전은 무시. LOST·LEFT·PREDICTION_CLEARED 는 목록에서 뺀다.
 *   배치는 증분이라 하나를 잃으면 다음 배치로 바로잡히지 않는다 — 버린 알림 메시지·원소 · 버전 틈(v > 현재+1)이면 수를 모름(alertsVersion null ·
 *   alertsIncomplete)으로 두고 {type:"resync", scope:"alerts"} 로 전체 목록만 다시 받는다(계약 v5 §E2).
 * - select → selected: 선택 항공기의 full 상태·예측 가능 여부·등록 노선(계약 v4 §A route, lib/route.ts 로 검증)을 스토어에 둔다.
 * - 탭 숨김 pause/resume: 연결이 실제로 열려 있을 때만 상태를 바꾸고, 재접속 후에도 숨김 상태면 구독을 미룬다.
 * - 송신 예산 16 msg/10 s(서버 한도 20) — 넘치면 종류별 최신 1개만 남겨 뒤로 미룬다.
 * - 지수 백오프 재접속(1→30 s, WS-1): 시도 횟수는 연결이 건강함이 확인된 뒤에만(첫 스냅샷 또는 welcome 뒤 30 s) 0 으로 되돌린다.
 *   1013(연결 상한)·1008(rate limit)로 닫히면 상한 30 s 부터. ping/pong.
 * - 수신 감시(WS-2): 75 s(ping 2.5 회) 동안 아무것도 오지 않으면 반쯤 열린 연결로 보고 닫고 다시 잇는다(onclose 를 기다리지 않는다).
 * - 서버 시계(WS-3): welcome·status·작은 diff/snapshot(≤ 32 KiB)의 시각으로 오프셋을 추정해(store) 워커에도 보낸다 — 경과·stale·외삽이 한 기준을 쓴다.
 * - 레이어(계약 v2 §B3): {type:"layers", aircraft, ships} — 서버 기본값(항공기 켬·선박 끔)과 다를 때만 welcome 에서, 바뀔 때마다 보낸다.
 *   선박: ships_snapshot/ships_diff(세션별 연속 sseq — 항공기 seq 와 같은 규칙, 틈이면 resync) · ships_grid(계약 v4 §C 규칙 — 줌 < 4·상한 초과) ·
 *   select_ship → ship_selected(목적지 풀이 destination_info 포함 — 계약 v4 §B). 구독한 화면(bbox·줌)은 스토어 viewport 에도 둔다(선박 칩 문구).
 *   받은 값은 lib/ships.ts 로 검증한다(MMSI·위치가 틀리면 버림, 필드는 모르면 null). 메인 스레드 선박 수 상한 MAX_SHIPS.
 * - 수요(계약 v2 §A3): {type:"demand"} 를 그대로 스토어에 — 연결이 끊기면 지운다(서버 임대는 60 s 안에 만료되므로 "추적 중"이라 말하지 않는다).
 * - 수신 검증(계약 v5 §E2 · ADR-020): 모든 메시지를 lib/ws-validate 로 검사한다 — 틀린 원소는 버리고 세고, 봉투가 틀린 메시지는 버린다.
 *   워커에도 검증된 같은 목록을 보낸다(주 스레드와 갈라지지 않게). diff 의 lastSeq(선박 sseq)는 적용이 끝난 뒤에만 오르고(R-93), 처리 중 예외는
 *   잡아서 세고 브라우저 오류로 보고(§C8)한다. 버린·실패한 메시지 뒤에는 그 종류에 맞게 다시 받는다(recoverFrom): 항공기·선박 흐름은 resync,
 *   알림·SIGMET·레이더는 resync scope, status·selected·demand 는 다음 갱신. 수는 스토어 wsInvalid → 상태 바.
 */
import {
  applyAlertsBatch, applyAlertsFull, attemptAfterClose, HEALTHY_AFTER_MS, needsResync, nextBackoffMs, ResyncGate, RX_DEAD_MS, SendBudget, toFeed,
} from "./ws-protocol";
import { applyDiff } from "./interpolate";
import { aircraftStates, clockOffsetMs, getData, observeServerTime, setData, shipStates, SHIPS_OFF, type ShipsView } from "./store";
import { describeThrown, reportClientError, type ClientErrorInput } from "./errorReport";
import { isMmsi, MAX_SHIPS, parseAisStatus } from "./ships";
import { validateServerMessage, type ServerMsg } from "./ws-validate";

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
  /** 형식 오류 · 처리 예외 보고(기본: 계약 v5 §C8 브라우저 오류 보고기 — 같은 문구 60 s 에 1번, 분당 5번 이하) */
  report?: (e: ClientErrorInput) => void;
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
/** welcome 이 계약(schemas/ws/server.v1.json)에 맞지 않아 닫을 때 */
const CLOSE_BAD_WELCOME = 4001;
/** 항공기 흐름(seq)과 선박 흐름(sseq · 선박 재동기 게이트)의 메시지 — 버리거나 처리에 실패하면 그 흐름의 seq 를 버리고 resync */
const AIRCRAFT_STREAM: ReadonlySet<string> = new Set(["snapshot", "diff"]);
const SHIP_STREAM: ReadonlySet<string> = new Set(["ships_snapshot", "ships_diff", "ships_grid"]);
/**
 * 서버가 바뀔 때만 보내는 목록(계약 v5 §E2) — 버리거나 처리에 실패하면 {type:"resync", scope} 로 그 목록만 전체로 다시 받는다.
 * 알림 배치는 증분이고, SIGMET 은 버전이 바뀔 때 · 레이더는 새 프레임이 있을 때만 오므로 기다려서는 바로잡히지 않는다.
 */
type ListScope = "alerts" | "sigmets" | "radar";
const LIST_SCOPE: Readonly<Partial<Record<string, ListScope>>> = { alerts: "alerts", alerts_batch: "alerts", sigmets: "sigmets", radar: "radar" };
type Msg = Record<string, unknown>;

function defaultUrl() {
  return typeof location === "undefined" ? "ws://localhost/ws/v1" : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/v1`;
}
const isObj = (v: unknown): v is Msg => typeof v === "object" && v !== null && !Array.isArray(v);

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
  /** 목록 재요청(resync scope) — 그 목록이 올 때까지 한 번만(10 s 뒤 다시) */
  private readonly listGates: Record<ListScope, ResyncGate> = { alerts: new ResyncGate(), sigmets: new ResyncGate(), radar: new ResyncGate() };
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
  private readonly report: (e: ClientErrorInput) => void;

  constructor(private worker: WorkerLike, opts: WsClientOptions = {}) {
    this.url = opts.url ?? defaultUrl();
    this.isHidden = opts.isHidden ?? (() => typeof document !== "undefined" && document.hidden);
    this.now = opts.now ?? Date.now;
    this.mono = opts.mono ?? (typeof performance !== "undefined" ? () => performance.now() : null);
    this.createSocket = opts.createSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike);
    this.report = opts.report ?? ((e) => { reportClientError(e); });
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
      for (const g of Object.values(this.listGates)) g.clear();
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

  /**
   * 사용자가 닫음(화면을 떠남). 소켓의 처리기를 떼고 참조를 버린 뒤 닫는다 — 닫기 핸드셰이크가 늦게 끝나도(반쯤 열린 연결)
   * 그 onclose 가 같은 스토어를 쓰는 다음 클라이언트의 상태를 'closed'·수요 없음으로 덮지 않는다(R-75). 스토어는 여기서 한 번만 쓴다.
   */
  close() {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopConnTimers();
    this.clearPending();
    const ws = this.ws;
    this.ws = null;
    this.welcomed = false;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(1000); } catch { /* 이미 닫힘 */ }
    setData({ conn: "closed", demand: null });
  }

  /**
   * 연결 하나가 끝났다(onclose 또는 수신 감시). 한 경로로 정리하고 재접속을 예약한다.
   * 감시가 끊는 경우 반쯤 열린 소켓의 닫기 핸드셰이크(최대 수십 초)를 기다리지 않는다 — 늦게 오는 이벤트는 `this.ws !== ws` 로 무시된다.
   */
  private connectionDown(ws: SocketLike, code: number | null, closeSocket: boolean, closeCode = CLOSE_RX_TIMEOUT) {
    this.ws = null;
    this.welcomed = false;
    this.stopConnTimers();
    this.clearPending();
    if (closeSocket) { try { ws.close(closeCode); } catch { /* 이미 닫힘 */ } }
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
    setData({ viewport: { bbox, zoom } });
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

  /** 목록 하나를 전체로 다시 요청한다(계약 v5 §E2 — 서버는 버전과 무관하게 그 목록만 보낸다). 그 목록이 올 때까지 한 번만. */
  private requestList(scope: ListScope) {
    if (this.listGates[scope].request(this.now())) this.sendControlled(`resync:${scope}`, { type: "resync", scope });
  }

  /** 알림 목록에 빠진 것이 있다: 수를 모름으로 두고 전체 목록을 요청한다(받은 배치는 계속 반영한다). */
  private alertsLost() {
    const d = getData();
    if (d.alertsVersion !== null || !d.alertsIncomplete) setData({ alertsVersion: null, alertsIncomplete: true });
    this.requestList("alerts");
  }

  private warnShipsOverflow() {
    if (this.shipsOverflowWarned) return;
    this.shipsOverflowWarned = true;
    console.warn(`ws: more than ${MAX_SHIPS} ships — extra ships ignored until the next snapshot`);
  }

  // ---- 수신 ----

  /**
   * 메시지 하나(계약 v5 §E2): JSON → 형태 검사(lib/ws-validate) → 적용. 봉투가 틀리면 버리고 세고 보고하고 resync, 틀린 원소는 버리고 센다(상태 바).
   * 적용 중 예외는 여기서 잡는다(onmessage 밖으로 새지 않는다) — 세고, 브라우저 오류로 보고하고(§C8), 그 흐름의 seq 를 버리고 resync.
   */
  private onMessage(rawMsg: string) {
    const now = this.now();
    this.lastRxAt = now; // 해석할 수 없는 메시지라도 연결은 살아 있다
    if (now - this.lastRxStored >= RX_STORE_EVERY_MS) { this.lastRxStored = now; setData({ lastRxAt: now }); }
    let parsed: unknown;
    try { parsed = JSON.parse(rawMsg); } catch { this.rejectMessage("?", "not JSON"); return; }
    let type = isObj(parsed) && typeof parsed.type === "string" ? parsed.type.slice(0, 40) : "?";
    try {
      const v = validateServerMessage(parsed);
      if (v.kind === "unknown") return; // 새 서버가 더한 종류 — 무시(세지 않는다)
      if (v.kind === "invalid") { this.rejectMessage(v.type, v.reason); return; }
      type = v.msg.type;
      if (v.dropped > 0) this.noteInvalid("elements", `${v.where ?? type}: 형식이 틀린 값을 버림`, v.dropped);
      this.dispatch(v.msg, rawMsg, now, v.dropped);
    } catch (e) {
      this.dispatchFailed(type, e);
    }
  }

  /** 상태 바 계수(페이지를 연 뒤 누적 — 재접속해도 지우지 않는다). last = 마지막 사유 */
  private noteInvalid(kind: "elements" | "messages" | "errors", last: string, n = 1) {
    const cur = getData().wsInvalid;
    setData({ wsInvalid: { ...cur, [kind]: cur[kind] + n, last: last.slice(0, 200), at: this.now() } });
  }

  /** 봉투가 틀린 메시지: 버리고 세고 보고한 뒤 그 종류에 맞게 다시 받는다(recoverFrom). */
  private rejectMessage(type: string, reason: string) {
    this.noteInvalid("messages", `${type}: ${reason}`);
    this.report({ message: `ws: malformed ${type} message dropped — ${reason}`, stack: null, component: "lib/ws.ts" });
    this.recoverFrom(type);
  }

  /** 적용 중 예외(R-93): 반쯤 적용됐을 수 있다 — 세고 보고하고 그 흐름을 다시 받는다. */
  private dispatchFailed(type: string, e: unknown) {
    const d = describeThrown(e);
    this.noteInvalid("errors", `${type}: ${d.message}`);
    this.report({ message: `ws: ${type} handler failed — ${d.message}`, stack: d.stack, component: "lib/ws.ts" });
    this.recoverFrom(type);
  }

  /**
   * 버린 · 실패한 메시지 뒤, 그 종류에 맞게 다시 받는다(계약 v5 §E2):
   * - 항공기 · 선박 흐름: 그 seq 를 버리고(null — 다음 스냅샷까지 diff 를 적용하지 않는다) scope 없는 resync(서버는 항공기 · 선박 스냅샷을 바로).
   * - 알림 · SIGMET · 레이더: resync scope 로 그 목록만 전체로. 알림은 수를 모름으로 둔다(받은 배치는 계속 반영).
   * - 종류를 모름(JSON 이 아님): 위를 모두.
   * - status · selected · demand · ship_selected · error · ping/pong: 요청하지 않는다 — status 는 30 s heartbeat, selected · ship_selected 는 그 대상이
   *   바뀔 때, demand 는 바뀌거나 30 s 마다 다시 온다(resync 로는 오지 않으므로 항공기 스냅샷을 끌어오지 않는다).
   * - welcome(처리 예외만 — 검증기는 welcome 을 버리지 않는다): 구독 상태를 알 수 없으니 연결을 다시 맺는다.
   */
  private recoverFrom(type: string) {
    if (type === "welcome") {
      const ws = this.ws;
      if (ws) this.connectionDown(ws, null, true, CLOSE_BAD_WELCOME);
      return;
    }
    const unknown = type === "?";
    const aircraft = AIRCRAFT_STREAM.has(type) || unknown, ships = SHIP_STREAM.has(type) || unknown;
    if (aircraft) this.lastSeq = null;
    if (ships) this.lastSseq = null;
    const now = this.now();
    const a = aircraft && this.resyncGate.request(now);
    const s = ships && this.shipsResyncGate.request(now);
    if (a || s) this.sendControlled("resync", { type: "resync" });
    const list = LIST_SCOPE[type];
    if (list === "alerts" || unknown) this.alertsLost();
    if (list === "sigmets" || unknown) this.requestList("sigmets");
    if (list === "radar" || unknown) this.requestList("radar");
  }

  /** 검증된 메시지 적용. dropped = 검증기가 버린 원소 수(알림은 빠진 것이 있으면 수를 모름으로). */
  private dispatch(m: ServerMsg, rawMsg: string, now: number, dropped = 0) {
    // 큰 메시지의 ts 는 시계 표본으로 쓰지 않는다 — 전송 시간(수 초)만큼 오프셋을 낮춘다(WS-3)
    const clockSample = rawMsg.length <= CLOCK_SAMPLE_MAX_CHARS;
    switch (m.type) {
      case "welcome": {
        this.welcomed = true;
        this.observeClock(m.server_time, now);
        if (this.isHidden()) this.paused = true;
        this.lastRxStored = now;
        // 이전 연결의 마지막 이벤트 배너는 지운다(R-23) — 새 연결에서 받은 이벤트만 "방금"으로 보인다
        setData({ conn: this.paused ? "paused" : "open", alertsVersion: null, alertsIncomplete: false, lastRxAt: now, lastEvent: null });
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
        this.lastSeq = null; // 적용이 끝나야 이 스냅샷의 seq 를 쓴다(R-93)
        aircraftStates.clear();
        for (const a of m.aircraft) aircraftStates.set(a.hex, a);
        this.worker.postMessage({ type: "snapshot", aircraft: m.aircraft }); // 워커도 검증된 같은 목록(주 스레드와 갈라지지 않게)
        this.resyncGate.clear();
        this.markHealthy();
        if (clockSample) this.observeClock(m.ts, now);
        const src = m.sources;
        setData({
          snapshotVersion: m.v ?? getData().snapshotVersion,
          snapshotAt: m.ts,
          feeds: src ? { region: toFeed(src.region, now, true), global: toFeed(src.global, now) } : getData().feeds,
          aircraftCount: aircraftStates.size,
        });
        this.lastSeq = m.seq;
        break;
      }
      case "diff": {
        if (!this.layers.aircraft) break;
        if (needsResync(this.lastSeq, m.seq)) { this.requestResync(); return; }
        applyDiff(aircraftStates, m.upsert, m.remove);
        this.worker.postMessage({ type: "diff", upsert: m.upsert, remove: m.remove });
        if (clockSample) this.observeClock(m.ts, now);
        setData({
          snapshotVersion: m.v ?? getData().snapshotVersion,
          snapshotAt: m.ts ?? getData().snapshotAt,
          aircraftCount: aircraftStates.size,
        });
        this.lastSeq = m.seq; // R-93: 주 스레드 · 워커 · 스토어에 모두 적용한 뒤에만
        break;
      }
      case "sigmets":
        setData({ sigmets: m.collection, sigmetsVersion: m.v ?? 0, sigmetsFetchedAt: m.fetched_at, sigmetsProvider: m.provider ?? "—" });
        this.listGates.sigmets.clear();
        break;
      case "radar":
        setData({ radar: m.frames });
        this.listGates.radar.clear();
        break;
      case "alerts": {
        const d = getData();
        const r = applyAlertsFull({ alerts: d.alerts, version: d.alertsVersion }, m.version, m.alerts);
        if (!r) break; // 가진 것보다 오래된 목록
        if (dropped > 0) {
          // 전체 목록에 틀린 원소가 있었다 — 나머지는 보이되 수는 모름. 바로 다시 묻지 않는다(같은 버전이면 같은 목록) — 다음 배치가 10 s 게이트로 다시 묻는다
          setData({ alerts: r.alerts, alertsVersion: null, alertsIncomplete: true });
          break;
        }
        setData({ alerts: r.alerts, alertsVersion: r.version, alertsIncomplete: false });
        this.listGates.alerts.clear();
        break;
      }
      case "alerts_batch": {
        const d = getData();
        const r = applyAlertsBatch({ alerts: d.alerts, version: d.alertsVersion }, m.version, m.items);
        if (!r) break; // 이미 반영한 버전
        setData({ alerts: r.alerts, alertsVersion: r.version, ...(r.last ? { lastEvent: { ...r.last, at: now } } : {}) });
        // 버전을 모름(전체 목록 없음 · 틈 · 버전 없음) 또는 버린 항목 → 빠진 것이 있다
        if (r.version == null || dropped > 0) this.alertsLost();
        break;
      }
      case "selected":
        if (m.hex !== this.selected) break; // 이전 선택에 대한 늦은 응답
        setData({ selected: { hex: m.hex, state: m.state, prediction: m.prediction, route: m.route, received_at: now } });
        break;
      case "status": {
        const st = m.status;
        this.observeClock(st.server_time, now);
        setData({ status: st, feeds: { region: toFeed(st.region, now, true), global: toFeed(st.global, now) }, ais: parseAisStatus(st, now) });
        break;
      }
      case "demand":
        setData({ demand: { hot: m.hot, focus: m.focus, received_at: now } });
        break;
      case "ships_snapshot": {
        if (!this.layers.ships) break; // 끈 뒤 늦게 온 메시지
        this.lastSseq = null; // 적용이 끝나야 이 스냅샷의 sseq 를 쓴다(R-93)
        shipStates.clear();
        let overflow = false;
        for (const s of m.ships) {
          if (shipStates.size >= MAX_SHIPS) { overflow = true; break; }
          shipStates.set(s.mmsi, s);
        }
        if (overflow) this.warnShipsOverflow();
        this.shipsResyncGate.clear();
        if (clockSample) this.observeClock(m.ts, now);
        this.setShips({ mode: "points", count: shipStates.size, total: shipStates.size, ts: m.ts, cell_deg: null, capped: false, grid: [] });
        this.lastSseq = m.sseq;
        break;
      }
      case "ships_diff": {
        if (!this.layers.ships) break;
        if (needsResync(this.lastSseq, m.sseq)) { this.requestShipsResync(); return; }
        for (const k of m.remove) shipStates.delete(k);
        let overflow = false;
        for (const s of m.upsert) {
          if (!shipStates.has(s.mmsi) && shipStates.size >= MAX_SHIPS) { overflow = true; continue; }
          shipStates.set(s.mmsi, s);
        }
        if (clockSample) this.observeClock(m.ts, now);
        const cur = getData().ships;
        this.setShips({ ...cur, mode: "points", count: shipStates.size, total: shipStates.size, ts: m.ts ?? cur.ts, grid: [] });
        this.lastSseq = m.sseq; // R-93: 적용이 끝난 뒤에만
        if (overflow) { this.warnShipsOverflow(); this.requestShipsResync(); }
        break;
      }
      case "ships_grid": {
        if (!this.layers.ships) break;
        // 개별 선박은 더 이상 갱신되지 않는다 — 지우고, 다음 개별 표시는 새 ships_snapshot 부터
        shipStates.clear();
        this.lastSseq = null;
        if (clockSample) this.observeClock(m.ts, now);
        this.setShips({ mode: "grid", count: m.cells.length, total: m.cells.reduce((n, c) => n + c.count, 0), ts: m.ts, cell_deg: m.cell_deg, capped: m.capped, grid: m.cells });
        break;
      }
      case "ship_selected":
        if (m.mmsi !== this.selectedShip) break; // 이전 선택에 대한 늦은 응답
        setData({ shipSelected: { mmsi: m.mmsi, state: m.state, static: m.static, destination_info: m.destination_info, received_at: now } });
        break;
      case "ping":
        this.raw({ type: "pong" });
        break;
      case "pong":
        break;
      case "error":
        console.warn("ws error", m.code, m.detail);
        break;
    }
  }
}
