/**
 * WS 클라이언트의 순수 상태 로직(테스트 가능) — 계약서 §1.
 * seq 연속성·resync 게이트·송신 예산(서버 한도 20 msg/10 s)·알림 버전·피드(region/global) 정규화·지연 계산·재접속 백오프.
 */
import type { Alert, AlertEventType, FeedInfo, SourceInfo } from "./types";

export function nextBackoffMs(attempt: number, min = 1000, max = 30000): number {
  const base = Math.min(max, min * Math.pow(2, Math.max(0, attempt)));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * 세션별 seq: 스냅샷마다 1 로 시작, diff 마다 정확히 +1(서버는 빈 diff 를 보내지 않으므로 틈이 없다).
 * 스냅샷을 아직 못 받았거나(lastSeq=null) seq 가 lastSeq+1 이 아니면 resync 가 필요하다(그 diff 는 적용하지 않는다).
 */
export function needsResync(lastSeq: number | null, seq: unknown): boolean {
  if (lastSeq == null) return true;
  return typeof seq !== "number" || seq !== lastSeq + 1;
}

/**
 * resync 요청은 다음 스냅샷이 올 때까지 한 번만 보낸다(불연속 diff 가 연달아 와도 요청 폭주 → 서버 rate limit 1008 종료 방지).
 * 응답이 timeoutMs 안에 오지 않으면 다시 보낼 수 있다.
 */
export class ResyncGate {
  private sentAt: number | null = null;
  constructor(private timeoutMs = 10_000) {}
  /** true 면 지금 resync 를 보내야 한다 */
  request(nowMs: number): boolean {
    if (this.sentAt != null && nowMs - this.sentAt < this.timeoutMs) return false;
    this.sentAt = nowMs;
    return true;
  }
  /** 스냅샷 수신 또는 새 연결 */
  clear() { this.sentAt = null; }
  get pending() { return this.sentAt != null; }
}

/**
 * 클라이언트 → 서버 송신 예산(슬라이딩 창). 서버 한도는 10 s 에 20 개(초과 시 1008 종료) — 여유를 두고 16 개.
 * hello·pong 은 예산 밖(드물고 필수)이라 최악에도 20 개를 넘지 않는다.
 */
export class SendBudget {
  private sent: number[] = [];
  constructor(private max = 16, private windowMs = 10_000) {}
  private prune(nowMs: number) {
    while (this.sent.length > 0 && nowMs - this.sent[0] >= this.windowMs) this.sent.shift();
  }
  tryTake(nowMs: number): boolean {
    this.prune(nowMs);
    if (this.sent.length >= this.max) return false;
    this.sent.push(nowMs);
    return true;
  }
  /** 다음 슬롯이 열릴 때까지 남은 ms(지금 가능하면 0) */
  waitMs(nowMs: number): number {
    this.prune(nowMs);
    return this.sent.length < this.max ? 0 : this.windowMs - (nowMs - this.sent[0]);
  }
}

// ---- 알림(alerts / alerts_batch) ----

/** 목록에 남기는 이벤트(활성). 나머지(LEFT·LOST·PREDICTION_CLEARED)는 목록에서 뺀다. */
const ACTIVE_EVENTS: ReadonlySet<string> = new Set(["ENTERED", "PREDICTED", "PREDICTION_UPDATED"]);
/** 배너(lastEvent)로 알릴 이벤트. PREDICTION_UPDATED/CLEARED 는 잦고 가치가 낮아 배너에서 뺀다(GAP-21). */
const BANNER_EVENTS: ReadonlySet<string> = new Set(["ENTERED", "LEFT", "LOST", "PREDICTED"]);

export interface AlertsState {
  alerts: Map<number, Alert>;
  version: number | null;
}

/** 전체 목록: 이미 가진 버전보다 오래된 목록이면 무시한다(연결마다 version=null 로 초기화). */
export function applyAlertsFull(cur: AlertsState, version: unknown, alerts: Alert[]): AlertsState | null {
  const v = typeof version === "number" ? version : null;
  if (v != null && cur.version != null && v < cur.version) return null;
  const map = new Map<number, Alert>();
  for (const a of alerts) if (a.left_at == null) map.set(a.id, a);
  return { alerts: map, version: v ?? cur.version };
}

export interface AlertsBatchResult extends AlertsState {
  last: { type: AlertEventType; alert: Alert } | null;
}

/** 증분: 이미 반영된 버전(≤ 현재)이면 무시한다. */
export function applyAlertsBatch(cur: AlertsState, version: unknown, items: { event: string; alert: Alert }[]): AlertsBatchResult | null {
  const v = typeof version === "number" ? version : null;
  if (v != null && cur.version != null && v <= cur.version) return null;
  const map = new Map(cur.alerts);
  let last: AlertsBatchResult["last"] = null;
  for (const it of items) {
    if (!it || !it.alert) continue;
    if (ACTIVE_EVENTS.has(it.event) && it.alert.left_at == null) map.set(it.alert.id, it.alert);
    else map.delete(it.alert.id);
    if (BANNER_EVENTS.has(it.event)) last = { type: it.event as AlertEventType, alert: it.alert };
  }
  return { alerts: map, version: v ?? cur.version, last };
}

// ---- 피드(region/global) ----

/** 스냅샷 sources.* 또는 status.region/global → FeedInfo. 피드가 없으면(null·provider "-"·수집 이력 없음) null. */
export function toFeed(src: SourceInfo | null | undefined, receivedAt: number, allowEmpty = false): FeedInfo | null {
  if (src == null || typeof src !== "object") return null;
  const provider = typeof src.provider === "string" && src.provider !== "-" && src.provider !== "" ? src.provider : null;
  const fetchedAt = typeof src.fetched_at === "string" && !src.fetched_at.startsWith("1970-") ? src.fetched_at : null;
  const lag = typeof src.lag_s === "number" && Number.isFinite(src.lag_s) && src.lag_s >= 0 ? src.lag_s : null;
  if (!allowEmpty && provider == null && fetchedAt == null && lag == null) return null;
  return { provider, fetched_at: fetchedAt, lag_s: lag, stale: typeof src.stale === "boolean" ? src.stale : null, received_at: receivedAt };
}

export const REGION_STALE_S = 60;
export const GLOBAL_STALE_S = 300;

/**
 * 표시할 지연. 연결이 열려 있으면 서버가 보고한 값(30 s 마다 status/스냅샷으로 갱신).
 * 연결이 끊겼거나 일시정지면 화면 데이터가 더 이상 갱신되지 않으므로 받은 뒤 경과 시간을 더한다.
 * stale 은 서버 판정 또는 지연 > 임계값(지역 60 s / 전세계 300 s).
 */
export function feedLag(feed: FeedInfo | null, nowMs: number, live: boolean, thresholdS: number): { lag: number | null; stale: boolean } {
  if (!feed || feed.lag_s == null) return { lag: null, stale: true };
  const lag = live ? feed.lag_s : feed.lag_s + Math.max(0, (nowMs - feed.received_at) / 1000);
  return { lag, stale: feed.stale === true || lag > thresholdS };
}
