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

export type PositionSource = "gnss" | "manual" | "estimated" | "inoperative";
const POSITION_SOURCES: ReadonlySet<string> = new Set(["gnss", "manual", "estimated", "inoperative"]);

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
    imo: int(o.imo, 1, 999_999_999),
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
  gnss: "GNSS(선박 보고)",
  estimated: "선박 추측항법 — 선박이 보고한 추정 위치",
  manual: "수동 입력 위치(선박 보고)",
  inoperative: "위치 장비 비작동 — 위치를 믿기 어려움",
};
/** 위치 출처 배지(계약 v2 §B4: estimated/manual → 추정/수동). gnss 는 배지 없음. */
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
export interface AisStatus {
  connected: boolean | null;
  lag_s: number | null;
  msgs_per_s: number | null;
  gap_open_since: string | null;
  last_gap: AisGap | null;
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
    received_at: receivedAt,
  };
}

/** 끝난 공백을 상태 바에 남기는 시간(계약 v2 §B4) */
export const AIS_GAP_SHOW_MS = 30 * 60_000;
/** AIS 지연 경고 기준 — ais 컨테이너 health 기준(마지막 메시지 120 s, 계약 v2 §B1)과 같게 */
export const AIS_LAG_WARN_S = 120;

/**
 * 상태 바 AIS 배지: "AIS · 5.4 msg/s · lag 3s". 끊김이면 "AIS 끊김". 지연은 서버 보고값 — 연결이 실시간(live)이 아니거나 받은 지 45 s 가 넘으면
 * 받은 뒤 경과를 더한다(화면 데이터가 그 뒤로 새로워졌다는 근거가 없으므로). AIS 상태를 받은 적이 없으면 null.
 */
export function aisBadge(ais: AisStatus | null, nowMs: number, live: boolean): { text: string; tone: "ok" | "warn" | "bad"; title: string } | null {
  if (!ais) return null;
  if (ais.connected === false) return { text: "AIS 끊김", tone: "bad", title: "AIS 수집기가 aisstream.io 에 연결되어 있지 않음 — 재연결 중(지수 백오프)" };
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
export interface ShipTrack { segs: ShipTrackSeg[]; gaps: AisGap[] }

function coord(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const lon = num(v[0], -180, 180), lat = num(v[1], -90, 90);
  return lon == null || lat == null ? null : [lon, lat];
}

function gapBetween(gaps: readonly AisGap[], a: number, b: number): boolean {
  for (const g of gaps) {
    const s = Date.parse(g.started_at);
    const e = g.ended_at ? Date.parse(g.ended_at) : Infinity;
    if (!Number.isNaN(s) && s < b && e > a) return true;
  }
  return false;
}

/**
 * REST /ships/{mmsi}/track 응답 → 항적. 받는 모양(api 계약 v2 §B3):
 * - GeoJSON(Feature·FeatureCollection 첫 항목·geometry) MultiLineString/LineString — 서버가 AIS 공백·15분 넘는 틈에서 이미 끊어 둔다.
 *   구간 시각은 properties.segments[i].{start|from, end|to} 가 있으면 쓴다(없으면 모름).
 * - 또는 points:[{ts, lon, lat}] — 이 경우 여기서 15분 틈·공백 구간으로 끊는다.
 * gaps(루트 또는 properties): 창과 겹치는 AIS 공백.
 */
export function shipTrackFromRest(resp: unknown): ShipTrack {
  const out: ShipTrack = { segs: [], gaps: [] };
  if (!isObj(resp)) return out;
  const feat = resp.type === "FeatureCollection" && Array.isArray(resp.features) ? resp.features[0] : resp;
  const props = isObj(feat) && isObj(feat.properties) ? feat.properties : {};
  const rawGaps = Array.isArray(resp.gaps) ? resp.gaps : Array.isArray(props.gaps) ? props.gaps : [];
  for (const g of rawGaps.slice(0, 200)) { const p = parseAisGap(g); if (p) out.gaps.push(p); }
  let budget = MAX_SHIP_TRACK_POINTS;

  if (Array.isArray(resp.points)) {
    let seg: ShipTrackSeg | null = null;
    for (const p of resp.points) {
      if (budget <= 0) break;
      if (!isObj(p)) continue;
      const c = coord([p.lon, p.lat]);
      const t = typeof p.ts === "string" ? Date.parse(p.ts) : NaN;
      if (!c || Number.isNaN(t)) continue;
      if (seg && seg.endMs != null && t <= seg.endMs) continue;
      if (!seg || (seg.endMs != null && (t - seg.endMs > TRACK_BREAK_MS || gapBetween(out.gaps, seg.endMs, t)))) {
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
 * 15분 넘는 틈이거나 그 사이에 AIS 공백이 있으면 새 구간(점선 연결)으로 시작한다. 같은 시각·이전 시각·같은 위치는 붙이지 않는다. 붙였으면 true.
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
 * 연결 라벨: 두 구간 시각을 알고 그 사이에 AIS 공백이 있으면 "AIS 공백 hh:mm–hh:mm", 시각만 알면 "기록 없음 hh:mm–hh:mm", 모르면 "기록 공백".
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
