/**
 * 선박(AIS, ADR-014 · 계약 v2 §B3/§B4) — 순수 함수(테스트 가능).
 * - 선종 분류(색): 계약 v2 §B3 의 USCG AIS Guide 표 하나만. api(ShipCategory)와 같은 표로 단위 시험한다(tests/fixtures/ship-category-uscg.json).
 * - 수신 메시지 검증: 서버 값도 믿지 않는다 — 형식·범위가 맞지 않는 필드는 null(모름), MMSI·위치가 틀리면 그 선박을 버린다. 문자열은 길이 상한.
 * - 표시 규칙: 값이 없으면 "—". AIS "값 없음" 표기(0·511·24·60 등)는 수집기가 null 로 바꾸고, 여기서는 ITU-R M.1371 기본값 0(크기·흘수)도 모름으로 본다
 *   (USCG NAVCEN 문서 2026-09-28 확인: 흘수 "0 = not available = default", 크기 "As default should A = B = C = D be set to '0'").
 * - 항해 상태 이름: USCG NAVCEN Class A 위치 보고 문서(2026-09-28 확인)의 0–15 표.
 */
import { fmtKst, fmtKstDayMinute, fmtKstFrom, fmtKstRange, fmtKstSpan } from "./time";
import type { Tone } from "./tooltip";
import { RX_FRESH_MS } from "./ws-protocol";

// ---- 선종 분류(색) ----

export const SHIP_CATEGORIES = ["cargo", "tanker", "passenger", "fishing", "tug", "pleasure", "hsc", "special", "military", "other", "unknown"] as const;
export type ShipCategory = (typeof SHIP_CATEGORIES)[number];
const CATEGORY_SET: ReadonlySet<string> = new Set(SHIP_CATEGORIES);

const SPECIAL_CODES: ReadonlySet<number> = new Set([50, 51, 53, 54, 55, 58]);

/**
 * AIS 선종 코드(ship_type) → 분류. 계약 v2 §B3(USCG AIS Guide):
 * 30 어선 · 31,32,52 예인 · 36,37 요트·레저 · 40–49 고속선 · 50,51,53,54,55,58 특수·업무 · 35 군 작전 · 60–69 여객 · 70–79 화물 · 80–89 탱커 ·
 * 0/null 미상 · 그 밖(1–29, 33, 34, 38, 39, 56, 57, 59, 90–99, 예약 100–255) 기타. 정수가 아니거나 음수(형식 오류)는 미상.
 */
export function shipCategory(code: unknown): ShipCategory {
  if (typeof code !== "number" || !Number.isInteger(code) || code <= 0) return "unknown";
  if (code === 30) return "fishing";
  if (code === 31 || code === 32 || code === 52) return "tug";
  if (code === 36 || code === 37) return "pleasure";
  if (code >= 40 && code <= 49) return "hsc";
  if (SPECIAL_CODES.has(code)) return "special";
  if (code === 35) return "military";
  if (code >= 60 && code <= 69) return "passenger";
  if (code >= 70 && code <= 79) return "cargo";
  if (code >= 80 && code <= 89) return "tanker";
  return "other";
}

/** 서버가 보낸 분류(ships_grid 의 dominant_category): 알려진 이름이면 그대로, 코드(숫자)면 표로, 그 밖은 미상(색을 지어내지 않는다). */
export function parseCategory(v: unknown): ShipCategory {
  if (typeof v === "string") { const k = v.trim().toLowerCase(); return CATEGORY_SET.has(k) ? (k as ShipCategory) : "unknown"; }
  if (typeof v === "number") return shipCategory(v);
  return "unknown";
}

export const SHIP_CATEGORY_LABEL: Record<ShipCategory, string> = {
  cargo: "화물선", tanker: "유조선·탱커", passenger: "여객선", fishing: "어선", tug: "예인·예선", pleasure: "요트·레저",
  hsc: "고속선(HSC)", special: "특수·업무선", military: "군 작전", other: "기타", unknown: "선종 미상",
};
/** 분류 설명(범례·카드 title) — 표의 코드 */
export const SHIP_CATEGORY_CODES: Record<ShipCategory, string> = {
  cargo: "70–79", tanker: "80–89", passenger: "60–69", fishing: "30", tug: "31·32·52", pleasure: "36·37", hsc: "40–49",
  special: "50·51·53·54·55·58 (도선·수색구조·항만·방제·법집행·의료)", military: "35", other: "그 밖의 코드", unknown: "0 또는 미보고",
};
/**
 * 아이콘·격자·범례가 같은 색표를 쓴다. 미상은 회색(항공기 "고도 모름" 회색 ALT_UNKNOWN_COLOR 와 같은 값).
 * 모든 색이 배경지도 육지·바다에서 ≥ 3:1(WCAG 1.4.11, tests/basemap.test.ts) — 계약 v4 §E.
 */
export const SHIP_CATEGORY_COLOR: Record<ShipCategory, string> = {
  cargo: "#5cb85c", tanker: "#e5534b", passenger: "#4f8ff7", fishing: "#f0a35e", tug: "#2ec4b6", pleasure: "#d16ad8",
  hsc: "#f2d64b", special: "#8f9bff", military: "#9aa55a", other: "#c7ccd4", unknown: "#7a828d",
};
export const SHIP_SELECTED_COLOR = "#ffffff";

// ---- 수신 메시지 검증 ----

/**
 * 위치 출처(계약 v3 §B, 보고의 Timestamp 필드): 0–59 → epfs(전자 위치 장치가 낸 위치 — 장치 종류는 모름) · 61 manual · 62 estimated · 63 inoperative.
 * 60(값 없음)·누락은 null. 옛 값 "gnss" 는 0–60·누락이 섞여 있어 모름(null)으로 받는다.
 */
export type PositionSource = "epfs" | "manual" | "estimated" | "inoperative";
const POSITION_SOURCES: ReadonlySet<string> = new Set(["epfs", "manual", "estimated", "inoperative"]);

/** ships_snapshot/ships_diff 의 선박(ShipLite). 없는 키 = 모름. */
export interface ShipLite {
  mmsi: string;
  lat: number;
  lon: number;
  sog_kn: number | null;
  cog_deg: number | null;
  heading_deg: number | null;
  ship_type: number | null;
  name: string | null;
  seen_at: string | null;
  position_source: PositionSource | null;
  nav_status: number | null;
}

/** ship_selected.state · REST /ships/{mmsi} state(ShipState) */
export interface ShipState extends ShipLite {
  rot: number | null;
  provider: string | null;
  msg_type: string | null;
  class: "A" | "B" | null;
}

/** ship_selected.static · REST static(ShipStatic) — 선원이 입력한 항해 정보(보고값) */
export interface ShipStatic {
  mmsi: string;
  name: string | null;
  call_sign: string | null;
  imo: number | null;
  ship_type: number | null;
  dim_a: number | null;
  dim_b: number | null;
  dim_c: number | null;
  dim_d: number | null;
  draught_m: number | null;
  destination: string | null;
  eta_month: number | null;
  eta_day: number | null;
  eta_hour: number | null;
  eta_minute: number | null;
  updated_at: string | null;
  provider: string | null;
}

/**
 * 정적 정보의 출처(계약 v5 §G17 — WS ship_selected.static_source · REST /ships/{mmsi} static_source):
 * live = api 메모리(실시간 선박 스트림에서 받은 값) · stored = 메모리에 없어 DB 에 저장된 마지막 AIS 정적 보고(실시간 값이 아님) ·
 * none = 메모리에도 DB 에도 없음 · stored_unavailable = 메모리에 없고 DB 를 읽지 못함(저장돼 있는지 모름). REST 는 live · stored 만.
 */
export const STATIC_SOURCES = ["live", "stored", "none", "stored_unavailable"] as const;
export type StaticSource = (typeof STATIC_SOURCES)[number];

/** 저장된 정적 보고 표기(카드 · 설명서 2.6 이 같은 글 — 계약 v5 §G17) */
export const STORED_STATIC_LABEL = "저장된 AIS 정적 보고";
/**
 * 저장 행의 updated_at 이 뜻하는 것 — DB 에 기록된 수신 시각: 수집기(ShipBook) 메모리가 '내용이 바뀜' 으로 본 메시지의 aisstream 수신 시각이다.
 * 그 메모리는 수집기가 다시 시작하면 비고, 30분 넘게 수신이 없거나(ttl_s 기본 1800 — ais/main.py 는 바꾸지 않는다) 선박 수 상한에 밀린 선박을 지운다 —
 * 그 뒤 같은 내용을 다시 받아도 새 시각이 기록된다(수집기 test_ais_book). 그 밖의 같은 내용 재수신은 기록하지 않는다(ShipWriter).
 * 그래서 첫 수신도 마지막 수신도 아니다 — 라벨은 어디에 기록된 무슨 시각인지만 말한다(리뷰 뒤 고침: '이 내용 첫 수신' 은 재시작 · 제거를 빠뜨린 추정이었다).
 */
export const STORED_STATIC_TIME_LABEL = "DB 기록 수신 시각";
/** 카드 설명(title) — 왜 저장값인지 · 시각이 무엇이고 언제 새로 기록되는지(입출항은 조건이 있어 본문 한 줄 — storedPortCallsNote) */
export const STORED_STATIC_TITLE =
  "실시간 선박 스트림(보존 최대 2.5 h — 서버가 다시 시작한 뒤처럼)에 이 선박의 정적 보고가 아직 없어, DB 에 저장된 마지막 AIS 정적 보고를 보입니다(실시간 값이 아님). "
  + "시각은 DB(ship.updated_at)에 기록된 수신 시각 — 지금 저장된 내용을 DB 에 쓴 메시지를 받은 때입니다. 내용이 바뀔 때뿐 아니라 수집기가 다시 시작했거나 "
  + "이 선박이 수집기 메모리에서 빠졌다가(30분 넘게 수신 없음 · 선박 수 상한) 다시 잡힐 때도 같은 내용이 새 시각으로 기록되고, 그 밖의 같은 내용 재수신은 기록하지 않으므로 "
  + "이 내용의 첫 수신도 마지막 수신도 아닙니다. 스트림에 정적 보고가 오면 실시간 값으로 바뀝니다";
/** 저장 정적 보고 표시의 입출항 한 줄 — 아래 입출항(WS port_calls)을 이 호출부호로 찾았을 때만 */
export const STORED_STATIC_PORT_CALLS_TEXT = "입출항도 이 호출부호로 찾음";
/** 카드는 REST 로 읽은 저장 보고를 보이지만 서버(WS)는 선택 때 그 보고를 읽지 못했다 — 아래 입출항은 이 호출부호로 찾은 결과가 아니다 */
export const STORED_STATIC_PORT_CALLS_UNREAD_TEXT =
  "입출항은 이 호출부호로 아직 찾지 않음 — 서버가 선택 때 저장된 보고를 읽지 못함(DB) · 서버가 다시 읽으면 바뀜";
/** 메모리에 없고 DB 도 읽지 못했다 — '없음' 이 아니라 '모름' */
export const STORED_STATIC_UNAVAILABLE_TEXT = "저장된 AIS 정적 보고를 읽지 못함(DB) — 정적 정보를 모릅니다(없다는 뜻이 아님)";

/**
 * 저장 정적 보고 표시에 붙이는 입출항 한 줄(계약 v5 §G17 · 리뷰). 카드의 입출항 절은 WS port_calls 뿐이므로, 그 결과를 찾은 호출부호
 * (port_calls.call_sign — 서버 PortCallReader.normalizeCallSign: ASCII 만 · 앞뒤 공백 제거 · 대문자)가 보이는 호출부호와 같을 때만 looked_up.
 * WS 가 저장 보고를 읽지 못했다(stored_unavailable)고 했으면 not_looked_up(보이는 저장 보고는 REST 가 읽은 것). 그 밖(WS 아직 · 다른 호출부호 ·
 * 형식 밖 · 출처 모름)은 null — 말하지 않는다(입출항 절이 스스로 상태를 말한다).
 */
export function storedPortCallsNote(
  callSign: string | null | undefined,
  ws: { static_source?: StaticSource | null; port_calls?: { call_sign: string | null } | null } | null,
): "looked_up" | "not_looked_up" | null {
  if (!callSign || !ws) return null;
  const cs = /[\u0080-\u{10ffff}]/u.test(callSign) ? null : callSign.trim().toUpperCase();
  if (cs && ws.port_calls?.call_sign === cs) return "looked_up";
  return ws.static_source === "stored_unavailable" ? "not_looked_up" : null;
}

