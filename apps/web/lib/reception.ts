/**
 * 관측 수신 범위(계약 v5 §G27 · ADR-027) — api GET /api/v1/ships/coverage 의 0.5° 칸(이 서비스가 최근 24 h 에 실제로 선박 위치를 받은 곳)을 지도에 옅게
 * 칠한다. 구독 범위(운영 설정 — 선박 레이어의 점선)가 아니다: aisstream.io 는 육상 AIS 수신국이 받은 것만 보내므로 구독해도 수신국이 없는 해역은 비어 있고,
 * 이 레이어가 그것을 잰 값으로 보인다. 레이어를 켤 때만 받는 조각이다(ADR-026 — components/ReceptionLayer).
 * - 값: api 가 센 그대로 — 칸마다 선박 수(창 안 서로 다른 MMSI) · 위치 수(선박마다 60 s 창의 첫 보고 — 저장과 같은 표본) · 마지막 수신. 여기서도 모양을 다시 본다(틀린 칸은
 *   버리고 센다 — 봉투가 틀리면 null 이라 마지막 값을 둔다).
 * - 창 · 덮음: window(지금 시의 시작 − 24 h ~ 응답 시각) · since(이 시각부터 빠짐없이 셌다) · covered(full · partial · since_api_start) — 창 전체를 세지
 *   못했으면 상태 줄 · 툴팁이 그렇다고 적는다(창 전체인 척하지 않는다). api 가 기동 때 못 읽은 시(bootstrap.missing — 다시 읽기 대기 · 포기)는 상태 줄이 그 시(KST) ·
 *   까닭 · 다음 다시 읽기 시각과 함께 적는다(계약 v5 §G27 — 2026-09-30 22:49 KST 배포 뒤: 전에는 시간 초과 하나로 부트스트랩이 멈췄다).
 * - 색: 한 가지(lib/reception-meta RECEPTION_COLOR), 채움 불투명도만 선박 수 구간으로(범례와 같은 표 — 표시용 선택값).
 * - 시각: KST 만(공유 형식기 lib/time — 계약 v5 §G20).
 */
import type * as GeoJSON from "geojson";
import { EtagPoller, POLL_NONE, watchVisible, type Fetcher, type PollState, type WatchVisible } from "./etag-poller";
import { RECEPTION_BINS, RECEPTION_COLOR, RECEPTION_FILL_LAYER, RECEPTION_LINE_LAYER } from "./reception-meta";
import { fmtKst, fmtKstMinute, fmtKstRange } from "./time";
import type { Tip } from "./tooltip";

export const RECEPTION_URL = "/api/v1/ships/coverage";
/** 조회 주기(선택값): api 는 스냅숏을 60 s 마다 새로 만들고, 24 h 집계라 천천히 바뀐다 */
export const RECEPTION_POLL_MS = 120_000;
export const RECEPTION_VISIBLE_MIN_GAP_MS = 10_000;
export const RECEPTION_CELL_DEG = 0.5;
/** 창 길이(시간) — 화면의 모든 '최근 24 h' 글(레이어 이름 · 범례 · 칩)이 이 값이다. api 의 window.hours 가 다르면 응답을 받지 않는다(형식 오류 — 마지막 값) */
export const RECEPTION_WINDOW_H = 24;
export const RECEPTION_SOURCE = "reception";
export const RECEPTION_LAYERS = [RECEPTION_FILL_LAYER, RECEPTION_LINE_LAYER] as const;

export type ReceptionCovered = "full" | "partial" | "since_api_start";
export type ReceptionBootstrapState = "pending" | "running" | "done" | "failed";
export type ReceptionError = "statement_timeout" | "connection" | "read_timeout" | "deadline" | "stopped" | "error";
/**
 * api 가 기동 때 못 읽은 시 하나(bootstrap.missing): [from, to) · 다시 읽기 대기(retry) · 포기(given_up) · attempts = 읽으려다 실패한 차례 수(차례 마감으로 조회하지
 * 않고 미룬 차례는 세지 않는다 — 0 이면 조회하지 않았다: error 는 deadline · stopped) · 마지막 실패의 종류
 */
