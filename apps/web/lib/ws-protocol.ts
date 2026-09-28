/**
 * WS 클라이언트의 순수 상태 로직(테스트 가능) — 계약서 §1.
 * seq 연속성·resync 게이트·송신 예산(서버 한도 20 msg/10 s)·알림 버전·피드(region/global) 정규화·지연 계산·재접속 백오프·수신 감시.
 */
import type { Alert, AlertEventType, FeedInfo, SourceInfo } from "./types";

// ---- 재접속·수신 감시(WS-1 · WS-2) ----

/** 서버 heartbeat 주기(계약서 §1: ping 30 s 마다, 구독 세션에는 status 도 함께) */
export const PING_INTERVAL_MS = 30_000;
/** 이만큼(ping 2.5 회) 아무 메시지도 없으면 반쯤 열린 연결로 보고 닫고 다시 잇는다 */
export const RX_DEAD_MS = 75_000;
/** 이만큼(ping 1.5 회) 수신이 없으면 "실시간"이 아니다 — 화면의 피드 지연을 받은 뒤 경과만큼 늘린다 */
export const RX_FRESH_MS = 45_000;
/** 연결이 건강하다고 볼 조건: 첫 스냅샷, 또는 welcome 뒤 이만큼 열려 있음(숨긴 탭은 구독을 미뤄 스냅샷이 없다) */
export const HEALTHY_AFTER_MS = 30_000;
/** 서버가 과부하(1013 연결 상한)·정책(1008 rate limit)으로 닫으면 바로 다시 붙지 않는다 — 백오프 상한(30 s)부터 */
export const LONG_BACKOFF_CODES: ReadonlySet<number> = new Set([1008, 1013]);
export const LONG_BACKOFF_ATTEMPT = 5; // 1 s · 2^5 = 32 s → 상한 30 s

export function nextBackoffMs(attempt: number, min = 1000, max = 30000): number {
  const base = Math.min(max, min * Math.pow(2, Math.max(0, attempt)));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * 연결이 닫힌 뒤 다음 백오프 단계. 시도 횟수는 열림(onopen)으로 초기화하지 않는다 — 업그레이드를 받아 준 뒤 곧바로 닫는 서버
 * (연결 상한 1013, 느린 소비자 종료)에 1 s 마다 다시 붙는 고리를 막는다. 초기화는 연결이 건강함이 확인된 뒤에만(HEALTHY_AFTER_MS).
 */
export function attemptAfterClose(attempt: number, code: unknown): number {
  return typeof code === "number" && LONG_BACKOFF_CODES.has(code) ? Math.max(attempt, LONG_BACKOFF_ATTEMPT) : attempt;
}

/**
 * 연결 배지 색(R-09): 열림·수신 중 = ok. 일시정지·수신 없음·첫 연결 중(재시도 전) = warn — 아직 실패가 아니다.
 * 끊김·재시도 중 = bad. silent = 연결은 열려 있지만 RX_FRESH_MS 넘게 아무것도 받지 못함.
 */
export function connTone(conn: string, silent: boolean, reconnectAttempt: number): "ok" | "warn" | "bad" {
  if (conn === "open") return silent ? "warn" : "ok";
  if (conn === "paused") return "warn";
  if (conn === "connecting" && reconnectAttempt === 0) return "warn";
  return "bad";
}

/**
 * 피드 지연 배지 색(R-09). 값이 없고(NO DATA) 첫 연결을 시도하는 중(재시도 전)이면 정상적인 시작이다 — 연결 배지처럼 warn.
 * 실제로 오래됐거나(stale), 재시도·끊김·연결된 뒤에도 값이 없으면 bad.
 */
export function lagTone(f: { lag: number | null; stale: boolean }, conn: string, reconnectAttempt: number): "ok" | "warn" | "bad" {
  if (f.lag == null && conn === "connecting" && reconnectAttempt === 0) return "warn";
  return f.stale ? "bad" : "ok";
}

/** 연결이 열려 있고 최근(RX_FRESH_MS 안)에 무엇이든 받았는가 — ping 은 30 s 마다 오므로 조용한 정상 연결도 참이다. */
export function isRxFresh(conn: string, lastRxAt: number | null | undefined, nowMs: number): boolean {
  return conn === "open" && lastRxAt != null && nowMs - lastRxAt < RX_FRESH_MS;
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

/**
 * 증분: 이미 반영된 버전(≤ 현재)이면 무시한다(null). 서버는 세션마다 전체 목록 뒤로 버전을 1씩 빠짐없이 보낸다 — 그래서 버전을 아는 것은
 * 가진 목록 바로 다음(현재+1) 배치뿐이다. 현재 버전을 모르거나(전체 목록 없음 · 이미 빠진 것이 있음), 틈이거나(> 현재+1 — 배치를 잃었다),
 * 배치에 버전이 없으면 항목은 반영하되 결과 버전은 null(모름) — 호출부(lib/ws.ts)가 전체 목록을 다시 요청한다(계약 v5 §E2).
 */
export function applyAlertsBatch(cur: AlertsState, version: unknown, items: { event: string; alert: Alert }[]): AlertsBatchResult | null {
  const v = typeof version === "number" ? version : null;
  if (v != null && cur.version != null && v <= cur.version) return null;
  const next = v != null && cur.version != null && v === cur.version + 1 ? v : null;
  const map = new Map(cur.alerts);
  let last: AlertsBatchResult["last"] = null;
  for (const it of items) {
    if (!it || !it.alert) continue;
    if (ACTIVE_EVENTS.has(it.event) && it.alert.left_at == null) map.set(it.alert.id, it.alert);
    else map.delete(it.alert.id);
    if (BANNER_EVENTS.has(it.event)) last = { type: it.event as AlertEventType, alert: it.alert };
  }
  return { alerts: map, version: next, last };
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
 * 표시할 지연(WS-2). 실시간(live = 연결 열림 ∧ 최근 수신)이고 그 값을 받은 지 RX_FRESH_MS 안이면 서버가 보고한 값
 * (status 는 30 s 마다, 스냅샷은 30/120 s 마다 새로 온다). 그 밖에는 — 끊김·일시정지·반쯤 열린 연결·status 가 멈춘 서버 —
 * 화면 데이터가 그 뒤로 새로워졌다는 근거가 없으므로 받은 뒤 경과 시간을 더한다(신선하다고 주장하지 않는다).
 * stale 은 서버 판정 또는 지연 > 임계값(지역 60 s / 전세계 300 s). nowMs·received_at 은 둘 다 브라우저 시계.
 */
export function feedLag(feed: FeedInfo | null, nowMs: number, live: boolean, thresholdS: number): { lag: number | null; stale: boolean } {
  if (!feed || feed.lag_s == null) return { lag: null, stale: true };
  const elapsedMs = Math.max(0, nowMs - feed.received_at);
  const lag = live && elapsedMs <= RX_FRESH_MS ? feed.lag_s : feed.lag_s + elapsedMs / 1000;
  return { lag, stale: feed.stale === true || lag > thresholdS };
}
