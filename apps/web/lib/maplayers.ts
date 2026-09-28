/** 지도 레이어 정의(11.2절) — 상황판·재생 화면이 공유. */
import type * as maplibregl from "maplibre-gl";
import { ALT_RAMP, ALT_UNKNOWN_COLOR, CAT_COLORS, CAT_STALE_FILL, CAT_STALE_STROKE, CAT_UNKNOWN_COLOR, GND_COLOR, HAZARD_COLORS, HAZARD_DEFAULT_COLOR } from "./format";
import { deadReckon, seenAtMs, thresholds } from "./interpolate";
import type { AircraftState, Alert, SelectedInfo } from "./types";

export const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
/**
 * 배경지도 스타일(STYLE_URL, 외부)을 받지 못했을 때 바꿔 끼우는 로컬 최소 스타일(R-01). 외부 요청이 없다(소스·스프라이트·글꼴 URL 없음 —
 * 글자는 MapLibre 가 로컬 글꼴로 그린다). 배경은 앱 바탕색 한 가지로, 육지·바다를 칠하지 않는다(모르는 지형을 그리지 않는다).
 * 우리 데이터 레이어(addBaseLayers·addShipLayers)는 이 위에 그대로 그려진다.
 */
export const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "wakeline-no-basemap", type: "background", paint: { "background-color": "#0b0d10" } }],
};
/** MapLibre 워커 경로(버전 폴더) — scripts/copy-maplibre-worker.mjs 가 public/maplibre/<버전>/ 에 복사한다. 지도를 만들기 전에 한 번 지정. */
export { MAPLIBRE_WORKER_URL } from "./maplibre";
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

/** 비행기 실루엣(48×48, 기수 위쪽) — 지도 아이콘과 범례가 같은 경로를 쓴다 */
export const PLANE_PATH = "M24 2 L27 12 L27 22 L44 32 L44 36 L27 30 L26 40 L32 44 L32 47 L24 45 L16 47 L16 44 L22 40 L21 30 L4 36 L4 32 L21 22 L21 12 Z";
/** 방위 모름 아이콘(48×48 마름모) — 어느 쪽도 가리키지 않는다(DH-11) */
export const NODIR_PATH = "M24 10 L38 24 L24 38 L10 24 Z";

/** 48×48 경로를 채운 SDF 마스크(검정·불투명) — icon-color 로 칠한다. 선박 아이콘(ship-layers.ts)도 쓴다. */
export function sdfImage(path: string, size = 48): ImageData {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fill(new Path2D(path));
  return ctx.getImageData(0, 0, size, size);
}
/** 항공기 SDF 아이콘(비행기 실루엣) — icon-color 로 고도 색 램프를 적용한다. */
export function planeImage(size = 48): ImageData {
  return sdfImage(PLANE_PATH, size);
}

// ---- 항공기 기호(DH-3 · DH-11) ----
const HAS_TRACK = ["==", ["typeof", ["get", "track_deg"]], "number"];
/** 방위(track_deg)를 알면 비행기 실루엣, 모르면 방향 없는 마름모 — 모르는 방위를 북쪽(0°)으로 그리지 않는다. */
export const AIRCRAFT_ICON_EXPR = ["case", HAS_TRACK, "plane", "plane-nodir"] as unknown as maplibregl.ExpressionSpecification;
/** 방위를 알 때만 회전. 모르면 0(마름모는 회전해도 방향을 뜻하지 않는다). */
export const AIRCRAFT_ROTATE_EXPR = ["case", HAS_TRACK, ["get", "track_deg"], 0] as unknown as maplibregl.ExpressionSpecification;
/** 아이콘 색: 비상 > 선택 > 지상(공급자 on_ground, 고도 램프의 0 ft 색이 아님) > 고도 램프(모르면 회색). */
export const AIRCRAFT_COLOR_EXPR = [
  "case", ["boolean", ["get", "emergency"], false], "#e5484d",
  ["boolean", ["get", "selected"], false], "#ffffff",
  ["==", ["get", "on_ground"], true], GND_COLOR,
  ALT_COLOR_EXPR,
] as unknown as maplibregl.ExpressionSpecification;

