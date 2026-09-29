/**
 * 화면 시각의 한 곳 — 한국 표준시(KST)만(사용자 결정 2026-09-30 "[상황판·재생·통계·공항 화면]을 포함한 필요한 메뉴에 시각을 UTC 지우고, KST 표시" —
 * 계약 v5 §G19 가 §G13 의 "KST 먼저 · UTC 함께" 를 대신한다). 모든 화면(상황판 · 재생 · 통계 · 공항 · 운영 · 로그 · 출처 · 설명서 · 오류 화면)이 이 모듈을 쓴다.
 * 화면 시간대는 DISPLAY_TZ 한 곳이 정한다. UTC 는 저장 · 전송 형식(API · WS · DB · 서버 로그)으로만 남고 화면 글자 · title 에는 나오지 않는다.
 * - inline "09-29 14:02:54 KST"(fmtKst) · 날짜가 자명한 자리 "14:02:54 KST"(fmtKstClock) · 좁은 자리(상태 바 · 지도 툴팁) "14:02 KST"(fmtKstMinute)
 * - 표 칸 "09-29 14:02:54"(kstCell + <KstTime variant="cell"> — 머리글 "(KST)", 화면 읽기에는 "… KST")
 * - 구간: 끝에 한 번 "09-29 10:00:00 – 09-29 14:00:00 KST"(fmtKstRange) · hh:mm 구간 "08:40–08:45 KST"(fmtKstSpan)
 * - title: 연도 · ms 까지의 같은 순간 "2026-09-29 08:41:14.906 KST"(fmtTimeTitle) · <time dateTime> 은 ISO 8601 +09:00
 * - 모르면 "—" 만(시간대 글자도 붙이지 않는다)
 * - 날짜만(원천이 날짜만 줬을 수 있는 KST 자정 — isKstMidnight): "09-29 KST"(fmtKstDateOnly)
 * - 날짜로 센 집계: 우리 집계는 KST 날짜(kstDayOf · kstDayHours — 통계 · 품질 규칙 일별 수). 경계가 UTC 날로 정해진 것(공급자 예산 날 — 수집기의 UTC 날
 *   예산 키)은 KST 날짜로 이름만 바꾸지 않고 그 창을 KST 로 적는다(utcDayWindowKst "09-29 09:00 – 09-30 08:59 KST").
 * 바꾸지 않는 것(화면 시각이 아니다): METAR · TAF · SIGMET 원문 · 서버 로그 메시지 본문(발표 · 기록된 그대로), 복사 · 내려받기 형식(머리 줄 ISO +09:00, JSON 의 ts).
 * 계산: 고정 오프셋 +09:00(lib/kst — 1988년 뒤로 일광 절약 없음, tz 데이터베이스와 대조한 시험 있음). Intl 을 쓰지 않는다 — 보는 사람의 시간대 ·
 * ICU 자료와 상관없이 같은 글자이고 형식기 생성 비용이 없다. 같은 입력의 분해 결과는 작은 캐시에 둔다(표가 매초 같은 시각을 다시 그린다).
 */
import { isoKst, KST_OFFSET_MS } from "./kst";

/** 화면 시간대(한 곳) — 글자 이름 · 이름 · tz 데이터베이스 이름 · 오프셋. 모든 형식기가 이 값으로 이름표를 단다 */
export const DISPLAY_TZ = { label: "KST", name: "한국 표준시", iana: "Asia/Seoul", offsetMs: KST_OFFSET_MS } as const;
const ZONE = DISPLAY_TZ.label;

export type TimeIn = string | number | null | undefined;

interface Wall { ymd: string; md: string; hm: string; hms: string; ms3: string }
/** 한 순간의 화면 시간대 벽시계: ms = epoch ms, iso = ISO 8601 +09:00(ms 까지) */
export interface TimeParts { ms: number; iso: string; wall: Wall }

