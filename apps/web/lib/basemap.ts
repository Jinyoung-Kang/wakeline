/**
 * 배경지도 시인성(계약 v4 §E) — OpenFreeMap dark 스타일을 받은 뒤(style.load) 알려진 층의 색만 바꾼다. 외부 요청은 늘리지 않는다.
 * - 층 고르기: 스타일 안의 층을 종류(type)와 OpenMapTiles 스키마의 source-layer(water·waterway·landcover·landuse·park·building·aeroway·transportation·boundary·place·water_name)로
 *   찾아 그 층 id 에 paint 값을 넣는다. 스타일 판마다 층 id 가 다를 수 있어 이름을 외워 두지 않는다. 없는 층은 건너뛴다.
 *   우리 레이어(geojson 소스)는 source-layer 가 없어 건드리지 않는다.
 * - 목표(tests/basemap.test.ts 가 WCAG 2.x 대비를 계산해 확인):
 *   육지·바다 ≥ 1.5:1 이고 바다가 더 어둡다 · 물이 아닌 채움(건물·공항 구역 포함)은 육지보다 어둡지 않다 · 국경선 ≥ 3:1 · 해안선은 바다 ≥ 3:1 · 지명 글자는 육지·바다·halo 모두 ≥ 4.5:1(AA) ·
 *   항공기 고도 색·SIGMET 선 색·선박 선종 색은 육지·바다(건물·공항 구역 포함) 모두 ≥ 3:1(WCAG 1.4.11 비텍스트 대비). 레이더는 바탕이 어두운 그대로라 색이 묻히지 않는다.
 * - 해안선(2026-09-30 — 사용자 스크린샷의 "지도 툴바 아래 파란 1 px 가로선"): 전에는 물 채움의 외곽선(fill-outline-color)을 해안 색으로 칠했다. 채움 외곽선은
 *   다각형의 모든 변을 긋기 때문에, 물 다각형끼리 맞닿는 안쪽 변(자료의 이음새 — 강원 앞바다 약 38.6°N 에서 해안부터 동쪽으로 뻗은 직선)도 바다 한가운데
 *   해안 색 선으로 보였다(문서 스크린샷 01 · 06 에서 같은 자리, 외곽선을 넣기 전 판(70e9955)에는 없다). 이제 채움 외곽선은 물 색이고, 해안선은 물 채움 층마다
 *   바로 아래에 같은 지물의 선 층(coastLayers)을 더해 1 px 바깥(육지 쪽 — line-offset 음수)으로 민다. 물 채움이 위에서 물 쪽을 덮으므로 이음새의 선은 가려지고
 *   육지와 맞닿은 해안의 선만 남는다. 외부 요청은 늘지 않는다(같은 타일).
 * - 층 순서(통합 리뷰 2026-09-30): OpenFreeMap dark 는 물 채움(1번째)보다 뒤에 육지 채움(얼음 · 빙하 · 주거지 · 숲 · 공원 · 건물 · 공항 활주로 구역)을 그린다.
 *   해안선은 육지 쪽 1 px 에 있으므로 그 채움이 해안에 닿는 곳에서는 해안선을 덮을 수 있다. 그래서 첫 물 채움보다 뒤의 지표 피복 · 토지 이용 · 공원 · 건물 채움을
 *   해안선 바로 아래로 옮긴다(landFillsAboveWater — 서로의 순서는 그대로). 물 · 해안선보다 위의 선(물길 · 도로 · 경계) · 글자(바다 이름 · 지명)는 그대로 위에 있다.
 *   물 다각형과 겹치는 그 채움은 이제 물 아래라 물로 보인다(물 쪽이 이긴다). 공항 활주로 구역(aeroway 채움)은 옮기지 않는다 — 스타일이 그 아래에 둔 유도로 선
 *   (#181818, 칠하지 않는다)이 드러난다(실제 타일 인천 z12 에서 확인). 부두 구역(transportation 채움)도 옮기지 않는다 — 물 위에 있다.
 *   실제 OpenFreeMap 타일(2026-09-30, 900×600 · 부산 z10 · 해운대 z13 · 인천 z10 · z12 · 강릉 z11 · 속초 z12 · 제주 z11 · 동해 38.6°N z7)에서 옮기기 전후의
 *   해안선 화소는 같거나(7곳) 28 px 늘었다(동해 z7 — 주거지 채움 0.4 불투명이 덮던 곳) — 덮임은 드물었지만 순서로 막는다.
 */
