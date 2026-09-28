/**
 * 표시 규칙(순수 함수). 값이 없으면 "—" — 0/false/"없음" 으로 채우지 않는다(데이터 정직성).
 * 색은 지도 레이어(maplayers.ts)·범례(MapLegend)·카드가 이 한 곳을 공유한다.
 */

/**
 * SIGMET 위험 유형 색. TC(빨강)와 IFR(분홍)은 서로 다른 색(GAP-13). 목록에 없는 유형은 HAZARD_DEFAULT_COLOR.
 * 배경지도 육지·바다(lib/basemap.ts) 모두에서 선 색이 ≥ 3:1 — MTW 계열·VA 는 계약 v4 §E 에서 밝게 고쳤다.
 */
export const HAZARD_COLORS: Record<string, string> = {
  TS: "#f59e0b", CONVECTIVE: "#f59e0b", TURB: "#a855f7", ICE: "#38bdf8", MTW: "#7b89a0", VA: "#b87818", TC: "#ef4444",
  IFR: "#f472b6", "MTN OBSCN": "#7b89a0", MTN: "#7b89a0", "MT OBSC": "#7b89a0", LLWS: "#22c55e",
};
export const HAZARD_DEFAULT_COLOR = "#94a3b8";
export const hazardColor = (h: string | null | undefined) => (h ? HAZARD_COLORS[h] : undefined) ?? HAZARD_DEFAULT_COLOR;
/** 범례에 보여 줄 위험 유형 묶음(같은 색끼리) */
export const HAZARD_LEGEND: { codes: string; color: string }[] = [
  { codes: "TS · CONVECTIVE", color: HAZARD_COLORS.TS },
  { codes: "TURB", color: HAZARD_COLORS.TURB },
  { codes: "ICE", color: HAZARD_COLORS.ICE },
  { codes: "MTW · MTN OBSCN", color: HAZARD_COLORS.MTW },
  { codes: "VA", color: HAZARD_COLORS.VA },
  { codes: "TC", color: HAZARD_COLORS.TC },
  { codes: "IFR", color: HAZARD_COLORS.IFR },
  { codes: "LLWS", color: HAZARD_COLORS.LLWS },
  { codes: "기타", color: HAZARD_DEFAULT_COLOR },
];

/** 비행 카테고리 색(항공 관례). 판정 불가(null)는 CAT_UNKNOWN_COLOR, METAR 가 오래되면 회색 테두리만(CAT_STALE_*). */
export const CAT_COLORS: Record<string, string> = { VFR: "#22c55e", MVFR: "#3b82f6", IFR: "#ef4444", LIFR: "#d946ef" };
export const CAT_UNKNOWN_COLOR = "#4b5563";
export const CAT_STALE_FILL = "#1f242b";
export const CAT_STALE_STROKE = "#8a929d";

/** 항공기 아이콘·항적 고도 색 램프(ft → 색). 지도 식과 범례가 같은 값을 쓴다. 고도를 모르면 0 ft 색이 아니라 ALT_UNKNOWN_COLOR. */
export const ALT_RAMP: [number, string][] = [[0, "#3ec98f"], [10000, "#4c90f0"], [25000, "#8fb8ff"], [40000, "#e5e7eb"]];
/** 고도 모름 회색 — 배경지도 육지(lib/basemap.ts) 위에서도 ≥ 3:1 */
export const ALT_UNKNOWN_COLOR = "#7a828d";
/** 지상(on_ground=true — 공급자 값) 항공기 아이콘 색. 고도 램프(0 ft 녹색)와 구분 — 지상 고도를 0 ft 로 그리지 않는다(DH-3). */
export const GND_COLOR = "#b5895a";

export function fmtAlt(ft: number | null | undefined) {
  return ft == null ? "—" : ft >= 18000 ? `FL${Math.round(ft / 100)}` : `${ft.toLocaleString()} ft`;
}
/**
 * 고도 표시(지상 포함, DH-3): 공급자가 지상(on_ground=true)이라고 하면 "GND". 수집기가 지상에 0 ft 를 채우던 시절 값(0)은 고도로 보이지 않는다.
 * 지상인데 0 이 아닌 기압 고도를 보고했으면(OpenSky baro_altitude) 함께 보여 준다 — 보고값 그대로.
 */