/**
 * 카드가 보이는 정적 정보의 출처와 저장 행 시각(계약 v5 §G17). 보이는 정적 정보는 WS ship_selected → REST 상세 순(ShipCard 와 같은 순서)이고,
 * 출처는 그 정적 정보를 준 쪽의 것만 쓴다(다른 쪽 출처를 붙이지 않는다). 둘 다 정적 정보가 없으면 WS 의 출처(none · stored_unavailable — 왜 없는지).
 */
export function staticProvenance(
  ws: { static: ShipStatic | null; static_source?: StaticSource | null; static_updated_at?: string | null } | null,
  rest: { static: ShipStatic | null; static_source: StaticSource | null; static_updated_at: string | null } | null,
): { source: StaticSource | null; storedAt: string | null } {
  const from = ws?.static ? ws : rest?.static ? rest : null;
  if (from) return { source: from.static_source ?? null, storedAt: from.static_source === "stored" ? from.static_updated_at ?? null : null };
  return { source: ws?.static_source ?? null, storedAt: null };
}

/**
 * ships_grid 칸. counts = 선종별 수(계약 v5 §B2 다섯째 원소, 순서 = SHIP_CATEGORIES = Java ShipCategory 선언 순서).
 * 구 서버(네 원소 칸)이거나 모양·합이 맞지 않으면 null — 선종 필터를 적용할 수 없다(지어내지 않는다).
 */
export interface ShipGridCell { lat: number; lon: number; count: number; category: ShipCategory; counts: number[] | null }

export const MMSI_RE = /^[0-9]{9}$/;
/** 정적 보고의 IMO 칸(schemas/ship_static.v1.json · USCG NAVCEN): 1,000,000–9,999,999 = IMO 번호, 10,000,000 이상 = 기국 공식 번호, 그 밖은 null */
const IMO_MIN = 1_000_000;
const IMO_MAX = 1_073_741_823;
export const FLAG_STATE_NO_MIN = 10_000_000;
/** 메인 스레드에 들고 있는 선박 수 상한(서버 상한 5 000/메시지). 넘치면 새 선박은 받지 않고 resync 를 요청한다. */
export const MAX_SHIPS = 10_000;
/** ships_grid 칸 수 상한(전세계 5° 격자 = 2 592) */
export const MAX_GRID_CELLS = 10_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
function num(v: unknown, lo: number, hi: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
}
function int(v: unknown, lo: number, hi: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
}
/** 문자열: 앞뒤 공백·AIS 채움 문자(@) 제거, 빈 값은 null, 길이 상한(외부 문자열 — 화면에는 텍스트 노드로만 넣는다) */
function str(v: unknown, max = 64): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/@+$/g, "").trim();
  return t.length ? t.slice(0, max) : null;
}
function iso(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 40) return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}
export function isMmsi(v: unknown): v is string {
  return typeof v === "string" && MMSI_RE.test(v);
}

export function parseShipLite(o: unknown): ShipLite | null {
  if (!isObj(o) || !isMmsi(o.mmsi)) return null;
  const lat = num(o.lat, -90, 90), lon = num(o.lon, -180, 180);
  if (lat == null || lon == null) return null;
  return {
    mmsi: o.mmsi, lat, lon,
    sog_kn: num(o.sog_kn, 0, 102.2),
    cog_deg: num(o.cog_deg, 0, 359.9999),
    heading_deg: num(o.heading_deg, 0, 359.9999),
    ship_type: int(o.ship_type, 0, 255),
    name: str(o.name, 32),
    seen_at: iso(o.seen_at),
    position_source: typeof o.position_source === "string" && POSITION_SOURCES.has(o.position_source) ? (o.position_source as PositionSource) : null,
    nav_status: int(o.nav_status, 0, 15),
  };
}

export function parseShipState(o: unknown): ShipState | null {
  const lite = parseShipLite(o);
  if (!lite || !isObj(o)) return null;
  return {
    ...lite,
    rot: num(o.rot, -720, 720),
    provider: str(o.provider, 32),
    msg_type: str(o.msg_type, 48),
    class: o.class === "A" || o.class === "B" ? o.class : null,
  };
}

export function parseShipStatic(o: unknown): ShipStatic | null {
  if (!isObj(o) || !isMmsi(o.mmsi)) return null;
  return {
    mmsi: o.mmsi,
    name: str(o.name, 32),
    call_sign: str(o.call_sign, 16),
    imo: int(o.imo, IMO_MIN, IMO_MAX),
    ship_type: int(o.ship_type, 0, 255),
    dim_a: int(o.dim_a, 0, 511), dim_b: int(o.dim_b, 0, 511), dim_c: int(o.dim_c, 0, 63), dim_d: int(o.dim_d, 0, 63),
    draught_m: num(o.draught_m, 0, 25.5),
    destination: str(o.destination, 32),
    eta_month: int(o.eta_month, 1, 12), eta_day: int(o.eta_day, 1, 31), eta_hour: int(o.eta_hour, 0, 23), eta_minute: int(o.eta_minute, 0, 59),
    updated_at: iso(o.updated_at),
    provider: str(o.provider, 32),
  };
}

/** 칸의 선종별 수: 원소 11개(SHIP_CATEGORIES 순서)의 0 이상 정수이고 합이 칸 선박 수와 같을 때만. 아니면 null */
function parseCatCounts(v: unknown, count: number): number[] | null {
  if (!Array.isArray(v) || v.length !== SHIP_CATEGORIES.length) return null;
  let sum = 0;
  for (const n of v) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return null;
    sum += n;
  }
  return sum === count ? (v as number[]).slice() : null;
}

/**
 * ships_grid.cells: [[lat, lon, count, dominant_category, [n0..n10]?], ...]. 형식이 틀린 칸·0척 칸은 버린다.
 * 다섯째 원소(선종별 수, 계약 v5 §B2)가 없는 네 원소 칸(구 서버)도 받는다 — counts null.
 */
export function parseGridCells(v: unknown): ShipGridCell[] {
  return parseGridCellsCounted(v).cells;
}

/**
 * parseGridCells + 버린 수(계약 v5 §E2 — lib/ws-validate 가 센다): 버린 칸, 그리고 칸은 남겼지만 있는데 틀린 다섯째 원소(선종별 수를 버림).
 * 네 원소 칸(구 서버)은 틀린 것이 아니다(세지 않는다).
 */
export function parseGridCellsCounted(v: unknown): { cells: ShipGridCell[]; dropped: number } {
  if (!Array.isArray(v)) return { cells: [], dropped: 0 };
  const out: ShipGridCell[] = [];
  let dropped = 0;
  for (const c of v) {
    if (out.length >= MAX_GRID_CELLS) break;
    const lat = Array.isArray(c) ? num(c[0], -90, 90) : null, lon = Array.isArray(c) ? num(c[1], -180, 180) : null;
    const count = Array.isArray(c) ? int(c[2], 1, Number.MAX_SAFE_INTEGER) : null;
    if (!Array.isArray(c) || lat == null || lon == null || count == null) { dropped++; continue; }
    const counts = parseCatCounts(c[4], count);
    if (counts == null && c[4] !== undefined) dropped++;
    out.push({ lat, lon, count, category: parseCategory(c[3]), counts });
  }
  return { cells: out, dropped };
}

/** 목록에서 MMSI 만(ships_diff.remove) */
export function parseMmsiList(v: unknown, max = MAX_SHIPS): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) { if (out.length >= max) break; if (isMmsi(x)) out.push(x); }
  return out;
}

// ---- 표시 ----

/** 선박 위치가 이보다 오래되면 STALE(반투명) — 계약 v2 §B4 */
export const SHIP_STALE_S = 900;

export function shipAgeS(seenAt: string | null | undefined, nowMs: number): number | null {
  if (!seenAt || !nowMs) return null;
  const t = Date.parse(seenAt);
  return Number.isNaN(t) ? null : Math.max(0, (nowMs - t) / 1000);
}

export type RotMode = "heading" | "cog" | "none";
/**
 * 아이콘 방향(계약 v2 §B4): 선수방위(heading) → 없으면 대지침로(cog, 점선 외곽 "침로 기준") → 둘 다 없으면 회전하지 않는 원("방향 모름").
 * 모르는 방향을 북쪽(0°)으로 그리지 않는다.
 */
export function shipRotation(s: { heading_deg?: number | null; cog_deg?: number | null }): { mode: RotMode; deg: number } {
  if (typeof s.heading_deg === "number" && Number.isFinite(s.heading_deg)) return { mode: "heading", deg: s.heading_deg };
  if (typeof s.cog_deg === "number" && Number.isFinite(s.cog_deg)) return { mode: "cog", deg: s.cog_deg };
  return { mode: "none", deg: 0 };
}

export const ROT_LABEL: Record<RotMode, string> = { heading: "선수방위 기준", cog: "침로 기준(선수방위 없음)", none: "방향 모름" };

/** 지도 source("ships") FeatureCollection. nowMs = 서버 기준 현재 시각(STALE 판정). */
export function shipFeatures(ships: Iterable<ShipLite>, selected: string | null, nowMs: number): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
  for (const s of ships) {
    const r = shipRotation(s);
    const age = shipAgeS(s.seen_at, nowMs);
    features.push({
      type: "Feature", id: s.mmsi,
      properties: {
        mmsi: s.mmsi, name: s.name, cat: shipCategory(s.ship_type), rot_mode: r.mode, rot: r.deg,
        stale: age != null && age > SHIP_STALE_S, age_unknown: age == null, pos_src: s.position_source, selected: s.mmsi === selected,
      },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** 관측 시각(seen_at)이 더 새로운 쪽. 같거나 비교할 수 없으면 앞의 것 */
function newerLite<T extends ShipLite>(a: T | null, b: T | null): T | null {
  if (!a || !b) return a ?? b;
  const ta = a.seen_at ? Date.parse(a.seen_at) : NaN, tb = b.seen_at ? Date.parse(b.seen_at) : NaN;
  return !Number.isNaN(tb) && (Number.isNaN(ta) || tb > ta) ? b : a;
}

/**
 * 선택 선박 표시(계약 v5 §B3 — 지도 source "ship-selected"): 격자 모드에서도 항상 그리고 선택 고리 + 라벨(이름, 모르면 MMSI)을 줌과 무관하게 단다.
 * - symbolDraws(점 모드에서 선박 기호가 이미 그림 — 목록 사본에 있고 선종 필터로 숨지 않음): 그 위치에 고리·라벨만(icon false — 기호와 어긋나지 않게).
 * - 그 밖: ship_selected 상태와 목록 사본 중 관측이 가장 새로운 위치에 아이콘까지(icon true).
 * 위치를 모르면(실시간 아님) 아무것도 그리지 않는다 — 마지막 저장 위치를 지금 위치처럼 그리지 않는다.
 */
export function selectedShipFeatures(
  mmsi: string | null, live: ShipLite | null, listed: ShipLite | null, symbolDraws: boolean, nowMs: number, staticName: string | null = null,
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const empty: GeoJSON.FeatureCollection<GeoJSON.Point> = { type: "FeatureCollection", features: [] };
  if (!mmsi) return empty;
  const l = listed?.mmsi === mmsi ? listed : null, v = live?.mmsi === mmsi ? live : null;
  const icon = !(symbolDraws && l);
  const pos = icon ? newerLite(v, l) : l;
  if (!pos) return empty;
  const r = shipRotation(pos);
  const age = shipAgeS(pos.seen_at, nowMs);
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature", id: mmsi,
      properties: {
        mmsi, label: pos.name ?? staticName ?? mmsi, cat: shipCategory(pos.ship_type), rot_mode: r.mode, rot: r.deg, icon,
        stale: age != null && age > SHIP_STALE_S, age_unknown: age == null, selected: true,
      },
      geometry: { type: "Point", coordinates: [pos.lon, pos.lat] },
    }],
  };
}

/** 격자 칸 수 라벨(1 234 → "1.2k") */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

// ---- 선종 필터(계약 v5 §B3) ----

