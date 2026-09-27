/** 서버 계약(schemas/aircraft_state.v1.json · WS 프로토콜 v1)과 같은 필드명(snake_case). */
export interface AircraftState {
  hex: string;
  callsign?: string | null;
  registration?: string | null;
  type_code?: string | null;
  category?: string | null;
  lat: number;
  lon: number;
  alt_ft?: number | null;
  gs_kt?: number | null;
  track_deg?: number | null;
  vrate_fpm?: number | null;
  on_ground?: boolean;
  squawk?: string | null;
  seen_at?: string;
  provider?: string;
  fetched_at?: string;
  quality?: number;
  estimated?: boolean;
}

/** 보간 결과(브라우저에서만 만들어진다). estimated=true 는 dead reckoning 결과. */
export interface RenderState {
  hex: string;
  lat: number;
  lon: number;
  alt_ft: number | null;
  track_deg: number | null;
  callsign: string | null;
  estimated: boolean;
  stale: boolean;
  emergency: boolean;
  on_ground: boolean;
  age_s: number;
}

export interface Alert {
  id: number;
  kind: "OBSERVED" | "PREDICTED";
  hex: string;
  callsign?: string | null;
  sigmet_id: string;
  fir_id: string;
  hazard: string;
  qualifier?: string | null;
  entered_at: string;
  left_at?: string | null;
  eta_s?: number | null;
  alt_ft?: number | null;
  evidence: Record<string, unknown>;
  estimated: boolean;
}

export interface RadarFrames {
  host: string;
  generated: number;
  past: { time: number; path: string }[];
  fetched_at?: string;
  provider?: string;
}

export interface PublicStatus {
  server_time: string;
  snapshot_version: number;
  fixture_mode: boolean;
  region: { center: number[]; radius_nm: number; provider: string; aircraft: number; lag_s: number | null; stale: boolean; fetched_at: string };
  global: { provider: string; aircraft: number; lag_s: number | null; stale: boolean; fetched_at: string };
  sigmet: { provider: string; count: number; active: number; fetched_at: string; lag_s: number | null; stale: boolean };
  radar: { provider: string; frames: number; fetched_at: string; stale: boolean };
  engine: { index_polygons: number; last_cycle_ms: number };
  active_providers: Record<string, string>;
}

export type SigmetCollection = GeoJSON.FeatureCollection<GeoJSON.MultiPolygon | null, SigmetProps>;

export interface SigmetProps {
  id: string;
  fir_id: string;
  fir_name?: string | null;
  series_id: string;
  hazard: string;
  qualifier?: string | null;
  base_ft: number;
  top_ft?: number | null;
  valid_from: string;
  valid_to: string;
  active: boolean;
  expiring_soon: boolean;
  excluded_reason?: string | null;
  raw_text: string;
  provider: string;
  fetched_at: string;
  move_dir?: string | null;
  move_spd?: string | null;
  chng?: string | null;
  inside?: boolean;
}

export interface KrRadar {
  available: boolean;
  status?: string | null;
  note?: string | null;
  product?: string | null;
  latest_tm?: string | null;
  georeferenced: boolean;
  coordinates: [number, number][] | null; // TL, TR, BR, BL (lon, lat)
  projection?: string | null;
  grid?: { nx: number; ny: number; res_m: number; ref: number[] } | null;
  legend: [number, number[]][] | null;
  min_dbz?: string | null;
  stations?: string | null;
  frames: { tm: string; obs_tm: string; fetched_at: string; echo_cells: number; url: string }[];
  attribution: string;
  meta: { fetched_at: string | null; stale: boolean };
}
