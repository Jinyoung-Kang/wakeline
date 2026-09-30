/**
 * 기상청 합성 레이더의 합성 크기 · 부분 합성 표시(ADR-021).
 * 합성은 tm 마다 일찍 올라오고 레이더 지점이 보고하는 대로 채워지기도 한다(2026-09-29 관찰). 화면은 프레임마다 합성 크기를 명시하고("합성 12/15곳"),
 * 부분 합성 프레임은 숨기지 않되(실자료) 완전한 것처럼 보이지 않게 경고한다. 값은 모두 서버가 준 프레임 필드 — 지점 수를 모르면 "—"(단위 없음),
 * 다시 받기 기한(refetch_until)이나 지금 시각을 모르면 기한 문장을 붙이지 않는다(지어내지 않는다).
 * 어디에도 '완전'이라고 하지 않는다: partial=false 는 "기준 도달"(지난 60분 저장 프레임 중 최대와 같음)일 뿐, 기상청 합성이 완전한지는 자료에 없다.
 * 기준이 그 프레임 하나뿐이면 수집기가 판정을 두지 않는다(REF_MIN_SUPPORT) — "판정 —".
 */
import { fmtKst, fmtKstMinute, fmtKstRange, fmtKstSpan, fmtTimeTitle, kstWallMs, timeParts } from "./time";
import type { KrRadarFrame } from "./types";

/** 기준 지점 수를 세는 창(분) — 수집기 jobs/kma_radar.py REF_WINDOW_S(선택값)와 같다(tests/kma-partial 이 견준다). 설명 글자에만 쓴다. */
export const KR_REF_WINDOW_MIN = 60;
/** '기준 도달' 판정에 필요한, 기준에 닿은 프레임 수 — 수집기 REF_MIN_SUPPORT(선택값)와 같다(tests/kma-partial 이 견준다). 설명 글자에만 쓴다. */
export const KR_REF_MIN_SUPPORT = 2;

/** at_ref 기준 도달(완전하다는 뜻이 아니다) · filling 부분(기한 전 — 다시 받기 대상) · final 부분(기한 지남) · partial 부분(기한·시각 모름) · unknown 판정 없음 */
export type KrCompositeState = "at_ref" | "filling" | "final" | "partial" | "unknown";

