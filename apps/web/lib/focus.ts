/**
 * 목록에서 고른 항목으로 지도 옮기기(R-08). 알려진 위치가 지금 화면(마지막 구독 bbox) 밖일 때만 옮기고, 줌은 그대로 둔다.
 * 위치를 모르면 옮기지 않는다(추정 위치로 옮기지 않는다).
 */
import { aircraftStates, getData, shipStates } from "./store";
import { useUi } from "./ui-store";
import type { Alert } from "./types";

export type LonLat = [number, number];

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** [lon, lat] 이 bbox [w, s, e, n] 안(경계 포함)인가 */
export function inBbox(p: LonLat, b: readonly [number, number, number, number]): boolean {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}

/** 항공기 위치: 실시간 사본(가장 최근) → 알림 근거의 판정 위치(evidence.position = [lat, lon]) → 모름 */
export function aircraftPos(hex: string, alert?: Pick<Alert, "evidence"> | null): LonLat | null {
  const s = aircraftStates.get(hex);
  if (s && finite(s.lon) && finite(s.lat)) return [s.lon, s.lat];
  const p = (alert?.evidence as { position?: unknown } | undefined)?.position;
  if (Array.isArray(p) && finite(p[0]) && finite(p[1])) return [p[1], p[0]];
  return null;
}

/** 선박 위치: 지도 목록 사본 → 모름 */
export function shipPos(mmsi: string): LonLat | null {
  const s = shipStates.get(mmsi);
  return s && finite(s.lon) && finite(s.lat) ? [s.lon, s.lat] : null;
}

/** 위치가 화면 밖이면(화면을 아직 모르면 포함) 지도 이동을 요청한다. 옮겼으면 true */
export function panIfOutside(pos: LonLat | null): boolean {
  if (!pos) return false;
  const vp = getData().viewport;
  if (vp && inBbox(pos, vp.bbox)) return false;
  useUi.getState().requestFlyTo(pos[0], pos[1], vp?.zoom ?? 6);
  return true;
}
