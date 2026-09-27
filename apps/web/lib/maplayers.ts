/** 지도 레이어 정의(11.2절) — 상황판·재생 화면이 공유. */
import type * as maplibregl from "maplibre-gl";
import { ALT_RAMP, ALT_UNKNOWN_COLOR, CAT_COLORS, CAT_STALE_FILL, CAT_STALE_STROKE, CAT_UNKNOWN_COLOR, HAZARD_COLORS, HAZARD_DEFAULT_COLOR } from "./format";
import { deadReckon } from "./interpolate";
import type { AircraftState, Alert, SelectedInfo } from "./types";

export const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
/** MapLibre 워커 경로 — scripts/copy-maplibre-worker.mjs 가 public/maplibre/ 에 복사한다. 지도를 만들기 전에 한 번 호출. */
export const MAPLIBRE_WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";
export const RADAR_COLOR_SCHEME = 2;

/** 위험 유형 색 식 — format.ts HAZARD_COLORS(범례·카드와 같은 표)에서 만든다 */
export const HAZARD_COLOR_EXPR = [
  "match", ["coalesce", ["get", "hazard"], ""],
  ...Object.entries(HAZARD_COLORS).flat(),
  HAZARD_DEFAULT_COLOR,
] as unknown as maplibregl.ExpressionSpecification;

/** 고도 색 램프 식. 고도를 모르면(null) 0 ft 색으로 칠하지 않고 회색(ALT_UNKNOWN_COLOR). */
export const ALT_COLOR_EXPR = [
  "case", ["==", ["typeof", ["get", "alt_ft"]], "number"],
  ["interpolate", ["linear"], ["get", "alt_ft"], ...ALT_RAMP.flat()],
  ALT_UNKNOWN_COLOR,
] as unknown as maplibregl.ExpressionSpecification;

/** 공항 원 색: METAR 가 오래되면(stale, > 2 h) 속이 빈 회색 고리, 카테고리를 모르면 어두운 회색. */
export const AIRPORT_FILL_EXPR = [
  "case", ["boolean", ["get", "stale"], false], CAT_STALE_FILL,
  ["match", ["coalesce", ["get", "flight_cat"], "-"], ...Object.entries(CAT_COLORS).flat(), CAT_UNKNOWN_COLOR],
] as unknown as maplibregl.ExpressionSpecification;

/** 항공기 SDF 아이콘(비행기 실루엣) — icon-color 로 고도 색 램프를 적용한다. */
export function planeImage(size = 48): ImageData {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  const p = new Path2D("M24 2 L27 12 L27 22 L44 32 L44 36 L27 30 L26 40 L32 44 L32 47 L24 45 L16 47 L16 44 L22 40 L21 30 L4 36 L4 32 L21 22 L21 12 Z");
  ctx.fill(p);
  return ctx.getImageData(0, 0, size, size);
}

/** 레이더 레이어 자리 표시(빈 소스·숨김). 커버리지 마스크는 이 아래, 레이더 프레임은 이 위·SIGMET 아래에 끼운다. */
export const RADAR_SLOT = "radar-slot";

