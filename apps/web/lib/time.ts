/**
 * 화면 시각의 한 곳(사용자 요청 2026-09-29 "UTC 와 KST 함께 표시" — 계약 v5 §G10 · §G11 의 "KST 만, 원본 UTC 는 툴팁" 을 대신한다, §G13).
 * 한국 표준시(KST)를 먼저, 같은 순간의 UTC 를 함께 보인다. 모든 화면(상황판 · 재생 · 통계 · 공항 · 운영 · 로그 · 오류 화면)이 이 모듈을 쓴다.
 * - inline  "09-29 14:02:54 KST · 05:02:54 UTC"(fmtDual) · 날짜가 자명한 자리 "14:02:54 KST · 05:02:54 UTC"(fmtDualClock)
 * - compact "14:02 KST · 05:02Z"(fmtDualCompact — 상태 바 · 지도 툴팁 · 지도 선 라벨)
 * - cell    첫 줄 KST "09-29 14:02:54" · 둘째 줄 흐린 "05:02:54 UTC"(dualCell + <DualTime variant="cell"> — 표 칸이 넓어지지 않게, 머리글 "(KST · UTC)")
 * - 구간     "09-29 10:00:00 – 09-29 14:00:00 KST · 01:00:00 – 05:00:00 UTC"(fmtDualRange) · hh:mm 구간 "08:40–08:45 KST · 23:40–23:45Z"(fmtDualSpan)
 * - UTC 날짜가 KST 날짜와 다르면(KST 00:00–08:59) UTC 쪽에 날짜를 붙인다 — "08:41:14 KST · 09-28 23:41:14 UTC". 구간은 한쪽이라도 다르면 양쪽에.
 * - 모르면 "—" 만(시간대 글자도 붙이지 않는다). title 에는 원본 UTC ISO(fmtUtcTitle — 서버 · 컨테이너 로그와 대조, ms 까지).
 * 바꾸지 않는 것: METAR · TAF · SIGMET 원문(발표된 그대로), 통계의 UTC 날짜 "(UTC 날짜)", 복사 · 내려받기 형식(머리 줄 ISO +09:00, JSON 의 UTC ts).
 * 계산: 고정 오프셋 +09:00(lib/kst — 1988년 뒤로 일광 절약 없음, tz 데이터베이스와 대조한 시험 있음). Intl 을 쓰지 않는다 — 보는 사람의 시간대 ·
 * ICU 자료와 상관없이 같은 글자이고 형식기 생성 비용이 없다. 같은 입력의 분해 결과는 작은 캐시에 둔다(표가 매초 같은 시각을 다시 그린다).
 */
import { isoKst, KST_OFFSET_MS } from "./kst";

export type TimeIn = string | number | null | undefined;

interface Wall { ymd: string; md: string; hm: string; hms: string; ms3: string }
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

// ---- 원본 · 복사 형식(바꾸지 않는다) ----

function isoOf(v: TimeIn): string | null {
  return dualParts(v)?.iso ?? null;
}
/** 원본 UTC ISO 전체("2026-09-28T23:41:14.906Z") — 로그 상세의 원본 칸. 모르면 "—" */
export function fmtIso(v: TimeIn) {
  return isoOf(v) ?? "—";
}
/** 오프셋을 붙인 ISO 8601 "2026-09-29T08:41:14.906+09:00"(ms 유지 — 복사 텍스트 · 상세). 모르면 "—" */
export function fmtIsoKst(v: TimeIn) {
  return isoKst(v) ?? "—";
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