const wallOf = (iso: string): Wall => ({ ymd: iso.slice(0, 10), md: iso.slice(5, 10), hm: iso.slice(11, 16), hms: iso.slice(11, 19), ms3: iso.slice(19, 23) });

/** 분해 캐시 상한 — 넘으면 비운다(가장 단순한 상한, 화면 하나의 시각 수보다 넉넉히) */
export const TIME_CACHE_MAX = 2048;
const partsCache = new Map<string | number, TimeParts | null>();
export const timeCacheSize = () => partsCache.size;

function computeParts(v: string | number): TimeParts | null {
  const t = new Date(v).getTime();
  if (!Number.isFinite(t)) return null;
  const iso = isoKst(t); // 0000–9999 년만(그 밖 · Date 범위 밖은 null)
  return iso == null ? null : { ms: t, iso, wall: wallOf(iso) };
}

/** 시각(ISO 문자열 · 숫자는 epoch ms) → 화면 시간대 벽시계. 읽을 수 없으면 null */
export function timeParts(v: TimeIn): TimeParts | null {
  if (v == null || v === "" || (typeof v === "number" && !Number.isFinite(v))) return null;
  const hit = partsCache.get(v);
  if (hit !== undefined) return hit;
  const p = computeParts(v);
  if (partsCache.size >= TIME_CACHE_MAX) partsCache.clear();
  partsCache.set(v, p);
  return p;
}

export interface KstOpts {
  /** 날짜(기본 true — MM-DD) */
  date?: boolean;
  /** 날짜에 연도(YYYY-MM-DD) — 30일을 오가는 재생 시각 · 캡처 시각 */
  year?: boolean;
  /** 초(기본 true) */
  seconds?: boolean;
  /** 밀리초(로그 목록 — 같은 초의 순서가 보인다) */
  ms?: boolean;
}

const clockOf = (w: Wall, o: KstOpts) => (o.ms ? `${w.hms}${w.ms3}` : o.seconds === false ? w.hm : w.hms);
/** 시간대 이름 없는 벽시계 글자(표 칸 · 구간의 앞쪽) */
const wallText = (p: TimeParts, o: KstOpts) => `${o.date === false ? "" : `${o.year ? p.wall.ymd : p.wall.md} `}${clockOf(p.wall, o)}`;

/** inline "09-29 14:02:54 KST"(date · year · seconds · ms 로 바꾼다). 모르면 "—" */
export function fmtKst(v: TimeIn, o: KstOpts = {}): string {
  const p = timeParts(v);
  return p ? `${wallText(p, o)} ${ZONE}` : "—";
}
/** 날짜가 자명한 자리(방금 받은 응답의 '갱신' 시각 등) "14:02:54 KST". 모르면 "—" */
export const fmtKstClock = (v: TimeIn): string => fmtKst(v, { date: false });
/** 좁은 자리(상태 바 · 지도 툴팁 · 레이더 프레임) 분까지 "14:02 KST" — date 면 "09-29 14:02 KST". 모르면 "—" */
export const fmtKstMinute = (v: TimeIn, o: { date?: boolean } = {}): string => fmtKst(v, { date: o.date === true, seconds: false });

/** 지금과 같은 KST 날짜면 날짜를 빼고, 아니면(또는 지금을 모르면) 붙인 분 형식 — 어제 시각이 오늘처럼 보이지 않게. 모르면 "—" */
export function fmtKstDayMinute(v: TimeIn, nowMs: number): string {
  const p = timeParts(v);
  if (!p) return "—";
  const today = nowMs > 0 ? timeParts(nowMs) : null;
  return fmtKstMinute(v, { date: !(today && today.wall.ymd === p.wall.ymd) });
}