export interface ReceptionMissing { from: string; to: string; state: "retry" | "given_up"; attempts: number; error: ReceptionError }
/** [lon0, lat0, 크기(°), 선박 수, 위치 수, 마지막 수신(ISO UTC — 화면에는 KST)] */
export type ReceptionCell = [number, number, number, number, number, string];

export interface Reception {
  cellDeg: number;
  windowHours: number;
  from: string;
  to: string;
  since: string;
  covered: ReceptionCovered;
  liveFrom: string;
  /**
   * missing = 못 읽은 시(오래된 것부터 — 옛 api 는 없음 = []) · nextRetryAt = 다음 다시 읽기(모르면 null) · nextRetry = 그 차례가 몇 번째 다시 읽기인지(api 의
   * next_retry — 다음 시각과 함께만, 모르면 null: attempts 로 짐작하지 않는다) · retries = 다시 읽기 횟수(retry_backoff_s 의 길이 — 모르면 null)
   */
  bootstrap: {
    state: ReceptionBootstrapState; hoursLoaded: number; hoursTotal: number; error: ReceptionError | null; missing: ReceptionMissing[];
    nextRetryAt: string | null; nextRetry: number | null; retries: number | null;
  };
  cells: ReceptionCell[];
  positions: number;
  truncated: boolean;
  droppedPositions: number;
  maxCells: number;
  /** 이 브라우저가 형식이 틀려 버린 칸 수 */
  dropped: number;
}

const COVERED: ReadonlySet<string> = new Set(["full", "partial", "since_api_start"]);
const STATES: ReadonlySet<string> = new Set(["pending", "running", "done", "failed"]);
const ERRORS: ReadonlySet<string> = new Set(["statement_timeout", "connection", "read_timeout", "deadline", "stopped", "error"]);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const time = (v: unknown): string | null => (typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);
const onLattice = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v * 2 - Math.round(v * 2)) <= 1e-9;

function cellOf(c: unknown): ReceptionCell | null {
  if (!Array.isArray(c) || c.length !== 6) return null;
  const [lon0, lat0, size, ships, positions, last] = c;
  if (!onLattice(lon0) || !onLattice(lat0) || lon0 < -180 || lon0 > 180 - RECEPTION_CELL_DEG || lat0 < -90 || lat0 > 90 - RECEPTION_CELL_DEG) return null;
  if (size !== RECEPTION_CELL_DEG) return null;
  const s = count(ships), n = count(positions), t = time(last);
  if (s == null || n == null || s < 1 || n < s || t == null) return null;
  return [lon0, lat0, size, s, n, t];
}