import type * as maplibregl from "maplibre-gl";

/** 육지(배경·지표 피복 층) — 어두운 청회색 */
export const BASEMAP_LAND = "#2e3239";
/** 건물·공항 구역(aeroway) 채움 — 육지보다 아주 조금 밝게(옛 스타일의 거의 검은 채움이 남으면 시가지·공항이 바다처럼 보인다) */
export const BASEMAP_LAND_DETAIL = "#31353c";
/** 바다·호수·강 — 육지보다 어두운 남색 */
export const BASEMAP_WATER = "#040a12";
/** 도로·철도 — 육지보다 조금 밝게(바다·강보다 어두우면 물길처럼 보인다). 항공기·SIGMET 와 겨루지 않게 옅게 */
export const BASEMAP_ROAD = "#3a3f47";
/** 해안선(물 채움 바로 아래의 선 층, 1 px — 육지 쪽으로 1 px 민다: coastLayers) */
export const BASEMAP_COAST = "#56779c";
/**
 * 해안선을 미는 거리(px, MapLibre line-offset — 양수 = 선 방향의 오른쪽). 벡터 타일의 바깥 고리는 화면에서 시계 방향(안쪽이 오른쪽)이고 구멍(섬)은 반대라
 * 음수면 둘 다 다각형 밖(육지 쪽)으로 간다. 1 px = 선 폭 1 px 이 물 채움의 경계 안티에일리어싱(±0.5 px) 바로 바깥에 놓이는 값(scratch 하네스로 확인한 선택).
 */
export const COAST_LINE_OFFSET_PX = -1;
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
export interface StyleLayerLike {
  id: string; type: string; source?: string; "source-layer"?: string; filter?: unknown; minzoom?: number; maxzoom?: number; layout?: { visibility?: string };
}
export interface PaintOverride { id: string; prop: string; value: unknown }

