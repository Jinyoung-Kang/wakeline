/**
 * 선박(AIS, ADR-014 · 계약 v2 §B3/§B4) — 순수 함수(테스트 가능).
 * - 선종 분류(색): 계약 v2 §B3 의 USCG AIS Guide 표 하나만. api(ShipCategory)와 같은 표로 단위 시험한다(tests/fixtures/ship-category-uscg.json).
 * - 수신 메시지 검증: 서버 값도 믿지 않는다 — 형식·범위가 맞지 않는 필드는 null(모름), MMSI·위치가 틀리면 그 선박을 버린다. 문자열은 길이 상한.
 * - 표시 규칙: 값이 없으면 "—". AIS "값 없음" 표기(0·511·24·60 등)는 수집기가 null 로 바꾸고, 여기서는 ITU-R M.1371 기본값 0(크기·흘수)도 모름으로 본다
 *   (USCG NAVCEN 문서 2026-09-28 확인: 흘수 "0 = not available = default", 크기 "As default should A = B = C = D be set to '0'").
 * - 항해 상태 이름: USCG NAVCEN Class A 위치 보고 문서(2026-09-28 확인)의 0–15 표.
 */
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
/** 아이콘·격자·범례가 같은 색표를 쓴다. 미상은 어두운 회색(항공기 "고도 모름" 회색과 같은 계열). */
export const SHIP_CATEGORY_COLOR: Record<ShipCategory, string> = {
  cargo: "#5cb85c", tanker: "#e5534b", passenger: "#4f8ff7", fishing: "#f0a35e", tug: "#2ec4b6", pleasure: "#d16ad8",
  hsc: "#f2d64b", special: "#8f9bff", military: "#9aa55a", other: "#c7ccd4", unknown: "#6b737e",
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

export interface ShipGridCell { lat: number; lon: number; count: number; category: ShipCategory }

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

/** ships_grid.cells: [[lat, lon, count, dominant_category], ...]. 형식이 틀린 칸·0척 칸은 버린다. */
export function parseGridCells(v: unknown): ShipGridCell[] {
  if (!Array.isArray(v)) return [];
  const out: ShipGridCell[] = [];
  for (const c of v) {
    if (out.length >= MAX_GRID_CELLS) break;
    if (!Array.isArray(c) || c.length < 3) continue;
    const lat = num(c[0], -90, 90), lon = num(c[1], -180, 180), count = int(c[2], 1, 10_000_000);
    if (lat == null || lon == null || count == null) continue;
    out.push({ lat, lon, count, category: parseCategory(c[3]) });
  }
  return out;
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

/** 격자 칸 수 라벨(1 234 → "1.2k") */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function gridFeatures(cells: readonly ShipGridCell[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: cells.map((c) => ({
      type: "Feature",
      properties: { count: c.count, label: fmtCount(c.count), cat: c.category },
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    })),
  };
}

const p2 = (n: number) => String(n).padStart(2, "0");

/**
 * ETA(계약 v2 §B4): 선원이 입력한 월·일·시·분(연도 없음, UTC). 네 값이 모두 있어야 "MM-DD HH:MM UTC · 선원 입력값, 연도 없음", 아니면 "—".
 * 연도를 붙이거나 올해/내년을 추측하지 않는다.
 */
export function fmtShipEta(st: Pick<ShipStatic, "eta_month" | "eta_day" | "eta_hour" | "eta_minute"> | null | undefined): string {
  if (!st || st.eta_month == null || st.eta_day == null || st.eta_hour == null || st.eta_minute == null) return "—";
  return `${p2(st.eta_month)}-${p2(st.eta_day)} ${p2(st.eta_hour)}:${p2(st.eta_minute)} UTC · 선원 입력값, 연도 없음`;
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

/** 속력/침로/선수방위 — 각 값이 없으면 "—" */
export function fmtMotion(s: { sog_kn?: number | null; cog_deg?: number | null; heading_deg?: number | null } | null | undefined): string {
  const f = (v: number | null | undefined, unit: string, d = 0) => (v == null ? "—" : `${v.toFixed(d)}${unit}`);
  return `${f(s?.sog_kn, " kn", 1)} / ${f(s?.cog_deg, "°", 1)} / ${f(s?.heading_deg, "°")}`;
}

// ---- AIS 상태(status.sources.ais) ----

export interface AisGap { started_at: string; ended_at: string | null; reason: string | null }
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
  received_at: number;
}

export function parseAisGap(v: unknown): AisGap | null {
  if (!isObj(v)) return null;
  const started = iso(v.started_at);
  if (!started) return null;
  return { started_at: started, ended_at: iso(v.ended_at), reason: str(v.reason, 64) };
}

/** status 객체에서 AIS 상태(계약 v2 §B3: status 에 sources.ais). 없으면 null(ais 수집기 없음/구버전 api). */
export function parseAisStatus(status: unknown, receivedAt: number): AisStatus | null {
  if (!isObj(status)) return null;
  const src = isObj(status.sources) ? status.sources.ais : status.ais;
  if (!isObj(src)) return null;
  return {
    connected: typeof src.connected === "boolean" ? src.connected : null,
    lag_s: num(src.lag_s, 0, 1e9),
    msgs_per_s: num(src.msgs_per_s, 0, 1e6),
    gap_open_since: iso(src.gap_open_since),
    last_gap: parseAisGap(src.last_gap),
    state: typeof src.state === "string" && AIS_STATE_SET.has(src.state) ? (src.state as AisState) : null,
    coverage: parseAisCoverage(src.coverage),
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
  if (ais.connected === false) {
    const retrying = ais.state === "connecting" || ais.state === "backoff";
    const why = retrying ? " — 재연결 중(지수 백오프)" : ` — 수집기 상태 ${ais.state ?? "모름"}`;
    return { text: "AIS 끊김", tone: "bad", title: `AIS 수집기가 aisstream.io 에 연결되어 있지 않음${why}` };
  }
  const elapsed = nowMs ? Math.max(0, (nowMs - ais.received_at) / 1000) : 0;
  const lag = ais.lag_s == null ? null : live && elapsed <= RX_FRESH_MS / 1000 ? ais.lag_s : ais.lag_s + elapsed;
  const rate = ais.msgs_per_s == null ? "— msg/s" : `${ais.msgs_per_s.toFixed(1)} msg/s`;
  const tone = ais.connected == null || lag == null || lag > AIS_LAG_WARN_S ? "warn" : "ok";
  return {
    text: `AIS${ais.connected == null ? " 연결 모름" : ""} · ${rate} · ${lag == null ? "lag —" : `lag ${Math.round(lag)}s`}`,
    tone,
    title: `AIS(aisstream.io) 수신 상태 — 지연 = 마지막 메시지 이후 경과(경고 > ${AIS_LAG_WARN_S} s)`,
  };
}

const hhmm = (isoStr: string) => { const d = new Date(isoStr); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };

/** 상태 바 공백 배지: 열린 공백 → "AIS 공백 hh:mm– UTC · 진행 중", 30분 안에 끝난 공백 → "AIS 공백 hh:mm–hh:mm UTC". 그 밖은 null. */
export function aisGapBadge(ais: AisStatus | null, nowMs: number): { text: string; open: boolean; title: string } | null {
  if (!ais) return null;
  if (ais.gap_open_since) {
    return { text: `AIS 공백 ${hhmm(ais.gap_open_since)}– UTC · 진행 중`, open: true, title: `AIS 수신이 ${ais.gap_open_since} 부터 끊겨 있음 — 재전송이 없어 이 구간 선박 위치는 비어 있게 됩니다` };
  }
  const g = ais.last_gap;
  if (!g || !g.ended_at || !nowMs) return null;
  const end = Date.parse(g.ended_at);
  if (Number.isNaN(end) || nowMs - end > AIS_GAP_SHOW_MS) return null;
  return { text: `AIS 공백 ${hhmm(g.started_at)}–${hhmm(g.ended_at)} UTC`, open: false, title: `AIS 수신 공백 ${g.started_at} – ${g.ended_at}${g.reason ? ` (${g.reason})` : ""} — 이 구간 선박 위치 없음` };
}

// ---- 선택 선박 항적(REST + 실시간) ----

/** 이보다 긴 시간 틈은 선을 끊는다(계약 v2 §B3 track: time jumps > 15 min) */
export const TRACK_BREAK_MS = 15 * 60_000;
/** 선택 선박 항적 창 — REST ≤ 24 h(계약). 선박은 느려 6 h 면 충분하고 60 s 에 1점이라 ≤ 360 점. */
export const SHIP_TRACK_WINDOW_MS = 6 * 3600_000;
export const MAX_SHIP_TRACK_POINTS = 5000;

export interface ShipTrackSeg { pts: [number, number][]; startMs: number | null; endMs: number | null }
/** gapsTruncated: 서버가 공백 목록을 잘랐거나(properties.gaps_truncated) 여기서 최신 MAX_TRACK_GAPS 개만 남겼음 — 개수는 하한 */
export interface ShipTrack { segs: ShipTrackSeg[]; gaps: AisGap[]; gapsTruncated?: boolean }

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
 * status.sources.ais 의 공백을 항적 공백 목록에 반영한다(선택 중에 생기거나 닫힌 공백). 바뀌었으면 true.
 * - 열린 공백(gap_open_since)은 자리표시: 같은 started_at 의 끝난 공백(last_gap)이 오면 대체되고,
 *   status 가 더 이상 그 공백이 열려 있다고 하지 않으면(gap_open_since null·다른 값) 뺀다 — 끝을 모르는 공백을 영원히 열어 두지 않는다.
 * - 항적 창(sinceMs) 전에 끝난 공백은 넣지 않는다. status 를 모르면(null) 그대로 둔다.
 */
export function mergeStatusGaps(track: ShipTrack, ais: Pick<AisStatus, "gap_open_since" | "last_gap"> | null, sinceMs: number): boolean {
  if (!ais) return false;
  const openMs = ais.gap_open_since ? Date.parse(ais.gap_open_since) : NaN;
  const next: AisGap[] = track.gaps.filter((g) => g.ended_at != null || Date.parse(g.started_at) === openMs);
  const lg = ais.last_gap;
  if (lg && lg.ended_at && !(Date.parse(lg.ended_at) < sinceMs)) next.push(lg);
  if (ais.gap_open_since) next.push({ started_at: ais.gap_open_since, ended_at: null, reason: null });
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
      budget--;
    }
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
 */
export function appendShipTrack(track: ShipTrack, p: { ts: number; lon: number; lat: number }, anchorMs: number | null = null): boolean {
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
 * 연결 라벨: 두 구간 시각을 알고 그 사이에 선을 끊는 AIS 공백(60 s 이상·열린 공백)이 있으면 "AIS 공백 hh:mm–hh:mm",
 * 시각만 알면 "기록 없음 hh:mm–hh:mm", 모르면 "기록 공백".
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
      const span = `${hhmm(new Date(a).toISOString())}–${hhmm(new Date(b).toISOString())}`;
      label = gapBetween(track.gaps, a, b) ? `AIS 공백 ${span}` : `기록 없음 ${span}`;
    }
    features.push({ type: "Feature", properties: { kind: "gap", label }, geometry: { type: "LineString", coordinates: [s.pts[s.pts.length - 1], next.pts[0]] } });
  });
  return { type: "FeatureCollection", features };
}

// ---- 선박 목록(지도 없이 고르기 — 키보드·스크린리더) ----

/** 화면 안 선박 목록: 이름 → MMSI 순, 필터(이름·MMSI 부분 일치, 대소문자 무시), 상한 */
export function shipList(ships: Iterable<ShipLite>, filter: string, max = 50): { items: ShipLite[]; total: number } {
  const q = filter.trim().toUpperCase().slice(0, 32);
  const all: ShipLite[] = [];
  for (const s of ships) if (!q || s.mmsi.includes(q) || (s.name ?? "").toUpperCase().includes(q)) all.push(s);
  all.sort((a, b) => {
    if (a.name && !b.name) return -1;
    if (!a.name && b.name) return 1;
    const n = (a.name ?? "").localeCompare(b.name ?? "");
    return n !== 0 ? n : a.mmsi.localeCompare(b.mmsi);
  });
  return { items: all.slice(0, max), total: all.length };
}
