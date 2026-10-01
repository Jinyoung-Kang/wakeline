/**
 * 선택 항적 REST(web-review §3.1) — 상황판 지도(components/MapView)만 부른다. 항공기 · 선박 모듈(./aircraft · lib/search)과 나눠 둔 까닭: 이 함수들이
 * 싣는 항적 코드(lib/track)는 지도 묶음에만 있으면 된다 — 검색이 실린 첫 로드 묶음으로 옮기지 않는다(첫 화면 JS 예산).
 * 함수마다 { signal } 을 받아 그대로 넘기고, 경로 조각은 ./path 로 인코딩하고(빈 값 · "." · ".." 는 요청하지 않고 거절), 파싱한 값을 돌려준다.
 */
import { apiGet } from "@/lib/api";
import { pathSegment } from "./path";
import { shipTrackFromRest, type ShipTrack } from "@/lib/ships";
import { trackFromRest, type TrackPt } from "@/lib/track";

type Opts = { signal?: AbortSignal };

/** 선택 항공기의 DB 항적(최근 2 h) → 항적 점(관측 시각을 모르는 점은 버린다 — lib/track). points 가 없으면 빈 항적, 본문이 없으면 거절 */
export async function aircraftTrack(hex: string, o?: Opts): Promise<TrackPt[]> {
  return apiGet<{ points: { ts?: string | null; lon: number; lat: number; alt_ft?: number | null }[] }>(`/api/v1/aircraft/${pathSegment(hex)}/track`, o)
    .then((t) => trackFromRest(t.points));
}

/** 선택 선박의 기록 항적(from–to — 계약 v5 §B3 기간 6 · 12 · 24 h) */
export async function shipTrack(mmsi: string, fromMs: number, toMs: number, o?: Opts): Promise<ShipTrack> {
  const q = `from=${encodeURIComponent(new Date(fromMs).toISOString())}&to=${encodeURIComponent(new Date(toMs).toISOString())}`;
  return apiGet<unknown>(`/api/v1/ships/${pathSegment(mmsi)}/track?${q}`, o).then((r) => shipTrackFromRest(r));
}
