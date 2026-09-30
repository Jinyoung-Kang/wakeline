/**
 * 항공기 출발지·도착지(계약 v4 §A · ADR-016) — 순수 함수(테스트 가능).
 * - 자료: collector 가 선택한 항공기의 콜사인으로 adsbdb 에 물은 "콜사인에 등록된 정기 노선". 실제 운항 경로와 다를 수 있다 — 화면이 그렇게 적는다.
 * - 검증: 서버 값도 믿지 않는다. 형식이 틀린 공항은 null, 모르는 상태는 노선 전체를 null(표시하지 않음).
 *   문자열은 api(RouteInfo.text)와 같게 제어·서식 문자(\p{Cc}·\p{Cf} — 방향 바꾸기 U+202E·폭 없는 문자 포함) 제거·코드포인트 길이 절단.
 * - disabled(계약 v4 §G A-2): fixture 모드이거나 운영자가 adsbdb 공급자를 끈 경우 — 조회 실패가 아니라 운영 설정이다.
 * - 거리: 현재(마지막 관측) 위치와 출발→(경유)→도착 대권 경로 사이 가장 가까운 거리. 구면 지구 계산값이며 추정이 아니라 계산이라고 적는다.
 *   "노선이 맞다/틀리다"를 판정해 붙이지 않는다.
 */

export const ROUTE_STATUSES = ["found", "not_found", "pending", "unavailable", "no_callsign", "disabled"] as const;
export type RouteStatus = (typeof ROUTE_STATUSES)[number];
const STATUS_SET: ReadonlySet<string> = new Set(ROUTE_STATUSES);

export interface RouteAirport {
  icao: string;
  iata: string | null;
  name: string;
  city: string | null;
  country: string | null;
  country_iso: string | null;
  lat: number;
  lon: number;
}
export interface RouteAirline { name: string | null; icao: string | null; iata: string | null }
export interface RouteInfo {
  status: RouteStatus;
  callsign: string | null;
  airline: RouteAirline | null;
  origin: RouteAirport | null;
  destination: RouteAirport | null;
  midpoint: RouteAirport | null;
  fetched_at: string | null;
  source: string | null;
}

/** 카드 제목 · 상태별 문구 · 주의 · 출처(계약 v4 §A 문구 그대로) */
export const ROUTE_TITLE = "노선(콜사인 기준 등록 노선)";
export const ROUTE_STATUS_TEXT: Record<Exclude<RouteStatus, "found">, string> = {
  pending: "노선 조회 중",
  not_found: "이 콜사인의 등록 노선 없음",
  no_callsign: "콜사인 없음 — 노선을 찾을 수 없음",
  unavailable: "노선 조회 실패",
  disabled: "노선 조회 꺼짐(운영 설정)",
};
/**
 * "조회 중"이 보통 경로보다 길어졌는가(사용자 요청 2026-09-29). 보통 경로 계산값(측정값이 아니다) = api 노선 메모리 캐시(RouteReader.TTL_MS 5 s —
 * 콜사인을 처음 읽을 때 "조회 중"이면 그 값을 5 s 동안 그대로 준다) + 다음 selected 전송(WsHub 는 수집기의 집중 추적 관측마다 selected 를 다시 계산하고
 * — 캐시가 지났으면 노선을 다시 묻는다 — 보이는 값이 바뀌었을 때 보낸다. 노선이 "조회 중"에서 바뀌면 글자가 달라 나간다(같은 글자만 건너뛴다 — 계약 v5 §G21) —
 * 관측 주기 collector jobs/demand FOCUS_INTERVAL_S 5 s, WsHub "≈ 5 s") = 10 s. 수집기는 임대에 적힌 콜사인을 다음 틱(TICK_S 1 s)에 곧바로 노선 조회에
 * 넘기므로(FOCUS_INTERVAL_S 는 같은 콜사인을 다시 넘기기까지의 간격), 조회가 캐시 5 s 안에 끝나면 결과는 이 계산값 안에 보인다. adsbdb 응답 시간은 잰 값이 없어
 * 셈에 넣지 않았다. 캐시가 지난 뒤 api 가 Redis 를 다시 읽는 시간도 잰 값이 없어 넣지 않았다(계약 v5 §G21 — 우편함 밖에서 읽고 답이 오는 즉시 selected 를
 * 보낸다. 상한은 아래 ROUTE_API_READ_BOUND_S). 넘으면 "보통 경로 계산값보다 오래 걸림"을 한 번 알린다 — 상한은 말하지 않는다
 * (수집기의 조회 대기열은 동시 2개라 여러 항공기를 고르면 기다림에 상한이 없다). tests/route-pending.test.ts 가 서버 코드의 값과 경로를 읽어 대조한다.
 */
