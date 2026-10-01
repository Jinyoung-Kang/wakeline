/**
 * 선박 카드 · 선박 표에서만 쓰는 표시 함수와 문구(ADR-026 — 첫 화면 JS 에서 뺐다). 이 모듈은 나중에 받는 조각(components/ShipCard · ShipTable —
 * components/DashboardParts)만 싣는다 — 첫 화면(수신 검증 · 지도 · 상태 줄 · 검색)이 쓰는 선박 코드는 lib/ships 에 있다.
 * 여기 있어야 하는 이름은 tests/first-screen-lazy.test.ts 의 SHIP_CARD_ONLY 가 본다.
 */
import {
  aisText, type AisGap, type DestinationInfo, type DestPlace, FLAG_STATE_NO_MIN, fmtDestPlace, NO_ORIGIN_TEXT, normalizeDestination, parseDestinationInfo, parseShipState,
  parseShipStatic, type PositionSource, SHIP_CATEGORY_LABEL, shipCategory, type ShipCategory, type ShipLite, type ShipRow, type ShipSort, type ShipState, type ShipStatic,
  type StaticSource,
} from "./ships";

// ---- REST /ships/{mmsi} 상세(카드) ----

/**
 * REST /ships/{mmsi} 상세. first_recorded_at = 이 서비스가 이 MMSI 를 처음 기록한 시각, last_position_at = DB 에 저장된 마지막 위치 시각
 * (보존 72 h 안 — 없으면 null), last_seen_at = 실시간이 아닐 때의 마지막 수신 기록(계약 v5 §G4 — 없으면 null). 계약 v5 §B3 카드 행.
 * static_source = 정적 정보의 출처(계약 v5 §G17 — live · stored, static 이 있을 때만), static_updated_at = stored 일 때 저장 행의 updated_at.
 */
export interface ShipDetail {
  mmsi: string; state: ShipState | null; static: ShipStatic | null; static_source: StaticSource | null; static_updated_at: string | null;
  destination_info: DestinationInfo | null; db_unavailable: boolean;
  first_recorded_at: string | null; last_position_at: string | null; last_seen_at: string | null;
}

const isoOrNull = (v: unknown) => (typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);

/** REST /ships/{mmsi} 응답 검증(모양이 다르면 null — 모르는 값을 채우지 않는다) */
export function parseShipDetail(mmsi: string, r: unknown): ShipDetail {
  const o = typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {};
  const st = parseShipState(typeof o.state === "object" && o.state !== null ? { mmsi, ...(o.state as object) } : null);
  const sx = parseShipStatic(typeof o.static === "object" && o.static !== null ? { mmsi, ...(o.static as object) } : null);
  const meta = typeof o.meta === "object" && o.meta !== null ? (o.meta as Record<string, unknown>) : {};
  const stat = sx?.mmsi === mmsi ? sx : null;
  // 출처는 정적 정보가 있을 때만, 시각은 stored 일 때만(REST 는 live · stored 뿐 — 그 밖은 모름)
  const source: StaticSource | null = stat && (o.static_source === "live" || o.static_source === "stored") ? o.static_source : null;
  return {
    mmsi, state: st?.mmsi === mmsi ? st : null, static: stat, static_source: source,
    static_updated_at: source === "stored" ? isoOrNull(o.static_updated_at) : null,
    destination_info: parseDestinationInfo(o.destination_info), db_unavailable: meta.db_unavailable === true,
    first_recorded_at: isoOrNull(o.first_recorded_at), last_position_at: isoOrNull(o.last_position_at), last_seen_at: isoOrNull(o.last_seen_at),
  };
}

// ---- 저장된 정적 보고 문구(계약 v5 §G17 · §G19) ----

