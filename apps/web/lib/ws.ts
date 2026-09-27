/**
 * WS 클라이언트(9.5절 · 11.4절 · 계약서 §1): hello → welcome → subscribe(bbox) → snapshot/diff.
 * - 세션별 seq 연속성: diff 의 seq 가 lastSeq+1 이 아니면 적용하지 않고 resync 를 (스냅샷이 올 때까지 한 번만) 요청.
 * - 없는 키 = 모름. stale 은 항공기별 seen_at(워커)과 피드별 지연(sources/status)에서만 나온다(diff 가 덮어쓰지 않는다).
 * - 알림: alerts(전체, version) / alerts_batch(증분, version) — 오래된 버전은 무시. LOST·LEFT·PREDICTION_CLEARED 는 목록에서 뺀다.
 * - select → selected: 선택 항공기의 full 상태·예측 가능 여부를 스토어에 둔다.
 * - 탭 숨김 pause/resume: 연결이 실제로 열려 있을 때만 상태를 바꾸고, 재접속 후에도 숨김 상태면 구독을 미룬다.
 * - 송신 예산 16 msg/10 s(서버 한도 20) — 넘치면 종류별 최신 1개만 남겨 뒤로 미룬다.
 * - 지수 백오프 재접속(1→30 s), ping/pong.
 */
import { applyAlertsBatch, applyAlertsFull, needsResync, nextBackoffMs, ResyncGate, SendBudget, toFeed } from "./ws-protocol";
import { applyDiff } from "./interpolate";
import { aircraftStates, getData, observeServerTime, setData } from "./store";
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
  createSocket?: (url: string) => SocketLike;
}

const WS_OPEN = 1;
type Msg = Record<string, unknown>;

function defaultUrl() {
  return typeof location === "undefined" ? "ws://localhost/ws/v1" : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/v1`;
}
const isObj = (v: unknown): v is Msg => typeof v === "object" && v !== null && !Array.isArray(v);
const PREDICTION_REASONS: ReadonlySet<string> = new Set(["turning", "slow", "on_ground", "no_track", "stale"]);

export class SkyWsClient {
  private ws: SocketLike | null = null;
  private welcomed = false;
  private attempt = 0;
  private lastSeq: number | null = null;
  private readonly resyncGate = new ResyncGate();
  private readonly budget = new SendBudget();
  private bbox: [number, number, number, number] | null = null;
  private zoom = 7;
  private selected: string | null = null;
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
  private readonly createSocket: (url: string) => SocketLike;

  constructor(private worker: WorkerLike, opts: WsClientOptions = {}) {
    this.url = opts.url ?? defaultUrl();
    this.isHidden = opts.isHidden ?? (() => typeof document !== "undefined" && document.hidden);
    this.now = opts.now ?? Date.now;
    this.createSocket = opts.createSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike);
  }

  connect() {
    this.closedByUser = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    setData({ conn: "connecting", reconnectAttempt: this.attempt });
    const ws = this.createSocket(this.url);
    this.ws = ws;
    this.welcomed = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.lastSeq = null;
      this.resyncGate.clear();
      this.subscribedOnConn = false;
      this.raw({ type: "hello", proto: 1, client: "web/0.3" });
    };
    ws.onmessage = (ev) => { if (this.ws === ws) this.onMessage(String(ev.data)); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.welcomed = false;
      this.clearPending();
      setData({ conn: "closed" });
      if (this.closedByUser) return;
      const delay = nextBackoffMs(this.attempt++);
      this.timer = setTimeout(() => this.connect(), delay);
      setData({ reconnectAttempt: this.attempt });
    };
    ws.onerror = () => { /* onclose 가 이어서 처리 */ };
  }

  close() {
    this.closedByUser = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.clearPending();
    this.ws?.close(1000);
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

  // ---- 수신 ----
  private onMessage(rawMsg: string) {
    let m: Msg;
    try { m = JSON.parse(rawMsg); } catch { return; }
    if (!isObj(m)) return;
    const now = this.now();
    switch (m.type) {
      case "welcome": {
        this.welcomed = true;
        observeServerTime(m.server_time, now);
        if (this.isHidden()) this.paused = true;
        setData({ conn: this.paused ? "paused" : "open", alertsVersion: null });
        if (this.selected) this.sendControlled("select", { type: "select", hex: this.selected });
        // 숨김 상태면 구독을 미룬다 — resume 이 subscribe 를 보낸다
        if (this.bbox && !this.paused) this.subscribe(this.bbox, this.zoom);
        break;
      }
      case "snapshot": {
        const aircraft = (Array.isArray(m.aircraft) ? m.aircraft : []) as AircraftState[];
        aircraftStates.clear();
        for (const a of aircraft) aircraftStates.set(a.hex, a);
        this.worker.postMessage({ type: "snapshot", aircraft });
        this.lastSeq = typeof m.seq === "number" ? m.seq : null;
        this.resyncGate.clear();
        observeServerTime(m.ts, now);
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
        if (needsResync(this.lastSeq, m.seq)) { this.requestResync(); return; }
        this.lastSeq = m.seq as number;
        const upsert = (Array.isArray(m.upsert) ? m.upsert : []) as AircraftState[];
        const remove = (Array.isArray(m.remove) ? m.remove : []) as string[];
        applyDiff(aircraftStates, upsert, remove);
        this.worker.postMessage({ type: "diff", upsert, remove });
        observeServerTime(m.ts, now);
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
        observeServerTime(st.server_time, now);
        setData({ status: st, feeds: { region: toFeed(st.region, now, true), global: toFeed(st.global, now) } });
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