/** 못 읽은 시 하나 — 모양이 틀리면 null(버린다 — 지어내지 않는다). 모르는 종류는 'error'(서버 글자를 보이지 않는다) */
function missingOf(m: unknown): ReceptionMissing | null {
  if (typeof m !== "object" || m === null || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  const from = time(o.from), to = time(o.to), attempts = count(o.attempts);
  if (from == null || to == null || attempts == null || (o.state !== "retry" && o.state !== "given_up")) return null;
  const error = typeof o.error === "string" && ERRORS.has(o.error) ? (o.error as ReceptionError) : "error";
  return { from, to, state: o.state, attempts, error };
}

/** api 응답 → 화면 값. 봉투가 틀리면 null(마지막 값을 둔다). 틀린 칸은 버리고 dropped 로 센다 */
export function parseReception(x: unknown): Reception | null {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const w = o.window as Record<string, unknown> | null | undefined;
  const b = o.bootstrap as Record<string, unknown> | null | undefined;
  if (o.cell_deg !== RECEPTION_CELL_DEG || typeof w !== "object" || w === null || typeof b !== "object" || b === null) return null;
  const hours = count(w.hours), from = time(w.from), to = time(w.to), since = time(o.since), liveFrom = time(o.live_from);
  const loaded = count(b.hours_loaded), total = count(b.hours_total);
  const limits = o.limits as Record<string, unknown> | null | undefined;
  const maxCells = typeof limits === "object" && limits !== null ? count(limits.max_cells) : null;
  if (hours == null || from == null || to == null || since == null || liveFrom == null || loaded == null || total == null || maxCells == null) return null;
  // 글은 모두 '24 h' — 다른 창을 24 h 라 적지 않게(리뷰 2026-09-30 밤: windowHours 를 받아 두기만 했다)
  if (hours !== RECEPTION_WINDOW_H) return null;
  if (typeof o.covered !== "string" || !COVERED.has(o.covered) || typeof b.state !== "string" || !STATES.has(b.state)) return null;
  if (!Array.isArray(o.cells) || typeof o.truncated !== "boolean") return null;
  const cells: ReceptionCell[] = [];
  let dropped = 0;
  for (const c of o.cells) { const v = cellOf(c); if (v) cells.push(v); else dropped++; }
  const error = b.state === "failed" ? (typeof b.error === "string" && ERRORS.has(b.error) ? (b.error as ReceptionError) : "error") : null;
  const missing = Array.isArray(b.missing) ? b.missing.map(missingOf).filter((m): m is ReceptionMissing => m != null) : [];
  const retries = Array.isArray(b.retry_backoff_s) && b.retry_backoff_s.every((x) => count(x) != null) ? b.retry_backoff_s.length : null;
  const nextRetryAt = time(b.next_retry_at), nth = count(b.next_retry);
  const nextRetry = nextRetryAt != null && nth != null && nth >= 1 && (retries == null || nth <= retries) ? nth : null;
  return {
    cellDeg: RECEPTION_CELL_DEG, windowHours: hours, from, to, since, covered: o.covered as ReceptionCovered, liveFrom,
    bootstrap: { state: b.state as ReceptionBootstrapState, hoursLoaded: loaded, hoursTotal: total, error, missing, nextRetryAt, nextRetry, retries },
    cells, positions: count(o.positions) ?? 0, truncated: o.truncated, droppedPositions: count(o.dropped_positions) ?? 0, maxCells, dropped,
  };
}

// ---- 지도 -------------------------------------------------------------------------------------------------------------

/** 칸 → 정사각형 하나. 속성: g 칸 번호("lat0,lon0") · s 선박 수 · n 위치 수 · t 마지막 수신(ISO) */
export function receptionFeatures(cells: readonly ReceptionCell[]): GeoJSON.FeatureCollection<GeoJSON.Polygon, { g: string; s: number; n: number; t: string }> {
  return {
    type: "FeatureCollection",
    features: cells.map(([lon, lat, d, s, n, t], i) => ({
      type: "Feature",
      id: i,
      properties: { g: `${lat},${lon}`, s, n, t },
      geometry: { type: "Polygon", coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]] },
    })),
  };
}

/** MapLibre step 식 — 선박 수 구간의 채움 불투명도(범례와 같은 표) */
export function receptionOpacityExpr(): unknown[] {
  return ["step", ["get", "s"], RECEPTION_BINS[0].opacity, ...RECEPTION_BINS.slice(1).flatMap((b) => [b.min, b.opacity])];
}

interface LayerHost {
  addSource(id: string, spec: unknown): unknown;
  addLayer(spec: unknown, before?: string): unknown;
  getSource(id: string): unknown;
  getLayer(id: string): unknown;
}

/** GeoJSON 소스 하나 + 채움 · 칸 테두리(줌 5 이상, 옅게). before 아래에 끼운다(상황판: 연안 교통량 아래 — 교통량 · 레이더 · 선박 · 항공기가 위) */
export function addReceptionLayers(map: LayerHost, before?: string): void {
  if (map.getSource(RECEPTION_SOURCE)) return;
  map.addSource(RECEPTION_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] }, tolerance: 0, buffer: 0 });
  map.addLayer({
    id: RECEPTION_FILL_LAYER, type: "fill", source: RECEPTION_SOURCE,
    paint: { "fill-color": RECEPTION_COLOR, "fill-opacity": receptionOpacityExpr(), "fill-antialias": false },
  }, before);
  map.addLayer({
    id: RECEPTION_LINE_LAYER, type: "line", source: RECEPTION_SOURCE, minzoom: 5,
    paint: { "line-color": RECEPTION_COLOR, "line-width": 0.5, "line-opacity": 0.35 },
  }, before);
}