/** 선종 필터를 적용한 칸: count = 보이는 선종의 수, all = 서버가 보낸 칸 전체 수, unfiltered = 선종별 수가 없어 필터를 적용하지 못함 */
export interface FilteredGridCell extends ShipGridCell { all: number; unfiltered: boolean; hidden: ReadonlySet<ShipCategory> }

/**
 * 격자 칸을 선종 필터로 다시 센다(계약 v5 §B3): 선종별 수(B2)가 있으면 켜진 선종의 합, 0 이면 칸을 그리지 않고,
 * 색(가장 많은 선종)도 켜진 선종 중에서 다시 고른다(같으면 SHIP_CATEGORIES 순서의 앞 — 서버와 같은 규칙).
 * 선종별 수가 없는 칸(구 서버)은 셀 수 없으므로 그대로 두고 unfiltered 로 밝힌다(추정해서 줄이지 않는다). 모두 켜져 있으면 서버 값 그대로.
 * total = 그리는 칸 수의 합, allTotal = 필터 전 합, active = 꺼진 선종이 있음.
 */
export function filterGridCells(cells: readonly ShipGridCell[], enabled: ReadonlySet<ShipCategory>): {
  cells: FilteredGridCell[]; total: number; allTotal: number; unfilteredCells: number; active: boolean;
} {
  const hidden = new Set(SHIP_CATEGORIES.filter((c) => !enabled.has(c)));
  const active = hidden.size > 0;
  const out: FilteredGridCell[] = [];
  let total = 0, allTotal = 0, unfilteredCells = 0;
  for (const c of cells) {
    allTotal += c.count;
    if (!active) { out.push({ ...c, all: c.count, unfiltered: false, hidden }); total += c.count; continue; }
    if (!c.counts) { out.push({ ...c, all: c.count, unfiltered: true, hidden }); total += c.count; unfilteredCells++; continue; }
    let n = 0, best = -1;
    SHIP_CATEGORIES.forEach((cat, i) => {
      if (!enabled.has(cat)) return;
      n += c.counts![i];
      if (c.counts![i] > 0 && (best < 0 || c.counts![i] > c.counts![best])) best = i;
    });
    if (n === 0) continue;
    out.push({ ...c, count: n, category: SHIP_CATEGORIES[best], all: c.count, unfiltered: false, hidden });
    total += n;
  }
  return { cells: out, total, allTotal, unfilteredCells, active };
}

/** 칸 툴팁의 선종별 수 "화물선 3(숨김) · 유조선·탱커 1" — 0 인 선종은 빼고, 꺼진 선종은 (숨김). 선종별 수가 없으면 "" */
function gridBreakdown(c: ShipGridCell & { hidden?: ReadonlySet<ShipCategory> }): string {
  if (!c.counts) return "";
  return SHIP_CATEGORIES.map((cat, i) => [cat, c.counts![i]] as const).filter(([, n]) => n > 0)
    .map(([cat, n]) => `${SHIP_CATEGORY_LABEL[cat]} ${n.toLocaleString("en-US")}${c.hidden?.has(cat) ? "(숨김)" : ""}`).join(" · ");
}

export function gridFeatures(cells: readonly (ShipGridCell | FilteredGridCell)[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: cells.map((c) => ({
      type: "Feature",
      properties: {
        count: c.count, label: fmtCount(c.count), cat: c.category,
        all: "all" in c ? c.all : c.count, unfiltered: "unfiltered" in c ? c.unfiltered : false, breakdown: gridBreakdown(c),
      },
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    })),
  };
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** 달마다 가장 긴 날 수(2월은 윤년의 29 — 연도가 없어 2월 29일 입력도 받는다) */
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * 선원 ETA(월·일·시·분 — 입력 형식은 UTC 벽시계, 계약 v2 §B4) → 한국 표준시 "MM-DD HH:MM KST". 날짜는 달력으로만 넘긴다(+9 h 로 다음 날이면 그 달의 날 수로).
 * 2월 28일 입력 15:00 이후(KST 로 다음 날)는 연도(윤년)를 몰라 다음 날이 02-29 인지 03-01 인지 정할 수 없다 — 둘 다 적는다(고르지 않는다).
 * 달력에 없는 날(04-31 등)·범위 밖 값은 null(바꾸지 않는다).
 */
function etaKst(mo: number, d: number, h: number, mi: number): string | null {
  if (![mo, d, h, mi].every(Number.isInteger) || mo < 1 || mo > 12 || d < 1 || d > MONTH_MAX_DAYS[mo - 1] || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  const hk = h + 9;
  if (hk < 24) return `${p2(mo)}-${p2(d)} ${p2(hk)}:${p2(mi)} KST`;
  const hm = `${p2(hk - 24)}:${p2(mi)}`;
  if (mo === 2 && d === 28) return `02-29 또는 03-01 ${hm} KST(연도 없어 윤년 모름)`;
  if (d < MONTH_MAX_DAYS[mo - 1]) return `${p2(mo)}-${p2(d + 1)} ${hm} KST`;
  return `${p2(mo === 12 ? 1 : mo + 1)}-01 ${hm} KST`;
}

/**
 * ETA(계약 v2 §B4): 선원이 입력한 월·일·시·분(연도 없음 — 입력 형식은 UTC 벽시계). 화면은 한국 표준시로 바꿔 적는다(계약 v5 §G19 — 화면에 UTC 를
 * 적지 않는다): "09-30 15:05 KST · 선원 입력 · 연도 없음". 네 값이 모두 없으면 "—". 연도를 붙이거나 올해/내년을 추측하지 않는다.
 * 바꿀 수 없는 입력(달력에 없는 날 — 04-31 등)은 시각을 보이지 않고 그 입력 날짜만 밝힌다(KST 로 바꿀 수 없는 시각을 지어내지 않는다).
 */
export function fmtShipEta(st: Pick<ShipStatic, "eta_month" | "eta_day" | "eta_hour" | "eta_minute"> | null | undefined): string {
  if (!st || st.eta_month == null || st.eta_day == null || st.eta_hour == null || st.eta_minute == null) return "—";
  const kst = etaKst(st.eta_month, st.eta_day, st.eta_hour, st.eta_minute);
  return kst ? `${kst} · 선원 입력 · 연도 없음` : `— (선원 입력 날짜 ${p2(st.eta_month)}-${p2(st.eta_day)} 이 달력에 없음 — KST 로 바꿀 수 없음, 연도 없음)`;
}

/**
 * 크기(보고값): 길이 = A+B, 폭 = C+D(안테나 기준 거리 합). 두 값 중 하나라도 없거나 합이 0(ITU 기본값 = 모름)이면 그 치수는 "—".
 */
export function fmtShipSize(st: Pick<ShipStatic, "dim_a" | "dim_b" | "dim_c" | "dim_d"> | null | undefined): string {
  if (!st) return "—";
  const len = st.dim_a != null && st.dim_b != null && st.dim_a + st.dim_b > 0 ? st.dim_a + st.dim_b : null;
  const beam = st.dim_c != null && st.dim_d != null && st.dim_c + st.dim_d > 0 ? st.dim_c + st.dim_d : null;
  if (len == null && beam == null) return "—";
  return `${len ?? "—"} × ${beam ?? "—"} m · 보고값`;
}

/** 흘수(보고값, 0.1 m 단위). 0 = 모름(기본값), 25.5 = 25.5 m 이상(USCG NAVCEN). */
export function fmtDraught(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m) || m <= 0) return "—";
  return m >= 25.5 ? "25.5 m 이상 · 보고값" : `${m.toFixed(1)} m · 보고값`;
}

/** 항해 상태(USCG NAVCEN 0–15). 15 = 미정의(기본값 — 선박이 입력하지 않음). */
export const NAV_STATUS_LABEL: readonly string[] = [
  "기관 사용 항해 중", "묘박(닻)", "조종 불능", "조종 제한", "흘수 제약", "계류", "좌초", "어로 중",
  "범주(돛) 항해 중", "예약(고속선 위험물)", "예약(WIG 위험물)", "선미 예인 중(지역 용도)", "밀거나 옆에 붙여 예인 중(지역 용도)", "예약", "AIS-SART·MOB·EPIRB 작동", "미정의(기본값)",
];
export function navStatusLabel(v: number | null | undefined): string {
  if (v == null || !Number.isInteger(v) || v < 0 || v > 15) return "—";
  return v === 15 ? "— (15 · 미정의, 선박 미입력)" : `${NAV_STATUS_LABEL[v]} (${v})`;
}

/** 좁은 표 칸용 줄임(같은 USCG 0–15 표 — 코드와 전체 이름은 title 로 navStatusLabel) */
export const NAV_STATUS_SHORT: readonly string[] = [
  "기관 항해", "묘박", "조종 불능", "조종 제한", "흘수 제약", "계류", "좌초", "어로 중",
  "범주 항해", "예약(HSC)", "예약(WIG)", "선미 예인", "밀어 예인", "예약", "SART·MOB·EPIRB", "미정의",
];
export function navStatusShort(v: number | null | undefined): string {
  if (v == null || !Number.isInteger(v) || v < 0 || v > 15) return "—";
  return NAV_STATUS_SHORT[v];
}

export const POSITION_SOURCE_LABEL: Record<PositionSource, string> = {
  epfs: "전자 위치 장치(EPFS) · 선박 보고",
  estimated: "선박 추측항법 — 선박이 보고한 추정 위치",
  manual: "수동 입력 위치(선박 보고)",
  inoperative: "위치 장비 비작동 — 위치를 믿기 어려움",
};
/** 카드의 위치 출처 칸: 모르면(null) "—" */
export function positionSourceLabel(src: PositionSource | null | undefined): string {
  return src ? POSITION_SOURCE_LABEL[src] : "—";
}
/** IMO 칸: 10,000,000 이상은 IMO 번호가 아니라 기국 공식 번호(같은 AIS 필드). 값이 없으면 이름 "IMO", 값 "—". */
export function imoField(imo: number | null | undefined): { label: string; value: string } {
  if (imo == null) return { label: "IMO", value: "—" };
  return { label: imo >= FLAG_STATE_NO_MIN ? "기국 공식 번호" : "IMO", value: String(imo) };
}
/** 위치 출처 배지(계약 v2 §B4: estimated/manual → 추정/수동). epfs·모름은 배지 없음. */
export function positionBadge(src: PositionSource | null | undefined): { text: string; tone: Tone } | null {
  if (src === "estimated") return { text: "추정 위치", tone: "est" };
  if (src === "manual") return { text: "수동 위치", tone: "est" };
  if (src === "inoperative") return { text: "위치 장비 비작동", tone: "warn" };
  return null;
}

export function fmtShipType(code: number | null | undefined): string {
  if (code == null) return "— (미보고)";
  const c = shipCategory(code);
  return `${code} · ${SHIP_CATEGORY_LABEL[c]}`;
}

/** 침로/선수방위 "123.4° / 120°" — 각 값이 없으면 "—". 속력은 두 단위로 따로(format.ts fmtSogDual, 계약 v5 §A1) */
export function fmtCourse(s: { cog_deg?: number | null; heading_deg?: number | null } | null | undefined): string {
  const f = (v: number | null | undefined, d: number) => (v == null ? "—" : `${v.toFixed(d)}°`);
  return `${f(s?.cog_deg, 1)} / ${f(s?.heading_deg, 0)}`;
}

// ---- 출발지·목적지(보고) 풀이(계약 v4 §B) ----
// AIS 에는 출발지 항목이 없고, 목적지는 선원이 입력한 자유 문자열이다. api 가 결정적 규칙으로만 풀이한 destination_info 를 그대로 보인다
// (A>B → 보고된 출발 A·도착 B, >B → 도착 B, A<>B·A<=>B → 왕복, 그 밖 → 원문). 웹은 다시 풀이하지 않는다.

export const DEST_KINDS = ["from_to", "to", "text", "between"] as const;
export type DestKind = (typeof DEST_KINDS)[number];
const DEST_KIND_SET: ReadonlySet<string> = new Set(DEST_KINDS);
/** 조각 하나(UN/LOCODE 로 풀었으면 locode·name·country) */
export interface DestPlace { text: string; locode: string | null; name: string | null; country: string | null; subdivision: string | null; ambiguous: boolean }
export interface DestinationInfo { raw: string; kind: DestKind; from: DestPlace | null; to: DestPlace | null; places: DestPlace[] }

