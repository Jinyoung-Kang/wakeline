/** 지도 레이어 정의(11.2절) — 상황판·재생 화면이 공유. */
import type * as maplibregl from "maplibre-gl";
import { deadReckon } from "./interpolate";
import type { AircraftState } from "./types";

export const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";
/** MapLibre 워커 경로 — scripts/copy-maplibre-worker.mjs 가 public/maplibre/ 에 복사한다. 지도를 만들기 전에 한 번 호출. */
export const MAPLIBRE_WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";
export const RADAR_COLOR_SCHEME = 2;

export const HAZARD_COLOR_EXPR: maplibregl.ExpressionSpecification = [
  "match", ["get", "hazard"],
  "TS", "#f59e0b", "CONVECTIVE", "#f59e0b", "TURB", "#a855f7", "ICE", "#38bdf8", "MTW", "#64748b", "VA", "#a16207", "TC", "#ef4444",
  "IFR", "#ef4444", "MTN OBSCN", "#64748b", "#94a3b8",
];

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

export function addBaseLayers(map: maplibregl.Map) {
  map.addImage("plane", planeImage(), { sdf: true });

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
    paint: { "line-color": ["interpolate", ["linear"], ["coalesce", ["get", "alt_ft"], 0], 0, "#3ec98f", 20000, "#4c90f0", 40000, "#e5e7eb"], "line-width": 2, "line-opacity": 0.9 },
  });

  map.addSource("prediction", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "prediction-line", type: "line", source: "prediction", paint: { "line-color": "#b18cf5", "line-width": 1.5, "line-dasharray": [2, 3] } });

  map.addSource("airports", { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "icao" });
  map.addLayer({
    id: "airport-circle", type: "circle", source: "airports", minzoom: 5.5,
    paint: {
      "circle-radius": 5,
      "circle-color": ["match", ["coalesce", ["get", "flight_cat"], "-"], "VFR", "#22c55e", "MVFR", "#3b82f6", "IFR", "#ef4444", "LIFR", "#d946ef", "#4b5563"],
      "circle-stroke-color": "#0b0d10", "circle-stroke-width": 1.5,
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
        ["interpolate", ["linear"], ["coalesce", ["get", "alt_ft"], 0], 0, "#3ec98f", 10000, "#4c90f0", 25000, "#8fb8ff", 40000, "#e5e7eb"]],
      "icon-opacity": ["case", ["boolean", ["get", "stale"], false], 0.4, 1],
      "icon-halo-color": ["case", ["boolean", ["get", "emergency"], false], "#ff0000", ["boolean", ["get", "estimated"], false], "rgba(0,0,0,0)", "#ffffff"],
      "icon-halo-width": ["case", ["boolean", ["get", "emergency"], false], 2, ["boolean", ["get", "estimated"], false], 0, 1],
      "text-color": "#cfd4da", "text-halo-color": "#0b0d10", "text-halo-width": 1,
    },
  });
}

export function radarTileUrl(host: string, path: string) {
  return `${host}${path}/512/{z}/{x}/{y}/${RADAR_COLOR_SCHEME}/1_1.png`;
}

/** 선택 항공기의 10분 예측 궤적(추정) */
export function predictionFeature(a: AircraftState): GeoJSON.Feature<GeoJSON.LineString> | null {
  if (a.on_ground || a.gs_kt == null || a.track_deg == null || a.gs_kt < 60) return null;
  const coords: [number, number][] = [[a.lon, a.lat]];
  for (let i = 1; i <= 10; i++) {
    const [lat, lon] = deadReckon(a.lat, a.lon, a.track_deg, a.gs_kt, i * 60);
    coords.push([lon, lat]);
  }
  return { type: "Feature", properties: { hex: a.hex, estimated: true }, geometry: { type: "LineString", coordinates: coords } };
}
