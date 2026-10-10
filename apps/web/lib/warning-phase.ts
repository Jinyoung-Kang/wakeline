/**
 * 기상특보의 지금 단계(QA-709 · 계약 v5 §G49) — React · 폴러 없음: 'wx' 탭(lib/warnings)과 선박 카드 줄(components/ShipCard)이 함께 쓴다(카드 조각에 폴러를 끌어오지 않게).
 */
import type { Warning } from "./warnings";

/**
 * 특보 하나의 지금 단계(QA-709): 예비특보(발표 예정 — 아직 특보가 아니다) · 발효 예정(정규 특보, 발효 시각이 아직) · 발효 중(정규 특보, 발효 시각이 지남).
 * 정규 특보에 발효 시각이 없으면 발효 중으로 센다(목록은 기상청 '특보현황' — 지금 내려진 특보).
 */
export type WarningPhase = "in_force" | "scheduled" | "preliminary";
export function warningPhase(w: Warning, nowMs: number): WarningPhase {
  if (w.preliminary) return "preliminary";
  const at = w.effective_at ? Date.parse(w.effective_at) : NaN;
  return Number.isFinite(at) && at > nowMs ? "scheduled" : "in_force";
}

/** 단계별 수 — 발효 중만 '발효 중'이라 부른다(예비 · 발효 예정을 섞어 세지 않는다) */
export function countPhases(items: readonly Warning[], nowMs: number): Record<WarningPhase, Warning[]> {
  const out: Record<WarningPhase, Warning[]> = { in_force: [], scheduled: [], preliminary: [] };
  for (const w of items) out[warningPhase(w, nowMs)].push(w);
  return out;
}

/** 발효 중이 아닌 것의 덧붙임 글('발효 예정 N · 예비 M' — 없으면 빈 글) */
export function notYetText(p: Record<WarningPhase, Warning[]>): string {
  return [p.scheduled.length ? `발효 예정 ${p.scheduled.length}` : null, p.preliminary.length ? `예비 ${p.preliminary.length}` : null].filter(Boolean).join(" · ");
}