const LOCODE_RE = /^[A-Z]{2} ?[A-Z0-9]{3}$/;
/** 조각 수 상한(api 는 A>B 에서 2개까지) */
const DEST_PLACES_MAX = 4;
export const NO_ORIGIN_TEXT = "— AIS 에는 출발지 항목이 없습니다";
export const AMBIGUOUS_TEXT = "코드로 읽은 값 · 같은 글자의 지명도 있음";

function parseDestPlace(v: unknown): DestPlace | null {
  if (!isObj(v)) return null;
  const text = str(v.text, 64);
  if (!text) return null;
  const locode = typeof v.locode === "string" && LOCODE_RE.test(v.locode) ? v.locode : null;
  return {
    text, locode,
    // 풀이(이름·국가)는 UN/LOCODE 로 읽었을 때만 의미가 있다
    name: locode ? str(v.name, 80) : null,
    country: locode ? str(v.country, 80) : null,
    subdivision: locode ? str(v.subdivision, 16) : null,
    ambiguous: locode != null && v.ambiguous === true,
  };
}

/** REST /ships/{mmsi} · WS ship_selected 의 destination_info. 모양이 틀리면 null(원문만 보인다). */
export function parseDestinationInfo(v: unknown): DestinationInfo | null {
  if (!isObj(v) || typeof v.kind !== "string" || !DEST_KIND_SET.has(v.kind)) return null;
  const raw = str(v.raw, 64);
  if (!raw) return null;
  const places: DestPlace[] = [];
  for (const p of Array.isArray(v.places) ? v.places.slice(0, DEST_PLACES_MAX) : []) { const q = parseDestPlace(p); if (q) places.push(q); }
  return { raw, kind: v.kind as DestKind, from: parseDestPlace(v.from), to: parseDestPlace(v.to), places };
}

/** 비교용 정규화(api 규칙과 같게): 대문자 · 앞뒤 공백·AIS 채움 문자(@) 제거 · 연속 공백 하나로 */
export function normalizeDestination(s: string | null | undefined): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/@+$/g, "").trim().replace(/\s+/g, " ").toUpperCase();
  return t.length ? t : null;
}

/**
 * 보이는 목적지 원문(static.destination)과 같은 원문을 풀이한 destination_info 만 고른다(앞의 것 우선 — WS 가 REST 보다 새롭다).
 * 원문이 다르면(정적 정보가 바뀐 직후 등) 풀이를 쓰지 않는다 — 다른 목적지의 풀이를 붙이지 않는다.
 */
export function pickDestinationInfo(rawDestination: string | null | undefined, ...candidates: (DestinationInfo | null | undefined)[]): DestinationInfo | null {
  const want = normalizeDestination(rawDestination);
  if (!want) return null;
  return candidates.find((c): c is DestinationInfo => c != null && normalizeDestination(c.raw) === want) ?? null;
}

/** 조각 풀이: "이름 · 국가 · UN/LOCODE 코드"(+ 같은 글자의 지명이 있으면 그 사실). UN/LOCODE 로 못 읽었으면 원문 조각 그대로라고 적는다. */
export function fmtDestPlace(p: DestPlace): string {
  if (!p.locode) return `${p.text} · UN/LOCODE 풀이 없음(원문 그대로)`;
  return `${p.name ?? "—"} · ${p.country ?? "—"} · UN/LOCODE ${p.locode}${p.ambiguous ? ` · ${AMBIGUOUS_TEXT}` : ""}`;
}

/** 카드 "출발지(보고)": A>B 일 때만 A 풀이. 원문을 모르면 "—", 그 밖은 AIS 에 출발지 항목이 없다고 적는다. */
export function shipOriginText(info: DestinationInfo | null, rawDestination: string | null | undefined): string {
  if (info?.kind === "from_to") {
    const a = info.from ?? info.places[0] ?? null;
    return a ? fmtDestPlace(a) : "—";
  }
  if (info) return NO_ORIGIN_TEXT;
  // 풀이가 없으면 원문에 출발지가 적혀 있는지 모른다(원문이 없을 때만 확실히 없다)
  return normalizeDestination(rawDestination) == null ? NO_ORIGIN_TEXT : "—";
}

/** 카드 "목적지(보고)": 원문 + 풀이 줄. 원문이 없으면 raw null. */
export function shipDestinationLines(info: DestinationInfo | null, rawDestination: string | null | undefined): { raw: string | null; lines: string[] } {
  const raw = str(rawDestination ?? null, 64);
  if (!raw) return { raw: null, lines: [] };
  if (!info) return { raw, lines: [] };
  if (info.kind === "between") {
    const a = info.places[0] ?? info.from, b = info.places[1] ?? info.to;
    const label = (p: DestPlace) => (p.locode && p.name ? p.name : p.text);
    const lines: string[] = [];
    if (a && b) lines.push(`${label(a)} ↔ ${label(b)} 왕복(보고)`);
    for (const p of [a, b]) if (p) lines.push(fmtDestPlace(p));
    return { raw, lines };
  }
  const target = info.to ?? (info.kind === "text" ? info.places[0] ?? null : info.kind === "from_to" ? info.places[1] ?? null : info.places[0] ?? null);
  if (!target) return { raw, lines: [] };
  // 원문 전체가 풀리지 않은 한 조각이면 같은 글자를 다시 쓰지 않는다
  if (!target.locode && normalizeDestination(target.text) === normalizeDestination(raw)) return { raw, lines: ["UN/LOCODE 풀이 없음 — 원문 그대로"] };
  return { raw, lines: [fmtDestPlace(target)] };
}

// ---- AIS 상태(status.sources.ais) ----

/** scope: 구역 공백이면 그 구역의 상자(계약 v4 §D · §G) — 없으면 모든 선박에 적용 */
export interface AisGap { started_at: string; ended_at: string | null; reason: string | null; scope?: AisBox[] }
/** ais 수집기 상태(계약 v3 §A, 상태 해시 state). 그 밖의 값·heartbeat 가 오래된 경우는 null(모름). */
export const AIS_STATES = ["starting", "connecting", "subscribed", "receiving", "backoff", "replaying", "disabled", "stopped"] as const;
export type AisState = (typeof AIS_STATES)[number];
const AIS_STATE_SET: ReadonlySet<string> = new Set(AIS_STATES);
/** 수신 범위 상자 하나(도). 모서리 순서와 상관없이 남·서·북·동으로 정리한 값 */
export interface AisBox { s: number; w: number; n: number; e: number }
export interface AisStatus {
  connected: boolean | null;
  lag_s: number | null;
  msgs_per_s: number | null;
  gap_open_since: string | null;
  last_gap: AisGap | null;
  state: AisState | null;
  /** 운영 설정 수신 범위(status.sources.ais.coverage). 없거나 형식이 틀리면 null — 그리지 않는다 */
  coverage: AisBox[] | null;
  /** 구역별 연결(계약 v4 §D, status.sources.ais.shards). 없거나 형식이 틀리면 null — 합계 필드만 쓴다 */
  shards?: AisShard[] | null;
  /** 이 상태를 만든 서버 시각(status.server_time, ms). 모르면 null — 구역 관측 시각(항적 공백 가르기)에 쓴다 */
  server_ms?: number | null;
  received_at: number;
}

/** 수신 구역 하나(연결 하나). coverage 가 null 이면 그 구역의 범위를 모른다. */
export interface AisShard { coverage: AisBox[] | null; state: AisState | null; connected: boolean | null; gap_open_since: string | null }
/** 구역 수 상한(계약 v4 §D: 공급자의 키당 연결 수 3) */
export const AIS_SHARDS_MAX = 3;

/** status.sources.ais.shards → 구역 목록. 배열이 아니거나 0개·4개 이상이거나 객체가 아닌 원소가 있으면 null("n/m 구역"의 m 을 틀리게 말하지 않는다). */
export function parseAisShards(v: unknown): AisShard[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > AIS_SHARDS_MAX) return null;
  const out: AisShard[] = [];
  for (const x of v) {
    if (!isObj(x)) return null;
    out.push({
      coverage: parseAisCoverage(x.coverage),
      state: typeof x.state === "string" && AIS_STATE_SET.has(x.state) ? (x.state as AisState) : null,
      connected: typeof x.connected === "boolean" ? x.connected : null,
      gap_open_since: iso(x.gap_open_since),
    });
  }
  return out;
}

/** 구역 이름(툴팁): 상자들을 운영 설정 문법(lat1,lon1,lat2,lon2;…)으로. 모르면 "범위 모름" */
export function fmtShardScope(sh: AisShard): string {
  return sh.coverage?.length ? sh.coverage.map((b) => `${b.s},${b.w},${b.n},${b.e}`).join(";") : "범위 모름";
}

export function parseAisGap(v: unknown): AisGap | null {
  if (!isObj(v)) return null;
  const started = iso(v.started_at);
  if (!started) return null;
  const g: AisGap = { started_at: started, ended_at: iso(v.ended_at), reason: str(v.reason, 64) };
  const scope = parseScopeText(v.scope);
  if (scope) g.scope = scope; // 형식이 틀리면 구역 없음(모든 선박에 적용 — 좁혀 추정하지 않는다)
  return g;
}

/** 구역 하나의 상자 문자열 "lat1,lon1,lat2,lon2;…"(계약 v4 §D, '|' 없음) → 상자. 틀리면 null */
export function parseScopeText(v: unknown): AisBox[] | null {
  if (typeof v !== "string" || !v || v.length > 1024 || v.includes("|")) return null;
  const boxes = v.split(";").map((b) => b.trim()).filter(Boolean).map((b) => b.split(",").map((x) => (/^-?\d{1,3}(\.\d{1,6})?$/.test(x.trim()) ? Number(x) : NaN)));
  return parseAisCoverage(boxes);
}

/** 이 공백이 이 위치의 선박에 해당하는가: 구역 공백은 그 구역 상자 안일 때만, 구역 없는 공백·위치 모름은 해당한다 */
export function gapAppliesTo(g: AisGap, pos: { lat: number; lon: number } | null | undefined): boolean {
  if (!g.scope || !pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) return true;
  return inCoverage(g.scope, pos.lat, pos.lon);
}

/** status 객체에서 AIS 상태(계약 v2 §B3: status 에 sources.ais). 없으면 null(ais 수집기 없음/구버전 api). */
export function parseAisStatus(status: unknown, receivedAt: number): AisStatus | null {
  if (!isObj(status)) return null;
  const src = isObj(status.sources) ? status.sources.ais : status.ais;
  if (!isObj(src)) return null;
  const serverTime = iso(status.server_time);
  return {
    connected: typeof src.connected === "boolean" ? src.connected : null,
    lag_s: num(src.lag_s, 0, 1e9),
    msgs_per_s: num(src.msgs_per_s, 0, 1e6),
    gap_open_since: iso(src.gap_open_since),
    last_gap: parseAisGap(src.last_gap),
    state: typeof src.state === "string" && AIS_STATE_SET.has(src.state) ? (src.state as AisState) : null,
    coverage: parseAisCoverage(src.coverage),
    shards: parseAisShards(src.shards),
    server_ms: serverTime == null ? null : Date.parse(serverTime),
    received_at: receivedAt,
  };
}

/** 수신 범위 상자 수 상한(계약 v3 §A: 1~16개) */
export const AIS_COVERAGE_MAX_BOXES = 16;

/**
 * status.sources.ais.coverage = [[lat1, lon1, lat2, lon2], ...] → 상자 목록. 두 모서리는 어느 순서여도 된다(남·북·서·동으로 정리).
 * 상자가 0개·17개 이상이거나 하나라도 형식·범위가 틀리거나 넓이가 0이면 전체를 null(일부만 그려 범위를 잘못 보이지 않는다).
 * 날짜변경선을 넘는 상자는 모서리 순서로 구별할 수 없으므로 서→동(작은 경도→큰 경도)으로만 읽는다.
 */
export function parseAisCoverage(v: unknown): AisBox[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > AIS_COVERAGE_MAX_BOXES) return null;
  const out: AisBox[] = [];
  for (const b of v) {
    if (!Array.isArray(b) || b.length !== 4) return null;
    const lat1 = num(b[0], -90, 90), lon1 = num(b[1], -180, 180), lat2 = num(b[2], -90, 90), lon2 = num(b[3], -180, 180);
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null || lat1 === lat2 || lon1 === lon2) return null;
    out.push({ s: Math.min(lat1, lat2), w: Math.min(lon1, lon2), n: Math.max(lat1, lat2), e: Math.max(lon1, lon2) });
  }
  return out;
}

