/**
 * 선택 항공기 항적(FR-18 · GAP-10) — 순수 함수. REST(/aircraft/{hex}/track, DB 기록)로 한 번 받고,
 * 이후 WS "selected" 상태의 새 관측(seen_at 이 바뀐 것)을 끝에 붙인다. REST 응답 전에 온 관측은 보류했다가 합친다.
 */
import { seenAtMs } from "./interpolate";
import type { AircraftState } from "./types";

export interface TrackPt { ts: number; lon: number; lat: number; alt_ft: number | null }

/** 2 h × 10 s ≈ 720 점. 오래 선택해 두어도 메모리가 무한히 늘지 않게 상한. */
export const MAX_TRACK_POINTS = 5000;

export function trackFromRest(points: { ts?: string | null; lon: number; lat: number; alt_ft?: number | null }[] | null | undefined): TrackPt[] {
  const out: TrackPt[] = [];
  for (const p of points ?? []) {
    const ts = seenAtMs(p.ts ?? null);
    if (ts == null || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    appendTrackPoint(out, { ts, lon: p.lon, lat: p.lat, alt_ft: p.alt_ft ?? null });
  }
  return out;
}

/** 관측 시각을 모르는 상태는 항적에 넣지 않는다(순서를 알 수 없다). */
export function pointFromState(s: AircraftState | null | undefined): TrackPt | null {
  if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return null;
  const ts = seenAtMs(s.seen_at);
  if (ts == null) return null;
  return { ts, lon: s.lon, lat: s.lat, alt_ft: s.alt_ft ?? null };
}

/** 마지막 점보다 새 관측이고 위치가 다르면 붙인다. 붙였으면 true. */
export function appendTrackPoint(pts: TrackPt[], p: TrackPt, max = MAX_TRACK_POINTS): boolean {
  const last = pts[pts.length - 1];
  if (last && p.ts <= last.ts) return false;
  if (last && last.lat === p.lat && last.lon === p.lon) return false;
  pts.push(p);
  if (pts.length > max) pts.splice(0, pts.length - max);
  return true;
}

/** REST 항적 + 그 사이 받은 실시간 관측(보류분) */
export function mergeTrack(rest: TrackPt[], pending: TrackPt[]): TrackPt[] {
  const out = rest.slice();
  for (const p of pending) appendTrackPoint(out, p);
  return out;
}

/** 고도 색을 입힌 선분 FeatureCollection(선분마다 끝점 고도) */
export function trackFeatureCollection(pts: TrackPt[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let i = 1; i < pts.length; i++) {
    features.push({
      type: "Feature",
      properties: { alt_ft: pts[i].alt_ft },
      geometry: { type: "LineString", coordinates: [[pts[i - 1].lon, pts[i - 1].lat], [pts[i].lon, pts[i].lat]] },
    });
  }
  return { type: "FeatureCollection", features };
}