export function addBaseLayers(map: maplibregl.Map) {
  map.addImage("plane", planeImage(), { sdf: true });

  map.addSource("anchors", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: RADAR_SLOT, type: "line", source: "anchors", layout: { visibility: "none" } });

  map.addSource("sigmets", { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "id" });
  map.addLayer({
    id: "sigmet-fill", type: "fill", source: "sigmets",
    paint: { "fill-color": HAZARD_COLOR_EXPR, "fill-opacity": ["case", ["boolean", ["get", "inside"], false], 0.28, 0.15] },
  });
  map.addLayer({
    id: "sigmet-line", type: "line", source: "sigmets",
    paint: {
      "line-color": HAZARD_COLOR_EXPR,
      "line-width": ["case", ["boolean", ["get", "inside"], false], 3, 1.2],
      "line-dasharray": ["case", ["boolean", ["get", "expiring_soon"], false], ["literal", [2, 2]], ["literal", [1, 0]]],
    },
  });

  map.addSource("tracks", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "track-line", type: "line", source: "tracks",
    paint: { "line-color": ALT_COLOR_EXPR, "line-width": 2, "line-opacity": 0.9 },
  });

  // 10분 예측 궤적(추정) — 선택 항공기(서버가 예측 가능하다고 한 경우)와 PREDICTED 알림 대상만. 선 위에 "추정" 라벨.
  map.addSource("prediction", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "prediction-line", type: "line", source: "prediction", paint: { "line-color": "#b18cf5", "line-width": 1.5, "line-dasharray": [2, 3] } });
  map.addLayer({
    id: "prediction-label", type: "symbol", source: "prediction",
    layout: { "symbol-placement": "line", "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 10, "symbol-spacing": 400 },
    paint: { "text-color": "#b18cf5", "text-halo-color": "#0b0d10", "text-halo-width": 1 },
  });

  map.addSource("airports", { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "icao" });
  map.addLayer({
    id: "airport-circle", type: "circle", source: "airports", minzoom: 5.5,
    paint: {
      "circle-radius": 5,
      "circle-color": AIRPORT_FILL_EXPR,
      "circle-stroke-color": ["case", ["boolean", ["get", "stale"], false], CAT_STALE_STROKE, "#0b0d10"],
      "circle-stroke-width": 1.5,
    },
  });
  map.addLayer({
    id: "airport-label", type: "symbol", source: "airports", minzoom: 7,
    layout: { "text-field": ["get", "icao"], "text-font": ["Noto Sans Regular"], "text-size": 10, "text-offset": [0, 1.1], "text-anchor": "top" },
    paint: { "text-color": "#a3aab4", "text-halo-color": "#0b0d10", "text-halo-width": 1 },
  });

  map.addSource("aircraft", { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "hex" });
  map.addLayer({
    id: "aircraft-symbol", type: "symbol", source: "aircraft",
    layout: {
      "icon-image": "plane",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.22, 7, 0.38, 11, 0.6],
      "icon-rotate": ["coalesce", ["get", "track_deg"], 0],
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "text-field": ["step", ["zoom"], "", 8, ["coalesce", ["get", "callsign"], ""]],
      "text-font": ["Noto Sans Regular"],
      "text-size": 10, "text-offset": [0, 1.3], "text-anchor": "top", "text-optional": true,
    },
    paint: {
      "icon-color": ["case", ["boolean", ["get", "emergency"], false], "#e5484d",
        ["boolean", ["get", "selected"], false], "#ffffff",
        ALT_COLOR_EXPR],
      // stale(수신 지연·외삽 상한 도달) 0.4, 수신 경과를 모름(seen_at 없음) 0.7 — 모르는 것을 "신선함"으로 그리지 않는다
      "icon-opacity": ["case", ["boolean", ["get", "stale"], false], 0.4, ["boolean", ["get", "age_unknown"], false], 0.7, 1],
      "icon-halo-color": ["case", ["boolean", ["get", "emergency"], false], "#ff0000", ["boolean", ["get", "estimated"], false], "rgba(0,0,0,0)", "#ffffff"],
      "icon-halo-width": ["case", ["boolean", ["get", "emergency"], false], 2, ["boolean", ["get", "estimated"], false], 0, 1],
      "text-color": "#cfd4da", "text-halo-color": "#0b0d10", "text-halo-width": 1,
    },
  });
}

export function radarTileUrl(host: string, path: string) {
  return `${host}${path}/512/{z}/{x}/{y}/${RADAR_COLOR_SCHEME}/1_1.png`;
}

/**
 * RainViewer 레이더 커버리지 마스크 타일(GAP-15). 문서(rainviewer.com/api/weather-maps-api.html, 2026-09 확인):
 * `/v2/coverage/0/{size}/{z}/{x}/{y}/0/0_0.png` — 커버리지 안은 투명, 밖은 검정. 최대 줌 7.
 * 검정을 raster-brightness-min 으로 회색으로 올려 "커버리지 밖"을 회색 베일로 그린다 → "에코 없음(투명)"과 구분.
 */