/** 웹 메르카토르가 그리는 위도 한계 — 이 너머의 가로 경계는 화면에 없다 */
const MERC_MAX_LAT = 85.0511;
const EDGE_EPS = 1e-6;

/** 점이 수신 범위 안인가(경도는 ±180 에서 이어진다, 극 너머는 경계가 아니므로 안으로 친다) */
function inCoverage(boxes: readonly AisBox[], lat: number, lon: number): boolean {
  if (lat > 90 || lat < -90) return true;
  const x = lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon;
  return boxes.some((b) => lat >= b.s && lat <= b.n && x >= b.w && x <= b.e);
}

/**
 * 수신 범위 경계선(지도 source "ship-coverage"): 상자들의 합집합 바깥 경계만 선분으로. 상자끼리 맞닿거나 겹친 변,
 * ±180°에서 이어지는 변(예: 운영 설정 -90,-180,90,0;-90,45,90,180 의 날짜변경선), 극 쪽 변은 경계가 아니므로 그리지 않는다.
 * null·빈 목록이면 빈 FeatureCollection.
 */
export function aisCoverageFeatures(boxes: readonly AisBox[] | null): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  if (!boxes?.length) return { type: "FeatureCollection", features };
  const lats = [...new Set(boxes.flatMap((b) => [b.s, b.n]))].sort((a, b) => a - b);
  const lons = [...new Set(boxes.flatMap((b) => [b.w, b.e]))].sort((a, b) => a - b);
  const seen = new Set<string>();
  const emit = (coords: [number, number][]) => {
    const k = JSON.stringify(coords);
    if (seen.has(k)) return;
    seen.add(k);
    features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } });
  };
  /** 한 변을 다른 상자의 모서리 값으로 나눠, 바깥쪽이 범위 밖인 조각만 이어서 낸다 */
  const edge = (from: number, to: number, cuts: number[], outside: (mid: number) => boolean, at: (v: number) => [number, number]) => {
    const pts = [from, ...cuts.filter((c) => c > from && c < to), to];
    let run: number | null = null;
    const flush = (end: number) => {
      if (run == null) return;
      const a = at(run), b = at(end);
      if (a[0] !== b[0] || a[1] !== b[1]) emit([a, b]);
      run = null;
    };
    for (let i = 0; i + 1 < pts.length; i++) {
      if (outside((pts[i] + pts[i + 1]) / 2)) { if (run == null) run = pts[i]; } else flush(pts[i]);
    }
    flush(to);
  };
  const clampLat = (lat: number) => Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, lat));
  for (const b of boxes) {
    for (const [lon, dir] of [[b.w, -1], [b.e, 1]] as const) {
      edge(b.s, b.n, lats, (lat) => !inCoverage(boxes, lat, lon + dir * EDGE_EPS), (lat) => [lon, clampLat(lat)]);
    }
    for (const [lat, dir] of [[b.s, -1], [b.n, 1]] as const) {
      if (Math.abs(lat) > MERC_MAX_LAT) continue;
      edge(b.w, b.e, lons, (lon) => !inCoverage(boxes, lat + dir * EDGE_EPS, lon), (lon) => [lon, lat]);
    }
  }
  return { type: "FeatureCollection", features };
}

/** 끝난 공백을 상태 바에 남기는 시간(계약 v2 §B4) */
export const AIS_GAP_SHOW_MS = 30 * 60_000;
/** AIS 지연 경고 기준 — ais 컨테이너 health 기준(마지막 메시지 120 s, 계약 v2 §B1)과 같게 */
export const AIS_LAG_WARN_S = 120;

/** 구역 하나의 연결 상태 문구(툴팁): 연결 · 끊김(재연결 중) · 연결 모름 — 수집기가 보고한 값만 */
function shardConnText(sh: AisShard): string {
  if (sh.connected === true) return "연결";
  if (sh.connected === false) return `끊김${sh.state === "connecting" || sh.state === "backoff" ? "(재연결 중)" : ""}`;
  return "연결 모름";
}

/**
 * 상태 바 AIS 배지: "AIS · 5.4 msg/s · lag 3s". 지연은 서버 보고값 — 연결이 실시간(live)이 아니거나 받은 지 45 s 가 넘으면
 * 받은 뒤 경과를 더한다(화면 데이터가 그 뒤로 새로워졌다는 근거가 없으므로). AIS 상태를 받은 적이 없으면 null.
 * 수집기 state(계약 v3 §A): disabled(키 없음) → 중립 "AIS 꺼짐 · 키 없음"(끊김·재연결이 아니다). 끊김은 "AIS 끊김" —
 * "재연결 중(지수 백오프)"은 state 가 connecting·backoff 일 때만 말한다(모르면 말하지 않는다).
 */
export function aisBadge(ais: AisStatus | null, nowMs: number, live: boolean): { text: string; tone: "ok" | "warn" | "bad" | "muted"; title: string } | null {
  if (!ais) return null;
  if (ais.state === "disabled") {
    return { text: "AIS 꺼짐 · 키 없음", tone: "muted", title: "ais 수집기에 aisstream.io 키가 설정되지 않아 선박을 받지 않습니다(운영 설정 — 끊김이 아님)" };
  }
  // 구역이 여럿이고 일부만 끊겼으면(계약 v4 §D: 합계 connected = 모든 구역 연결) 전체 끊김이라고 하지 않는다
  const shards = ais.shards && ais.shards.length > 1 ? ais.shards : null;
  const down = shards ? shards.filter((sh) => sh.connected === false).length : 0;
  const partial = shards != null && down > 0 && shards.some((sh) => sh.connected === true);
  if (ais.connected === false && !partial) {
    const retrying = ais.state === "connecting" || ais.state === "backoff";
    const why = retrying ? " — 재연결 중(지수 백오프)" : ` — 수집기 상태 ${ais.state ?? "모름"}`;
    return { text: "AIS 끊김", tone: "bad", title: `AIS 수집기가 aisstream.io 에 연결되어 있지 않음${why}` };
  }
  const elapsed = nowMs ? Math.max(0, (nowMs - ais.received_at) / 1000) : 0;
  const lag = ais.lag_s == null ? null : live && elapsed <= RX_FRESH_MS / 1000 ? ais.lag_s : ais.lag_s + elapsed;
  const rate = ais.msgs_per_s == null ? "msg/s —" : `${ais.msgs_per_s.toFixed(1)} msg/s`;
  const lagText = lag == null ? "lag —" : `lag ${Math.round(lag)}s`;
  const title = `AIS(aisstream.io) 수신 상태 — 지연 = 마지막 메시지 이후 경과(경고 > ${AIS_LAG_WARN_S} s)`;
  if (partial) {
    return {
      text: `AIS 일부 끊김 ${down}/${shards!.length} 구역 · ${rate} · ${lagText}`,
      tone: "warn",
      title: `${title}\n${shards!.map((sh, i) => `구역 ${i + 1} ${fmtShardScope(sh)} — ${shardConnText(sh)}`).join("\n")}`,
    };
  }
  const tone = ais.connected == null || lag == null || lag > AIS_LAG_WARN_S ? "warn" : "ok";
  return { text: `AIS${ais.connected == null ? " 연결 모름" : ""} · ${rate} · ${lagText}`, tone, title };
}

/** 열린 공백이 있는 구역 수(구역이 둘 이상일 때만 — 하나면 합계와 같다) */
export function openGapShards(ais: Pick<AisStatus, "shards"> | null): { open: AisShard[]; total: number } | null {
  const shards = ais?.shards;
  if (!shards || shards.length < 2) return null;
  return { open: shards.filter((sh) => sh.gap_open_since != null), total: shards.length };
}

/**
 * 상태 바 공백 배지(분까지 — KST, 계약 v5 §G19): 열린 공백 → "AIS 공백 08:40 KST 부터 · 진행 중",
 * 30분 안에 끝난 공백 → "AIS 공백 08:20–08:25 KST". 그 밖은 null. 툴팁은 날짜 · 초까지의 KST 구간.
 * 구역이 여럿이고 일부만 공백이면(계약 v4 §D) "AIS 공백 n/m 구역" — 툴팁에 공백 구역·시작 시각, 나머지 구역은 보고된 연결 상태 그대로
 * (연결·끊김·연결 모름 — 공백이 없다고 "수신 중"이라고 말하지 않는다).
 */
export function aisGapBadge(ais: AisStatus | null, nowMs: number): { text: string; open: boolean; partial?: boolean; title: string } | null {
  if (!ais) return null;
  const sg = openGapShards(ais);
  if (sg && sg.open.length > 0 && sg.open.length < sg.total) {
    const lines = ais.shards!.map((sh, i) => `구역 ${i + 1} ${fmtShardScope(sh)} — ${
      sh.gap_open_since ? `공백 ${fmtKst(sh.gap_open_since)} 부터` : `공백 없음 · ${shardConnText(sh)}`}`);
    return {
      text: `AIS 공백 ${sg.open.length}/${sg.total} 구역`, open: true, partial: true,
      title: `${lines.join("\n")}\n공백 구역 안 선박 위치는 멈춰 있고, 재전송이 없어 그 구간은 비어 있게 됩니다`,
    };
  }
  if (ais.gap_open_since) {
    const all = sg && sg.open.length === sg.total ? ` · 모든 구역(${sg.total}개)` : "";
    return { text: `AIS 공백 ${fmtKstFrom(ais.gap_open_since)} · 진행 중`, open: true, title: `AIS 수신이 ${fmtKst(ais.gap_open_since)} 부터 끊겨 있음${all} — 재전송이 없어 이 구간 선박 위치는 비어 있게 됩니다` };
  }
  const g = ais.last_gap;
  if (!g || !g.ended_at || !nowMs) return null;
  const end = Date.parse(g.ended_at);
  if (Number.isNaN(end) || nowMs - end > AIS_GAP_SHOW_MS) return null;
  // 끝난 공백은 상태에 구역이 없다 — 구역이 여럿이면 그렇다고 적는다(모든 구역이라고 말하지 않는다)
  const scope = sg ? ` · 어느 구역의 공백인지는 상태에 없음(구역 ${sg.total}개)` : "";
  return { text: `AIS 공백 ${fmtKstSpan(g.started_at, g.ended_at)}`, open: false, title: `AIS 수신 공백 ${fmtKstRange(g.started_at, g.ended_at)}${g.reason ? ` (${g.reason})` : ""} — 이 구간 선박 위치 없음${scope}` };
}

// ---- 선택 선박 항적(REST + 실시간) ----

/** 이보다 긴 시간 틈은 선을 끊는다(계약 v2 §B3 track: time jumps > 15 min) */
export const TRACK_BREAK_MS = 15 * 60_000;
/** 선택 선박 항적 창 기본값 — REST ≤ 24 h(계약). 선박은 느려 6 h 면 대개 충분하고 60 s 에 1점이라 ≤ 360 점. */
export const SHIP_TRACK_WINDOW_MS = 6 * 3600_000;
/** 항적 기간 선택(계약 v5 §B3): 6 · 12 · 24 h — REST 상한 24 h(24 × 60 = 1,440 점) */
export const SHIP_TRACK_HOURS = [6, 12, 24] as const;
export type ShipTrackHours = (typeof SHIP_TRACK_HOURS)[number];
export const MAX_SHIP_TRACK_POINTS = 5000;

export interface ShipTrackSeg { pts: [number, number][]; startMs: number | null; endMs: number | null }
/**
 * 항적 점 하나(계약 v5 §B3 호버): REST points[] 의 값 그대로(속력·침로·선수방위·항해 상태 — 키가 없거나 범위 밖이면 null).
 * src: rest = 저장 기록(60 s 창의 첫 보고) · live = 선택한 뒤 WS 로 받은 관측.
 */
export interface ShipTrackPoint { ts: number; lon: number; lat: number; sog_kn: number | null; cog_deg: number | null; heading_deg: number | null; nav_status: number | null; src: "rest" | "live" }
/** gapsTruncated: 서버가 공백 목록을 잘랐거나(properties.gaps_truncated) 여기서 최신 MAX_TRACK_GAPS 개만 남겼음 — 개수는 하한. points: 호버용 점(있을 때만). */
export interface ShipTrack {
  segs: ShipTrackSeg[];
  gaps: AisGap[];
  gapsTruncated?: boolean;
  points?: ShipTrackPoint[];
}