// ---- SIGMET 표현(DH-8): 발효 전(pending)은 연한 채움 + 점선, 곧 만료는 파선, 안에 항공기(관측 알림)는 굵게 ----
const PENDING = ["boolean", ["get", "pending"], false];
export const SIGMET_FILL_OPACITY_EXPR = [
  "case", PENDING, 0.04, ["boolean", ["get", "inside"], false], 0.28, 0.15,
] as unknown as maplibregl.ExpressionSpecification;
export const SIGMET_LINE_DASH_EXPR = [
  "case", PENDING, ["literal", [0.6, 2.4]], ["boolean", ["get", "expiring_soon"], false], ["literal", [2, 2]], ["literal", [1, 0]],
] as unknown as maplibregl.ExpressionSpecification;
export const SIGMET_LINE_WIDTH_EXPR = [
  "case", PENDING, 1.2, ["boolean", ["get", "inside"], false], 3, 1.2,
] as unknown as maplibregl.ExpressionSpecification;

/** 레이더 레이어 자리 표시(빈 소스·숨김). 커버리지 마스크는 이 아래, 레이더 프레임은 이 위·SIGMET 아래에 끼운다. */
export const RADAR_SLOT = "radar-slot";

/**
 * 공항 라벨(줌 7+): ICAO 와 비행 카테고리 글자 — 색만으로 구분하지 않는다(R-40, WCAG 1.4.1). METAR 가 오래됐거나(stale) 카테고리를 모르면 ICAO 만
 * (원 색도 같은 규칙으로 회색 — AIRPORT_FILL_EXPR).
 */
export const AIRPORT_LABEL_EXPR = [
  "case", ["boolean", ["get", "stale"], false], ["get", "icao"],
  ["match", ["coalesce", ["get", "flight_cat"], ""], Object.keys(CAT_COLORS), ["concat", ["get", "icao"], " ", ["get", "flight_cat"]], ["get", "icao"]],
] as unknown as maplibregl.ExpressionSpecification;

