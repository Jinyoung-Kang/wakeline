/**
 * 배경지도 시인성(계약 v4 §E) — 고른 색의 WCAG 대비를 계산해 확인하고, 합성(SYNTHETIC) 스타일에 덮어쓸 paint 값이 스타일 명세에 맞는지 본다.
 * 스타일 층 목록은 OpenMapTiles 스키마 모양의 합성 값이다(외부 스타일을 받지 않는다).
 */
import { readFileSync } from "node:fs";
import { createPropertyExpression, latest, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import {
  applyBasemap, BASEMAP_BOUNDARY_COUNTRY, BASEMAP_BOUNDARY_STATE, BASEMAP_COAST, BASEMAP_HALO, BASEMAP_LABEL, BASEMAP_LAND, BASEMAP_LAND_DETAIL, BASEMAP_ROAD, BASEMAP_WATER,
  BASEMAP_WATER_LABEL, basemapOverrides, BOUNDARY_COLOR_EXPR, COAST_LINE_OFFSET_PX, coastLayers, contrastRatio, landFillsAboveWater, relativeLuminance, type StyleLayerLike,
} from "@/lib/basemap";
import { ALT_RAMP, ALT_UNKNOWN_COLOR, GND_COLOR, HAZARD_COLORS, HAZARD_DEFAULT_COLOR } from "@/lib/format";
import { AIRCRAFT_COLOR_EXPR, COVERAGE_PAINT } from "@/lib/maplayers";
import { SHIP_CATEGORIES, SHIP_CATEGORY_COLOR } from "@/lib/ships";

function evalExpr(expr: unknown, spec: string, properties: Record<string, unknown>, zoom = 8): unknown {
  const [group, prop] = spec.split(".");
  const propSpec = (latest as unknown as Record<string, Record<string, unknown>>)[group][prop];
  const r = createPropertyExpression(expr, `layers[0].${group.split("_")[0]}.${prop}`, propSpec as never);
  if (r.result !== "success") throw new Error(r.value.map((e) => `${e.key}: ${e.message}`).join("; "));
  return r.value.evaluate({ zoom } as never, { type: "Point", properties } as never);
}
const colorHex = (c: unknown) => {
  const x = c as { r: number; g: number; b: number };
  return "#" + [x.r, x.g, x.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
};
const hex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
/** a 위에 b 를 불투명도 alpha 로(8 bit sRGB 에서 섞음 — WebGL 기본 블렌딩) */
function over(base: string, top: string, alpha: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [a, b] = [p(base), p(top)];
  return hex(a[0] * (1 - alpha) + b[0] * alpha, a[1] * (1 - alpha) + b[1] * alpha, a[2] * (1 - alpha) + b[2] * alpha);
}

const GROUNDS: [string, string][] = [["land", BASEMAP_LAND], ["water", BASEMAP_WATER]];
/** 기호(항공기·SIGMET·선박)가 놓이는 모든 바탕 — 건물·공항 구역 채움 포함 */
const SYMBOL_GROUNDS: [string, string][] = [...GROUNDS, ["building/aeroway", BASEMAP_LAND_DETAIL]];

describe("WCAG contrast helpers", () => {
  it("match the WCAG 2.x definition", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 10);
    expect(contrastRatio("#3ec98f", "#3ec98f")).toBe(1);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2); // WCAG 에서 흔히 드는 예(4.48:1 — AA 미달)
    expect(() => relativeLuminance("red")).toThrow();
  });
});