/** 점의 부가 값(속력 0–102.2 kn · 침로/선수방위 0–359.9999° · 항해 상태 0–15) — 범위 밖·형식 오류는 null */
function trackPointDetail(p: Obj): Pick<ShipTrackPoint, "sog_kn" | "cog_deg" | "heading_deg" | "nav_status"> {
  return { sog_kn: num(p.sog_kn, 0, 102.2), cog_deg: num(p.cog_deg, 0, 359.9999), heading_deg: num(p.heading_deg, 0, 359.9999), nav_status: int(p.nav_status, 0, 15) };
}

/**
 * 선을 끊는 공백의 최소 길이(계약 v3 §D, api properties.gap_break_min_s = 60): 저장 간격이 60 s 라 더 짧은 수신 공백은
 * 저장점을 없애지 못한다. 열린 공백(ended_at null)은 길이와 상관없이 끊는다.
 */
export const GAP_BREAK_MIN_MS = 60_000;
/** 항적에 들고 있는 공백 수 상한(api 도 창과 겹치는 최신 200개만 준다) */
export const MAX_TRACK_GAPS = 200;

function coord(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const lon = num(v[0], -180, 180), lat = num(v[1], -90, 90);
  return lon == null || lat == null ? null : [lon, lat];
}

/** a–b 사이에 선을 끊는 공백(60 s 이상 끝난 공백 또는 열린 공백)이 있는가 */
function gapBetween(gaps: readonly AisGap[], a: number, b: number): boolean {
  for (const g of gaps) {
    const s = Date.parse(g.started_at);
    const e = g.ended_at ? Date.parse(g.ended_at) : Infinity;
    if (Number.isNaN(s) || Number.isNaN(e) || e - s < GAP_BREAK_MIN_MS) continue;
    if (s < b && e > a) return true;
  }
  return false;
}

/**
 * 공백 목록 정리: 같은 started_at 은 하나만(열린 공백은 자리표시라 같은 시작의 끝난 공백이 대신한다), 오래된 것부터 정렬,
 * 최신 max 개만. dropped = 넘쳐서 버린 것이 있음.
 */
export function normalizeGaps(gaps: readonly AisGap[], max = MAX_TRACK_GAPS): { gaps: AisGap[]; dropped: boolean } {
  const byStart = new Map<number, AisGap>();
  for (const g of gaps) {
    const t = Date.parse(g.started_at);
    if (Number.isNaN(t)) continue;
    const cur = byStart.get(t);
    if (!cur || (cur.ended_at == null && g.ended_at != null)) byStart.set(t, g);
  }
  const sorted = [...byStart.entries()].sort((x, y) => x[0] - y[0]).map(([, g]) => g);
  return { gaps: sorted.slice(-max), dropped: sorted.length > max };
}

/**
 * 이 위치의 선박에 해당하는 열린 공백(계약 v4 §D 항적 끊기: 구역 공백은 그 구역 상자 안 선박에만).
 * 구역이 둘 이상이고 모든 구역의 범위를 알며 위치를 알 때만 구역으로 가른다(scoped) — 그 위치를 덮는 구역들의 열린 공백 중 가장 이른 것.
 * 그 밖(구역 없음·범위 모름·위치 모름)은 합계 gap_open_since 그대로(기존 동작).
 */
export function statusOpenGapFor(ais: Pick<AisStatus, "gap_open_since" | "shards">, pos: { lat: number; lon: number } | null | undefined): { openSince: string | null; scoped: boolean } {
  const shards = ais.shards;
  if (!shards || shards.length < 2 || !pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lon) || shards.some((sh) => !sh.coverage?.length)) {
    return { openSince: ais.gap_open_since, scoped: false };
  }
  let best: string | null = null;
  for (const sh of shards) {
    if (!sh.gap_open_since || !inCoverage(sh.coverage!, pos.lat, pos.lon)) continue;
    if (best == null || Date.parse(sh.gap_open_since) < Date.parse(best)) best = sh.gap_open_since;
  }
  return { openSince: best, scoped: true };
}

/**
 * status.sources.ais 의 공백을 항적 공백 목록에 반영한다(선택 중에 생기거나 닫힌 공백). 바뀌었으면 true.
 * - 열린 공백(gap_open_since)은 자리표시: 같은 started_at 의 끝난 공백(last_gap)이 오면 대체되고,
 *   status 가 더 이상 그 공백이 열려 있다고 하지 않으면 뺀다 — 끝을 모르는 공백을 영원히 열어 두지 않는다.
 * - 구역이 여럿이면(계약 v4 §D) pos(선박 위치)를 덮는 구역의 열린 공백만 자리표시로 넣는다.
 * - 끝난 공백(REST 항적의 gaps · 상태의 last_gap)은 그 공백의 scope(구역 상자)가 이 선박 위치를 덮을 때만 — 구역 없는 공백은 모두에(계약 v4 §G).
 *   추정하지 않는다: 공백이 어느 구역의 것인지는 서버가 준 scope 로만 가른다.
 * - 항적 창(sinceMs) 전에 끝난 공백은 넣지 않는다. status 를 모르면(null) 그대로 둔다.
 */
export function mergeStatusGaps(track: ShipTrack, ais: Pick<AisStatus, "gap_open_since" | "last_gap" | "shards"> | null, sinceMs: number, pos?: { lat: number; lon: number } | null): boolean {
  if (!ais) return false;
  const { openSince } = statusOpenGapFor(ais, pos);
  const openMs = openSince ? Date.parse(openSince) : NaN;
  const next: AisGap[] = track.gaps.filter((g) => (g.ended_at != null ? gapAppliesTo(g, pos) : Date.parse(g.started_at) === openMs));
  const lg = ais.last_gap;
  if (lg && lg.ended_at && !(Date.parse(lg.ended_at) < sinceMs) && gapAppliesTo(lg, pos)) next.push(lg);
  if (openSince) next.push({ started_at: openSince, ended_at: null, reason: null });
  const r = normalizeGaps(next);
  const key = (gs: readonly AisGap[]) => gs.map((g) => `${Date.parse(g.started_at)}/${g.ended_at == null ? "open" : Date.parse(g.ended_at)}`).join(",");
  if (key(r.gaps) === key(track.gaps)) return false;
  track.gaps = r.gaps;
  if (r.dropped) track.gapsTruncated = true;
  return true;
}

/**
 * 카드 요약: 창 [fromMs, toMs] 와 겹치는 공백 수 · 끝난 공백이 창 안에서 차지한 길이 합(초) · 열린 공백이 있으면 그 시작(ms).
 * 창 밖으로 걸친 부분은 세지 않는다(창보다 먼저 시작한 공백을 통째로 더하면 '최근 6 h' 합계가 부풀려진다).
 */
export function gapSummary(gaps: readonly AisGap[], fromMs = -Infinity, toMs = Infinity): { count: number; closedS: number; openSinceMs: number | null } {
  let closed = 0;
  let count = 0;
  let openSinceMs: number | null = null;
  for (const g of gaps) {
    const s = Date.parse(g.started_at);
    if (Number.isNaN(s)) continue;
    if (g.ended_at == null) {
      if (s <= toMs) { openSinceMs = s; count++; }
      continue;
    }
    const e = Date.parse(g.ended_at);
    if (Number.isNaN(e) || e < fromMs || s > toMs) continue;
    count++;
    const clipped = Math.min(e, toMs) - Math.max(s, fromMs);
    if (clipped > 0) closed += clipped;
  }
  return { count, closedS: Math.round(closed / 1000), openSinceMs };
}

/** 한 공백의 길이(초). 열린 공백·모름은 null */
export function gapDurationS(g: AisGap): number | null {
  if (!g.ended_at) return null;
  const s = Date.parse(g.started_at), e = Date.parse(g.ended_at);
  return Number.isNaN(s) || Number.isNaN(e) ? null : Math.max(0, Math.round((e - s) / 1000));
}

/** properties.segments → [시작 ms, 끝 ms] 목록(시간순). 없거나 하나라도 읽을 수 없으면 null(그때는 공백 목록으로 끊는다). */
function serverSegments(v: unknown): [number, number][] | null {
  if (!Array.isArray(v)) return null;
  const out: [number, number][] = [];
  for (const x of v) {
    if (!isObj(x)) return null;
    const a = typeof (x.start ?? x.from) === "string" ? Date.parse(String(x.start ?? x.from)) : NaN;
    const b = typeof (x.end ?? x.to) === "string" ? Date.parse(String(x.end ?? x.to)) : NaN;
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
    out.push([a, b]);
  }
  out.sort((p, q) => p[0] - q[0]);
  return out;
}

/** REST 공백 목록에서 읽는 원소 상한(끝에서부터 — 서버는 오래된 것부터 정렬해 준다) */
const REST_GAPS_READ_MAX = 1000;

/**
 * REST /ships/{mmsi}/track 응답 → 항적. 받는 모양(api 계약 v2 §B3 · v3 §D):
 * - GeoJSON(Feature·FeatureCollection 첫 항목·geometry) MultiLineString/LineString — 서버가 선을 끊는 공백(60 s 이상·열린 공백)·15분 넘는 틈에서 이미 끊어 둔다.
 *   구간 시각은 properties.segments[i].{start|from, end|to} 가 있으면 쓴다(없으면 모름).
 * - 또는 points:[{ts, lon, lat}] — 이 경우 여기서 15분 틈·공백 구간으로 끊는다.
 * gaps(루트 또는 properties): 창과 겹치는 AIS 수신 공백 — 최신 MAX_TRACK_GAPS 개만 둔다. properties.gaps_truncated 면 목록이 잘렸다.
 */
export function shipTrackFromRest(resp: unknown): ShipTrack {
  const out: ShipTrack = { segs: [], gaps: [] };
  if (!isObj(resp)) return out;
  const feat = resp.type === "FeatureCollection" && Array.isArray(resp.features) ? resp.features[0] : resp;
  const props = isObj(feat) && isObj(feat.properties) ? feat.properties : {};
  const rawGaps = Array.isArray(resp.gaps) ? resp.gaps : Array.isArray(props.gaps) ? props.gaps : [];
  const parsed: AisGap[] = [];
  for (const g of rawGaps.slice(-REST_GAPS_READ_MAX)) { const p = parseAisGap(g); if (p) parsed.push(p); }
  const norm = normalizeGaps(parsed);
  out.gaps = norm.gaps;
  if (norm.dropped || rawGaps.length > REST_GAPS_READ_MAX || props.gaps_truncated === true || resp.gaps_truncated === true) out.gapsTruncated = true;
  let budget = MAX_SHIP_TRACK_POINTS;

  if (Array.isArray(resp.points)) {
    // 서버가 구간을 알려 주면(properties.segments) 그 경계를 따른다 — 서버는 잘리지 않은 긴 공백 목록으로 끊었고,
    // 여기 공백 목록(out.gaps)은 최신 200개로 잘렸을 수 있다(계약 v3 §D). 구간에 속하지 않는 점(앞뒤가 끊긴 한 점)은 따로 둔다.
    const bounds = serverSegments(props.segments);
    const points: ShipTrackPoint[] = [];
    let seg: ShipTrackSeg | null = null;
    let segIdx = -2;
    let j = 0;
    for (const p of resp.points) {
      if (budget <= 0) break;
      if (!isObj(p)) continue;
      const c = coord([p.lon, p.lat]);
      const t = typeof p.ts === "string" ? Date.parse(p.ts) : NaN;
      if (!c || Number.isNaN(t)) continue;
      if (seg && seg.endMs != null && t <= seg.endMs) continue;
      let brk: boolean;
      if (bounds) {
        while (j < bounds.length && bounds[j][1] < t) j++;
        const idx = j < bounds.length && bounds[j][0] <= t ? j : -1;
        brk = !seg || idx === -1 || idx !== segIdx;
        segIdx = idx;
      } else {
        brk = !seg || (seg.endMs != null && (t - seg.endMs > TRACK_BREAK_MS || gapBetween(out.gaps, seg.endMs, t)));
      }
      if (brk || !seg) {
        seg = { pts: [], startMs: t, endMs: t };
        out.segs.push(seg);
      }
      seg.pts.push(c);
      seg.endMs = t;
      points.push({ ts: t, lon: c[0], lat: c[1], ...trackPointDetail(p), src: "rest" });
      budget--;
    }
    out.points = points;
    return out;
  }

  const geom = isObj(feat) && isObj(feat.geometry) ? feat.geometry : isObj(feat) && (feat.type === "MultiLineString" || feat.type === "LineString") ? feat : null;
  if (!geom || !Array.isArray(geom.coordinates)) return out;
  const lines = geom.type === "MultiLineString" ? geom.coordinates : geom.type === "LineString" ? [geom.coordinates] : [];
  const segTimes = Array.isArray(props.segments) ? props.segments : [];
  lines.forEach((line: unknown, i: number) => {
    if (!Array.isArray(line) || budget <= 0) return;
    const pts: [number, number][] = [];
    for (const v of line) { if (budget <= 0) break; const c = coord(v); if (c) { pts.push(c); budget--; } }
    if (!pts.length) return;
    const st = isObj(segTimes[i]) ? segTimes[i] as Obj : {};
    const ms = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);
    out.segs.push({ pts, startMs: ms(st.start ?? st.from), endMs: ms(st.end ?? st.to) });
  });
  return out;
}