export function addBaseLayers(map: maplibregl.Map) {
  map.addImage("plane", planeImage(), { sdf: true });
  map.addImage("plane-nodir", sdfImage(NODIR_PATH), { sdf: true });

  map.addSource("anchors", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: RADAR_SLOT, type: "line", source: "anchors", layout: { visibility: "none" } });

  map.addSource("sigmets", { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "id" });
  map.addLayer({
    id: "sigmet-fill", type: "fill", source: "sigmets",
    paint: { "fill-color": HAZARD_COLOR_EXPR, "fill-opacity": SIGMET_FILL_OPACITY_EXPR },
  });
  map.addLayer({
    id: "sigmet-line", type: "line", source: "sigmets",
    paint: { "line-color": HAZARD_COLOR_EXPR, "line-width": SIGMET_LINE_WIDTH_EXPR, "line-dasharray": SIGMET_LINE_DASH_EXPR },
  });

  map.addSource("tracks", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "track-line", type: "line", source: "tracks", filter: ["==", ["get", "kind"], "track"],
    paint: { "line-color": ALT_COLOR_EXPR, "line-width": 2, "line-opacity": 0.9 },
  });
  // 수신 공백(R-04, lib/track.ts TRACK_GAP_MS): 관측하지 않은 구간 — 선박 항적 공백과 같은 회색 점선 + "수신 없음 hh:mm–hh:mm"
  map.addLayer({
    id: "track-gap", type: "line", source: "tracks", filter: ["==", ["get", "kind"], "gap"],
    paint: { "line-color": "#8a929d", "line-width": 1.5, "line-dasharray": [2, 2] },
  });
  map.addLayer({
    id: "track-gap-label", type: "symbol", source: "tracks", filter: ["==", ["get", "kind"], "gap"],
    layout: { "symbol-placement": "line-center", "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 10 },
    paint: { "text-color": "#a3aab4", "text-halo-color": "#0b0d10", "text-halo-width": 1 },
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
    layout: { "text-field": AIRPORT_LABEL_EXPR, "text-font": ["Noto Sans Regular"], "text-size": 10, "text-offset": [0, 1.1], "text-anchor": "top" },
    paint: { "text-color": "#a3aab4", "text-halo-color": "#0b0d10", "text-halo-width": 1 },
  });

  map.addSource("aircraft", { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "hex" });
  map.addLayer({
    id: "aircraft-symbol", type: "symbol", source: "aircraft",
    layout: {
      "icon-image": AIRCRAFT_ICON_EXPR,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.22, 7, 0.38, 11, 0.6],
      "icon-rotate": AIRCRAFT_ROTATE_EXPR,
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "text-field": ["step", ["zoom"], "", 8, ["coalesce", ["get", "callsign"], ""]],
      "text-font": ["Noto Sans Regular"],
      "text-size": 10, "text-offset": [0, 1.3], "text-anchor": "top", "text-optional": true,
    },
    paint: {
      "icon-color": AIRCRAFT_COLOR_EXPR,
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
/** 회색 0.4 — 밝아진 배경지도 육지(lib/basemap.ts) 위에서도 옛 지도만큼 구분된다(tests/basemap.test.ts) */
export const COVERAGE_PAINT = { "raster-opacity": 0.5, "raster-brightness-min": 0.4, "raster-saturation": -1 } as const;

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
/** 서버 엔진과 같은 예측 조건(IntersectionEngine: 10 × 60 s, |lat| ≤ 85) */
const PREDICT_STEPS = 10;
const PREDICT_STEP_S = 60;
const PREDICT_MAX_ABS_LAT = 85;

/**
 * 10분 예측 궤적(추정, DH-12): 서버 엔진(IntersectionEngine.predictOne)과 같게 — 관측 위치를 seen_at → 지금(서버 기준)까지 먼저 전진시킨 뒤,
 * 그 위치에서 현재 지상속도·방위로 1분 간격 10점 직선 외삽. 그래서 선의 시작 = 지금, 끝 = 지금 + 10분이고 PREDICTED 알림의 ETA 와 맞는다.
 * 예측 가능 여부는 서버가 판단한다(선회·저속·지상·방위 없음·지연 → 그리지 않음). 여기서는 값·시각이 있는지만 본다:
 * 관측 시각을 모르면 선이 언제부터인지 모르므로, 지연 기준(60 s / opensky 300 s)을 넘으면 엔진이 예측하지 않으므로 그리지 않는다.
 * 경도 ±180 을 넘는 궤적은 엔진처럼 생략한다.
 */
export function predictionFeature(a: AircraftState, serverNowMs: number): GeoJSON.Feature<GeoJSON.LineString> | null {
  if (a.on_ground === true || a.gs_kt == null || a.track_deg == null || a.gs_kt <= 0 || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return null;
  const seen = seenAtMs(a.seen_at);
  if (seen == null || !Number.isFinite(serverNowMs)) return null;
  const age = Math.max(0, (serverNowMs - seen) / 1000);
  if (age > thresholds(a.provider).staleAfterS) return null;
  const [lat0, lon0] = age > 0 ? deadReckon(a.lat, a.lon, a.track_deg, a.gs_kt, age) : [a.lat, a.lon];
  if (Math.abs(lat0) > PREDICT_MAX_ABS_LAT) return null;
  const coords: [number, number][] = [[lon0, lat0]];
  for (let i = 1; i <= PREDICT_STEPS; i++) {
    const [lat, lon] = deadReckon(lat0, lon0, a.track_deg, a.gs_kt, i * PREDICT_STEP_S);
    if (Math.abs(lon - coords[i - 1][0]) > 180) return null;
    coords.push([lon, lat]);
  }
  return {
    type: "Feature",
    properties: { hex: a.hex, estimated: true, label: PREDICTION_LABEL, from: new Date(serverNowMs).toISOString(), horizon_s: PREDICT_STEPS * PREDICT_STEP_S },
    geometry: { type: "LineString", coordinates: coords },
  };
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

/**
 * 예측선 입력이 바뀌었는지 비교하는 키(바뀌지 않으면 setData 하지 않는다). 선의 시작이 "지금"이므로 대상이 있으면 초 단위 시각도 넣는다
 * (최대 1 s 마다 다시 그림, 대상이 없으면 시각과 무관하게 같은 키).
 */
export function predictionKey(targets: AircraftState[], serverNowMs = 0): string {
  if (targets.length === 0) return "";
  return `${Math.floor(serverNowMs / 1000)}#` + targets.map((t) => `${t.hex}:${t.seen_at ?? ""}:${t.lat}:${t.lon}:${t.gs_kt ?? ""}:${t.track_deg ?? ""}`).join("|");
}
