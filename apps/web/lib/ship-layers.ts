/**
 * 선박 지도 레이어(계약 v2 §B4) — 상황판 지도(MapView)만 쓴다. 항공기 기호 아래, SIGMET·레이더 위.
 * - 아이콘: 선수방위가 있으면 선체(실루엣, 선수 방향 회전) · 침로만 있으면 점선 외곽 선체("침로 기준") · 둘 다 없으면 회전하지 않는 원("방향 모름").
 * - 색: 선종 분류(ships.ts SHIP_CATEGORY_COLOR — 범례와 같은 표). 선택 = 흰색. STALE(> 15분) 반투명.
 * - 격자(계약 v4 §C — 줌 < 4 · 화면 안 선박이 상한 초과): 칸 선박 수에 따라 커지는 원(최소 반지름 8 px) + 수 라벨(halo), 색 = 가장 많은 선종,
 *   흰 테두리 1.5 px · 불투명도 0.85 — 어두운 육지·바다 어디서나 보인다. 항공기 기호보다 아래 층.
 * - 항적: 실선(기록 구간) · 회색 점선 + 라벨(AIS 공백·기록 없음 — 그 사이 위치는 모름).
 * - 수신 범위(계약 v3 §A): 운영 설정 수신 범위의 바깥 경계만 옅은 점선. 범위 밖을 가리지 않는다. status 에 범위가 없으면 그리지 않는다.
 */
import type * as maplibregl from "maplibre-gl";
import { sdfImage } from "./maplayers";
import { SHIP_CATEGORIES, SHIP_CATEGORY_COLOR, SHIP_SELECTED_COLOR, type ShipCategory } from "./ships";

/** 선체(48×48, 선수 위쪽) — 지도 아이콘과 범례가 같은 경로를 쓴다 */
export const HULL_PATH = "M24 4 C29 10 32 16 32 24 L32 42 Q32 45 29 45 L19 45 Q16 45 16 42 L16 24 C16 16 19 10 24 4 Z";
/** 방향 모름(원) */
export const SHIP_NODIR_PATH = "M24 13 A11 11 0 1 1 23.99 13 Z";
/** 침로 기준 아이콘: 선체 점선 외곽 + 안쪽 절반 크기 선체. 안쪽 선체 변환(범례 SVG 와 같은 값) */
export const HULL_COG_INNER = { tx: 12, ty: 13, scale: 0.5 } as const;
export const HULL_COG_DASH: [number, number] = [7, 5];
export const HULL_COG_STROKE = 4;

/** 침로 기준 아이콘 이미지(점선 외곽 선체 + 작은 선체) */
export function shipCogImage(size = 48): ImageData {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.strokeStyle = "#000";
  ctx.lineWidth = HULL_COG_STROKE;
  ctx.setLineDash(HULL_COG_DASH);
  ctx.stroke(new Path2D(HULL_PATH));
  ctx.setLineDash([]);
  ctx.save();
  ctx.translate(HULL_COG_INNER.tx, HULL_COG_INNER.ty);
  ctx.scale(HULL_COG_INNER.scale, HULL_COG_INNER.scale);
  ctx.fill(new Path2D(HULL_PATH));
  ctx.restore();
  return ctx.getImageData(0, 0, size, size);
}

export const SHIP_ICON_EXPR = [
  "match", ["get", "rot_mode"], "heading", "ship-hull", "cog", "ship-hull-cog", "ship-nodir",
] as unknown as maplibregl.ExpressionSpecification;
/** 방향을 알 때만 회전(모르면 0 — 원은 방향을 뜻하지 않는다) */
export const SHIP_ROTATE_EXPR = [
  "case", ["==", ["get", "rot_mode"], "none"], 0, ["to-number", ["get", "rot"], 0],
] as unknown as maplibregl.ExpressionSpecification;
const CATEGORY_MATCH = ["match", ["coalesce", ["get", "cat"], "unknown"], ...SHIP_CATEGORIES.filter((c) => c !== "unknown").flatMap((c) => [c, SHIP_CATEGORY_COLOR[c]]), SHIP_CATEGORY_COLOR.unknown];
export const SHIP_COLOR_EXPR = [
  "case", ["boolean", ["get", "selected"], false], SHIP_SELECTED_COLOR, CATEGORY_MATCH,
] as unknown as maplibregl.ExpressionSpecification;
export const SHIP_GRID_COLOR_EXPR = CATEGORY_MATCH as unknown as maplibregl.ExpressionSpecification;
/** STALE(> 15분) 35% · 수신 경과 모름 70% */
export const SHIP_OPACITY_EXPR = [
  "case", ["boolean", ["get", "stale"], false], 0.35, ["boolean", ["get", "age_unknown"], false], 0.7, 1,
] as unknown as maplibregl.ExpressionSpecification;
/** 격자 원 모양(계약 v4 §C) — 지도와 범례가 같은 값 */
export const SHIP_GRID_STYLE = { minRadius: 8, opacity: 0.85, stroke: "#ffffff", strokeWidth: 1.5, labelColor: "#ffffff", labelHalo: "#0b0d10", labelHaloWidth: 1.5 } as const;
/** 격자 원 반지름: 선박 수의 제곱근에 비례(면적 ∝ 수), 1척이어도 최소 반지름 */
export const SHIP_GRID_RADIUS_EXPR = [
  "interpolate", ["linear"], ["sqrt", ["get", "count"]], 1, SHIP_GRID_STYLE.minRadius, 10, 14, 30, 22, 100, 34,
] as unknown as maplibregl.ExpressionSpecification;