/**
 * 실시간 관측(ship_selected)을 항적 끝에 붙인다. 마지막 구간의 끝 시각을 모르면 anchorMs(REST 를 받을 때 알던 선박 관측 시각)를 쓴다.
 * 15분 넘는 틈이거나 그 사이에 선을 끊는 AIS 공백(60 s 이상·열린 공백)이 있으면 새 구간(점선 연결)으로 시작한다. 같은 시각·이전 시각·같은 위치는 붙이지 않는다. 붙였으면 true.
 * 붙인 관측은 호버용 점(src live — 계약 v5 §B3)으로도 남긴다(속력·침로·상태는 받은 값, 없으면 null).
 */
export function appendShipTrack(
  track: ShipTrack,
  p: { ts: number; lon: number; lat: number; sog_kn?: number | null; cog_deg?: number | null; heading_deg?: number | null; nav_status?: number | null },
  anchorMs: number | null = null,
): boolean {
  if (!Number.isFinite(p.ts) || coord([p.lon, p.lat]) == null) return false;
  const last = track.segs[track.segs.length - 1];
  const lastEnd = last ? last.endMs ?? anchorMs : null;
  if (last && lastEnd != null && p.ts <= lastEnd) return false;
  const lastPt = last?.pts[last.pts.length - 1];
  if (lastPt && lastPt[0] === p.lon && lastPt[1] === p.lat) { last.endMs = p.ts; return false; }
  if (!last || lastEnd == null || p.ts - lastEnd > TRACK_BREAK_MS || gapBetween(track.gaps, lastEnd, p.ts)) {
    track.segs.push({ pts: [[p.lon, p.lat]], startMs: p.ts, endMs: p.ts });
  } else {
    last.pts.push([p.lon, p.lat]);
    last.endMs = p.ts;
  }
  (track.points ??= []).push({ ts: p.ts, lon: p.lon, lat: p.lat, ...trackPointDetail(p as Obj), src: "live" });
  if (track.points.length > MAX_SHIP_TRACK_POINTS) track.points.splice(0, track.points.length - MAX_SHIP_TRACK_POINTS);
  // 점 상한 — 오래된 구간부터 버린다
  let total = track.segs.reduce((n, s) => n + s.pts.length, 0);
  while (total > MAX_SHIP_TRACK_POINTS && track.segs.length > 0) {
    const s = track.segs[0];
    const drop = Math.min(s.pts.length, total - MAX_SHIP_TRACK_POINTS);
    s.pts.splice(0, drop);
    s.startMs = null;
    total -= drop;
    if (s.pts.length === 0) track.segs.shift();
  }
  return true;
}

/**
 * 항적 → 지도 FeatureCollection: 구간(kind "track", 실선) + 구간 사이 연결(kind "gap", 회색 점선 + 라벨).
 * 연결 라벨(KST — fmtKstSpan): 두 구간 시각을 알고 그 사이에 선을 끊는 AIS 공백(60 s 이상·열린 공백)이 있으면
 * "AIS 공백 hh:mm–hh:mm KST", 시각만 알면 "기록 없음 …", 모르면 "기록 공백".
 */
export function shipTrackFeatures(track: ShipTrack): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  track.segs.forEach((s, i) => {
    if (s.pts.length >= 2) features.push({ type: "Feature", properties: { kind: "track" }, geometry: { type: "LineString", coordinates: s.pts } });
    const next = track.segs[i + 1];
    if (!next || !s.pts.length || !next.pts.length) return;
    const a = s.endMs, b = next.startMs;
    let label = "기록 공백";
    if (a != null && b != null) {
      const span = fmtKstSpan(a, b);
      label = gapBetween(track.gaps, a, b) ? `AIS 공백 ${span}` : `기록 없음 ${span}`;
    }
    features.push({ type: "Feature", properties: { kind: "gap", label }, geometry: { type: "LineString", coordinates: [s.pts[s.pts.length - 1], next.pts[0]] } });
  });
  return { type: "FeatureCollection", features };
}

/** 항적 점 → 지도 source "ship-track-points"(호버 툴팁 자료 — 계약 v5 §B3). 모르는 값은 null 그대로 */
export function shipTrackPointFeatures(track: ShipTrack): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: (track.points ?? []).map((p) => ({
      type: "Feature",
      properties: { ts: new Date(p.ts).toISOString(), sog: p.sog_kn, cog: p.cog_deg, hdg: p.heading_deg, nav: p.nav_status, src: p.src },
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    })),
  };
}

// ---- 지도 선박 칩(계약 v4 §C) ----

/**
 * 서버(api ShipFanout)의 표시 규칙 — 칩·목록·범례·툴팁 문구가 같은 값을 쓴다.
 * 개별(points) = (줌 ≥ 7 이고 화면 안 ≤ 5,000척) 또는 (4 ≤ 줌 < 7 이고 ≤ 1,500척). 줌 4–6 에서 격자로 바꾸는 기준은 1,500 초과,
 * 개별로 돌아오는 기준은 1,200 이하(되풀이 전환 방지). 그 밖은 격자.
 */
export const SHIPS_RULE = { lowZoom: 4, highZoom: 7, lowMax: 1500, lowBack: 1200, highMax: 5000 } as const;
const n0 = (n: number) => n.toLocaleString("en-US");
export const SHIPS_RULE_TEXT =
  `개별 표시: 줌 ${SHIPS_RULE.highZoom} 이상은 화면 안 ${n0(SHIPS_RULE.highMax)}척 이하, 줌 ${SHIPS_RULE.lowZoom}–${SHIPS_RULE.highZoom - 1} 은 ${n0(SHIPS_RULE.lowMax)}척 이하` +
  `(격자가 된 뒤에는 ${n0(SHIPS_RULE.lowBack)}척 이하로 줄어야 돌아옴), 줌 ${SHIPS_RULE.lowZoom} 미만은 항상 격자`;
/** 화면 안 선박이 0척일 때(계약 v4 §C 문구 그대로) — AIS 가 연결돼 있고 화면이 수신 범위에 걸칠 때만(§G C-1) */
export const SHIPS_ZERO_TEXT = "화면 안 선박 0척 — aisstream 은 육상 수신국 기반이라 수신국이 없는 해역은 비어 있습니다";
/** 화면이 수신 범위(운영 설정) 밖일 때 — 이때는 수신국 탓이 아니다 */
export const SHIPS_OUT_OF_COVERAGE_TEXT = "화면 안 선박 0척 — 수신 범위(운영 설정) 밖입니다";
/** 화면을 덮는 구역(구역을 모르면 전체)이 aisstream 에 연결돼 있지 않을 때 — 비어 있는 이유를 수신국 탓으로 돌리지 않는다(§G C-1) */
export const SHIPS_ZERO_AIS_DOWN_TEXT = "화면 안 선박 0척 — AIS 연결 안 됨";
/** AIS 연결 상태를 모를 때(ais 상태 없음 · heartbeat 가 오래돼 connected 모름) */
export const SHIPS_ZERO_AIS_UNKNOWN_TEXT = "화면 안 선박 0척 — AIS 연결 상태 모름";
/** 연결은 됐지만 수신 범위(coverage)나 화면 범위를 몰라 수신국 탓인지 말할 수 없을 때 */
export const SHIPS_ZERO_RANGE_UNKNOWN_TEXT = "화면 안 선박 0척 — 수신 범위 모름";

/** 구독 영역 [west, south, east, north](경도 −180~180)가 수신 범위 상자와 겹치는가 */
export function bboxTouchesCoverage(bbox: readonly [number, number, number, number], boxes: readonly AisBox[]): boolean {
  const [w, s, e, n] = bbox;
  return boxes.some((b) => w <= b.e && e >= b.w && s <= b.n && n >= b.s);
}

/** 칩이 보는 AIS 상태(status.sources.ais) 부분 — null = 상태 없음(모름) */
export type ShipsChipAis = Pick<AisStatus, "state" | "connected" | "coverage" | "shards"> | null;

export type ZeroShipsReason = "off" | "outside" | "receivers" | "down" | "unknown" | "range";

/**
 * 화면 안 0척의 이유(계약 v4 §C · §G C-1) — 상태가 말하는 것만:
 * off = AIS 꺼짐(키 없음) · outside = 화면이 수신 범위와 겹치지 않음 · receivers = 화면에 걸친 구역 중 하나라도 연결(수신국 없는 해역 문구) ·
 * down = 화면에 걸친 구역이 모두 끊김 · unknown = 연결 상태 모름 · range = 연결은 됐지만 수신 범위나 화면을 모름.
 * 구역이 있고 모든 구역의 범위를 알면 화면에 걸친 구역만 본다(다른 구역이 연결돼 있다고 이 화면의 빈 바다를 수신국 탓으로 돌리지 않는다).
 */
export function zeroShipsReason(ais: ShipsChipAis, bbox: readonly [number, number, number, number] | null): ZeroShipsReason {
  if (!ais) return "unknown";
  if (ais.state === "disabled") return "off";
  const shards = ais.shards?.length && ais.shards.every((sh) => sh.coverage?.length) ? ais.shards : null;
  // '범위 밖' 은 구역별 범위(운영 설정)의 합으로 가른다 — 합계 coverage 는 실제로 구독한 구역만이라(§G D-2) 구독 전·끊긴 구역이 빠진다
  const cov = shards ? shards.flatMap((sh) => sh.coverage!) : ais.coverage?.length ? ais.coverage : null;
  if (bbox && cov && !bboxTouchesCoverage(bbox, cov)) return "outside";
  const conns = shards && bbox
    ? shards.filter((sh) => bboxTouchesCoverage(bbox, sh.coverage!)).map((sh) => sh.connected)
    : [ais.connected, ...(ais.shards ?? []).map((sh) => sh.connected)];
  if (conns.some((c) => c === true)) return bbox && cov ? "receivers" : "range";
  return conns.some((c) => c === false) ? "down" : "unknown";
}

const ZERO_SHIPS: Record<Exclude<ZeroShipsReason, "off">, { text: string; title: string }> = {
  outside: { text: SHIPS_OUT_OF_COVERAGE_TEXT, title: "AIS 수집기가 구독하지 않는 영역입니다(운영 설정 ais_bboxes — 지도의 점선 경계)" },
  receivers: { text: SHIPS_ZERO_TEXT, title: "aisstream.io 는 육상 AIS 수신국이 받은 것만 보냅니다. 우리 쪽에서 거른 것이 아닙니다." },
  down: { text: SHIPS_ZERO_AIS_DOWN_TEXT, title: "이 화면을 덮는 AIS 수집 연결이 aisstream.io 에 연결되어 있지 않습니다 — 선박이 없는지 알 수 없습니다" },
  unknown: { text: SHIPS_ZERO_AIS_UNKNOWN_TEXT, title: "AIS 수집기의 연결 상태를 모릅니다(상태 보고 없음 또는 오래됨) — 비어 있는 이유를 말할 수 없습니다" },
  range: { text: SHIPS_ZERO_RANGE_UNKNOWN_TEXT, title: "AIS 는 연결돼 있지만 수신 범위(운영 설정)나 화면 범위를 몰라 비어 있는 이유를 말할 수 없습니다" },
};

export interface ShipsChipInput {
  mode: "off" | "waiting" | "points" | "grid";
  count: number;
  total: number;
  cell_deg: number | null;
  capped: boolean;
}

