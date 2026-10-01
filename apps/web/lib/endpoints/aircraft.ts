/**
 * 항공기 REST(web-review §3.1) — 항공기 카드 · 상단 검색(위치를 모를 때)이 부른다. 전송은 lib/api(시험의 vi.mock("@/lib/api") 가 그대로 가로챈다).
 * { signal } 을 받아 그대로 넘기고, 경로 조각은 ./path 로 인코딩한다(빈 값 · "." · ".." 는 요청하지 않고 거절). 상세는 파서가 없어 모양만 적는다(노선 route 는 lib/route parseRoute 가 읽는다).
 * 검색 요청은 lib/search(searchAircraft · searchShips), 선택 항적은 ./tracks 에 있다 — 둘 다 첫 화면 JS 예산 때문(각 모듈의 머리말).
 */
import { apiGet } from "@/lib/api";
import { pathSegment } from "./path";
import type { AircraftState, Alert } from "@/lib/types";

/** GET /api/v1/aircraft/{hex} */
export interface AircraftDetail {
  hex: string;
  state: AircraftState | null;
  static: { registration?: string | null; type_code?: string | null; category?: string | null; first_seen?: string | null; last_seen?: string | null } | null;
  active_alerts?: Alert[];
  inside_sigmets?: string[];
  emergency?: boolean;
  meta?: { provider?: string | null; fetched_at?: string | null; lag_s?: number | null; stale?: boolean; db_unavailable?: boolean };
  /** 계약 v4 §A — 검증 전 값(parseRoute) */
  route?: unknown;
}

/** 항공기 상세(카드 · 검색에서 위치를 모를 때) */
export async function aircraftDetail(hex: string, o?: { signal?: AbortSignal }): Promise<AircraftDetail> {
  return apiGet<AircraftDetail>(`/api/v1/aircraft/${pathSegment(hex)}`, o);
}