/**
 * 선종 필터(계약 v5 §B3) — 점 모드 "ship-symbol" 의 MapLibre filter. 모두 켜져 있으면 null(필터 없음).
 * 분류가 없으면 unknown 으로 본다(색 식 CATEGORY_MATCH 와 같은 규칙).
 */
export function shipCategoryFilter(enabled: ReadonlySet<ShipCategory>): maplibregl.FilterSpecification | null {
  if (SHIP_CATEGORIES.every((c) => enabled.has(c))) return null;
  return ["in", ["coalesce", ["get", "cat"], "unknown"], ["literal", SHIP_CATEGORIES.filter((c) => enabled.has(c))]] as unknown as maplibregl.FilterSpecification;
}

/** 수신 범위 경계선 — 범례 견본과 같은 값 */
export const SHIP_COVERAGE_COLOR = "#7f93a8";
export const SHIP_COVERAGE_DASH: [number, number] = [4, 3];

export const SHIP_LAYERS = ["ship-coverage-line", "ship-track-line", "ship-track-gap", "ship-track-gap-label", "ship-grid-circle", "ship-grid-label", "ship-symbol"] as const;
export const SHIP_IMAGES = ["ship-hull", "ship-hull-cog", "ship-nodir"] as const;

/** 선박 소스·레이어를 beforeId(항공기 기호) 아래에 더한다. 모두 visibility none 으로 시작(선박 레이어를 켜야 보인다). */
export function addShipLayers(map: maplibregl.Map, beforeId = "aircraft-symbol") {
  map.addImage("ship-hull", sdfImage(HULL_PATH), { sdf: true });
  map.addImage("ship-hull-cog", shipCogImage(), { sdf: true });
  map.addImage("ship-nodir", sdfImage(SHIP_NODIR_PATH), { sdf: true });
  const hidden = { visibility: "none" as const };
  const before = map.getLayer?.(beforeId) ? beforeId : undefined;

  map.addSource("ship-coverage", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "ship-coverage-line", type: "line", source: "ship-coverage", layout: hidden,
    paint: { "line-color": SHIP_COVERAGE_COLOR, "line-width": 1, "line-opacity": 0.6, "line-dasharray": SHIP_COVERAGE_DASH },
  }, before);

  map.addSource("ship-track", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "ship-track-line", type: "line", source: "ship-track", filter: ["==", ["get", "kind"], "track"], layout: hidden,
    paint: { "line-color": "#dbe4ee", "line-width": 2, "line-opacity": 0.85 },
  }, before);
  map.addLayer({
    id: "ship-track-gap", type: "line", source: "ship-track", filter: ["==", ["get", "kind"], "gap"], layout: hidden,
    paint: { "line-color": "#8a929d", "line-width": 1.5, "line-dasharray": [2, 2] },
  }, before);
  map.addLayer({
    id: "ship-track-gap-label", type: "symbol", source: "ship-track", filter: ["==", ["get", "kind"], "gap"],
    layout: { ...hidden, "symbol-placement": "line-center", "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 10 },
    paint: { "text-color": "#a3aab4", "text-halo-color": "#0b0d10", "text-halo-width": 1 },
  }, before);

  map.addSource("ship-grid", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "ship-grid-circle", type: "circle", source: "ship-grid", layout: hidden,
    paint: {
      "circle-radius": SHIP_GRID_RADIUS_EXPR, "circle-color": SHIP_GRID_COLOR_EXPR, "circle-opacity": SHIP_GRID_STYLE.opacity,
      "circle-stroke-color": SHIP_GRID_STYLE.stroke, "circle-stroke-width": SHIP_GRID_STYLE.strokeWidth,
    },
  }, before);
  map.addLayer({
    id: "ship-grid-label", type: "symbol", source: "ship-grid",
    layout: { ...hidden, "text-field": ["get", "label"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-allow-overlap": true },
    paint: { "text-color": SHIP_GRID_STYLE.labelColor, "text-halo-color": SHIP_GRID_STYLE.labelHalo, "text-halo-width": SHIP_GRID_STYLE.labelHaloWidth },
  }, before);

  map.addSource("ships", { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "mmsi" });
  map.addLayer({
    id: "ship-symbol", type: "symbol", source: "ships",
    layout: {
      ...hidden,
      "icon-image": SHIP_ICON_EXPR,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 7, 0.3, 10, 0.45, 13, 0.62],
      "icon-rotate": SHIP_ROTATE_EXPR,
      "icon-rotation-alignment": "map",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "text-field": ["step", ["zoom"], "", 10, ["coalesce", ["get", "name"], ""]],
      "text-font": ["Noto Sans Regular"],
      "text-size": 10, "text-offset": [0, 1.3], "text-anchor": "top", "text-optional": true,
    },
    paint: { "icon-color": SHIP_COLOR_EXPR, "icon-opacity": SHIP_OPACITY_EXPR, "text-color": "#9fb3c8", "text-halo-color": "#0b0d10", "text-halo-width": 1 },
  }, before);
}