/**
 * 칩이 보는 선종 필터(계약 v5 §B3): on/of = 켜진 선종 수/전체, shown = 필터 뒤 그리는 선박 수(점 모드는 화면 안 선박, 격자는 다시 센 합),
 * shownCells = 격자에서 그리는 칸 수, unfilteredCells = 선종별 수가 없어(구 서버) 필터를 적용하지 못한 칸 수.
 */
export interface ShipsChipFilter { on: number; of: number; shown: number; shownCells?: number; unfilteredCells?: number }

/** 켜진 선종의 선박 수(점 모드 칩·목록) */
export function countShipsIn(ships: Iterable<ShipLite>, enabled: ReadonlySet<ShipCategory>): number {
  let n = 0;
  for (const s of ships) if (enabled.has(shipCategory(s.ship_type))) n++;
  return n;
}

/**
 * 지도 왼쪽 위 선박 칩: 지금 지도가 무엇을 그리는지 + 규칙. zoom·bbox 는 마지막으로 구독한 화면(모르면 null — 그때는 규칙 전체를 적는다).
 * 0척이면 zeroShipsReason(AIS 꺼짐 · 범위 밖 · 수신국 없는 해역 · 연결 안 됨 · 상태 모름 · 범위 모름).
 * 경고 색은 줌 ≥ 7 에서 전송 상한(5,000척)을 넘었을 때만 — 줌 4–6 격자는 정상 동작이다(§G C-1, api 는 이때도 capped:true 를 보낸다).
 * 선종 필터가 켜져 있으면(일부 선종 숨김) 보이는 수와 전체 수를 함께 적는다 — 숨긴 선박을 "없다"고 말하지 않는다.
 */
export function shipsChip(
  v: ShipsChipInput,
  ctx: { zoom: number | null; bbox: readonly [number, number, number, number] | null; ais: ShipsChipAis; filter?: ShipsChipFilter | null },
): { text: string; title: string; warn: boolean } | null {
  if (v.mode === "off") return null;
  const aisOff = ctx.ais?.state === "disabled";
  const aisOffText = "선박 없음 · AIS 꺼짐(키 없음)";
  if (v.mode === "waiting") return { text: aisOff ? aisOffText : "선박 수신 대기", title: SHIPS_RULE_TEXT, warn: false };
  const inView = v.mode === "points" ? v.count : v.total;
  if (inView === 0) {
    const why = zeroShipsReason(ctx.ais, ctx.bbox);
    if (why === "off") return { text: aisOffText, title: "ais 수집기에 aisstream.io 키가 설정되지 않아 선박을 받지 않습니다(운영 설정)", warn: false };
    return { ...ZERO_SHIPS[why], warn: false };
  }
  const f = ctx.filter && ctx.filter.on < ctx.filter.of ? ctx.filter : null;
  const fText = f ? `선종 필터 ${f.on}/${f.of}` : "";
  const fTitle = f ? " 선종 필터: 범례의 선종 항목으로 켜고 끕니다(이 브라우저에만 저장)." : "";
  if (f && f.shown === 0) {
    return { text: `선박 0척 표시 — ${fText} 로 ${v.mode === "points" ? "화면 안" : "격자"} ${v.mode === "points" ? n0(inView) : fmtCount(inView)}척 모두 숨김`, title: `${SHIPS_RULE_TEXT}.${fTitle}`, warn: false };
  }
  if (v.mode === "points") {
    const text = f ? `선박 ${n0(f.shown)}척 · 화면 안 ${n0(v.count)}척 중 · ${fText} · AIS` : `선박 ${n0(v.count)}척 · 화면 안 · AIS`;
    return { text, title: `AIS 로 받은 선박 위치(보간 없음) — ${SHIPS_RULE_TEXT}.${fTitle}`, warn: false };
  }
  const z = ctx.zoom;
  const overCap = v.capped && z != null && z >= SHIPS_RULE.highZoom;
  const why = z == null ? "확대하면 개별 표시"
    : z < SHIPS_RULE.lowZoom ? `줌 ${SHIPS_RULE.lowZoom} 이상에서 개별 표시`
    : z < SHIPS_RULE.highZoom ? `줌 ${SHIPS_RULE.lowZoom}–${SHIPS_RULE.highZoom - 1} 은 ${n0(SHIPS_RULE.lowMax)}척 넘으면 격자 · ${n0(SHIPS_RULE.lowBack)}척 이하에서 개별`
    : overCap ? `화면 안 ${n0(SHIPS_RULE.highMax)}척 초과 · 전송 상한` : "확대하면 개별 표시";
  const head = f ? `선박 ${fmtCount(f.shown)}척 · ${fText}(전체 ${fmtCount(v.total)}척)` : `선박 ${fmtCount(v.total)}척`;
  const cells = f?.shownCells ?? v.count;
  const unf = f?.unfilteredCells ? ` · ${f.unfilteredCells}칸은 선종별 수 없음(구 서버 — 필터 미적용)` : "";
  return {
    text: `${head} · ${v.cell_deg ?? "—"}° 격자 ${cells}칸으로 묶음 · ${why}${unf}`,
    title: `서버가 격자별 선박 수만 보냅니다(원 크기 = 수, 색 = 가장 많은 선종). 원을 누르면 확대합니다. ${SHIPS_RULE_TEXT}.${fTitle}`,
    warn: overCap,
  };
}

/** 칩 뒤에 붙이는 AIS 공백: 일부 구역만이면 "AIS 공백 n/m 구역(그 구역 위치 멈춤)", 전체면 "AIS 공백 중(위치 멈춤)" */
export function shipsGapSuffix(ais: Pick<AisStatus, "gap_open_since" | "shards"> | null): string {
  if (!ais) return "";
  const sg = openGapShards(ais);
  if (sg && sg.open.length > 0 && sg.open.length < sg.total) return ` · AIS 공백 ${sg.open.length}/${sg.total} 구역(그 구역 위치 멈춤)`;
  return ais.gap_open_since || (sg && sg.open.length > 0) ? " · AIS 공백 중(위치 멈춤)" : "";
}

/**
 * 실시간이 아닌 선박(계약 v5 §B3 · §G4 — 검색 결과·카드): "실시간 아님 · 마지막 수신 hh:mm KST · 마지막 저장 …"(KST — §G19).
 * 마지막 수신 = api last_seen_at(ship.last_seen — 어떤 AIS 메시지든 받은 기록, 저장 위치가 더 늦으면 그 시각 — 위치 보존 72 h 가 지나도 남는다),
 * 마지막 저장 = last_position_at(저장된 마지막 위치). 지금과 KST 날짜가 다르면 날짜도(어제 시각이 오늘처럼 보이지 않게). 모르면 "—".
 */
export function notLiveText(t: { lastSeenAt: string | null | undefined; lastPositionAt: string | null | undefined }, nowMs: number): string {
  return `실시간 아님 · 마지막 수신 ${fmtSavedAt(t.lastSeenAt, nowMs)} · 마지막 저장 ${fmtSavedAt(t.lastPositionAt, nowMs)}`;
}

/** 마지막 수신 기록(§G4)의 뜻 — 카드·표의 설명(title) */
export const LAST_SEEN_TITLE =
  "이 서비스가 이 선박의 AIS 메시지(위치·정적 정보)를 마지막으로 받은 기록(api last_seen_at). 위치로는 10분에 한 번만 기록하므로 저장된 위치가 더 늦으면 그 시각 — 실제 마지막 수신은 이보다 조금 늦을 수 있음";
/** 저장 시각 "hh:mm KST"(지금과 KST 날짜가 다르면 "MM-DD hh:mm KST"). 모르면 "—" */
export function fmtSavedAt(v: string | null | undefined, nowMs: number): string {
  return fmtKstDayMinute(v, nowMs);
}

// ---- 선박 표(계약 v5 §B3 — 화면 안 목록 · 검색 결과가 같은 표) ----

/**
 * 표의 한 줄. live = 실시간 목록(AIS)에 있음 — 경과는 관측 시각(seen_at)부터. 실시간이 아니면 마지막 수신 기록(last_seen_at, §G4)부터,
 * 그것을 모르면 마지막 저장 위치 시각(last_position_at)부터. 값은 받은 그대로(모르면 null → "—").
 */
export interface ShipRow {
  mmsi: string; name: string | null; category: ShipCategory; sog_kn: number | null; nav_status: number | null;
  live: boolean; seen_at: string | null; last_position_at: string | null;
  /** 실시간이 아닐 때의 마지막 수신 기록(§G4) — 실시간 줄은 null */
  last_seen_at: string | null;
}
export type ShipSortKey = "cat" | "name" | "mmsi" | "sog" | "nav" | "age";
export interface ShipSort { key: ShipSortKey; dir: "asc" | "desc" }
export const SHIP_SORT_DEFAULT: ShipSort = { key: "name", dir: "asc" };

export function shipRowFromLite(s: ShipLite): ShipRow {
  return { mmsi: s.mmsi, name: s.name, category: shipCategory(s.ship_type), sog_kn: s.sog_kn, nav_status: s.nav_status, live: true, seen_at: s.seen_at, last_position_at: null, last_seen_at: null };
}

/** 줄의 경과(초): 실시간이면 관측 시각, 아니면 마지막 수신 기록(없으면 마지막 저장 시각)부터. 모르면 null */
export function shipRowAgeS(r: ShipRow, nowMs: number): number | null {
  return shipAgeS(r.live ? r.seen_at : r.last_seen_at ?? r.last_position_at, nowMs);
}

const CAT_INDEX: ReadonlyMap<ShipCategory, number> = new Map(SHIP_CATEGORIES.map((c, i) => [c, i]));

/**
 * 표 정렬: 선종(SHIP_CATEGORIES 순서) · 선명(대소문자 무시) · MMSI · 속력 · 항해 상태(코드) · 경과. 모르는 값은 방향과 상관없이 끝에,
 * 같으면 MMSI 오름차순(결정적).
 */
export function sortShipRows(rows: readonly ShipRow[], sort: ShipSort, nowMs: number): ShipRow[] {
  const val = (r: ShipRow): number | string | null => {
    switch (sort.key) {
      case "cat": return CAT_INDEX.get(r.category) ?? null;
      case "name": return r.name ? r.name.toUpperCase() : null;
      case "mmsi": return r.mmsi;
      case "sog": return r.sog_kn;
      case "nav": return r.nav_status;
      case "age": return shipRowAgeS(r, nowMs);
    }
  };
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows.map((r) => ({ r, v: val(r) })).sort((a, b) => {
    if (a.v == null || b.v == null) return a.v == null && b.v == null ? a.r.mmsi.localeCompare(b.r.mmsi) : a.v == null ? 1 : -1;
    const c = typeof a.v === "number" && typeof b.v === "number" ? a.v - b.v : String(a.v).localeCompare(String(b.v));
    return c !== 0 ? c * sign : a.r.mmsi.localeCompare(b.r.mmsi);
  }).map((x) => x.r);
}

// ---- 선박 목록(지도 없이 고르기 — 키보드·스크린리더) ----

/**
 * 화면 안 선박 목록: 이름 → MMSI 순, 필터(이름·MMSI 부분 일치, 대소문자 무시), 상한.
 * enabled(선종 필터, 계약 v5 §B3)가 있으면 꺼진 선종은 빼고 그 수를 hidden 으로 센다(지도와 같은 필터).
 */
export function shipList(ships: Iterable<ShipLite>, filter: string, max = 50, enabled?: ReadonlySet<ShipCategory> | null): { items: ShipLite[]; total: number; hidden: number } {
  const q = filter.trim().toUpperCase().slice(0, 32);
  const all: ShipLite[] = [];
  let hidden = 0;
  for (const s of ships) {
    if (enabled && !enabled.has(shipCategory(s.ship_type))) { hidden++; continue; }
    if (!q || s.mmsi.includes(q) || (s.name ?? "").toUpperCase().includes(q)) all.push(s);
  }
  all.sort((a, b) => {
    if (a.name && !b.name) return -1;
    if (!a.name && b.name) return 1;
    const n = (a.name ?? "").localeCompare(b.name ?? "");
    return n !== 0 ? n : a.mmsi.localeCompare(b.mmsi);
  });
  return { items: all.slice(0, max), total: all.length, hidden };
}
