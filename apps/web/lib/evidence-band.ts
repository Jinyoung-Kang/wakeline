/**
 * 알림 근거의 고도대 · 출처(근거 카드 — 알림 행을 펼친 뒤에만 보이는 조각, components/EvidenceCard). lib/alerts 는 알림 패널(첫 화면)이 쓰므로
 * 카드 전용인 이 함수들은 여기에 둔다 — 첫 화면 JS 에 싣지 않는다(ADR-026 · tests/first-screen-lazy CARRIED_BY_PARTS).
 */
import type { BandSource } from "./format";
import { topAboveFromRaw } from "./sigmet";
import type { SigmetProps } from "./types";

/** 근거의 고도대 [base, top]. top 이 null 또는 구버전의 -1 이면 미발표. */
export function evidenceBand(ev: Record<string, unknown>): { base: number | null; top: number | null } | null {
  const b = ev.band_ft;
  if (!Array.isArray(b) || b.length < 2) return null;
  const base = typeof b[0] === "number" && b[0] >= 0 ? b[0] : null;
  const top = typeof b[1] === "number" && b[1] >= 0 ? b[1] : null;
  return { base, top };
}

/**
 * 근거의 고도대 출처: 근거에 담긴 base_source/top_source(판정 당시)를 우선, 없으면 현재 SIGMET 속성.
 * 원문 "TOP ABV FLxxx" 여부는 SIGMET 원문에서 결정적으로 읽는다.
 */
export function evidenceBandSource(ev: Record<string, unknown>, sigmet: Pick<SigmetProps, "base_source" | "top_source" | "raw_text"> | null | undefined, topFt: number | null): BandSource {
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const baseSource = str(ev.base_source) ?? (ev.base_assumed_surface === true ? "assumed_surface" : null) ?? sigmet?.base_source ?? null;
  const topSource = str(ev.top_source) ?? (ev.top_assumed_unbounded === true ? "unknown" : null) ?? sigmet?.top_source ?? null;
  return { base_source: baseSource, top_source: topSource, top_above: topSource === "raw_text" && topAboveFromRaw(sigmet?.raw_text, topFt) };
}
