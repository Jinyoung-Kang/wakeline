/**
 * 항공기 노선 응답의 검증(계약 v4 §A · ADR-016 — lib/route 머리말의 규칙): WS selected.route · REST /aircraft/{hex}.route → RouteInfo. 순수 함수.
 * 첫 화면의 WS 수신 검증(lib/ws-validate)이 쓴다 — 카드 문구 · 거리 계산 · 표시(lib/route)는 항공기 카드와 함께만 받게 이 모듈에서 뺐다(첫 화면 JS — ADR-026).
 * lib/route 가 이 모듈의 것을 그대로 다시 내보낸다(카드 · 시험은 lib/route 에서 쓴다).
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
