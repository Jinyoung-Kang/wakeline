/**
 * 항공기 카드에서만 쓰는 규칙(web-review §3.3 — 카드 컴포넌트에서 옮겼다). 카드 조각(components/AircraftCard — DashboardParts)과 함께만 온다:
 * 첫 화면에 싣지 않는다(tests/first-screen-lazy CARRIED_BY_PARTS).
 */
import { seenAtMs } from "./interpolate";
import type { AircraftState, PredictionReason } from "./types";

/** 비상 squawk(7500 납치 · 7600 통신 두절 · 7700 비상) */
export const EMERGENCY_SQUAWKS: ReadonlySet<string> = new Set(["7500", "7600", "7700"]);

/** 서버가 예측하지 않은 까닭(WS selected.prediction.reason) */
export const REASON_LABEL: Record<PredictionReason, string> = {
  turning: "선회 중(최근 트랙 변화 > 15°)", slow: "저속", on_ground: "지상", no_track: "속도/방위 없음", stale: "수신 지연",
};

/** 관측 시각(seen_at)이 더 새로운 상태. 같거나 비교할 수 없으면 앞의 것(REST full). 숫자 seen_at 은 epoch 초(lib/interpolate seenAtMs) */
export function newerState(a: AircraftState | null, b: AircraftState | null): AircraftState | null {
  if (!a || !b) return a ?? b;
  const ta = seenAtMs(a.seen_at), tb = seenAtMs(b.seen_at);
  return tb != null && (ta == null || tb > ta) ? b : a;
}

/** 품질 칸(quality — 0 통과 · 1 경고). 모르면 "—" */
export function qualityLabel(q: number | null | undefined): string {
  if (q == null) return "—";
  if (q === 0) return "0 · 통과";
  if (q === 1) return "1 · 경고(속도/방위 없음 → 보간 안 함)";
  return String(q);
}
