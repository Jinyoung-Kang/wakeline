import type { RouteInfo } from "./route";

/**
 * 서버 계약(schemas/aircraft_state.v1.json · WS 프로토콜 v1 개정 — 계약서 §1/§2)과 같은 필드명(snake_case).
 * 서버는 null 값을 가진 키를 생략한다(Jackson non_null). 없는 키 = 모름(null) — 0/false/"통과" 로 채우지 않는다.
 */
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
  on_ground?: boolean | null;
  squawk?: string | null;
  /** ISO-8601 UTC(계약). 숫자면 epoch 초로 해석한다(호환). 없으면 관측 시각 모름. */
  seen_at?: string | number | null;
  provider?: string | null;
  fetched_at?: string | null;
  quality?: number | null;
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
  /** 수신 지연(60 s / opensky 300 s) 초과 또는 외삽 상한 도달 */
  stale: boolean;
  /** 외삽 상한(60 s / opensky 180 s)에 도달해 상한 위치에 멈춘 상태 */
  capped: boolean;
  /** seen_at 이 없어 수신 경과 시간을 알 수 없음(외삽하지 않음) */
  age_unknown: boolean;
  emergency: boolean;
  /** null = 모름(서버가 on_ground 를 보내지 않음) */
  on_ground: boolean | null;
  /** null = 모름 */
  age_s: number | null;
}

export type CloseReason = "left" | "signal_lost" | "restart" | "prediction_cleared";
export type AlertEventType = "ENTERED" | "LEFT" | "LOST" | "PREDICTED" | "PREDICTION_UPDATED" | "PREDICTION_CLEARED";

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
  close_reason?: CloseReason | null;
  eta_s?: number | null;
  /** judged_at + eta_s(PREDICTED 만) */
  eta_at?: string | null;
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

/** 스냅샷 sources 의 한 범위(region/global) 또는 status 의 같은 필드 */
export interface SourceInfo {
  provider?: string | null;
  fetched_at?: string | null;
  lag_s?: number | null;
  stale?: boolean | null;
}

/** 스토어에 정규화해 두는 피드 상태 — 받은 시각(received_at, 클라이언트 ms)과 함께 */
export interface FeedInfo {
  provider: string | null;
  fetched_at: string | null;
  lag_s: number | null;
  stale: boolean | null;
  received_at: number;
}

/**
 * WS "status" · REST /status(StatusService.publicStatus). 서버는 모든 묶음을 보내지만(schemas/ws/server.v1.json) 웹 검증기(lib/ws-validate)는
 * 없는 묶음을 모름으로 받는다 — 화면은 ?. 로 읽고 없으면 "—". 있는데 형식이 틀리면 메시지를 버린다.
 */
export interface PublicStatus {
  server_time?: string;
  snapshot_version?: number;
  fixture_mode?: boolean;
  region?: { center?: number[]; radius_nm?: number; provider?: string | null; aircraft?: number; lag_s?: number | null; stale?: boolean; fetched_at?: string | null };
  global?: { provider?: string | null; aircraft?: number; lag_s?: number | null; stale?: boolean; fetched_at?: string | null } | null;
  sigmet?: { provider?: string; count?: number; active?: number; fetched_at?: string; lag_s?: number | null; stale?: boolean };
  radar?: { provider?: string; frames?: number; fetched_at?: string; stale?: boolean };
  engine?: { index_polygons?: number; last_cycle_ms?: number };
  active_providers?: Record<string, string>;
}

export type PredictionReason = "turning" | "slow" | "on_ground" | "no_track" | "stale";

/** WS "selected" 메시지(선택 항공기의 full 상태 + 예측 가능 여부 + 등록 노선) */
export interface SelectedInfo {
  hex: string;
  /** null = 스냅샷에 더 이상 없음 */
  state: AircraftState | null;
  prediction: { available: boolean; reason?: PredictionReason | null } | null;
  /** 계약 v4 §A route(lib/route.ts 로 검증). null = 서버가 보내지 않았거나 형식이 틀림(모름) */
  route?: RouteInfo | null;
  received_at: number;
}

export type SigmetCollection = GeoJSON.FeatureCollection<GeoJSON.MultiPolygon | null, SigmetProps>;

export interface SigmetProps {
  id: string;
  fir_id: string;
  fir_name?: string | null;
  series_id: string;
  hazard: string;
  qualifier?: string | null;
  base_ft?: number | null;
  top_ft?: number | null;
  /** "assumed_surface" = AWC 하한 null → 판정은 SFC 가정 */
  base_source?: "json" | "assumed_surface" | null;
  /** "unknown" = 상한 미발표(top_ft null) → 판정은 무제한 가정. "raw_text" = 원문(TOP FLxxx)에서 결정적으로 읽음 */
  top_source?: "json" | "raw_text" | "raw_text_lower_bound" | "unknown" | null;
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
  /** 클라이언트가 붙인다: 발효 전(valid_from > 지금) — 엔진이 아직 판정하지 않는다(DH-8) */
  pending?: boolean;
}

/**
 * 기상청 합성 레이더 프레임(/api/v1/radar/kr frames[]). 합성 지점 필드(ADR-021)는 수집기가 기록한 값 그대로 — 없으면 모름(옛 프레임).
 * stations = 헤더 STN_LIST 의 레이더 지점 수, stations_ref = 기준(지난 60분 저장 프레임 중 최대 — 수집기 선택값), partial = stations < stations_ref.
 * partial=false 는 '기준 도달'(완전하다는 뜻이 아니다) — 기준에 닿은 프레임이 2개 이상일 때만. 기준이 이 프레임뿐이면 partial 이 없다(판정 없음).
 */
export interface KrRadarFrame {
  tm: string;
  obs_tm: string;
  fetched_at: string;
  echo_cells: number;
  /** 영상 URL — 받은 시각을 알면 ?v=<epoch ms>(다시 받아 바뀐 영상이 캐시의 옛 영상으로 보이지 않게) */
  url: string;
  stations?: number | null;
  station_ids?: string[] | null;
  stations_ref?: number | null;
  partial?: boolean | null;
  /** 부분 합성이라 다시 받은 횟수 · 지점이 늘어 바꾼 횟수 */
  refetches?: number | null;
  upgrades?: number | null;
  refetched_at?: string | null;
  /** 수집기가 이 프레임을 다시 받을 수 있는 마지막 순간(UTC ISO) — 화면은 KST. 지나면 refetches 대로 '다시 받은 N회에도 기준 미만' · '다시 받지 못함' */
  refetch_until?: string | null;
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
  /** 최신 프레임(frames 의 마지막)의 합성 지점 수 · 코드 · 기준 · 부분 합성(ADR-021) — 모르면 없음 */
  stations?: number | null;
  station_ids?: string[] | null;
  stations_ref?: number | null;
  partial?: boolean | null;
  frames: KrRadarFrame[];
  attribution: string;
  meta: { fetched_at: string | null; stale: boolean };
}