/**
 * 보이는 화면 [west, south, east, north](MapLibre getBounds — 날짜변경선을 넘으면 경도를 펼친 값, 예: 170 ~ 190)과 겹치는 칸 수. 모서리만 닿으면 세지 않는다.
 */
export function cellsInView(cells: readonly ReceptionCell[], b: readonly [number, number, number, number]): number {
  const [w, s, e, n] = b;
  const all = e - w >= 360;
  let k = 0;
  for (const [lon, lat, d] of cells) {
    if (lat + d <= s || lat >= n) continue;
    if (all || lon < e && lon + d > w || lon - 360 < e && lon - 360 + d > w || lon + 360 < e && lon + 360 + d > w) k++;
  }
  return k;
}

// ---- 글 -------------------------------------------------------------------------------------------------------------

const n0 = (v: number) => v.toLocaleString("en-US");
const ERROR_TEXT: Record<ReceptionError, string> = {
  statement_timeout: "DB 문장 상한 초과",
  connection: "DB 연결 실패",
  read_timeout: "DB 응답 없음",
  deadline: "한 차례 마감 초과",
  stopped: "api 종료",
  error: "DB 오류",
};

/** 위도 칸 "37.0–37.5°N" · 남반구 "34.0–33.5°S"(남 → 북 가장자리 순, 절댓값) */
function latSpan(lat: number): string {
  const a = lat, b = lat + RECEPTION_CELL_DEG;
  return a >= 0 ? `${a.toFixed(1)}–${b.toFixed(1)}°N` : `${Math.abs(a).toFixed(1)}–${Math.abs(b).toFixed(1)}°S`;
}
function lonSpan(lon: number): string {
  const a = lon, b = lon + RECEPTION_CELL_DEG;
  return a >= 0 ? `${a.toFixed(1)}–${b.toFixed(1)}°E` : `${Math.abs(a).toFixed(1)}–${Math.abs(b).toFixed(1)}°W`;
}

const windowText = (r: Reception | null) => (r ? fmtKstRange(r.from, r.to, { seconds: false }) : "—");

/** 지도 툴팁(칸 하나) — 값은 api 가 센 그대로, 시각은 KST */
export function receptionTip(p: Record<string, unknown>, r: Reception | null): Tip | null {
  if (typeof p.g !== "string") return null;
  const [lat, lon] = p.g.split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const s = typeof p.s === "number" ? p.s : null;
  const n = typeof p.n === "number" ? p.n : null;
  const last = fmtKst(typeof p.t === "string" ? p.t : null);
  const flags: Tip["flags"] = [{ text: "받은 위치의 집계 — 구독 범위 아님", tone: "muted" }];
  if (r && r.covered !== "full")
    flags.push({ text: `${fmtKstMinute(r.since, { date: true })} 부터만 셈(${r.covered === "partial" ? "기동 전 기록 일부" : "api 시작 뒤"})`, tone: "warn" });
  return {
    title: "관측 수신 칸",
    subtitle: `${latSpan(lat)} · ${lonSpan(lon)}`,
    rows: [
      ["선박", s == null ? "—" : `${n0(s)}척`],
      ["위치", n == null ? "—" : `${n0(n)}건(선박마다 60 s 창의 첫 보고 — 많아야 1건)`],
      // 표본(60 s 창의 첫 보고)의 가장 늦은 시각 — 같은 창의 뒤 보고는 표본에 없으므로 실제 마지막 수신보다 60 s 안쪽으로 이를 수 있다(리뷰 2026-09-30 밤)
      ["마지막 표본 수신", last === "—" ? last : `${last}(60 s 창의 첫 보고 — 실제 마지막 수신은 60 s 안쪽으로 늦을 수 있음)`],
      ["창", windowText(r)],
    ],
    flags,
  };
}