/** hh:mm 구간(지도 선 라벨 · AIS 공백 배지) "08:40–08:45 KST". 한쪽을 모르면 그쪽만 "—", 둘 다 모르면 "—" */
export function fmtKstSpan(a: TimeIn, b: TimeIn): string {
  const x = timeParts(a), y = timeParts(b);
  if (!x && !y) return "—";
  return `${x ? x.wall.hm : "—"}–${y ? y.wall.hm : "—"} ${ZONE}`;
}
/** 끝이 없는 구간의 시작 "08:40 KST 부터". 모르면 "—" */
export function fmtKstFrom(a: TimeIn): string {
  const s = fmtKstMinute(a);
  return s === "—" ? s : `${s} 부터`;
}

/**
 * 구간의 두 쪽(따로 그릴 때 — 쪽마다 줄바꿈 없이): { from: "09-29 10:00:00", to: "09-29 14:00:00 KST" }(시간대는 끝에 한 번).
 * 한쪽만 알면 그쪽이 시간대를 달고 모르는 쪽은 "—"(open 을 주면 끝이 없는 구간을 그 글자로). 둘 다 모르면 { from: "—", to: "—" }.
 */
export function kstRangeParts(a: TimeIn, b: TimeIn, o: { open?: string; seconds?: boolean } = {}): { from: string; to: string } {
  const x = timeParts(a), y = timeParts(b);
  const w: KstOpts = { seconds: o.seconds };
  if (x && y) return { from: wallText(x, w), to: `${wallText(y, w)} ${ZONE}` };
  const end = b == null && o.open ? o.open : "—";
  if (x) return { from: `${wallText(x, w)} ${ZONE}`, to: end };
  if (y) return { from: "—", to: `${wallText(y, w)} ${ZONE}` };
  return { from: "—", to: "—" };
}
/** 구간 "09-29 10:00:00 – 09-29 14:00:00 KST" · 한쪽만 알면 "09-29 08:00:00 KST – —" · 둘 다 모르면 "— – —" */
export function fmtKstRange(a: TimeIn, b: TimeIn, o: { open?: string; seconds?: boolean } = {}): string {
  const r = kstRangeParts(a, b, o);
  return `${r.from} – ${r.to}`;
}

/** 표 칸: { text: "09-29 14:02:54"(ms 면 ".906" 까지), iso: ISO +09:00 } — 시간대는 머리글 "(KST)" 가 말한다. 모르면 null */
export function kstCell(v: TimeIn, o: { ms?: boolean } = {}): { text: string; iso: string } | null {
  const p = timeParts(v);
  return p ? { text: wallText(p, { ms: o.ms }), iso: p.iso } : null;
}

/** 보인 시각의 title: 연도 · ms 까지의 같은 순간 "2026-09-29 08:41:14.906 KST". 모르면 undefined(title 없음) */
export function fmtTimeTitle(v: TimeIn): string | undefined {
  const p = timeParts(v);
  return p ? `${wallText(p, { year: true, ms: true })} ${ZONE}` : undefined;
}
/** 구간의 title "a – b"(연도 · ms 까지, 모르는 쪽은 "—"). 둘 다 모르면 undefined */
export function fmtRangeTitle(a: TimeIn, b: TimeIn): string | undefined {
  const x = fmtTimeTitle(a), y = fmtTimeTitle(b);
  return x == null && y == null ? undefined : `${x ?? "—"} – ${y ?? "—"}`;
}

/**
 * KST 벽시계로 자정(00:00:00.000)인 순간인지 — 원천이 날짜만 줬을 수 있는 값(예: PORT-MIS 신고 시각 "…T00:00:00+09:00", ADR-022 — 날짜만 신고했는지
 * 자정인지 원천이 구분하지 않는다). 모르면 false.
 */
export function isKstMidnight(v: TimeIn): boolean {
  const p = timeParts(v);
  return p != null && p.wall.hms === "00:00:00" && p.wall.ms3 === ".000";
}
/** 날짜만(시각을 모르는 값) "09-29 KST"(year 면 "2026-09-29 KST"). 모르면 "—". 시각이 있는 값에는 쓰지 않는다(그때는 fmtKst · KstTime) */
export function fmtKstDateOnly(v: TimeIn, o: { year?: boolean } = {}): string {
  const p = timeParts(v);
  return p ? `${o.year ? p.wall.ymd : p.wall.md} ${ZONE}` : "—";
}

