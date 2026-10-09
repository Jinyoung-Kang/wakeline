/**
 * 신뢰도 한 줄(SPEC F6) — 점수가 아니라 구성 요소 그대로: 위치 나이 · 공급자 지연 · 수신 공백. 등급 낱말은 상태 바와 같다(정상 · 주의 · 경고 · 모름 —
 * lib/statusbar HEALTH_WORD). 모르는 칸은 "모름" — 합쳐 하나의 점수로 만들지 않는다. React 없음(카드 · 근거 화면이 쓴다 — 첫 화면 밖).
 */
import { fmtAgeS } from "./format";

export type RelGrade = "ok" | "warn" | "bad" | "unknown";
/**
 * 등급 기호 · 낱말 — lib/statusbar HEALTH_MARK · HEALTH_WORD 와 같은 값(tests/evidence-share.test.ts 가 대조한다). 가져오지 않고 옮겨 둔 까닭: 카드 조각이 첫 화면
 * 모듈(lib/statusbar)을 부르면 Turbopack 이 첫 화면 청크를 다시 나눠 첫 화면 JS 가 수백 B 늘었다(PERF §19).
 */
export const REL_MARK: Record<RelGrade, string> = { ok: "■", warn: "▲", bad: "✕", unknown: "□" };
export const REL_WORD: Record<RelGrade, string> = { ok: "정상", warn: "주의", bad: "경고", unknown: "모름" };
export interface RelPart { key: "position" | "lag" | "gaps"; grade: RelGrade; text: string }

/** 위치 나이 등급 경계(초): [정상 이하, 주의 이하] — 그 위는 경고. 항공기 30 · 120 s, 선박 5 · 15분 */
export const POSITION_LIMITS_S = { aircraft: [30, 120], ship: [300, 900] } as const;

export function positionPart(kind: "aircraft" | "ship", ageS: number | null | undefined, estimated = false): RelPart {
  if (ageS == null || !Number.isFinite(ageS)) return { key: "position", grade: "unknown", text: "위치 나이 모름" };
  const [ok, warn] = POSITION_LIMITS_S[kind];
  const grade: RelGrade = ageS <= ok ? "ok" : ageS <= warn ? "warn" : "bad";
  return { key: "position", grade, text: `위치 ${fmtAgeS(ageS)} 전${estimated ? "(추정 위치)" : ""}` };
}

/** 공급자 지연 — 상태 바와 같은 값(lib/ws-protocol feedLag · lib/ships aisBadge). stale 이면 경고. 모르면(피드 없음 · 기록 없음) 모름 */
export function lagPart(lag: { lag: number | null; stale: boolean } | null | undefined, unknownText = "공급자 지연 모름"): RelPart {
  if (!lag || lag.lag == null) return { key: "lag", grade: "unknown", text: unknownText };
  return { key: "lag", grade: lag.stale ? "bad" : "ok", text: `공급자 지연 ${fmtAgeS(lag.lag)}` };
}

/** 수신 공백 — 항적(그 창)을 불러온 경우에만 안다. 0 회면 정상, 있으면 주의 */
export function gapsPart(g: { count: number; window: string } | null | undefined, unknownText = "수신 공백 모름"): RelPart {
  if (!g) return { key: "gaps", grade: "unknown", text: unknownText };
  return g.count === 0 ? { key: "gaps", grade: "ok", text: `${g.window} 수신 공백 없음` } : { key: "gaps", grade: "warn", text: `${g.window} 수신 공백 ${g.count}회` };
}

export function reliabilityText(parts: readonly RelPart[]): string {
  return parts.map((p) => p.text).join(" · ");
}