export type ReceptionTone = "ok" | "warn" | "bad" | "muted";
export interface ReceptionStatusLine { text: string; tone: ReceptionTone; detail: string | null }

/** 빈 시 구간을 KST 로(닿은 시는 한 구간 — 둘까지 적고 나머지는 '외 N곳') */
function missingSpans(ms: readonly ReceptionMissing[]): string {
  const spans: [string, string][] = [];
  for (const m of ms) {
    const last = spans[spans.length - 1];
    if (last && Date.parse(last[1]) === Date.parse(m.from)) last[1] = m.to;
    else spans.push([m.from, m.to]);
  }
  const shown = spans.slice(0, 2).map(([a, b]) => fmtKstRange(a, b, { seconds: false })).join(", ");
  return spans.length > 2 ? `${shown} 외 ${spans.length - 2}곳` : shown;
}
/**
 * 빈 시의 실제 길이(조각마다 to − from 의 합 — 가장 최근 조각은 셈 시작에서 끊긴 한 시 안이라 1시간보다 짧다): '37분' · '3시간' · '3시간 30분'. 조각 수를
 * '시간'으로 적지 않는다(리뷰 2026-10-01 — 전에는 09:00–09:37 조각을 '1시간'이라 적었다). 조각은 분 경계라 분으로 딱 떨어진다.
 */
function missingLength(ms: readonly ReceptionMissing[]): string {
  const min = Math.round(ms.reduce((a, m) => a + (Date.parse(m.to) - Date.parse(m.from)), 0) / 60_000);
  const h = Math.floor(min / 60), m = min % 60;
  return h && m ? `${h}시간 ${m}분` : h ? `${h}시간` : `${m}분`;
}
/** 다시 읽기를 기다리는 시의 까닭(나온 순서) — 차례 마감(deadline)은 조회하지 않았다는 뜻이다 */
const retryKinds = (ms: readonly ReceptionMissing[]) =>
  [...new Set(ms.map((m) => (m.error === "deadline" ? "차례 마감으로 아직 조회하지 않음" : ERROR_TEXT[m.error])))].join(" · ");
/** 포기한 시의 까닭과 까닭마다 못 읽은 횟수(api 의 attempts 그대로 — 다르면 'a–b번'). 조회하지 않은 시(0번)는 횟수를 적지 않는다 */
function goneKinds(ms: readonly ReceptionMissing[]): string {
  const by = new Map<ReceptionError, number[]>();
  for (const m of ms) by.set(m.error, [...(by.get(m.error) ?? []), m.attempts]);
  return [...by].map(([k, a]) => {
    if (k === "deadline") return "차례 마감으로 한 번도 조회하지 못함";
    const lo = Math.min(...a), hi = Math.max(...a);
    return hi > 0 ? `${ERROR_TEXT[k]}(${lo > 0 && lo < hi ? `${lo}–${hi}` : hi}번 못 읽음)` : ERROR_TEXT[k];
  }).join(" · ");
}

/**
 * 못 읽은 시(api 가 기동 때 읽다 실패한 시 — 계약 v5 §G27): 다시 읽기를 기다리는 시와 포기한 시를 따로 — 실제 길이 · 구간(KST) · 까닭 · 다음 다시 읽기(아직 정하지
 * 않았으면 '이 차례 뒤', 시각이 지났으면 '다시 읽는 중' — 몇 번째인지는 api 가 준 번호만) · 포기한 시는 몇 번 못 읽었는지(조회하지 않은 시는 그렇다고)와 다음 재시작
 * 전까지 비어 있다는 것. 없으면 null.
 */
