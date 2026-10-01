/**
 * 공항 기상(GET /api/v1/airports/{icao}/wx — FR-22)의 모양과 본문 검사(web-review B10). 공항 카드(지연 조각)와 공항 기상 이력 화면만 쓴다 —
 * 첫 화면에 싣지 않는다(tests/first-screen-lazy CARRIED_BY_PARTS).
 * 화면이 바로 읽는 값만 본다: airport.icao · latest(없음 = METAR 없음, 있으면 obs_time · raw) · history(목록)가 틀리면 null — 부른 쪽이 그리지 않고 그렇다고 말한다.
 * 이력 줄은 obs_time 이 있는 것만, 위경도가 수가 아니면 모름(null). 나머지 값은 그대로(표시 함수가 모르는 값을 "—" 로 다룬다).
 */
export interface AirportWxLatest {
  obs_time: string; raw: string; temp_c?: number; dewp_c?: number; wind_dir?: number; wind_kt?: number; vis_sm?: number; vis_raw?: string;
  ceiling_ft?: number | null; ceiling_state?: "measured" | "none" | "unknown" | null; flight_cat?: string | null; flight_cat_source?: string | null;
  obs_age_s?: number | null; stale?: boolean | null; wx_string?: string; taf_raw?: string | null; provider?: string; fetched_at?: string;
}
export interface AirportWxRow {
  obs_time: string; flight_cat?: string | null; wind_dir?: number | null; wind_kt?: number | null; vis_sm?: number | null; vis_raw?: string | null;
  ceiling_ft?: number | null; temp_c?: number | null;
}
export interface AirportWx {
  airport: { icao: string; name?: string; country?: string; elev_ft?: number; lat?: number | null; lon?: number | null };
  latest: AirportWxLatest | null;
  history: AirportWxRow[];
}

/** 읽을 수 없는 본문의 문구(카드 · 이력 화면) */
export const WX_UNREADABLE = "공항 기상 응답 형식이 맞지 않음 — 표시하지 않습니다";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseWx(v: unknown): AirportWx | null {
  if (!isObj(v) || !isObj(v.airport) || typeof v.airport.icao !== "string" || !Array.isArray(v.history)) return null;
  const l = v.latest;
  if (l != null && !(isObj(l) && typeof l.obs_time === "string" && typeof l.raw === "string")) return null;
  const a = v.airport;
  return {
    ...v,
    airport: { ...a, icao: a.icao as string, ...("lat" in a ? { lat: numOrNull(a.lat) } : {}), ...("lon" in a ? { lon: numOrNull(a.lon) } : {}) },
    latest: (l ?? null) as AirportWxLatest | null,
    history: v.history.filter((h): h is AirportWxRow => isObj(h) && typeof h.obs_time === "string"),
  } as AirportWx;
}