export interface KrComposite {
  /** "합성 12/15곳" · "합성 7/7곳 · 판정 —" · "합성 12곳 · 기준 —" · "합성 —" */
  label: string;
  state: KrCompositeState;
  /** 부분 합성 경고 문장(부분 합성일 때만) */
  warn: string | null;
  /** 툴팁: 합성 지점 · 기준 · 판정 · 지점 코드 · 다시 받기 기록 · 경고 */
  title: string;
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** 기한이 지난 부분 합성: 수집기의 기록(refetches)이 말하는 것만 — 다시 받았는데도 기준 미만 · 다시 받지 못함 · 모름. */
function afterDeadline(hm: string, re: number | null): string {
  if (re == null) return `다시 받기 기한 ${hm} 지남`;
  return re > 0 ? `기한 ${hm}까지 다시 받은 ${re}회에도 기준 미만` : `기한 ${hm} 안에 다시 받지 못함`;
}

export function krComposite(f: KrRadarFrame | null | undefined, nowMs: number): KrComposite {
  const n = count(f?.stations);
  const m = count(f?.stations_ref);
  const re = count(f?.refetches);
  const up = count(f?.upgrades);
  let state: KrCompositeState = "unknown";
  let warn: string | null = null;
  let verdict: string | null = null;
  if (f?.partial === true) {
    const until = f.refetch_until ? Date.parse(f.refetch_until) : NaN;
    const hm = Number.isFinite(until) ? fmtKstMinute(until) : null; // "08:40 KST"
    const size = n != null && m != null ? `(${n}/${m}곳)` : "";
    if (nowMs > 0 && hm != null) {
      state = nowMs <= until ? "filling" : "final";
      // 기한 전: 다시 받기 '대상' — 주기당 개수 · 예산 여유에 따라 실제로 다시 받는지는 조건부라 '다음 주기에 다시 받음' 이라고 하지 않는다
      warn = `일부 지점만 합성${size} — ${state === "filling" ? `${hm}까지 다시 받기 대상(지점이 늘면 바꿈)` : afterDeadline(hm, re)}`;
    } else {
      state = "partial";
      warn = `일부 지점만 합성${size}`;
    }
  } else if (f?.partial === false && n != null && m != null) {
    state = "at_ref";
    verdict = `기준 도달 — 지난 ${KR_REF_WINDOW_MIN}분 저장 프레임 중 최대와 같음(기상청 합성이 완전한지는 자료에 없음)`;
  } else if (n != null && m != null) {
    verdict = `판정 없음 — 기준(${m}곳)에 닿은 저장 프레임이 이 프레임뿐이거나(첫 프레임 · 공백 뒤) 판정 값이 없음 · '기준 도달'은 기준에 닿은 프레임이 ${KR_REF_MIN_SUPPORT}개 이상일 때만`;
  }
  const label = n == null ? "합성 —" : m == null ? `합성 ${n}곳 · 기준 —` : state === "unknown" ? `합성 ${n}/${m}곳 · 판정 —` : `합성 ${n}/${m}곳`;
  const lines = [n == null ? "합성 지점 수 모름(이 프레임을 받은 수집기가 기록하지 않음)"
    : `합성 지점 ${n}곳 / 기준 ${m ?? "—"}${m == null ? "" : "곳"}(지난 ${KR_REF_WINDOW_MIN}분 저장 프레임 중 최대 — 수집기 선택값)`];
  if (verdict) lines.push(verdict);
  const ids = Array.isArray(f?.station_ids) ? f.station_ids.filter((x) => typeof x === "string") : [];
  if (ids.length) lines.push(`지점: ${ids.join(", ")}`);
  if (re != null) lines.push(`다시 받음 ${re}회 · 지점이 늘어 바꿈 ${up ?? "—"}${up == null ? "" : "회"}`);
  if (warn) lines.push(warn);
  return { label, state, warn, title: lines.join("\n") };
}

/** 부분 합성 프레임 수: "k / 판정 있는 수"(+ " · 모름 u"). 판정이 하나도 없으면 "—". */
export function krPartialSummary(frames: readonly KrRadarFrame[]): string {
  const known = frames.filter((f) => typeof f.partial === "boolean");
  if (!known.length) return "—";
  const k = known.filter((f) => f.partial === true).length;
  const unknown = frames.length - known.length;
  return `${k} / ${known.length}${unknown ? ` · 모름 ${unknown}` : ""}`;
}

/** 지도 레이어 id: 영상 URL 의 버전(?v=)을 붙인다 — 같은 tm 을 다시 받아 바뀐 영상이 새 레이어로 그려지고 옛 부분 합성 영상은 지워진다. */
export function krLayerId(f: Pick<KrRadarFrame, "tm" | "url">): string {
  const v = /[?&]v=(\d+)/.exec(f.url)?.[1];
  return v ? `kmar-${f.tm}-${v}` : `kmar-${f.tm}`;
}

/** tm(YYYYMMDDHHMM — 기상청이 준 KST 벽시계) → "HH:MM KST"(계약 v5 §G20). 틀리면 "—". */
export function krTmClock(tm: string | null | undefined): string {
  return fmtKstMinute(kstWallMs(tm));
}

// ---- 기상청 내려받기 '파일 없음' 연속(운영 로그 2026-09-30) ----

/** 연속 동안 수집기가 가장 새 tm 과 함께 다시 확인하는 tm 의 나이 하한(분) — 수집기 jobs/kma_radar.py MISSING_RECHECK_S(선택값)와 같다(tests/kma-missing 이 견준다). 설명 글자에만 쓴다. */
export const KR_MISSING_RECHECK_MIN = 10;
/**
 * 마지막 확인이 이보다(분) 오래되면 '확인 멈춤' — 수집기 MISSING_CARRY_S(다시 띄운 수집기가 연속을 이어받는 상한, 선택값)와 같다(tests/kma-missing 이 견준다).
 * 연속 동안 수집기는 5분마다 확인한다 — 그보다 오래 확인이 없으면 수집기가 멈췄거나 목록 호출이 실패하는 중이라 연속이 지금도 맞는지 모른다(리뷰 2026-09-30).
 */
export const KR_MISSING_CHECK_STALE_MIN = 15;

/** 연속 한 건(krMissing) — 칩 낱말 · 한 줄 · 여러 줄 설명과 그 조각(상세 행). 값은 모두 api(수집기 확인) 그대로 */
export interface KrMissingInfo {
  /** 마지막 확인이 KR_MISSING_CHECK_STALE_MIN 분을 넘었으면 "파일 없음 · 확인 멈춤" */
  word: "파일 없음" | "파일 없음 · 확인 멈춤";
  /** "기상청 내려받기 파일(PUB) 없음 — tm 08:15–09:50 KST · 확인한 tm 20개 모두 없음 · 목록에는 EXT · 마지막 확인 09:50:31 KST" */
  text: string;
  /** 여러 줄: 무엇 · 첫/마지막 tm 과 센 것 · 기상청 답의 파일 · 목록 종류 · 마지막 확인(전체 순간) · 수집기가 하는 일 · (확인 멈춤) */
  title: string;
  /** 없다는 답을 받은 가장 이른 · 가장 새 tm "08:15–09:50 KST"(하나면 "09:50 KST") */
  range: string;
  since: string;
  last: string;
  /** 확인해서 없다는 답을 받은 서로 다른 tm 수(수집기가 센 것 — 그 사이 확인하지 않은 tm 은 들지 않는다) */
  tms: number;
  checkedAt: string;
  /** 마지막 확인이 KR_MISSING_CHECK_STALE_MIN 분을 넘었다(지금을 모르면 false — 판정하지 않는다) */
  stale: boolean;
  /** 기상청 답의 파일 이름(모르면 null) · 목록 종류 "EXT/KMA"(모르면 null) */
  file: string | null;
  listed: string | null;
}

const MISSING_FILE = /^RDR_CMP_[A-Z]+_([A-Z]+)_\d{12}\.bin\.gz$/;
const TM = /^\d{12}$/;

/** 두 tm 의 구간 "08:15–09:50 KST" — 지금과 KST 날짜가 다르면 "09-30 08:15–09:50 KST", 날짜를 넘으면 "09-29 23:50 – 09-30 00:10 KST" */
function tmRange(sinceMs: number, lastMs: number, today: string | undefined): string {
  const a = timeParts(sinceMs)!, b = timeParts(lastMs)!;
  if (sinceMs === lastMs) return fmtKstMinute(sinceMs, { date: a.wall.ymd !== today });
  if (a.wall.ymd === b.wall.ymd) return a.wall.ymd !== today ? `${a.wall.md} ${fmtKstSpan(sinceMs, lastMs)}` : fmtKstSpan(sinceMs, lastMs);
  return fmtKstRange(sinceMs, lastMs, { seconds: false });
}

/**
 * api 의 missing(기상청 내려받기 '파일 없음' 연속) → 글자. 핵심 값(첫 tm · 마지막 tm · 수 · 마지막 확인)이 틀리면 null — 일부만으로 까닭을 말하지 않는다.
 * 잰 것만 말한다(리뷰 2026-09-30): 없다는 답을 받은 가장 이른 · 가장 새 tm 의 구간과 "확인한 tm N개 모두 없음" — 그 구간의 tm 이 모두 N개라거나 모두
 * 없다고 하지 않는다(수집기는 연속 동안 주기마다 두 tm 만 확인한다).
 * 파일 이름 · 목록 종류는 기상청 글자 그대로일 때만 쓰고, 모르면 쓰지 않는다(짓지 않는다). 파일 종류(PUB 등)는 기상청 답의 파일 이름에서 읽는다 — 뜻을 풀지 않는다.
 * tm 은 기상청 KST 벽시계라 그대로 "HH:MM KST"(지금과 KST 날짜가 다르면 날짜도), 마지막 확인은 "HH:MM:SS KST"(마우스를 올리면 연도 · ms).
 * 마지막 확인이 KR_MISSING_CHECK_STALE_MIN 분을 넘으면(서버 기준 지금 — 모르면 판정하지 않는다) '확인 멈춤'을 붙인다: 수집기가 멈추면 연속을 지울 주체가 없다.
 */
export function krMissing(m: unknown, nowMs: number): KrMissingInfo | null {
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  const since = typeof o.since_tm === "string" && TM.test(o.since_tm) ? o.since_tm : null;
  const last = typeof o.last_tm === "string" && TM.test(o.last_tm) ? o.last_tm : null;
  const tms = typeof o.tms === "number" && Number.isInteger(o.tms) && o.tms >= 1 ? o.tms : null;
  // 마지막 확인은 시간대가 있는 ISO 만(없으면 브라우저 시간대로 읽혀 다른 순간이 된다 — api 는 늘 붙인다)
  const checkedMs = typeof o.checked_at === "string" && /(Z|[+-]\d\d:\d\d)$/.test(o.checked_at) && timeParts(o.checked_at) ? Date.parse(o.checked_at) : NaN;
  const sinceMs = kstWallMs(since), lastMs = kstWallMs(last);
  if (since == null || last == null || tms == null || !Number.isFinite(checkedMs) || sinceMs == null || lastMs == null || lastMs < sinceMs) return null;
  const checkedAt = o.checked_at as string;
  const file = typeof o.file === "string" && MISSING_FILE.test(o.file) ? o.file : null;
  const kind = file ? MISSING_FILE.exec(file)![1] : null;
  const kinds = Array.isArray(o.listed) && o.listed.length > 0 && o.listed.every((k) => typeof k === "string" && /^[A-Z]{1,8}$/.test(k)) ? (o.listed as string[]) : null;
  const listed = kinds ? kinds.join("/") : null;
  const today = nowMs > 0 ? timeParts(nowMs)?.wall.ymd : undefined;
  const clock = (ms: number) => fmtKstMinute(ms, { date: timeParts(ms)?.wall.ymd !== today });
  const checked = fmtKst(checkedMs, { date: timeParts(checkedMs)?.wall.ymd !== today, seconds: true });
  const stale = nowMs > 0 && nowMs - checkedMs > KR_MISSING_CHECK_STALE_MIN * 60_000;
  const range = tmRange(sinceMs, lastMs, today);
  const head = `기상청 내려받기 파일${kind ? `(${kind})` : ""} 없음`;
  const counted = `확인한 tm ${tms}개 ${tms === 1 ? "" : "모두 "}없음`;
  const text = `${head} — tm ${range} · ${counted}${listed ? ` · 목록에는 ${listed}` : ""} · 마지막 확인 ${checked}`
    + (stale ? ` — ${KR_MISSING_CHECK_STALE_MIN}분 넘게 다시 확인하지 않음(확인 멈춤)` : "");
  const title = [
    `${head} — 기상청 목록에는 tm 이 있는데 내려받기가 '파일 없음'으로 답함(수집기 확인)`,
    `첫 tm ${clock(sinceMs)} · 마지막 tm ${clock(lastMs)}(없다는 답을 받은 가장 이른 · 가장 새 tm) · 확인한 서로 다른 tm ${tms}개 ${tms === 1 ? "" : "모두 "}없음 — 확인하지 않은 tm 은 세지 않음`,
    file ? `기상청 답의 파일: ${file}` : "기상청 답의 파일 이름 모름",
    kinds ? `목록의 파일 종류: ${kinds.join(", ")}` : "목록의 파일 종류 모름",
    `마지막 확인 ${fmtTimeTitle(checkedMs) ?? "—"}`,
    `그동안 수집기가 주기마다 목록의 가장 새 tm 과 ${KR_MISSING_RECHECK_MIN}분 넘게 앞선 가장 새 tm 만 확인(수집기 선택값) — 파일이 다시 오면 이 표시는 사라짐`,
    ...(stale ? [`마지막 확인 뒤 ${KR_MISSING_CHECK_STALE_MIN}분 넘게 확인 없음 — 지금도 없는지는 모름(수집기가 멈췄거나 목록 호출이 실패하는 중일 수 있다 · 기준은 수집기 선택값과 같다)`] : []),
  ].join("\n");
  return {
    word: stale ? "파일 없음 · 확인 멈춤" : "파일 없음", text, title, range, since: clock(sinceMs), last: clock(lastMs), tms, checkedAt, stale, file, listed,
  };
}