export function coverageTileUrl(host: string) {
  return `${host}/v2/coverage/0/512/{z}/{x}/{y}/0/0_0.png`;
}
export const COVERAGE_PAINT = { "raster-opacity": 0.5, "raster-brightness-min": 0.32, "raster-saturation": -1 } as const;

export type FrameRole = "current" | "preload";
/**
 * 레이더 프레임 표시(PERF-12): MapLibre 는 불투명도 0 인 레이어의 타일도 받고 텍스처를 올린다(visibility 만 봄).
 * 그래서 현재 프레임만 visible, 나머지는 visibility none. 재생 중에는 다음 `lookahead` 프레임을 불투명도 0 으로
 * 미리 받고(끊김 방지), 직전 프레임은 페이드아웃이 끝나도록 잠시 남긴다. 레이더가 꺼져 있으면 아무것도 보이지 않는다.
 */
export function frameDisplay(n: number, idx: number | null, enabled: boolean, playing: boolean, lookahead = 2): Map<number, FrameRole> {
  const out = new Map<number, FrameRole>();
  if (!enabled || n <= 0) return out;
  const cur = idx == null ? n - 1 : Math.min(n - 1, Math.max(0, idx));
  if (playing && n > 1) {
    out.set((cur - 1 + n) % n, "preload");
    for (let k = 1; k <= Math.min(lookahead, n - 1); k++) out.set((cur + k) % n, "preload");
  }
  out.set(cur, "current");
  return out;
}

/** 예측 궤적 라벨(지도 위 "추정") */
export const PREDICTION_LABEL = "추정 · 10분";

/**
 * 10분 예측 궤적(추정): 마지막 관측 위치·시각에서 현재 지상속도·방위로 직선 외삽(1분 간격 10점).
 * 예측 가능 여부는 서버가 판단한다(선회·저속·지상·방위 없음·지연 → 그리지 않음). 여기서는 값이 있는지만 본다.
 */
export function predictionFeature(a: AircraftState): GeoJSON.Feature<GeoJSON.LineString> | null {
  if (a.on_ground === true || a.gs_kt == null || a.track_deg == null || a.gs_kt <= 0 || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return null;
  const coords: [number, number][] = [[a.lon, a.lat]];
  for (let i = 1; i <= 10; i++) {
    const [lat, lon] = deadReckon(a.lat, a.lon, a.track_deg, a.gs_kt, i * 60);
    coords.push([lon, lat]);
  }
  return { type: "Feature", properties: { hex: a.hex, estimated: true, label: PREDICTION_LABEL }, geometry: { type: "LineString", coordinates: coords } };
}

/**
 * 예측선을 그릴 항공기(GAP-20, 설계 11.2 "선택 항공기 또는 예측 알림 대상만"):
 * - 활성 PREDICTED 알림 대상(서버가 이미 예측했다) — 현재 상태는 구독 영역의 aircraftStates.
 * - 선택 항공기: WS selected 의 prediction.available 이 true 일 때만(full 상태 사용). false 면(선회 등) 알림이 있어도 그리지 않는다(더 최신 판단).
 */
export function predictionTargets(selected: SelectedInfo | null, alerts: Iterable<Alert>, states: ReadonlyMap<string, AircraftState>): AircraftState[] {
  const out = new Map<string, AircraftState>();
  for (const a of alerts) {
    if (a.kind !== "PREDICTED" || a.left_at != null) continue;
    const s = states.get(a.hex);
    if (s) out.set(a.hex, s);
  }
  if (selected?.prediction) {
    if (selected.prediction.available && selected.state) out.set(selected.hex, selected.state);
    else if (!selected.prediction.available) out.delete(selected.hex);
  }
  return [...out.values()];
}

/** 예측선 입력이 바뀌었는지 비교하는 키(바뀌지 않으면 setData 하지 않는다) */
export function predictionKey(targets: AircraftState[]): string {
  return targets.map((t) => `${t.hex}:${t.seen_at ?? ""}:${t.lat}:${t.lon}:${t.gs_kt ?? ""}:${t.track_deg ?? ""}`).join("|");
}
