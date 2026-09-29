/**
 * 선택 항공기 항적(FR-18 · GAP-10) — 순수 함수. REST(/aircraft/{hex}/track, DB 기록)로 한 번 받고,
 * 이후 WS "selected" 상태의 새 관측(seen_at 이 바뀐 것)을 끝에 붙인다. REST 응답 전에 온 관측은 보류했다가 합친다.
 */
import { seenAtMs, STALE_AFTER_S, thresholds } from "./interpolate";
import type { AircraftState } from "./types";
import { fmtKstSpan } from "./time";

/**
 * 항적 조회 실패(계약 v5 §G5) → 화면 문구와 요청 id. 요청 id 는 ApiError 가 problem+json(또는 X-Request-Id)에서 이미 형식을 확인해 둔 값만 —
 * 없으면 null(지어내지 않는다). api 모듈을 부르지 않는다(모양으로 읽는다 — 시험이 api 모듈을 바꿔 끼워도 같게).
 */
export function trackError(e: unknown): { error: string; requestId: string | null } {
  const rid = e instanceof Error ? (e as Error & { requestId?: unknown }).requestId : null;
  return { error: e instanceof Error ? e.message : String(e), requestId: typeof rid === "string" && rid ? rid : null };
}

/** provider: 그 점을 준 공급자(track_point.provider · WS 상태) — 수신 공백 기준에 쓴다. 모르면 null/없음 */
export interface TrackPt { ts: number; lon: number; lat: number; alt_ft: number | null; provider?: string | null }

/** 2 h × 10 s ≈ 720 점. 오래 선택해 두어도 메모리가 무한히 늘지 않게 상한. */
export const MAX_TRACK_POINTS = 5000;

export function trackFromRest(points: { ts?: string | null; lon: number; lat: number; alt_ft?: number | null; provider?: string | null }[] | null | undefined): TrackPt[] {
  const out: TrackPt[] = [];
  for (const p of points ?? []) {
    const ts = seenAtMs(p.ts ?? null);
    if (ts == null || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    appendTrackPoint(out, { ts, lon: p.lon, lat: p.lat, alt_ft: p.alt_ft ?? null, provider: typeof p.provider === "string" ? p.provider : null });
  }
  return out;
}

/** 관측 시각을 모르는 상태는 항적에 넣지 않는다(순서를 알 수 없다). */
export function pointFromState(s: AircraftState | null | undefined): TrackPt | null {
  if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return null;
  const ts = seenAtMs(s.seen_at);
  if (ts == null) return null;
  return { ts, lon: s.lon, lat: s.lat, alt_ft: s.alt_ft ?? null, provider: s.provider ?? null };
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

/**
 * 연속한 두 관측이 이보다 멀리 떨어져 있으면 실선으로 잇지 않는다(R-04) — 그 사이는 관측하지 않은 구간이다.
 * 상황판이 항공기를 STALE(위치 모름)로 바꾸는 기준과 같다(interpolate.ts thresholds()): 공급자마다 갱신 주기가 달라서
 * (지역 약 10 s, 전세계 OpenSky 약 120 s) 한 기준을 쓰면 OpenSky 로만 잡힌 항공기의 모든 선분이 공백이 된다.
 * 선분은 두 끝점 공급자 중 더 느린 쪽 기준을 쓰고, 공급자를 모르면 더 짧은 지역 기준이다. 공급자는 기록된 값(track_point.provider)이다.
 */
export const TRACK_GAP_MS = STALE_AFTER_S * 1000;

export function trackGapMs(a: string | null | undefined, b: string | null | undefined): number {
  return Math.max(thresholds(a).staleAfterS, thresholds(b).staleAfterS) * 1000;
}


/**
 * 항적 → 지도 FeatureCollection: 관측 선분(kind "track", 선분마다 끝점 고도 — 고도색 실선) +
 * 수신 공백 연결(kind "gap", 회색 점선 + "수신 없음 hh:mm–hh:mm KST" 라벨(계약 v5 §G19) — 선박 항적의 공백 표시와 같은 모양).
 */
export function trackFeatureCollection(pts: TrackPt[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const coordinates = [[a.lon, a.lat], [b.lon, b.lat]];
    features.push(b.ts - a.ts > trackGapMs(a.provider, b.provider)
      ? { type: "Feature", properties: { kind: "gap", label: `수신 없음 ${fmtKstSpan(a.ts, b.ts)}` }, geometry: { type: "LineString", coordinates } }
      : { type: "Feature", properties: { kind: "track", alt_ft: b.alt_ft }, geometry: { type: "LineString", coordinates } });
  }
  return { type: "FeatureCollection", features };
}