describe("basemap colours (contract v4 §E)", () => {
  it("the measured OpenFreeMap dark land/water (rgb 12,12,12 vs 27,27,29) was below 1.5:1 with the sea lighter", () => {
    expect(contrastRatio("#0c0c0c", "#1b1b1d")).toBeLessThan(1.5);
    expect(relativeLuminance("#1b1b1d")).toBeGreaterThan(relativeLuminance("#0c0c0c"));
  });
  it("land and water: ≥ 1.5:1 and the water is the darker one", () => {
    expect(contrastRatio(BASEMAP_LAND, BASEMAP_WATER)).toBeGreaterThanOrEqual(1.5);
    expect(relativeLuminance(BASEMAP_WATER)).toBeLessThan(relativeLuminance(BASEMAP_LAND));
    // 남색 계열: 파랑 성분이 가장 크다
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(BASEMAP_WATER.slice(i, i + 2), 16));
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });
  it("place and water labels reach 4.5:1 (AA) against land, water and their halo", () => {
    for (const label of [BASEMAP_LABEL, BASEMAP_WATER_LABEL]) {
      for (const [name, ground] of [...GROUNDS, ["halo", BASEMAP_HALO] as [string, string]]) {
        expect(contrastRatio(label, ground), `${label} on ${name}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it("country borders ≥ 3:1 on land and water; state borders stay visible but fainter; the coastline ≥ 3:1 against the water", () => {
    for (const [name, ground] of GROUNDS) expect(contrastRatio(BASEMAP_BOUNDARY_COUNTRY, ground), name).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(BASEMAP_BOUNDARY_STATE, BASEMAP_LAND)).toBeGreaterThanOrEqual(2);
    expect(contrastRatio(BASEMAP_BOUNDARY_STATE, BASEMAP_LAND)).toBeLessThan(contrastRatio(BASEMAP_BOUNDARY_COUNTRY, BASEMAP_LAND));
    expect(contrastRatio(BASEMAP_COAST, BASEMAP_WATER)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(BASEMAP_COAST, BASEMAP_LAND)).toBeGreaterThanOrEqual(2);
  });
  it("roads are a subtle shade lighter than land (not darker like water, not competing with borders)", () => {
    expect(relativeLuminance(BASEMAP_ROAD)).toBeGreaterThan(relativeLuminance(BASEMAP_LAND));
    expect(contrastRatio(BASEMAP_ROAD, BASEMAP_LAND)).toBeGreaterThanOrEqual(1.1);
    expect(contrastRatio(BASEMAP_ROAD, BASEMAP_LAND)).toBeLessThan(contrastRatio(BASEMAP_BOUNDARY_STATE, BASEMAP_LAND));
  });
  it("aircraft colours (altitude ramp, unknown, ground, emergency, selected) stay ≥ 3:1 on land and water", () => {
    const spec = "paint_symbol.icon-color";
    const colours = [
      ...ALT_RAMP.map(([, c]) => c), ALT_UNKNOWN_COLOR, GND_COLOR,
      colorHex(evalExpr(AIRCRAFT_COLOR_EXPR, spec, { emergency: true })),
      colorHex(evalExpr(AIRCRAFT_COLOR_EXPR, spec, { selected: true })),
      colorHex(evalExpr(AIRCRAFT_COLOR_EXPR, spec, {})),
    ];
    for (const c of colours) for (const [name, ground] of SYMBOL_GROUNDS) expect(contrastRatio(c, ground), `${c} on ${name}`).toBeGreaterThanOrEqual(3);
  });
  it("every SIGMET hazard line colour stays ≥ 3:1 on land and water", () => {
    for (const c of [...Object.values(HAZARD_COLORS), HAZARD_DEFAULT_COLOR]) {
      for (const [name, ground] of SYMBOL_GROUNDS) expect(contrastRatio(c, ground), `${c} on ${name}`).toBeGreaterThanOrEqual(3);
    }
  });
  it("every ship category colour (icons, grid circles, legend — 'unknown' included) stays ≥ 3:1 on land and water", () => {
    for (const cat of SHIP_CATEGORIES) {
      const c = SHIP_CATEGORY_COLOR[cat];
      for (const [name, ground] of SYMBOL_GROUNDS) expect(contrastRatio(c, ground), `${cat} ${c} on ${name}`).toBeGreaterThanOrEqual(3);
    }
    expect(SHIP_CATEGORY_COLOR.unknown).toBe(ALT_UNKNOWN_COLOR); // 항공기 "고도 모름"과 같은 회색
  });
  it("building and airport-area fills are a shade of land: never darker than land, still far from the water", () => {
    expect(relativeLuminance(BASEMAP_LAND_DETAIL)).toBeGreaterThanOrEqual(relativeLuminance(BASEMAP_LAND));
    expect(contrastRatio(BASEMAP_LAND_DETAIL, BASEMAP_LAND)).toBeLessThan(1.1); // 은은하게
    expect(contrastRatio(BASEMAP_LAND_DETAIL, BASEMAP_WATER)).toBeGreaterThanOrEqual(1.5);
  });
  it("the RainViewer 'outside coverage' veil stays as distinct as it was on the old basemap (≥ 1.4:1 on land and water)", () => {
    const veil = (min: number) => hex(min * 255, min * 255, min * 255); // 검정(커버리지 밖) → brightness-min 회색
    // 이전 값(brightness-min 0.32, 옛 육지 rgb 12,12,12)의 구분 정도
    const before = contrastRatio(over("#0c0c0c", veil(0.32), 0.5), "#0c0c0c");
    expect(before).toBeGreaterThan(1.4);
    for (const [name, ground] of GROUNDS) {
      const c = contrastRatio(over(ground, veil(COVERAGE_PAINT["raster-brightness-min"]), COVERAGE_PAINT["raster-opacity"]), ground);
      expect(c, name).toBeGreaterThanOrEqual(1.4);
    }
  });
});

/** SYNTHETIC: OpenMapTiles 스키마 모양의 어두운 스타일 층(값·id 는 지어낸 것) + 우리 geojson 레이어 */
const SYNTHETIC_LAYERS = [
  { id: "background", type: "background", paint: { "background-color": "rgb(12,12,12)" } },
  { id: "water", type: "fill", source: "openmaptiles", "source-layer": "water", filter: ["!=", ["get", "brunnel"], "tunnel"], paint: { "fill-color": "rgb(27,27,29)", "fill-antialias": false } },
  { id: "water_intermittent", type: "fill", source: "openmaptiles", "source-layer": "water", minzoom: 8, filter: ["==", ["get", "intermittent"], 1], paint: { "fill-color": "rgb(27,27,29)", "fill-opacity": 0.7 } },
  { id: "landcover_ice", type: "fill", source: "openmaptiles", "source-layer": "landcover", paint: { "fill-color": "#111", "fill-opacity": 0.5 } },
  { id: "landuse_residential", type: "fill", source: "openmaptiles", "source-layer": "landuse", paint: { "fill-color": "#0e0e0e" } },
  { id: "park", type: "fill", source: "openmaptiles", "source-layer": "park", paint: { "fill-color": "#101010" } },
  { id: "waterway", type: "line", source: "openmaptiles", "source-layer": "waterway", paint: { "line-color": "rgb(27,27,29)" } },
  { id: "building", type: "fill", source: "openmaptiles", "source-layer": "building", paint: { "fill-color": "#0a0a0a", "fill-outline-color": "#050505" } },
  { id: "aeroway_area", type: "fill", source: "openmaptiles", "source-layer": "aeroway", paint: { "fill-color": "rgb(8,8,8)", "fill-opacity": 0.9 } },
  { id: "highway_major", type: "line", source: "openmaptiles", "source-layer": "transportation", paint: { "line-color": "#222" } },
  { id: "boundary_state", type: "line", source: "openmaptiles", "source-layer": "boundary", paint: { "line-color": "#333", "line-opacity": 0.5 } },
  { id: "boundary_country", type: "line", source: "openmaptiles", "source-layer": "boundary", paint: { "line-color": "#444" } },
  { id: "water_name", type: "symbol", source: "openmaptiles", "source-layer": "water_name", layout: { "text-field": "{name}" }, paint: { "text-color": "#555" } },
  { id: "place_city", type: "symbol", source: "openmaptiles", "source-layer": "place", layout: { "text-field": "{name}" }, paint: { "text-color": "rgb(101,101,101)" } },
  { id: "road_label", type: "symbol", source: "openmaptiles", "source-layer": "transportation_name", layout: { "text-field": "{name}" }, paint: { "text-color": "#666" } },
  { id: "sigmet-fill", type: "fill", source: "sigmets", paint: { "fill-color": "#f59e0b" } },
  { id: "airport-label", type: "symbol", source: "airports", layout: { "text-field": "{icao}" }, paint: { "text-color": "#a3aab4" } },
] as const;

describe("basemap overrides on the style (by layer type + OpenMapTiles source-layer)", () => {
  const overrides = basemapOverrides(SYNTHETIC_LAYERS as unknown as StyleLayerLike[]);
  const touched = new Set(overrides.map((o) => o.id));
  it("touches only the known basemap layers; road labels and our own layers are left alone", () => {
    expect([...touched].sort()).toEqual([
      "aeroway_area", "background", "boundary_country", "boundary_state", "building", "highway_major", "landcover_ice", "landuse_residential", "park", "place_city",
      "water", "water_intermittent", "water_name", "waterway",
    ]);
    for (const id of ["road_label", "sigmet-fill", "airport-label"]) expect(touched.has(id), id).toBe(false);
  });
  it("no opaque non-water basemap fill is left darker than land (the old near-black building/aeroway fills looked like water)", () => {
    const fills = SYNTHETIC_LAYERS.filter((l) => l.type === "fill" && "source-layer" in l && l["source-layer"] !== "water");
    expect(fills.map((l) => l.id)).toContain("building");
    expect(fills.map((l) => l.id)).toContain("aeroway_area");
    for (const l of fills) {
      const c = overrides.find((o) => o.id === l.id && o.prop === "fill-color")?.value;
      expect(typeof c, `${l.id} repainted`).toBe("string");
      expect(relativeLuminance(c as string), l.id).toBeGreaterThanOrEqual(relativeLuminance(BASEMAP_LAND));
      const outline = overrides.find((o) => o.id === l.id && o.prop === "fill-outline-color")?.value;
      if (outline !== undefined) expect(relativeLuminance(outline as string), `${l.id} outline`).toBeGreaterThanOrEqual(relativeLuminance(BASEMAP_LAND));
    }
  });
  it("missing layers are skipped (an empty or partial style gives only what exists)", () => {
    expect(basemapOverrides([])).toEqual([]);
    expect(basemapOverrides([{ id: "only-water", type: "fill", "source-layer": "water" }]).every((o) => o.id === "only-water")).toBe(true);
    expect(basemapOverrides([null as never, { id: "x", type: "raster" }])).toEqual([]);
  });
  it("sets the colours the contrast tests check; the water fill's own outline is the water colour (the coastline is a separate line — below)", () => {
    const v = (id: string, prop: string) => overrides.find((o) => o.id === id && o.prop === prop)?.value;
    expect(v("background", "background-color")).toBe(BASEMAP_LAND);
    expect(v("water", "fill-color")).toBe(BASEMAP_WATER);
    // 채움 외곽선은 다각형의 모든 변을 긋는다 — 물 다각형 안쪽 이음새(동해 38.6°N 의 직선, 사용자 스크린샷 2026-09-30)도. 그래서 물 색으로
    expect(v("water", "fill-outline-color")).toBe(BASEMAP_WATER);
    expect(v("water", "fill-antialias")).toBe(true);
    for (const id of ["landcover_ice", "landuse_residential", "park"]) expect(v(id, "fill-color")).toBe(BASEMAP_LAND);
    for (const id of ["building", "aeroway_area"]) expect(v(id, "fill-color")).toBe(BASEMAP_LAND_DETAIL);
    expect(v("waterway", "line-color")).toBe(BASEMAP_WATER);
    expect(v("highway_major", "line-color")).toBe(BASEMAP_ROAD);
    expect(v("place_city", "text-color")).toBe(BASEMAP_LABEL);
    expect(v("water_name", "text-color")).toBe(BASEMAP_WATER_LABEL);
    for (const id of ["place_city", "water_name"]) {
      expect(v(id, "text-halo-color")).toBe(BASEMAP_HALO);
      expect(v(id, "text-halo-width")).toBeGreaterThanOrEqual(1);
    }
    expect(v("boundary_state", "line-opacity")).toBe(1);
  });
  it("coastline: one line per water fill, right below it, on the same features (source · source-layer · filter · zooms), pushed 1 px outward onto land", () => {
    const c = coastLayers(SYNTHETIC_LAYERS as unknown as StyleLayerLike[]);
    expect(c.map((x) => x.beforeId)).toEqual(["water", "water_intermittent"]);
    expect(c[0].layer).toEqual({
      id: "wakeline-coast-water", type: "line", source: "openmaptiles", "source-layer": "water", filter: ["!=", ["get", "brunnel"], "tunnel"],
      paint: { "line-color": BASEMAP_COAST, "line-width": 1, "line-offset": COAST_LINE_OFFSET_PX },
    });
    expect(c[1].layer).toMatchObject({ id: "wakeline-coast-water_intermittent", minzoom: 8, filter: ["==", ["get", "intermittent"], 1] });
    // 음수 = 선의 왼쪽 = 다각형 밖: 벡터 타일의 바깥 고리는 화면에서 시계 방향(안쪽이 오른쪽), 구멍(섬)은 반대 — 둘 다 육지 쪽으로 간다.
    // 물 채움(위 층)이 물 쪽을 덮으므로 두 물 다각형이 맞닿는 이음새의 선은 가려지고 해안의 선만 남는다(scratch 하네스: MapLibre 6.11.2 · 합성 이음새 38°N).
    expect(COAST_LINE_OFFSET_PX).toBe(-1);
    // 물이 아닌 층 · 우리 geojson 층 · source 가 없는 층에는 만들지 않는다
    expect(coastLayers([{ id: "only-water", type: "fill", "source-layer": "water" }])).toEqual([]);
    expect(coastLayers([{ id: "sigmet-fill", type: "fill", source: "sigmets" } as StyleLayerLike, null as never])).toEqual([]);
  });
  it("the coastline still reaches 3:1 against the water it borders", () => {
    expect(contrastRatio(BASEMAP_COAST, BASEMAP_WATER)).toBeGreaterThanOrEqual(3);
  });
  it("border colour: admin_level ≤ 2 is a country border, anything else (or unknown) the fainter state colour", () => {
    const spec = "paint_line.line-color";
    expect(colorHex(evalExpr(BOUNDARY_COLOR_EXPR, spec, { admin_level: 2 }))).toBe(BASEMAP_BOUNDARY_COUNTRY);
    expect(colorHex(evalExpr(BOUNDARY_COLOR_EXPR, spec, { admin_level: 4 }))).toBe(BASEMAP_BOUNDARY_STATE);
    expect(colorHex(evalExpr(BOUNDARY_COLOR_EXPR, spec, {}))).toBe(BASEMAP_BOUNDARY_STATE);
  });
  it("the overridden style still validates against the MapLibre style spec", () => {
    const layers = SYNTHETIC_LAYERS.map((l) => ({ ...l, paint: { ...l.paint } })) as { id: string; paint: Record<string, unknown> }[];
    for (const o of overrides) layers.find((l) => l.id === o.id)!.paint[o.prop] = o.value;
    for (const c of coastLayers(SYNTHETIC_LAYERS as unknown as StyleLayerLike[])) layers.splice(layers.findIndex((l) => l.id === c.beforeId), 0, c.layer as never);
    const style = {
      version: 8, glyphs: "https://example.invalid/{fontstack}/{range}.pbf",
      sources: {
        openmaptiles: { type: "vector", url: "https://example.invalid/tiles.json" },
        sigmets: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        airports: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      },
      layers,
    };
    expect(validateStyleMin(style as never).map((e) => e.message)).toEqual([]);
  });
  it("applyBasemap sets each override once, adds each coastline once below its water fill, survives a rejected property or layer and an unreadable style", () => {
    const calls: [string, string, unknown][] = [];
    const added: [string, string | undefined][] = [];
    const moved: [string, string | undefined][] = [];
    const have = new Set<string>();
    let rejectOnce = true;
    const target = {
      getStyle: () => ({ layers: SYNTHETIC_LAYERS }) as never,
      setPaintProperty: ((id: string, prop: string, value: unknown) => {
        if (id === "park") throw new Error("rejected");
        calls.push([id, prop, value]);
      }) as never,
      getLayer: (id: string) => (have.has(id) ? { id } : undefined),
      addLayer: ((l: { id: string }, before?: string) => {
        if (l.id === "wakeline-coast-water_intermittent" && rejectOnce) { rejectOnce = false; throw new Error("rejected"); }
        have.add(l.id); added.push([l.id, before]);
      }) as never,
      moveLayer: ((id: string, before?: string) => {
        if (id === "building") throw new Error("rejected");
        moved.push([id, before]);
      }) as never,
    };
    const n = applyBasemap(target);
    // 칠하기(park 거절) + 해안선 1(두 번째 거절) + 육지 채움 옮기기 4 중 building 거절(공항 구역은 옮기지 않는다)
    expect(n).toBe(overrides.length - 1 + 1 + 3);
    expect(moved).toEqual(["landcover_ice", "landuse_residential", "park"].map((id) => [id, "wakeline-coast-water"]));
    expect(calls.map((c) => `${c[0]}.${c[1]}`)).toEqual(overrides.filter((o) => o.id !== "park").map((o) => `${o.id}.${o.prop}`));
    expect(added).toEqual([["wakeline-coast-water", "water"]]); // 거절된 층은 건너뛴다
    // 다시 불러도(같은 스타일) 이미 있는 선은 더하지 않는다
    applyBasemap(target);
    expect(added).toEqual([["wakeline-coast-water", "water"], ["wakeline-coast-water_intermittent", "water_intermittent"]]);
    applyBasemap(target);
    expect(added).toHaveLength(2);
    expect(applyBasemap({ ...target, getStyle: () => { throw new Error("no style"); } })).toBe(0);
    // 해안선을 더하지 못했으면 육지 채움을 옮기지 않는다(스타일 순서 그대로)
    moved.length = 0;
    applyBasemap({ ...target, getLayer: () => undefined, addLayer: (() => { throw new Error("rejected"); }) as never });
    expect(moved).toEqual([]);
  });
  /**
   * 층 순서(통합 리뷰 2026-09-30): OpenFreeMap dark 는 물 채움보다 뒤에 육지 채움(주거지 · 숲 · 공원 · 건물 · 활주로 구역)을 그린다 — 해안선을 물 채움 바로 아래에만
   * 두면 해안에 닿는 그 채움이 육지 쪽 1 px 의 해안선을 덮을 수 있었다(이 시험이 실패했다). 이제 지표 피복 · 토지 이용 · 공원 · 건물 채움은 해안선 아래,
   * 물 위의 선 · 글자는 그대로 위. 공항 구역 채움은 제자리(그 아래의 유도로 선이 드러나지 않게 — 실제 타일 인천 z12).
   */
  it("after applyBasemap no landcover · landuse · park · building fill is drawn above a coastline; lines and labels stay above the water in their order", () => {
    const order: string[] = SYNTHETIC_LAYERS.map((l) => l.id);
    const at = (id: string) => order.indexOf(id);
    const place = (id: string, before?: string) => { const i = order.indexOf(id); if (i >= 0) order.splice(i, 1); order.splice(before ? order.indexOf(before) : order.length, 0, id); };
    const target = {
      getStyle: () => ({ layers: SYNTHETIC_LAYERS }) as never,
      setPaintProperty: (() => undefined) as never,
      getLayer: (id: string) => (order.includes(id) ? { id } : undefined),
      addLayer: ((l: { id: string }, before?: string) => place(l.id, before)) as never,
      moveLayer: ((id: string, before?: string) => place(id, before)) as never,
    };
    applyBasemap(target);
    const coasts = order.filter((id) => id.startsWith("wakeline-coast-"));
    expect(coasts).toEqual(["wakeline-coast-water", "wakeline-coast-water_intermittent"]);
    for (const c of coasts) expect(order[at(c) + 1], c).toBe(c.replace("wakeline-coast-", "")); // 해안선은 제 물 채움 바로 아래
    const landFills = ["landcover_ice", "landuse_residential", "park", "building"];
    for (const f of landFills) expect(at(f), `${f} below the first coastline`).toBeLessThan(at("wakeline-coast-water"));
    expect(landFills.map(at)).toEqual([...landFills.map(at)].sort((a, b) => a - b)); // 서로의 순서는 그대로
    for (const id of ["waterway", "highway_major", "boundary_state", "boundary_country", "water_name", "place_city", "road_label", "sigmet-fill", "airport-label"])
      expect(at(id), `${id} above the water`).toBeGreaterThan(at("water_intermittent"));
    const rest = order.filter((id) => !coasts.includes(id) && !landFills.includes(id));
    expect(rest).toEqual(SYNTHETIC_LAYERS.map((l) => l.id).filter((id) => !landFills.includes(id))); // 나머지 층의 순서는 스타일 그대로
    // 다시 불러도 같은 자리
    const once = [...order];
    applyBasemap(target);
    expect(order).toEqual(once);
    expect(landFillsAboveWater(order.map((id) => SYNTHETIC_LAYERS.find((l) => l.id === id) ?? { id, type: "line" }) as StyleLayerLike[])).toEqual([]);
  });
  it("both maps (dashboard and replay) apply it on every style.load", () => {
    for (const f of ["../components/MapView.tsx", "../components/ReplayMap.tsx"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      // 대시보드는 배경지도를 못 받아 대체 스타일로 그릴 때(R-01)만 건너뛴다 — 칠할 지형 층이 없다
      expect(src, f).toMatch(/on\("style\.load", \(\) => (applyBasemap\(map\)\)|\{[^}]*if \(!noBasemap\) applyBasemap\(map\);)/);
    }
  });
});