export function fmtAltGnd(ft: number | null | undefined, onGround: boolean | null | undefined) {
  if (onGround !== true) return fmtAlt(ft);
  return ft == null || ft === 0 ? "GND" : `GND (${fmtAlt(ft)} 보고)`;
}
export function fmtNum(v: number | null | undefined, unit = "", digits = 0) {
  return v == null ? "—" : `${v.toFixed(digits)}${unit}`;
}
function isoOf(v: string | number | null | undefined): string | null {
  if (v == null || v === "") return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
/**
 * UTC 시각 "MM-DD HH:MM:SSZ"(예: 09-27 08:44:33Z). 날짜를 빼면 어제 METAR·감사 기록이 오늘 것처럼 보인다(GAP-26).
 * 숫자는 epoch ms.
 */
export function fmtTime(v: string | number | null | undefined) {
  const s = isoOf(v);
  return s == null ? "—" : `${s.slice(5, 10)} ${s.slice(11, 19)}Z`;
}
/** UTC "HH:MM:SSZ" — 날짜가 자명한 곳(방금 받은 값 + 지연 배지가 옆에 있는 상태 바)에만. */
export function fmtClock(v: string | number | null | undefined) {
  const s = isoOf(v);
  return s == null ? "—" : `${s.slice(11, 19)}Z`;
}
/** 전체 ISO(툴팁 title 용) */
export function fmtIso(v: string | number | null | undefined) {
  return isoOf(v) ?? "—";
}
/** 경과 시간(초) — "42s", "3m 05s", "1h 12m", "2d 03h". 모르면 "—". */
export function fmtDuration(sec: number | null | undefined) {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  const p2 = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${p2(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${p2(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86400)}d ${p2(Math.floor((s % 86400) / 3600))}h`;
}
/** 시각 v 부터 nowMs 까지의 경과(초). 모르면 null. */
export function ageS(v: string | number | null | undefined, nowMs: number): number | null {
  const s = isoOf(v);
  if (s == null || !nowMs) return null;
  return Math.max(0, (nowMs - Date.parse(s)) / 1000);
}
export function fmtAgo(iso: string | null | undefined, nowMs = Date.now()) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}
export function fmtEta(s: number | null | undefined) {
  if (s == null || !Number.isFinite(s)) return "—";
  const v = Math.max(0, Math.round(s));
  return v < 60 ? `${v}s` : `${Math.floor(v / 60)}m ${v % 60}s`;
}
/** 불리언 — 모르면 "—"(false 로 채우지 않는다) */
export function fmtBool(v: boolean | null | undefined, yes = "yes", no = "no") {
  return v == null ? "—" : v ? yes : no;
}

export interface BandSource {
  /** "assumed_surface" = 하한 미발표 → 판정은 SFC 가정 */
  base_source?: string | null;
  /** "unknown" = 상한 미발표 → 판정은 무제한 가정. "raw_text" = 원문에서 읽은 값 */
  top_source?: string | null;
  /** 원문이 "TOP ABV FLxxx" — 발표값은 상한의 하한(그 이상) */
  top_above?: boolean;
}

export const BASE_ASSUMED_LABEL = "하한 미발표(SFC 가정)";
export const TOP_UNKNOWN_LABEL = "상한 미발표(무제한 가정)";

/**
 * SIGMET 고도대 표시(계약서 §1). 발표되지 않은 값을 "SFC"·"∞" 같은 발표값처럼 보이게 하지 않는다.
 * - 하한: base_source=assumed_surface → "하한 미발표(SFC 가정)", 0 → "SFC", 없음 → "—"
 * - 상한: null → "상한 미발표(무제한 가정)"(판정이 무제한으로 가정하므로), raw_text → "FL380 (원문)" / ABV → "FL380 이상 (원문)"
 * - 하한 출처를 모르는 0(구 알림 근거 등)은 "SFC(출처 미확인)" 로 가정일 수 있음을 드러낸다.
 */
export function band(base: number | null | undefined, top: number | null | undefined, src?: BandSource | null) {
  let lo: string;
  if (src?.base_source === "assumed_surface") lo = BASE_ASSUMED_LABEL;
  else if (base == null) lo = "—";
  else if (base === 0) lo = src?.base_source === "json" ? "SFC" : "SFC(출처 미확인)";
  else lo = fmtAlt(base);
  let hi: string;
  if (top == null || src?.top_source === "unknown") hi = TOP_UNKNOWN_LABEL;
  else if (src?.top_source === "raw_text_lower_bound") hi = `${fmtAlt(top)} 이상 (원문 ABV)`;
  else if (src?.top_source === "raw_text") hi = `${fmtAlt(top)}${src.top_above ? " 이상" : ""} (원문)`;
  else hi = fmtAlt(top);
  return `${lo} – ${hi}`;
}

// ---- METAR(공항) ----

/**
 * 시정(DH-7): AWC METAR JSON 의 visib 는 법정마일(SM) — 원문 9999(10 km 이상)가 "6+"(6.2 SM 이상)로 온다(2026-09-28 RKSI·RKPC 실응답 대조).
 * "N+" 는 "N SM 이상"(하한). 숫자·분수 형식이 아니면 원문 그대로(단위를 붙이지 않는다). 없으면 "—".
 */
export function fmtVisSm(raw: string | number | null | undefined) {
  if (raw == null || raw === "") return "—";
  const v = String(raw).trim();
  const m = /^(\d+(?:\.\d+)?|\d+\/\d+|\d+ \d+\/\d+)(\+)?$/.exec(v);
  if (!m) return v;
  return m[2] ? `${m[1]} SM 이상` : `${m[1]} SM`;
}

/** METAR 가 이보다 오래되면 "오래됨"(계약서 §2 stale: obs_age_s > 7200) */
export const METAR_STALE_S = 7200;
export type CeilingState = "measured" | "none" | "unknown";

/**
 * 실링 표시(GAP-16 · 계약서 §5): "실링 없음"은 ceiling_state='none'(구름 자료가 있고 실링층이 없음)일 때만.
 * 'unknown'(구름 자료 없음·BKN/// 처럼 높이 모름)은 "—". 상태가 없는 구 응답은 값이 있으면 값, 없으면 "—"(없음으로 단정하지 않는다).
 */
export function ceilingLabel(state: string | null | undefined, ceilingFt: number | null | undefined) {
  if (state === "none") return "실링 없음";
  if (state === "unknown") return "—";
  return ceilingFt == null ? "—" : `${ceilingFt.toLocaleString("en-US")} ft`;
}

/** 카테고리 출처 표시. 카테고리를 모르면(판정 불가) 출처도 말하지 않는다. */
export function catSourceLabel(src: string | null | undefined, cat: string | null | undefined) {
  if (!cat) return "카테고리 판정 불가(AWC 값 없음 · 실링/시정 모름)";
  if (src === "awc") return "카테고리: AWC 제공";
  if (src === "computed") return "카테고리: 실링·시정으로 계산";
  return "카테고리 출처 미상";
}

/**
 * METAR 경과(초): 관측 시각(obs_time)과 (서버 보정) 현재 시각에서 계산 — 실데이터 필드의 결정적 계산.
 * obs_time 을 읽을 수 없으면 서버가 준 obs_age_s. 둘 다 없으면 null(METAR 없음).
 */
export function metarAgeS(p: { obs_time?: unknown; obs_age_s?: unknown } | null | undefined, nowMs: number): number | null {
  if (!p) return null;
  if (typeof p.obs_time === "string") { const a = ageS(p.obs_time, nowMs); if (a != null) return a; }
  return typeof p.obs_age_s === "number" && Number.isFinite(p.obs_age_s) ? p.obs_age_s : null;
}
/** 오래된 METAR 인가. 경과를 알면 > 7200 s, 모르면 서버 stale 값, 그것도 없으면 false(METAR 없음은 따로 표시). */
export function isMetarStale(p: { obs_time?: unknown; obs_age_s?: unknown; stale?: unknown } | null | undefined, nowMs: number): boolean {
  const age = metarAgeS(p, nowMs);
  if (age != null) return age > METAR_STALE_S;
  return p?.stale === true;
}

// ---- 레이더(기상청) ----

/** 기상청 레이더 수집이 이보다 오래되면 STALE — 서버 meta.stale 과 같은 기준(WeatherController: Meta.of(…, 900)). */
export const KR_RADAR_STALE_S = 900;
/**
 * 기상청 레이더 STALE(REL-19): 서버 판정(meta.stale) 또는 (서버 기준) 현재 시각에서 본 수집 경과 > 900 s.
 * REST 폴링이 실패해 마지막 응답이 남아 있는 경우도 경과로 드러난다.
 */
export function isKrRadarStale(kr: { meta?: { stale?: boolean | null; fetched_at?: string | null } | null } | null | undefined, nowMs: number): boolean {
  if (!kr?.meta) return false;
  if (kr.meta.stale === true) return true;
  const age = ageS(kr.meta.fetched_at ?? null, nowMs);
  return age != null && age > KR_RADAR_STALE_S;
}

// ---- 운영 ----

/**
 * 공급자 일일 예산 한도(DH-14). 0 은 설정상 "한도 없음"(budget.py: limit > 0 일 때만 검사) → "∞".
 * 값이 없으면(아직 성공한 적 없는 공급자는 status 에 한도를 쓰지 않는다) "—" — 모르는 한도를 무제한으로 보이게 하지 않는다.
 */
export function fmtBudgetLimit(v: unknown) {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return "—";
  return n > 0 ? String(n) : "∞";
}

/** 공항 기상 이력 화면의 오류 → 한국어(R-56: 서버 영문 detail 을 그대로 보이지 않는다) */
export function airportErrorText(e: unknown, icao: string): string {
  const status = typeof e === "object" && e !== null && typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : null;
  if (status == null) return "서버에 연결할 수 없습니다(네트워크) — 기상 이력을 불러오지 못했습니다.";
  if (status === 404) return `감시 공항 목록에 없는 코드입니다: ${icao} — 감시 공항만 기상 이력을 보관합니다.`;
  if (status === 400) return `공항 코드 형식이 올바르지 않습니다: ${icao}`;
  return `기상 이력을 불러오지 못했습니다(HTTP ${status}).`;
}

/**
 * 색 칸 위 글자색(R-57): 검정·흰색 중 WCAG 명암비가 큰 쪽. 기상청 범례의 45/50/55 dBZ 칸은 검정이 3.0–3.5 : 1 이었다(흰색은 6–7 : 1).
 * 반환은 6자리 hex. 입력이 이상하면 검정.
 */
export function legendTextColor(rgb: readonly number[] | null | undefined): "#000000" | "#ffffff" {
  if (!rgb || rgb.length < 3 || !rgb.slice(0, 3).every((v) => Number.isFinite(v))) return "#000000";
  const lin = (c: number) => { const v = Math.min(255, Math.max(0, c)) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#000000" : "#ffffff";
}