export const ROUTE_NORMAL_PATH_S = 10;
export const ROUTE_SLOW_AFTER_S = ROUTE_NORMAL_PATH_S;
export const ROUTE_SLOW_TEXT = `보통 경로 계산값(${ROUTE_NORMAL_PATH_S} s)보다 오래 걸림`;
/**
 * api 가 수집기의 노선 결과(Redis)를 읽는 한 번의 상한(초) — api 의 Redis 명령 상한 spring.data.redis.timeout(application.yml 3s, 설정값 · 측정값 아님).
 * 계약 v5 §G21: 이 읽기는 세션 우편함 밖에서 돌고, selected 는 곧바로 "조회 중"으로 나간다. api 는 늦어도 이 값 안에 답을 정한다(읽지 못하면 "노선 조회
 * 실패"). 이 값은 화면에 닿는 상한이 아니다 — 답은 그 연결의 전송 차례(세션 우편함)로 나가고, Redis 가 멈춘 동안에는 같은 연결의 상태 메시지(heartbeat ·
 * 초기 세트의 status — 아직 우편함에서 Redis 를 읽는다, §G21 '남은 것')가 먼저 기다릴 수 있다(그 상한은 말하지 않는다).
 * tests/route-pending.test.ts 가 서버 설정 파일의 값과 대조한다.
 */
export const ROUTE_API_READ_BOUND_S = 3;
export const ROUTE_PENDING_TITLE = "수집기가 선택한 항공기의 콜사인을 adsbdb 에 묻는 중이거나, api 가 그 결과(Redis)를 읽는 중입니다. "
  + `api 는 그 읽기의 답을 늦어도 ${ROUTE_API_READ_BOUND_S} s(api 의 Redis 명령 상한 — 설정값) 안에 정하고, 읽지 못하면 “${ROUTE_STATUS_TEXT.unavailable}”로 바뀝니다. `
  + "Redis 가 멈춘 동안에는 그 답이 화면에 닿기까지 더 걸릴 수 있습니다(같은 연결의 상태 메시지가 먼저 Redis 를 기다립니다). "
  + "api 가 “조회 중”을 5 s 동안 캐시하고, "
  + "선택 항공기 갱신(selected)은 집중 추적 관측마다(약 5 s) 다시 계산되고, 노선 상태나 다른 보이는 값이 바뀌었을 때 옵니다 — "
  + "조회가 그 사이에 끝나면 결과는 10 s 안에 보입니다(서버 설정으로 셈한 계산값, 측정값 아님). "
  + "수집기는 adsbdb 호출 한도(0.5 req/s, 대기 최대 10 s)와 응답(읽기 제한 8 s)을 기다릴 수 있고, 부르지 못하거나 실패하면 “노선 조회 실패”로 바뀝니다.";
export type RoutePendingPhase = "normal" | "slow";
/** 조회 중 경과(초, 카드가 처음 "조회 중"을 본 때부터 — 모르면 null) → 단계 */
export function routePendingPhase(elapsedS: number | null): RoutePendingPhase {
  return elapsedS != null && elapsedS >= ROUTE_SLOW_AFTER_S ? "slow" : "normal";
}
export const ROUTE_CAVEAT = "콜사인에 등록된 정기 노선입니다 — 실제 운항 경로와 다를 수 있습니다";
/** 출처 표기: "adsbdb.com" + 뒤 문구(카드는 앞부분을 링크로) */
export const ROUTE_ATTRIBUTION_TAIL = " · flight route data © David Taylor, Edinburgh & Jim Mason, Glasgow";
export const ROUTE_ATTRIBUTION = `adsbdb.com${ROUTE_ATTRIBUTION_TAIL}`;
export const ROUTE_SOURCE_URL = "https://www.adsbdb.com";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** 제어(Cc)·서식(Cf) 문자 — 방향 바꾸기(U+202A–202E·2066–2069)·폭 없는 문자(U+200B–200F)·BOM 포함 */
const CONTROL_FORMAT_RE = /[\p{Cc}\p{Cf}]/gu;

