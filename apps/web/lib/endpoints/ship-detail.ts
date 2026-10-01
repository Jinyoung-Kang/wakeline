/**
 * 선박 카드의 REST 상세(web-review §3.1) — 선박 카드 조각과 함께만 온다(첫 화면 밖: tests/first-screen-lazy CARRIED_BY_PARTS).
 * 본문은 lib/ship-card parseShipDetail 로 읽는다(모양이 다른 값은 null — 모르는 값을 채우지 않는다). MMSI 는 ./path 로(빈 값 · "." · ".." 는 거절).
 */
import { apiGet } from "@/lib/api";
import { parseShipDetail, type ShipDetail } from "@/lib/ship-card";
import { pathSegment } from "./path";

export async function shipDetail(mmsi: string, o?: { signal?: AbortSignal }): Promise<ShipDetail> {
  return apiGet<unknown>(`/api/v1/ships/${pathSegment(mmsi)}`, o).then((r) => parseShipDetail(mmsi, r));
}
