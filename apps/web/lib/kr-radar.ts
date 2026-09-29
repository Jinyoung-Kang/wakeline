/**
 * 기상청 합성 레이더의 합성 크기 · 부분 합성 표시(ADR-021).
 * 합성은 tm 마다 일찍 올라오고 레이더 지점이 보고하는 대로 채워진다(2026-09-29 관찰). 화면은 프레임마다 합성 크기를 명시하고("합성 12/15곳"),
 * 부분 합성 프레임은 숨기지 않되(실자료) 완전한 것처럼 보이지 않게 경고한다. 값은 모두 서버가 준 프레임 필드 — 지점 수를 모르면 "—"(단위 없음),
 * 다시 받기 기한(refetch_until)이나 지금 시각을 모르면 '다시 받음 · 채워지지 않음' 문장을 붙이지 않는다(지어내지 않는다).
 */
import type { KrRadarFrame } from "./types";

/** 기준 지점 수를 세는 창(분) — 수집기 jobs/kma_radar.py REF_WINDOW_S(선택값)와 같다(tests/kma-partial 이 견준다). 설명 글자에만 쓴다. */
export const KR_REF_WINDOW_MIN = 60;

export type KrCompositeState = "full" | "filling" | "final" | "partial" | "unknown";

export interface KrComposite {
  /** "합성 12/15곳" · "합성 12곳 · 기준 —" · "합성 —" */
  label: string;
  /** full 완전 · filling 부분(기한 전 — 다시 받음) · final 부분(기한 지남) · partial 부분(기한·시각 모름) · unknown 판정 없음 */
  state: KrCompositeState;
  /** 부분 합성 경고 문장(부분 합성일 때만) */
  warn: string | null;
  /** 툴팁: 합성 지점 · 기준 · 지점 코드 · 다시 받기 기록 · 경고 */
  title: string;
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

export function krComposite(f: KrRadarFrame | null | undefined, nowMs: number): KrComposite {
  const n = count(f?.stations);
  const m = count(f?.stations_ref);
  const label = n == null ? "합성 —" : m == null ? `합성 ${n}곳 · 기준 —` : `합성 ${n}/${m}곳`;
  let state: KrCompositeState = "unknown";
  let warn: string | null = null;
  if (f?.partial === true) {
    const until = f.refetch_until ? Date.parse(f.refetch_until) : NaN;
    const size = n != null && m != null ? `(${n}/${m}곳)` : "";
    if (nowMs > 0 && Number.isFinite(until)) {
      state = nowMs <= until ? "filling" : "final";
      warn = `일부 지점만 합성${size} — ${state === "filling" ? "기상청이 아직 채우는 중, 다음 주기에 다시 받음" : "끝까지 채워지지 않음"}`;
    } else {
      state = "partial";
      warn = `일부 지점만 합성${size}`;
    }
  } else if (f?.partial === false && n != null && m != null) {
    state = "full";
  }
  const lines = [n == null ? "합성 지점 수 모름(이 프레임을 받은 수집기가 기록하지 않음)"
    : `합성 지점 ${n}곳 / 기준 ${m ?? "—"}${m == null ? "" : "곳"}(지난 ${KR_REF_WINDOW_MIN}분 저장 프레임 중 최대 — 수집기 선택값)`];
  const ids = Array.isArray(f?.station_ids) ? f.station_ids.filter((x) => typeof x === "string") : [];
  if (ids.length) lines.push(`지점: ${ids.join(", ")}`);
  const re = count(f?.refetches);
  const up = count(f?.upgrades);
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

/** tm(YYYYMMDDHHMM, KST) → "HH:MM KST". 틀리면 "—". */
export function krTmClock(tm: string | null | undefined): string {
  return tm && /^\d{12}$/.test(tm) ? `${tm.slice(8, 10)}:${tm.slice(10, 12)} KST` : "—";
}
