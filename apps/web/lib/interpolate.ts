/**
 * 클라이언트 보간(10.1절) — 순수 함수. 구면 dead reckoning, 1 kt = 1,852 m/h, R = 6,371 km.
 * 정지·지상·속도/방위 없음·|lat| > 85 는 보간하지 않는다(estimated=false). 60 s 초과는 stale.
 */
import type { AircraftState, RenderState } from "./types";

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function wrap180(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export function deadReckon(lat: number, lon: number, trackDeg: number, gsKt: number, dtS: number): [number, number] {
  const d = (gsKt * 1852 * dtS) / 3600;
  const δ = d / R;
  const θ = rad(trackDeg);
  const φ1 = rad(lat);
  const λ1 = rad(lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [deg(φ2), wrap180(deg(λ2))];
}

export const STALE_AFTER_S = 60;
export const REMOVE_AFTER_S = 300;

export function predict(s: AircraftState, nowMs: number): RenderState {
  const seenMs = s.seen_at ? Date.parse(s.seen_at) : nowMs;
  const dt = Math.max(0, (nowMs - seenMs) / 1000);
  const base: RenderState = {
    hex: s.hex,
    lat: s.lat,
    lon: s.lon,
    alt_ft: s.alt_ft ?? null,
    track_deg: s.track_deg ?? null,
    callsign: s.callsign ?? null,
    estimated: false,
    stale: dt > STALE_AFTER_S,
    emergency: s.squawk === "7500" || s.squawk === "7600" || s.squawk === "7700",
    on_ground: !!s.on_ground,
    age_s: dt,
  };
  if (s.on_ground || s.gs_kt == null || s.track_deg == null || s.gs_kt <= 0 || Math.abs(s.lat) > 85 || dt === 0) return base;
  const [lat, lon] = deadReckon(s.lat, s.lon, s.track_deg, s.gs_kt, Math.min(dt, REMOVE_AFTER_S));
  return {
    ...base,
    lat,
    lon,
    alt_ft: s.alt_ft == null ? null : Math.round(s.alt_ft + ((s.vrate_fpm ?? 0) * dt) / 60),
    estimated: true,
  };
}

/** 새 서버 값이 오면 예측 위치에서 관측 위치로 500 ms 완화(easing). t∈[0,1] */
export function ease(from: [number, number], to: [number, number], t: number): [number, number] {
  const k = t >= 1 ? 1 : 1 - Math.pow(1 - t, 3);
  let dlon = to[1] - from[1];
  if (dlon > 180) dlon -= 360;
  if (dlon < -180) dlon += 360;
  return [from[0] + (to[0] - from[0]) * k, wrap180(from[1] + dlon * k)];
}

/** diff 적용(10.6절): upsert 는 교체, remove 는 삭제. 반환값은 같은 Map(가변). */
export function applyDiff(states: Map<string, AircraftState>, upsert: AircraftState[], remove: string[]): Map<string, AircraftState> {
  for (const s of upsert) states.set(s.hex, s);
  for (const h of remove) states.delete(h);
  return states;
}
