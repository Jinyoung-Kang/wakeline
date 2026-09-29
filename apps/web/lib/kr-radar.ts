/**
 * 기상청 합성 레이더의 합성 크기 · 부분 합성 표시(ADR-021).
 * 합성은 tm 마다 일찍 올라오고 레이더 지점이 보고하는 대로 채워지기도 한다(2026-09-29 관찰). 화면은 프레임마다 합성 크기를 명시하고("합성 12/15곳"),
 * 부분 합성 프레임은 숨기지 않되(실자료) 완전한 것처럼 보이지 않게 경고한다. 값은 모두 서버가 준 프레임 필드 — 지점 수를 모르면 "—"(단위 없음),
 * 다시 받기 기한(refetch_until)이나 지금 시각을 모르면 기한 문장을 붙이지 않는다(지어내지 않는다).
 * 어디에도 '완전'이라고 하지 않는다: partial=false 는 "기준 도달"(지난 60분 저장 프레임 중 최대와 같음)일 뿐, 기상청 합성이 완전한지는 자료에 없다.
 * 기준이 그 프레임 하나뿐이면 수집기가 판정을 두지 않는다(REF_MIN_SUPPORT) — "판정 —".
 */
import { fmtDualCompact, kstWallMs } from "./time";
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
    const hm = Number.isFinite(until) ? fmtDualCompact(until) : null; // "08:40 KST · 23:40Z"
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

/** tm(YYYYMMDDHHMM — 기상청이 준 KST 벽시계) → "HH:MM KST · HH:MMZ"(같은 순간의 UTC 를 함께). 틀리면 "—". */
export function krTmClock(tm: string | null | undefined): string {
  return fmtDualCompact(kstWallMs(tm));
}
