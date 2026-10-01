/**
 * 선박 카드의 REST 상세(web-review §3.1) — 선박 카드 조각과 함께만 온다(첫 화면 밖: tests/first-screen-lazy CARRIED_BY_PARTS).
 * 본문은 lib/ship-card parseShipDetail 로 읽는다(모양이 다른 값은 null — 모르는 값을 채우지 않는다).
 */
import { apiGet } from "@/lib/api";
import { parseShipDetail, type ShipDetail } from "@/lib/ship-card";

export function shipDetail(mmsi: string, o?: { signal?: AbortSignal }): Promise<ShipDetail> {
  return apiGet<unknown>(`/api/v1/ships/${encodeURIComponent(mmsi)}`, o).then((r) => parseShipDetail(mmsi, r));
}