/** 문자열: 제어·서식 문자 제거 → 앞뒤 공백 제거 → max 글자(코드포인트)로 절단(api RouteInfo.text 와 같은 규칙). 빈 값·문자열이 아니면 null */
function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  let t = v.replace(CONTROL_FORMAT_RE, "").trim();
  const cps = Array.from(t);
  if (cps.length > max) t = cps.slice(0, max).join("").trim();
  return t.length ? t : null;
}
function code(v: unknown, re: RegExp): string | null {
  return typeof v === "string" && re.test(v) ? v : null;
}
function num(v: unknown, lo: number, hi: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
}

const ICAO_AIRPORT_RE = /^[A-Z0-9]{4}$/;
const IATA_AIRPORT_RE = /^[A-Z0-9]{3}$/;
const COUNTRY_ISO_RE = /^[A-Z]{2}$/;
const CALLSIGN_RE = /^[A-Z0-9]{3,8}$/;
const AIRLINE_CODE_RE = /^[A-Z0-9]{2,4}$/;

/** 공항(계약 v4 §A Airport): icao·이름·좌표가 맞아야 한다. 선택 필드는 형식이 틀리면 null. */
export function parseRouteAirport(v: unknown): RouteAirport | null {
  if (!isObj(v)) return null;
  const icao = code(v.icao, ICAO_AIRPORT_RE);
  const name = text(v.name, 120);
  const lat = num(v.lat, -90, 90), lon = num(v.lon, -180, 180);
  if (!icao || !name || lat == null || lon == null) return null;
  return {
    icao, name, lat, lon,
    iata: code(v.iata, IATA_AIRPORT_RE),
    city: text(v.city, 80),
    country: text(v.country, 80),
    country_iso: code(v.country_iso, COUNTRY_ISO_RE),
  };
}

function parseAirline(v: unknown): RouteAirline | null {
  if (!isObj(v)) return null;
  const a = { name: text(v.name, 120), icao: code(v.icao, AIRLINE_CODE_RE), iata: code(v.iata, AIRLINE_CODE_RE) };
  return a.name || a.icao || a.iata ? a : null;
}

/**
 * WS selected.route · REST /aircraft/{hex}.route → RouteInfo. 모르는 상태·객체가 아니면 null.
 * found 인데 출발·도착이 둘 다 없으면(검증에서 빠진 경우 포함) not_found — 수집기와 같은 규칙.
 */
export function parseRoute(v: unknown): RouteInfo | null {
  if (!isObj(v) || typeof v.status !== "string" || !STATUS_SET.has(v.status)) return null;
  const fetched = typeof v.fetched_at === "string" && v.fetched_at.length <= 40 && !Number.isNaN(Date.parse(v.fetched_at)) ? v.fetched_at : null;
  const r: RouteInfo = {
    status: v.status as RouteStatus,
    callsign: code(v.callsign, CALLSIGN_RE),
    airline: null, origin: null, destination: null, midpoint: null,
    fetched_at: fetched,
    source: text(v.source, 32),
  };
  if (r.status !== "found") return r;
  r.airline = parseAirline(v.airline);
  r.origin = parseRouteAirport(v.origin);
  r.destination = parseRouteAirport(v.destination);
  r.midpoint = parseRouteAirport(v.midpoint);
  if (!r.origin && !r.destination) return { ...r, status: "not_found", airline: null, midpoint: null };
  return r;
}

// ---- 대권 경로와의 거리(계산값) ----

/** 평균 지구 반지름(km) — 구면 근사 */
export const EARTH_RADIUS_KM = 6371;
type V3 = [number, number, number];
const toVec = (lat: number, lon: number): V3 => {
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3) => Math.sqrt(dot(a, a));
/** 두 단위 벡터 사이 각(라디안) — 짧은 거리에서도 정확한 atan2 식 */
const angle = (a: V3, b: V3) => Math.atan2(norm(cross(a, b)), dot(a, b));

