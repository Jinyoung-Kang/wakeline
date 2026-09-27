/**
 * 클라이언트 보간(10.1절 · 계약서 §1) — 순수 함수. 구면 dead reckoning, 1 kt = 1,852 m/h, R = 6,371 km.
 * - 클라이언트는 경과 시간으로 항공기를 지우지 않는다(FR-19: 전체 장애 중에도 마지막 위치를 stale 로 남긴다). 삭제는 서버 remove·스냅샷만.
 * - stale: 수신 경과 > 60 s(opensky 는 > 300 s), 또는 외삽 상한 도달.
 * - 외삽 상한: 60 s(opensky 180 s). 상한을 넘으면 상한 위치에 멈춘다.
 * - seen_at 이 없으면 경과 시간을 모른다 → 외삽하지 않고 age_s=null(화면 "—").
 * 정지·지상·속도/방위 없음·|lat| > 85 는 보간하지 않는다(estimated=false).
 * public/interpolate.worker.js 와 같은 규칙이어야 한다(tests/worker-sync.test.ts).
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
export const STALE_AFTER_OPENSKY_S = 300;
export const EXTRAPOLATE_CAP_S = 60;
export const EXTRAPOLATE_CAP_OPENSKY_S = 180;

/** 공급자별 기준. provider 를 모르면 더 엄격한(짧은) 지역 기준을 쓴다. */
export function thresholds(provider: string | null | undefined): { staleAfterS: number; capS: number } {
  return provider === "opensky"
    ? { staleAfterS: STALE_AFTER_OPENSKY_S, capS: EXTRAPOLATE_CAP_OPENSKY_S }
    : { staleAfterS: STALE_AFTER_S, capS: EXTRAPOLATE_CAP_S };
}

/** seen_at → epoch ms. ISO 문자열 또는 epoch 초(숫자). 없거나 해석 불가면 null(모름). */
export function seenAtMs(v: string | number | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v * 1000 : null;
  if (typeof v === "string" && v.length > 0) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function predict(s: AircraftState, nowMs: number): RenderState {
  const seen = seenAtMs(s.seen_at);
  const age = seen == null ? null : Math.max(0, (nowMs - seen) / 1000);
  const th = thresholds(s.provider);
  const base: RenderState = {
    hex: s.hex,
    lat: s.lat,
    lon: s.lon,
    alt_ft: s.alt_ft ?? null,
    track_deg: s.track_deg ?? null,
    callsign: s.callsign ?? null,
    estimated: false,
    stale: age != null && age > th.staleAfterS,
    capped: false,
    age_unknown: age == null,
    emergency: s.squawk === "7500" || s.squawk === "7600" || s.squawk === "7700",
    on_ground: s.on_ground == null ? null : s.on_ground === true,
    age_s: age,
  };
  if (age == null || age === 0 || s.on_ground === true || s.gs_kt == null || s.track_deg == null || s.gs_kt <= 0 || Math.abs(s.lat) > 85) return base;
  const capped = age > th.capS;
  const dt = capped ? th.capS : age;
  const [lat, lon] = deadReckon(s.lat, s.lon, s.track_deg, s.gs_kt, dt);
  return {
    ...base,
    lat,
    lon,
    // 수직속도를 모르면 고도는 외삽하지 않는다(관측 고도 유지)
    alt_ft: s.alt_ft == null ? null : s.vrate_fpm == null ? s.alt_ft : Math.round(s.alt_ft + (s.vrate_fpm * dt) / 60),
    estimated: true,
    capped,
    stale: base.stale || capped,
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

/**
 * 보간 틱 간격(ms): 빠른 항공기(500 kt)가 화면에서 약 0.5 px 움직이는 시간. 저줌에서는 화소 이하 이동을
 * 매 250 ms 다시 그릴 이유가 없다. MapLibre 는 512 px 타일 → 줌 z 에서 1 px = 360/(512·2^z) 도(경도).
 * 대수가 많으면(> 2,000) 최소 1 s. 범위 250 ms – 4 s.
 */
export function tickIntervalMs(zoom: number | null | undefined, midLat: number | null | undefined, n: number): number {
  let want = 250;
  if (zoom != null && Number.isFinite(zoom)) {
    const halfPxDeg = 180 / (512 * Math.pow(2, zoom));
    const cosLat = Math.max(0.2, Math.cos(rad(midLat ?? 0)));
    const degPerS = 500 / 3600 / 60 / cosLat;
    want = Math.round((1000 * halfPxDeg) / degPerS);
  }
  if (n > 2000) want = Math.max(want, 1000);
  return Math.min(4000, Math.max(250, want));
}

/** diff 적용(10.6절): upsert 는 교체, remove 는 삭제. 반환값은 같은 Map(가변). */
export function applyDiff(states: Map<string, AircraftState>, upsert: AircraftState[], remove: string[]): Map<string, AircraftState> {
  for (const s of upsert) states.set(s.hex, s);
  for (const h of remove) states.delete(h);
  return states;
}