/** 카드 설명(title) — 왜 저장값인지 · 시각이 무엇이고 언제 새로 기록되는지(입출항은 조건이 있어 본문 한 줄 — storedPortCallsNote) */
export const STORED_STATIC_TITLE =
  "실시간 선박 스트림(보존 최대 2.5 h — 서버가 다시 시작한 뒤처럼)에 이 선박의 정적 보고가 아직 없어, DB 에 저장된 마지막 AIS 정적 보고를 보입니다(실시간 값이 아님). "
  + "시각은 DB(ship.updated_at)에 기록된 수신 시각 — 이 행에 마지막으로 정적 보고를 저장한 메시지를 받은 때입니다. 그 메시지가 싣지 않은 부분(예: Class B 의 "
  + "선명 조각만 받았을 때의 호출부호 · 선종 · 크기)은 그보다 앞서 저장된 보고의 값입니다. 내용이 바뀔 때뿐 아니라 수집기가 다시 시작했거나 "
  + "이 선박이 수집기 메모리에서 빠졌다가(30분 넘게 수신 없음 · 선박 수 상한) 다시 잡힐 때도 같은 내용이 새 시각으로 기록되고, 그 밖의 같은 내용 재수신은 기록하지 않으므로 "
  + "이 내용의 첫 수신도 마지막 수신도 아닙니다. 스트림에 정적 보고가 오면 실시간 값으로 바뀝니다";

/**
 * 저장 정적 보고 표시의 본문 한 줄(계약 v5 §G19 · 리뷰): 아래 필드는 DB 에 저장된 값이다. 저장 행은 받은 필드만 덮으므로 위 시각(마지막으로 저장한 보고)의
 * 보고가 싣지 않은 필드는 그보다 앞서 저장된 보고의 값이다 — '이 보고의 값' 은 모든 필드가 그 시각의 한 보고인 것처럼 읽혔다.
 */
export const STORED_STATIC_FIELDS_TEXT =
  "실시간 값이 아님 — 아래 선박명 · 호출부호 · IMO · 선종 · 크기 · 흘수 · 목적지 · ETA 는 DB 에 저장된 값이고, 위 시각의 보고가 싣지 않은 필드는 그보다 앞서 저장된 보고의 값";

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

// ---- 정적 보고 표시(ETA · 크기 · 흘수 · 항해 상태 · 위치 출처 · IMO · 선종) ----

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
 * ETA(계약 v2 §B4): 선원이 입력한 월·일·시·분(연도 없음 — 입력 형식은 UTC 벽시계). 화면은 한국 표준시로 바꿔 적는다(계약 v5 §G20 — 화면에 UTC 를
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

export function fmtShipType(code: number | null | undefined): string {
  if (code == null) return "— (미보고)";
  const c = shipCategory(code);
  return `${code} · ${SHIP_CATEGORY_LABEL[c]}`;
}

// ---- 출발지·목적지 줄(계약 v4 §B) ----

/**
 * 보이는 목적지 원문(static.destination)과 같은 원문을 풀이한 destination_info 만 고른다(앞의 것 우선 — WS 가 REST 보다 새롭다).
 * 원문이 다르면(정적 정보가 바뀐 직후 등) 풀이를 쓰지 않는다 — 다른 목적지의 풀이를 붙이지 않는다.
 */
export function pickDestinationInfo(rawDestination: string | null | undefined, ...candidates: (DestinationInfo | null | undefined)[]): DestinationInfo | null {
  const want = normalizeDestination(rawDestination);
  if (!want) return null;
  return candidates.find((c): c is DestinationInfo => c != null && normalizeDestination(c.raw) === want) ?? null;
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
  const raw = aisText(rawDestination ?? null, 64);
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

// ---- 항적 창 · 수신 공백 요약 ----

/** 선택 선박 항적 창 기본값 — REST ≤ 24 h(계약). 선박은 느려 6 h 면 대개 충분하고 60 s 에 1점이라 ≤ 360 점. */
export const SHIP_TRACK_WINDOW_MS = 6 * 3600_000;

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

// ---- 선박 표(계약 v5 §B3) ----

/** 마지막 수신 기록(§G4)의 뜻 — 카드·표의 설명(title) */
export const LAST_SEEN_TITLE =
  "이 서비스가 이 선박의 AIS 메시지(위치·정적 정보)를 마지막으로 받은 기록(api last_seen_at). 위치로는 10분에 한 번만 기록하므로 저장된 위치가 더 늦으면 그 시각 — 실제 마지막 수신은 이보다 조금 늦을 수 있음";

export const SHIP_SORT_DEFAULT: ShipSort = { key: "name", dir: "asc" };

export function shipRowFromLite(s: ShipLite): ShipRow {
  return { mmsi: s.mmsi, name: s.name, category: shipCategory(s.ship_type), sog_kn: s.sog_kn, nav_status: s.nav_status, live: true, seen_at: s.seen_at, last_position_at: null, last_seen_at: null };
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