/** 점 p 와 대권 호 a→b(짧은 쪽) 사이 가장 가까운 각거리(라디안). a·b 가 같거나 정반대면 끝점까지의 거리. */
function arcDistance(p: V3, a: V3, b: V3): number {
  const n = cross(a, b);
  const nl = norm(n);
  const ends = Math.min(angle(p, a), angle(p, b));
  if (nl < 1e-12) return ends;
  const u: V3 = [n[0] / nl, n[1] / nl, n[2] / nl];
  const s = dot(p, u);
  // p 를 대권 평면에 내린 점 c 가 호 a→b 안에 있으면 수선 거리, 아니면 끝점까지
  const c: V3 = [p[0] - s * u[0], p[1] - s * u[1], p[2] - s * u[2]];
  if (norm(c) < 1e-12) return ends; // p 가 대권의 극 — 호 위 모든 점이 같은 거리
  const inside = dot(cross(a, c), u) >= 0 && dot(cross(c, b), u) >= 0;
  return inside ? Math.abs(Math.asin(Math.max(-1, Math.min(1, s)))) : ends;
}

/** 위치와 경로(점 목록을 대권 호로 이은 것) 사이 가장 가까운 거리(km). 점이 2개 미만이거나 값이 틀리면 null. */
export function distanceToPathKm(path: readonly { lat: number; lon: number }[], pos: { lat: number; lon: number } | null | undefined): number | null {
  if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lon) || Math.abs(pos.lat) > 90 || path.length < 2) return null;
  if (path.some((q) => !Number.isFinite(q.lat) || !Number.isFinite(q.lon))) return null;
  const p = toVec(pos.lat, pos.lon);
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) best = Math.min(best, arcDistance(p, toVec(path[i].lat, path[i].lon), toVec(path[i + 1].lat, path[i + 1].lon)));
  return best * EARTH_RADIUS_KM;
}

/** 노선(출발 → 경유 → 도착)과 현재 위치 사이 거리(km, 계산값). 출발·도착 중 하나라도 모르면 null. */
export function routeDistanceKm(route: RouteInfo | null, pos: { lat: number; lon: number } | null | undefined): number | null {
  if (!route || route.status !== "found" || !route.origin || !route.destination) return null;
  const path = [route.origin, ...(route.midpoint ? [route.midpoint] : []), route.destination];
  return distanceToPathKm(path, pos);
}

// ---- 표시 ----

/** "RKSS · GMP" — IATA 가 없으면 "RKSS · IATA —" */
export function fmtAirportCodes(a: RouteAirport): string {
  return `${a.icao} · ${a.iata ?? "IATA —"}`;
}
/** "이름 · 도시 · 국가" — 모르는 칸은 "—" */
export function fmtAirportPlace(a: RouteAirport): string {
  return `${a.name} · ${a.city ?? "—"} · ${a.country ?? "—"}${a.country_iso ? ` (${a.country_iso})` : ""}`;
}
/** 항공사: "이름 · ICAO · IATA"(아는 것만). 없으면 "—" */
export function fmtAirline(a: RouteAirline | null): string {
  if (!a) return "—";
  const parts = [a.name, a.icao, a.iata].filter((x): x is string => x != null);
  return parts.length ? parts.join(" · ") : "—";
}
/** 거리(km): 10 km 미만은 소수 한 자리, 그 밖은 정수(천 단위 쉼표). 모르면 "—" */
export function fmtRouteKm(km: number | null): string {
  if (km == null || !Number.isFinite(km)) return "—";
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString("en-US")} km`;
}

/** 노선을 조회한 콜사인과 지금 콜사인이 다른가(둘 다 알 때만) — 다르면 카드가 그렇다고 적는다 */
export function routeCallsignMismatch(route: RouteInfo | null, callsign: string | null | undefined): boolean {
  if (!route?.callsign || !callsign) return false;
  const now = callsign.trim().toUpperCase();
  return now.length > 0 && now !== route.callsign;
}
