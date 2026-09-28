/**
 * 배경지도 시인성(계약 v4 §E) — OpenFreeMap dark 스타일을 받은 뒤(style.load) 알려진 층의 색만 바꾼다. 외부 요청은 늘리지 않는다.
 * - 층 고르기: 스타일 안의 층을 종류(type)와 OpenMapTiles 스키마의 source-layer(water·waterway·landcover·landuse·park·transportation·boundary·place·water_name)로
 *   찾아 그 층 id 에 paint 값을 넣는다. 스타일 판마다 층 id 가 다를 수 있어 이름을 외워 두지 않는다. 없는 층은 건너뛴다.
 *   우리 레이어(geojson 소스)는 source-layer 가 없어 건드리지 않는다.
 * - 목표(tests/basemap.test.ts 가 WCAG 2.x 대비를 계산해 확인):
 *   육지·바다 ≥ 1.5:1 이고 바다가 더 어둡다 · 국경선 ≥ 3:1 · 해안선(물 채움 외곽선)은 바다 ≥ 3:1 · 지명 글자는 육지·바다·halo 모두 ≥ 4.5:1(AA) ·
 *   항공기 고도 색·SIGMET 선 색은 육지·바다 모두 ≥ 3:1(WCAG 1.4.11 비텍스트 대비). 레이더는 바탕이 어두운 그대로라 색이 묻히지 않는다.
 */
import type * as maplibregl from "maplibre-gl";

/** 육지(배경·지표 피복 층) — 어두운 청회색 */
export const BASEMAP_LAND = "#2e3239";
/** 바다·호수·강 — 육지보다 어두운 남색 */
export const BASEMAP_WATER = "#040a12";
/** 도로·철도 — 육지보다 조금 밝게(바다·강보다 어두우면 물길처럼 보인다). 항공기·SIGMET 와 겨루지 않게 옅게 */
export const BASEMAP_ROAD = "#3a3f47";
/** 해안선(물 채움 외곽선, 1 px) */
export const BASEMAP_COAST = "#56779c";
/** 국경(admin_level ≤ 2) */
export const BASEMAP_BOUNDARY_COUNTRY = "#7a8492";
/** 그 아래 행정 경계(주·도) — 국경보다 옅게 */
export const BASEMAP_BOUNDARY_STATE = "#636c7a";
/** 지명(place) 글자 */
export const BASEMAP_LABEL = "#a3acb8";
/** 바다·호수 이름(water_name) 글자 */
export const BASEMAP_WATER_LABEL = "#7ea3c8";
/** 지명 글자 halo — 앱 바탕색과 같다 */
export const BASEMAP_HALO = "#0b0d10";
export const BASEMAP_HALO_WIDTH = 1.5;

/** 국경선 색: admin_level ≤ 2 는 국경, 그 밖(모름 포함 — to-number 는 null 을 0 으로 바꾸므로 먼저 99 로)은 옅은 행정 경계 */
export const BOUNDARY_COLOR_EXPR = [
  "case", ["<=", ["to-number", ["coalesce", ["get", "admin_level"], 99], 99], 2], BASEMAP_BOUNDARY_COUNTRY, BASEMAP_BOUNDARY_STATE,
] as unknown as maplibregl.ExpressionSpecification;

/** 스타일 층에서 쓰는 부분만 */
export interface StyleLayerLike { id: string; type: string; "source-layer"?: string }
export interface PaintOverride { id: string; prop: string; value: unknown }

/** 육지로 칠할 지표 피복 층(숲·주거지·공원 등). 바다보다 어두운 옛 색이 남으면 육지·바다 구분이 무너진다. */
const LAND_LAYERS: ReadonlySet<string> = new Set(["landcover", "landuse", "park"]);

/** 스타일 층 목록 → 바꿀 paint 값(층 순서대로). 모르는 층은 넣지 않는다. */
export function basemapOverrides(layers: readonly StyleLayerLike[]): PaintOverride[] {
  const out: PaintOverride[] = [];
  const set = (id: string, prop: string, value: unknown) => out.push({ id, prop, value });
  for (const l of layers) {
    if (!l || typeof l.id !== "string") continue;
    const sl = l["source-layer"];
    if (l.type === "background") { set(l.id, "background-color", BASEMAP_LAND); continue; }
    if (typeof sl !== "string") continue;
    if (l.type === "fill" && sl === "water") {
      set(l.id, "fill-color", BASEMAP_WATER);
      set(l.id, "fill-opacity", 1);
      // 외곽선은 fill-antialias 가 켜져 있어야 그려진다
      set(l.id, "fill-antialias", true);
      set(l.id, "fill-outline-color", BASEMAP_COAST);
    } else if (l.type === "fill" && LAND_LAYERS.has(sl)) {
      set(l.id, "fill-color", BASEMAP_LAND);
    } else if (l.type === "line" && sl === "waterway") {
      set(l.id, "line-color", BASEMAP_WATER);
    } else if (l.type === "line" && sl === "transportation") {
      set(l.id, "line-color", BASEMAP_ROAD);
    } else if (l.type === "line" && sl === "boundary") {
      set(l.id, "line-color", BOUNDARY_COLOR_EXPR);
      set(l.id, "line-opacity", 1);
    } else if (l.type === "symbol" && (sl === "place" || sl === "water_name")) {
      set(l.id, "text-color", sl === "place" ? BASEMAP_LABEL : BASEMAP_WATER_LABEL);
      set(l.id, "text-halo-color", BASEMAP_HALO);
      set(l.id, "text-halo-width", BASEMAP_HALO_WIDTH);
    }
  }
  return out;
}

/** 지도에서 쓰는 부분만(maplibregl.Map 이 맞는다 — 시험은 가짜로) */
export interface BasemapTarget {
  getStyle(): { layers?: readonly unknown[] } | undefined;
  setPaintProperty(id: string, prop: string, value: unknown): unknown;
}

/** 지도에 적용(style.load 마다). 적용한 수를 돌려준다. 스타일을 읽을 수 없거나 층이 없으면 0. */
export function applyBasemap(map: BasemapTarget): number {
  let layers: readonly StyleLayerLike[] = [];
  try { layers = (map.getStyle()?.layers ?? []) as readonly StyleLayerLike[]; } catch { return 0; }
  let n = 0;
  for (const o of basemapOverrides(layers)) {
    try { map.setPaintProperty(o.id, o.prop, o.value); n++; } catch { /* 그 층에 없는 속성 — 건너뛴다 */ }
  }
  return n;
}

// ---- WCAG 2.x 대비(시험·설계용 순수 함수) ----

/** "#rrggbb" → 상대 휘도(WCAG 2.x, sRGB) */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not #rrggbb: ${hex}`);
  const n = parseInt(m[1], 16);
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** 두 색의 대비(1–21) */
export function contrastRatio(a: string, b: string): number {
  const x = relativeLuminance(a), y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
