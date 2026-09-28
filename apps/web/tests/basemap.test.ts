/**
 * 배경지도 시인성(계약 v4 §E) — 고른 색의 WCAG 대비를 계산해 확인하고, 합성(SYNTHETIC) 스타일에 덮어쓸 paint 값이 스타일 명세에 맞는지 본다.
 * 스타일 층 목록은 OpenMapTiles 스키마 모양의 합성 값이다(외부 스타일을 받지 않는다).
 */
import { readFileSync } from "node:fs";
import { createPropertyExpression, latest, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import {
  applyBasemap, BASEMAP_BOUNDARY_COUNTRY, BASEMAP_BOUNDARY_STATE, BASEMAP_COAST, BASEMAP_HALO, BASEMAP_LABEL, BASEMAP_LAND, BASEMAP_LAND_DETAIL, BASEMAP_ROAD, BASEMAP_WATER,
  BASEMAP_WATER_LABEL, basemapOverrides, BOUNDARY_COLOR_EXPR, contrastRatio, relativeLuminance, type StyleLayerLike,
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
  { id: "water", type: "fill", source: "openmaptiles", "source-layer": "water", paint: { "fill-color": "rgb(27,27,29)", "fill-antialias": false } },
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
      "water", "water_name", "waterway",
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
  it("sets the colours the contrast tests check, plus a visible water outline (coastline)", () => {
    const v = (id: string, prop: string) => overrides.find((o) => o.id === id && o.prop === prop)?.value;
    expect(v("background", "background-color")).toBe(BASEMAP_LAND);
    expect(v("water", "fill-color")).toBe(BASEMAP_WATER);
    expect(v("water", "fill-outline-color")).toBe(BASEMAP_COAST);
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
  it("border colour: admin_level ≤ 2 is a country border, anything else (or unknown) the fainter state colour", () => {
    const spec = "paint_line.line-color";
    expect(colorHex(evalExpr(BOUNDARY_COLOR_EXPR, spec, { admin_level: 2 }))).toBe(BASEMAP_BOUNDARY_COUNTRY);
    expect(colorHex(evalExpr(BOUNDARY_COLOR_EXPR, spec, { admin_level: 4 }))).toBe(BASEMAP_BOUNDARY_STATE);
    expect(colorHex(evalExpr(BOUNDARY_COLOR_EXPR, spec, {}))).toBe(BASEMAP_BOUNDARY_STATE);
  });
  it("the overridden style still validates against the MapLibre style spec", () => {
    const layers = SYNTHETIC_LAYERS.map((l) => ({ ...l, paint: { ...l.paint } })) as { id: string; paint: Record<string, unknown> }[];
    for (const o of overrides) layers.find((l) => l.id === o.id)!.paint[o.prop] = o.value;
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
  it("applyBasemap sets each override once, survives a rejected property and an unreadable style", () => {
    const calls: [string, string, unknown][] = [];
    const n = applyBasemap({
      getStyle: () => ({ layers: SYNTHETIC_LAYERS }) as never,
      setPaintProperty: ((id: string, prop: string, value: unknown) => {
        if (id === "park") throw new Error("rejected");
        calls.push([id, prop, value]);
      }) as never,
    });
    expect(n).toBe(overrides.length - 1);
    expect(calls.map((c) => `${c[0]}.${c[1]}`)).toEqual(overrides.filter((o) => o.id !== "park").map((o) => `${o.id}.${o.prop}`));
    expect(applyBasemap({ getStyle: () => { throw new Error("no style"); }, setPaintProperty: (() => {}) as never })).toBe(0);
  });
  it("both maps (dashboard and replay) apply it on every style.load", () => {
    for (const f of ["../components/MapView.tsx", "../components/ReplayMap.tsx"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src, f).toMatch(/on\("style\.load", \(\) => applyBasemap\(map\)\)/);
    }
  });
});