// ---- 날짜(집계 단위) ----

/** 순간의 KST 날짜 "YYYY-MM-DD"(통계 · 품질 규칙 일별 수의 날짜 — 계약 v5 §G19). 모르면 null */
export function kstDayOf(v: TimeIn): string | null {
  return timeParts(v)?.wall.ymd ?? null;
}

/** "YYYY-MM-DD" 가 달력에 있는 날짜면 그날 00:00 을 UTC 벽시계로 본 epoch ms, 아니면 null(형식 오류 · 2월 30일 등 — 다른 날로 넘기지 않는다) */
function calendarDayMs(day: string | null | undefined): number | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day ? t : null;
}
/** KST 날짜 "YYYY-MM-DD" 가 시작하는 순간(그날 00:00 KST, epoch ms). 달력에 없으면 null */
export function kstDayStartMs(day: string | null | undefined): number | null {
  const t = calendarDayMs(day);
  return t == null ? null : t - KST_OFFSET_MS;
}
/** 달력에 있는 "YYYY-MM-DD" 인가 */
export const isCalendarDay = (day: string | null | undefined): boolean => calendarDayMs(day) != null;
/** 날짜 + n 일("YYYY-MM-DD"). 달력에 없으면 null */
export function addDays(day: string | null | undefined, n: number): string | null {
  const t = calendarDayMs(day);
  return t == null ? null : new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/** 통계 시간대별 막대 한 칸: label "07"(KST 시) · full "09-29 07시 KST"(툴팁 · 화면 읽기 표) */
export interface KstDayHour { label: string; full: string }
/**
 * KST 날짜 하루(day "YYYY-MM-DD" — 통계 집계 단위, 계약 v5 §G19)의 24개 시(00 → 23시, 막대 순서). 날짜를 모르면(없음 · 형식 오류 · 달력에 없는 날)
 * 시만("07시 KST") — 날짜를 지어내지 않는다.
 */
export function kstDayHours(day: string | null | undefined): KstDayHour[] {
  const md = calendarDayMs(day) == null ? null : day!.slice(5);
  return Array.from({ length: 24 }, (_, h) => {
    const label = String(h).padStart(2, "0");
    return { label, full: `${md ? `${md} ` : ""}${label}시 ${ZONE}` };
  });
}

/**
 * UTC 날 하나(day "YYYY-MM-DD" — 공급자 예산 날처럼 경계가 UTC 날로 정해진 묶음)를 그 창의 KST 로(분까지, 끝 = 다음 날 08:59): "09-29 09:00 – 09-30 08:59 KST".
 * KST 날짜로 이름만 바꾸지 않는다(다른 하루가 된다). 날짜를 모르면 null
 */
export function utcDayWindowKst(day: string | null | undefined): string | null {
  const t0 = calendarDayMs(day);
  return t0 == null ? null : fmtKstRange(t0, t0 + 86_400_000 - 60_000, { seconds: false });
}

/** 기상청 tm(KST 벽시계 "YYYYMMDDHHMM" — 기상청이 한국 표준시로 준다) → 순간(epoch ms). 형식이 틀리거나 달력에 없으면 null */
export function kstWallMs(tm: string | null | undefined): number | null {
  const m = typeof tm === "string" ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(tm) : null;
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const w = Date.UTC(y, mo - 1, d, h, mi);
  const b = new Date(w);
  const ok = b.getUTCFullYear() === y && b.getUTCMonth() === mo - 1 && b.getUTCDate() === d && b.getUTCHours() === h && b.getUTCMinutes() === mi;
  return ok ? w - KST_OFFSET_MS : null;
}

// ---- 복사 형식 · 원문 모양(화면 시각이 아니다) ----

/**
 * 발표 원문(METAR · TAF · SIGMET)의 보이는 이름표와 설명 — 원문 글자는 발표된 그대로(바꾸지 않는다). 안의 "…Z" 시각은 발표 형식이라 화면의 KST 와
 * 9시간 다르다는 것을 툴팁 없이도 읽히게 이름표를 단다(공항 카드 · 공항 화면 · SIGMET 카드 · 재생 상세가 같은 글자). 원문 요소에는 data-raw 를 단다
 * (tests/kst-only-screens.test.ts 가 원문 밖에서 UTC 시각을 찾을 때 그 요소만 뺀다).
 */
export const RAW_BULLETIN_LABEL = "원문 · 발표 그대로";
export const RAW_BULLETIN_TITLE = "발표된 원문 그대로(바꾸지 않음) — 안의 ‘…Z’ 시각은 발표 형식이다(KST = …Z + 9시간). 화면의 다른 시각은 모두 KST";

/** 오프셋을 붙인 ISO 8601 "2026-09-29T08:41:14.906+09:00"(ms 유지 — 복사 텍스트 · 로그 상세). 모르면 "—" */
export function fmtIsoKst(v: TimeIn): string {
  return timeParts(v)?.iso ?? "—";
}
/**
 * 발표 원문(METAR · TAF)의 시각 토큰 "DDHHMMZ"(발표된 그대로의 모양 — 일 · 시 · 분 + Z). 화면 시각이 아니라 원문 모양이다: 설명서 7장이 원문 글자 옆에
 * 같은 순간을 KST 로 보이는 예에 쓴다. 모르면 null
 */
export function fmtZuluToken(v: TimeIn): string | null {
  const p = timeParts(v);
  if (!p) return null;
  const z = new Date(p.ms).toISOString();
  return `${z.slice(8, 10)}${z.slice(11, 13)}${z.slice(14, 16)}Z`;
}

// ==== 옛 두 시간대 API(§G13) — 호출부를 옮기는 동안만. 옮긴 뒤 지운다 ====



/** 한 순간의 두 벽시계 */
export interface DualParts { ms: number; iso: string; kst: Wall; utc: Wall; sameDate: boolean }

const wall = (iso: string): Wall => ({ ymd: iso.slice(0, 10), md: iso.slice(5, 10), hm: iso.slice(11, 16), hms: iso.slice(11, 19), ms3: iso.slice(19, 23) });

/** 분해 캐시 상한 — 넘으면 비운다(가장 단순한 상한, 화면 하나의 시각 수보다 넉넉히) */
export const DUAL_CACHE_MAX = 2048;
const cache = new Map<string | number, DualParts | null>();
export const dualCacheSize = () => cache.size;

function compute(v: string | number): DualParts | null {
  const t = new Date(v).getTime();
  if (!Number.isFinite(t)) return null;
  const k = isoKst(t);
  if (k == null) return null;
  const iso = new Date(t).toISOString();
  if (iso.length !== 24) return null; // 0000–9999 년만
  const kst = wall(k), utc = wall(iso);
  return { ms: t, iso, kst, utc, sameDate: kst.ymd === utc.ymd };
}

/** 시각(ISO 문자열 · 숫자는 epoch ms) → 두 벽시계. 읽을 수 없으면 null */
export function dualParts(v: TimeIn): DualParts | null {
  if (v == null || v === "" || (typeof v === "number" && !Number.isFinite(v))) return null;
  const hit = cache.get(v);
  if (hit !== undefined) return hit;
  const p = compute(v);
  if (cache.size >= DUAL_CACHE_MAX) cache.clear();
  cache.set(v, p);
  return p;
}

export interface DualOpts {
  /** KST 쪽 날짜(기본 true — MM-DD) */
  date?: boolean;
  /** 날짜에 연도(YYYY-MM-DD) — 30일을 오가는 재생 시각 */
  year?: boolean;
  /** 초(기본 true) */
  seconds?: boolean;
  /** 밀리초(로그 목록 — 같은 초의 순서가 보인다) */
  ms?: boolean;
}

const clock = (w: Wall, o: DualOpts) => (o.ms ? `${w.hms}${w.ms3}` : o.seconds === false ? w.hm : w.hms);
const day = (w: Wall, o: DualOpts) => (o.year ? w.ymd : w.md);

/** 두 부분(따로 꾸밀 때): { kst: "09-29 08:41:14 KST", utc: "09-28 23:41:14 UTC", iso }. 모르면 null */
export function dualPair(v: TimeIn, o: DualOpts = {}): { kst: string; utc: string; iso: string } | null {
  const p = dualParts(v);
  if (!p) return null;
  const withDate = o.date !== false;
  const kst = `${withDate ? `${day(p.kst, o)} ` : ""}${clock(p.kst, o)} KST`;
  const utcDay = p.sameDate ? "" : `${withDate ? day(p.utc, o) : p.utc.md} `;
  return { kst, utc: `${utcDay}${clock(p.utc, o)} UTC`, iso: p.iso };
}

/** inline "09-29 14:02:54 KST · 05:02:54 UTC". 모르면 "—" */
export function fmtDual(v: TimeIn, o: DualOpts = {}): string {
  const x = dualPair(v, o);
  return x ? `${x.kst} · ${x.utc}` : "—";
}
/** 날짜가 자명한 자리(방금 받은 응답의 '갱신' 시각 등) "14:02:54 KST · 05:02:54 UTC" — UTC 날짜가 다르면 UTC 쪽에 날짜 */
export const fmtDualClock = (v: TimeIn) => fmtDual(v, { date: false });

/** compact 두 부분: { kst: "14:02 KST", utc: "05:02Z" } — UTC 날짜가 다르면 "09-28 23:41Z" */
export function dualPairCompact(v: TimeIn, o: { date?: boolean; seconds?: boolean } = {}): { kst: string; utc: string; iso: string } | null {
  const p = dualParts(v);
  if (!p) return null;
  const c = (w: Wall) => (o.seconds ? w.hms : w.hm);
  return { kst: `${o.date ? `${p.kst.md} ` : ""}${c(p.kst)} KST`, utc: `${p.sameDate ? "" : `${p.utc.md} `}${c(p.utc)}Z`, iso: p.iso };
}
/** compact(상태 바 · 지도 툴팁) "14:02 KST · 05:02Z". date: KST 날짜도, seconds: 초까지. 모르면 "—" */
export function fmtDualCompact(v: TimeIn, o: { date?: boolean; seconds?: boolean } = {}): string {
  const x = dualPairCompact(v, o);
  return x ? `${x.kst} · ${x.utc}` : "—";
}

/** 지금과 같은 KST 날짜면 KST 날짜를 빼고, 아니면(또는 지금을 모르면) 붙인 compact — 어제 시각이 오늘처럼 보이지 않게. 모르면 "—" */
export function fmtDualDayMinute(v: TimeIn, nowMs: number): string {
  const p = dualParts(v);
  if (!p) return "—";
  const today = nowMs > 0 ? dualParts(nowMs) : null;
  return fmtDualCompact(v, { date: !(today && today.kst.ymd === p.kst.ymd) });
}

/** hh:mm 구간(지도 선 라벨 · AIS 공백 배지) "08:40–08:45 KST · 23:40–23:45Z". UTC 날짜가 다르면 UTC 쪽 시작(끝 날짜가 다르면 끝에도)에. 둘 다 모르면 "—" */
export function fmtDualSpan(a: TimeIn, b: TimeIn): string {
  const x = dualParts(a), y = dualParts(b);
  if (!x && !y) return "—";
  const k = `${x ? x.kst.hm : "—"}–${y ? y.kst.hm : "—"} KST`;
  const anyDiff = (x && !x.sameDate) || (y && !y.sameDate);
  const endDay = x && y && x.utc.ymd !== y.utc.ymd;
  const ua = x ? `${anyDiff ? `${x.utc.md} ` : ""}${x.utc.hm}` : "—";
  const ub = y ? `${(anyDiff && !x) || endDay ? `${y.utc.md} ` : ""}${y.utc.hm}` : "—";
  return `${k} · ${ua}–${ub}Z`;
}
/** 끝이 없는 구간의 시작(compact) "08:40 KST · 09-28 23:40Z 부터". 모르면 "—" */
export function fmtDualFrom(a: TimeIn): string {
  const s = fmtDualCompact(a);
  return s === "—" ? s : `${s} 부터`;
}

/**
 * 구간 "MM-DD HH:MM:SS – MM-DD HH:MM:SS KST · HH:MM:SS – HH:MM:SS UTC"(시간대는 쪽마다 끝에 한 번). UTC 날짜는 한쪽이라도 KST 날짜와 다르면 양쪽에.
 * 한쪽을 모르면 아는 쪽만 두 시간대("09-29 08:00:00 KST · 09-28 23:00:00 UTC – —"), open 을 주면 끝이 없는 구간을 그 글자로. 둘 다 모르면 "— – —".
 */
export function fmtDualRange(a: TimeIn, b: TimeIn, o: { open?: string; seconds?: boolean } = {}): string {
  const both = dualRangePair(a, b, o);
  if (both) return `${both.kst} · ${both.utc}`;
  const x = dualParts(a), y = dualParts(b);
  const one = (v: TimeIn) => fmtDual(v, { seconds: o.seconds });
  if (x) return `${one(a)} – ${b == null && o.open ? o.open : "—"}`;
  if (y) return `— – ${one(b)}`;
  return "— – —";
}

/** 양쪽을 아는 구간의 두 부분(따로 꾸밀 때): { kst: "09-29 10:00:00 – 09-29 14:00:00 KST", utc: "01:00:00 – 05:00:00 UTC" }. 한쪽이라도 모르면 null */
export function dualRangePair(a: TimeIn, b: TimeIn, o: { seconds?: boolean } = {}): { kst: string; utc: string } | null {
  const x = dualParts(a), y = dualParts(b);
  if (!x || !y) return null;
  const c = (w: Wall) => (o.seconds === false ? w.hm : w.hms);
  const utcDates = !x.sameDate || !y.sameDate;
  const u = (p: DualParts) => `${utcDates ? `${p.utc.md} ` : ""}${c(p.utc)}`;
  return { kst: `${x.kst.md} ${c(x.kst)} – ${y.kst.md} ${c(y.kst)} KST`, utc: `${u(x)} – ${u(y)} UTC` };
}

/** 표 칸: { kst: "09-29 08:41:14", utc: "09-28 23:41:14 UTC" | "05:02:54 UTC", iso }. 첫 줄은 머리글 "(KST · UTC)" 가 시간대를 말한다. 모르면 null */
export function dualCell(v: TimeIn, o: { ms?: boolean } = {}): { kst: string; utc: string; iso: string } | null {
  const p = dualParts(v);
  if (!p) return null;
  const c = (w: Wall) => (o.ms ? `${w.hms}${w.ms3}` : w.hms);
  return { kst: `${p.kst.md} ${c(p.kst)}`, utc: `${p.sameDate ? "" : `${p.utc.md} `}${c(p.utc)} UTC`, iso: p.iso };
}


/** "YYYY-MM-DD" 가 달력에 있는 UTC 날짜면 그날 00:00 UTC(epoch ms), 아니면 null(형식 오류 · 2월 30일 등 — 다른 날로 넘기지 않는다) */
function utcDayMs(day: string | null | undefined): number | null {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day ? t : null;
}

/** 통계 시간대별 막대 한 칸의 두 시: kst "09" · utcTick "00Z"(둘째 줄) · full "09-28 09시 KST · 00시 UTC"(툴팁 · 화면 읽기 표) */
export interface UtcDayHour { kst: string; utcTick: string; full: string }

/**
 * UTC 날짜 하루(day "YYYY-MM-DD" — 통계 집계 단위)의 24개 시, UTC 00시 → 23시 순서(막대 순서). 칸마다 그 시의 KST 시와 같은 순간의 UTC 시.
 * full 은 KST 날짜와 함께, UTC 날짜가 KST 날짜와 다르면(KST 00–08시) UTC 쪽에도 날짜("09-29 00시 KST · 09-28 15시 UTC").
 * 날짜를 모르면(없음 · 형식 오류 · 달력에 없는 날) 시만("00시 KST · 15시 UTC") — 날짜를 지어내지 않는다. 시는 고정 오프셋이라 날짜와 상관없이 같다.
 */
export function utcDayHours(day: string | null | undefined): UtcDayHour[] {
  const t0 = utcDayMs(day);
  const h2 = (n: number) => String(n).padStart(2, "0");
  return Array.from({ length: 24 }, (_, h) => {
    const kh = h2((h + KST_OFFSET_MS / 3_600_000) % 24), uh = h2(h);
    const p = t0 == null ? null : dualParts(t0 + h * 3_600_000);
    const full = p ? `${p.kst.md} ${kh}시 KST · ${p.sameDate ? "" : `${p.utc.md} `}${uh}시 UTC` : `${kh}시 KST · ${uh}시 UTC`;
    return { kst: kh, utcTick: `${uh}Z`, full };
  });
}

/** UTC 날짜 하루가 두 시간대로 어디부터 어디까지인지(분까지, 끝 = 23:59 UTC): "09-28 09:00 – 09-29 08:59 KST · 09-28 00:00 – 09-28 23:59 UTC". 날짜를 모르면 null */
export function fmtUtcDayDual(day: string | null | undefined): string | null {
  const t0 = utcDayMs(day);
  return t0 == null ? null : fmtDualRange(t0, t0 + 86_400_000 - 60_000, { seconds: false });
}


// ---- 원본 · 복사 형식(바꾸지 않는다) ----

function isoOf(v: TimeIn): string | null {
  return dualParts(v)?.iso ?? null;
}
/** 원본 UTC ISO 전체("2026-09-28T23:41:14.906Z") — 로그 상세의 원본 칸. 모르면 "—" */
export function fmtIso(v: TimeIn) {
  return isoOf(v) ?? "—";
}
/** 보인 시각의 title: 원본 UTC ISO("원본 UTC 2026-09-28T23:41:14.906Z" — 서버 · 컨테이너 로그와 대조용, ms 까지). 모르면 undefined(title 없음) */
export function fmtUtcTitle(v: TimeIn): string | undefined {
  const s = isoOf(v);
  return s == null ? undefined : `원본 UTC ${s}`;
}
/** 구간의 title: "원본 UTC a – b"(모르는 쪽은 "—"). 둘 다 모르면 undefined */
export function fmtUtcRangeTitle(a: TimeIn, b: TimeIn): string | undefined {
  const x = isoOf(a), y = isoOf(b);
  return x == null && y == null ? undefined : `원본 UTC ${x ?? "—"} – ${y ?? "—"}`;
}
/** 시각이 title 에만 있는 자리(보이는 글자가 경과 등): "09-29 08:41:14 KST · 09-28 23:41:14 UTC (원본 2026-09-28T23:41:14.906Z)". 모르면 "—" */
export function fmtKstTitle(v: TimeIn) {
  const t = fmtDual(v);
  return t === "—" ? t : `${t} (원본 ${isoOf(v)})`;
}