/** 육지로 칠할 지표 피복 층(숲·주거지·공원 등). 바다보다 어두운 옛 색이 남으면 육지·바다 구분이 무너진다. */
const LAND_LAYERS: ReadonlySet<string> = new Set(["landcover", "landuse", "park"]);
/** 육지 위의 다른 불투명 채움(건물·공항 구역) — 같은 이유로 육지보다 어둡지 않은 색으로 */
const LAND_DETAIL_LAYERS: ReadonlySet<string> = new Set(["building", "aeroway"]);

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
      // 경계는 부드럽게(안티에일리어싱) 하되 외곽선은 물 색 — 물 다각형 안쪽의 이음새가 선으로 보이지 않게. 해안선은 coastLayers 가 따로 긋는다
      set(l.id, "fill-antialias", true);
      set(l.id, "fill-outline-color", BASEMAP_WATER);
    } else if (l.type === "fill" && LAND_LAYERS.has(sl)) {
      set(l.id, "fill-color", BASEMAP_LAND);
    } else if (l.type === "fill" && LAND_DETAIL_LAYERS.has(sl)) {
      set(l.id, "fill-color", BASEMAP_LAND_DETAIL);
      // 건물 외곽선이 옛 어두운 색으로 남지 않게 채움과 같은 색
      set(l.id, "fill-outline-color", BASEMAP_LAND_DETAIL);
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

/** 해안선 층 하나: 넣을 층과 그 위에 올 물 채움 층 id */
export interface CoastLayer { beforeId: string; layer: maplibregl.LineLayerSpecification }

/**
 * 물 채움 층(OpenMapTiles source-layer water)마다 해안선 선 층 하나 — 같은 source · source-layer · filter · 줌 범위 · 보임(그 채움이 그리는 지물과 같게),
 * 그 채움 바로 아래에. 선은 1 px 바깥(COAST_LINE_OFFSET_PX)으로 밀려 육지 쪽에 놓이고, 물 쪽(이음새 포함)은 위의 물 채움이 덮는다. source 가 없는 층은 건너뛴다.
 */
export function coastLayers(layers: readonly StyleLayerLike[]): CoastLayer[] {
  const out: CoastLayer[] = [];
  for (const l of layers) {
    if (!l || typeof l.id !== "string" || l.type !== "fill" || l["source-layer"] !== "water" || typeof l.source !== "string") continue;
    out.push({
      beforeId: l.id,
      layer: {
        id: `wakeline-coast-${l.id}`, type: "line", source: l.source, "source-layer": "water",
        ...(l.filter !== undefined ? { filter: l.filter as maplibregl.FilterSpecification } : {}),
        ...(typeof l.minzoom === "number" ? { minzoom: l.minzoom } : {}),
        ...(typeof l.maxzoom === "number" ? { maxzoom: l.maxzoom } : {}),
        ...(l.layout?.visibility === "none" ? { layout: { visibility: "none" as const } } : {}),
        paint: { "line-color": BASEMAP_COAST, "line-width": 1, "line-offset": COAST_LINE_OFFSET_PX },
      },
    });
  }
  return out;
}

/** 해안선 아래로 옮길 육지 채움의 source-layer — 공항(aeroway)은 빼고(위 머리 주석: 그 아래의 유도로 선이 드러난다) */
const MOVE_BELOW_COAST: ReadonlySet<string> = new Set(["landcover", "landuse", "park", "building"]);

/**
 * 첫 물 채움(해안선이 붙는 층)보다 뒤에 그려지는 육지 채움(landcover · landuse · park · building 의 fill)의 id — 층 순서대로. 이 층들이 물 위에 있으면
 * 육지 쪽 1 px 의 해안선을 덮을 수 있다(applyBasemap 이 해안선 아래로 옮긴다). 물 채움이 없거나 source 가 없어 해안선이 없으면 [].
 */
export function landFillsAboveWater(layers: readonly StyleLayerLike[]): string[] {
  const first = coastLayers(layers)[0];
  if (!first) return [];
  const at = layers.findIndex((l) => l?.id === first.beforeId);
  return layers.slice(at + 1)
    .filter((l) => l && typeof l.id === "string" && l.type === "fill" && typeof l["source-layer"] === "string" && MOVE_BELOW_COAST.has(l["source-layer"]))
    .map((l) => l.id);
}

/** 지도에서 쓰는 부분만(maplibregl.Map 이 맞는다 — 시험은 가짜로) */
export interface BasemapTarget {
  getStyle(): { layers?: readonly unknown[] } | undefined;
  setPaintProperty(id: string, prop: string, value: unknown): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: CoastLayer["layer"], beforeId?: string): unknown;
  moveLayer(id: string, beforeId?: string): unknown;
}

/**
 * 지도에 적용(style.load 마다): 알려진 층의 색을 바꾸고 해안선 층을 더한 뒤(이미 있으면 더하지 않는다), 첫 해안선보다 위의 육지 채움을 그 해안선 바로 아래로
 * 옮긴다(landFillsAboveWater — 서로의 순서는 그대로, 다시 불러도 같은 자리). 적용한 수를 돌려준다.
 * 스타일을 읽을 수 없거나 층이 없으면 0. 거절된 속성 · 층 · 옮기기는 건너뛴다(배경지도가 조금 덜 칠해질 뿐 지도는 계속 그려진다).
 */
export function applyBasemap(map: BasemapTarget): number {
  let layers: readonly StyleLayerLike[] = [];
  try { layers = (map.getStyle()?.layers ?? []) as readonly StyleLayerLike[]; } catch { return 0; }
  let n = 0;
  for (const o of basemapOverrides(layers)) {
    try { map.setPaintProperty(o.id, o.prop, o.value); n++; } catch { /* 그 층에 없는 속성 — 건너뛴다 */ }
  }
  const coasts = coastLayers(layers);
  for (const c of coasts) {
    try {
      if (map.getLayer(c.layer.id)) continue;
      map.addLayer(c.layer, c.beforeId);
      n++;
    } catch { /* 그 스타일이 받지 않는 층 — 해안선 없이 그린다 */ }
  }
  const first = coasts[0]?.layer.id;
  let hasFirst = false;
  try { hasFirst = first != null && !!map.getLayer(first); } catch { /* 모름 — 옮기지 않는다 */ }
  if (first && hasFirst) {
    for (const id of landFillsAboveWater(layers)) {
      try { map.moveLayer(id, first); n++; } catch { /* 옮기지 못한 층 — 그 자리에서 해안선을 덮을 수 있다 */ }
    }
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