function missingText(r: Reception): string | null {
  const b = r.bootstrap;
  const retry = b.missing.filter((m) => m.state === "retry"), gone = b.missing.filter((m) => m.state === "given_up");
  const parts: string[] = [];
  if (retry.length) {
    const next = b.nextRetryAt == null ? "이 차례 뒤 다시 읽음"
      : Date.parse(b.nextRetryAt) > Date.parse(r.to) ? `다음 ${fmtKstMinute(b.nextRetryAt)}` : "다시 읽는 중";
    const nth = b.nextRetry != null && b.retries != null ? `(다시 읽기 ${b.nextRetry}/${b.retries})` : "";
    parts.push(`빈 시 ${missingLength(retry)}(${missingSpans(retry)}) 다시 읽기 대기 — ${retryKinds(retry)} · ${next}${nth}`);
  }
  if (gone.length) parts.push(`빈 시 ${missingLength(gone)}(${missingSpans(gone)}) 포기 — ${goneKinds(gone)} · api 재시작 전까지 빈 시`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * 레이어 상태 줄: 칸 수 · 이 화면의 칸 수(모르면 뺀다) · 창(KST). detail = 창을 다 세지 못한 까닭(부트스트랩 상태 · 종류 · 못 읽은 시) · 메모리 상한 · 버린 칸.
 * 조회가 실패해도 마지막 값을 보이되 오류를 함께 적는다.
 */
export function receptionStatusLine(r: Reception | null, error: string | null, inView: number | null): ReceptionStatusLine {
  if (!r) return error ? { text: `조회 실패 — ${error}`, tone: "bad", detail: null } : { text: "불러오는 중…", tone: "muted", detail: null };
  const parts = [`칸 ${n0(r.cells.length)}개(${RECEPTION_CELL_DEG}°)`];
  if (inView != null) parts.push(`이 화면 ${n0(inView)}개`);
  parts.push(`창 ${windowText(r)}`);
  const extra: string[] = [];
  if (r.covered !== "full") {
    const b = r.bootstrap;
    const miss = missingText(r);
    const why = miss != null ? `${r.covered === "since_api_start" ? "api 시작 뒤 · " : ""}기동 전 기록 ${b.hoursLoaded}/${b.hoursTotal}시간 읽음 · ${miss}`
      : r.covered === "partial"
      ? `기동 전 기록 ${b.hoursLoaded}/${b.hoursTotal}시간만 읽음 — ${b.state === "running" ? "읽는 중" : b.error ? ERROR_TEXT[b.error] : "멈춤"}`
      : `api 시작 뒤 · ${b.state === "pending" ? "기동 전 기록은 곧 읽음"
        : b.state === "running" ? `기동 전 기록 읽는 중 ${b.hoursLoaded}/${b.hoursTotal}시간`
        : b.state === "failed" ? `기동 전 기록 읽기 실패 — ${ERROR_TEXT[b.error ?? "error"]}` : "기동 전 기록 없음"}`;
    extra.push(`창의 일부만 셈 — ${fmtKstMinute(r.since, { date: true })} 부터(${why})`);
  }
  if (r.truncated) extra.push(`메모리 상한(칸 ${n0(r.maxCells)}) — 위치 ${n0(r.droppedPositions)}건 세지 못함`);
  if (r.dropped > 0) extra.push(`형식 오류로 뺀 칸 ${n0(r.dropped)}`);
  const err = error ? ` · 조회 실패(${error}) — 마지막 값` : "";
  return { text: parts.join(" · ") + err, tone: extra.length || error ? "warn" : "ok", detail: extra.length ? extra.join(" · ") : null };
}

// ---- 조회 -------------------------------------------------------------------------------------------------------------

export type ReceptionPollState = PollState<Reception>;
export const RECEPTION_POLL_NONE: ReceptionPollState = POLL_NONE;

/** 레이어가 켜져 있는 동안만 도는 ETag 조회기(lib/etag-poller) */
export function receptionPoller(
  publish: (s: ReceptionPollState) => void,
  initial: ReceptionPollState = RECEPTION_POLL_NONE,
  fetcher: Fetcher = (u, i) => fetch(u, i),
  hidden: () => boolean = () => typeof document !== "undefined" && document.hidden,
  now: () => number = () => Date.now(),
  watch: WatchVisible = watchVisible,
): EtagPoller<Reception> {
  return new EtagPoller({ url: RECEPTION_URL, parse: parseReception, intervalMs: RECEPTION_POLL_MS, visibleMinGapMs: RECEPTION_VISIBLE_MIN_GAP_MS },
    publish, initial, fetcher, hidden, now, watch);
}
