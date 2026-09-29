/**
 * 선박(AIS, 계약 v2 §B3/§B4)·수요 기반 추적 표시(§A3) — 순수 로직·지도 식·카드 렌더.
 * 선종 분류는 api(ShipCategory)와 같은 표(tests/fixtures/ship-category-uscg.json)로 0–255 전부를 검사한다.
 */
import { existsSync, readFileSync } from "node:fs";
import { createPropertyExpression, latest, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aisBadge, aisCoverageFeatures, aisGapBadge, appendShipTrack, fmtCount, fmtCourse, fmtDraught, fmtShipEta, fmtShipSize, fmtShipType, gapSummary,
  gridFeatures, imoField, mergeStatusGaps, navStatusLabel, normalizeGaps, parseAisCoverage, parseAisStatus, parseCategory, parseGridCells, parseShipLite,
  parseShipState, parseShipStatic, positionBadge, positionSourceLabel, SHIP_CATEGORIES, SHIP_CATEGORY_COLOR, shipCategory, shipFeatures, shipList,
  shipRotation, shipTrackFeatures, shipTrackFromRest, type AisBox, type AisGap, type AisStatus, type ShipLite, type ShipTrack,
} from "@/lib/ships";
import {
  addShipLayers, SHIP_COLOR_EXPR, SHIP_GRID_RADIUS_EXPR, SHIP_ICON_EXPR, SHIP_IMAGES, SHIP_LAYERS, SHIP_OPACITY_EXPR, SHIP_ROTATE_EXPR,
} from "@/lib/ship-layers";
import { elapsedLabel, focusChip, hotChip, mapDemandChip, parseDemand, type DemandInfo } from "@/lib/demand";
import { loadLayers, saveLayers, type KV } from "@/lib/prefs";
import { attributionText, mapAttributionHtml } from "@/lib/attribution";
import { shipGridTip, shipTip } from "@/lib/tooltip";
import { appendTrackPoint, trackFeatureCollection, type TrackPt } from "@/lib/track";
import { resetData, setData, shipStates } from "@/lib/store";
import { ShipCard, ShipPanelView } from "@/components/ShipCard";
import { MapChipsView } from "@/components/MapChips";
import { MapLegendView } from "@/components/MapLegend";
import { useUi } from "@/lib/ui-store";
import { AircraftCard } from "@/components/AircraftCard";

const NOW = Date.parse("2026-09-28T03:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

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

// ---------------------------------------------------------------- 선종 분류

describe("ship category — the USCG table shared with the api (contract v2 §B3)", () => {
  const table = JSON.parse(readFileSync(new URL("./fixtures/ship-category-uscg.json", import.meta.url), "utf8")) as {
    default: string; null_category: string; categories: Record<string, number[]>;
  };
  const expected = (code: number) => Object.entries(table.categories).find(([, codes]) => codes.includes(code))?.[0] ?? table.default;

  it("every code 0–255 maps exactly as the table says; null/missing → unknown", () => {
    for (let code = 0; code <= 255; code++) expect(shipCategory(code), `code ${code}`).toBe(expected(code));
    expect(shipCategory(null)).toBe(table.null_category);
    expect(shipCategory(undefined)).toBe(table.null_category);
  });
  it("malformed codes (non-integer, negative, string) are unknown, never guessed", () => {
    for (const bad of [-1, 70.5, "70", NaN, Infinity, true]) expect(shipCategory(bad)).toBe("unknown");
  });
  it("the table and the code agree on the set of category names (one colour per category)", () => {
    for (const c of Object.keys(table.categories)) expect(SHIP_CATEGORIES).toContain(c);
    expect(SHIP_CATEGORIES).toContain(table.default);
    for (const c of SHIP_CATEGORIES) expect(SHIP_CATEGORY_COLOR[c]).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(Object.values(SHIP_CATEGORY_COLOR)).size).toBe(SHIP_CATEGORIES.length);
  });
  it("a repository-level copy of the table (if the api lane adds one) must be identical", () => {
    const shared = new URL("../../../fixtures/ship_category_uscg.json", import.meta.url);
    if (!existsSync(shared)) return;
    const other = JSON.parse(readFileSync(shared, "utf8"));
    expect(other.categories).toEqual(table.categories);
    expect(other.default).toBe(table.default);
  });
  it("server-sent dominant_category: known names pass, codes map through the table, anything else is unknown", () => {
    expect(parseCategory("Cargo")).toBe("cargo");
    expect(parseCategory(84)).toBe("tanker");
    expect(parseCategory("warship")).toBe("unknown");
    expect(parseCategory(null)).toBe("unknown");
  });
});

// ---------------------------------------------------------------- 수신 검증·표시

describe("ship message validation (untrusted input → null, never defaults)", () => {
  it("ShipLite: 9-digit MMSI string and a valid position are required; bad fields become null", () => {
    expect(parseShipLite({ mmsi: "43101130", lat: 1, lon: 1 })).toBeNull(); // 8 자리
    expect(parseShipLite({ mmsi: 431011305, lat: 1, lon: 1 })).toBeNull(); // 숫자(앞자리 0 손실 가능) — 계약은 문자열
    expect(parseShipLite({ mmsi: "431011305", lat: 91, lon: 1 })).toBeNull();
    expect(parseShipLite({ mmsi: "431011305", lat: 1, lon: 181 })).toBeNull();
    const s = parseShipLite({
      mmsi: "431011305", lat: 35.39, lon: 139.83, sog_kn: 102.3, cog_deg: 360, heading_deg: 197, ship_type: 70,
      name: "KIMITSU MARU        ", seen_at: "2026-09-28T02:59:00Z", position_source: "bogus", nav_status: 16,
    })!;
    expect(s).toMatchObject({ sog_kn: null, cog_deg: null, heading_deg: 197, ship_type: 70, name: "KIMITSU MARU", position_source: null, nav_status: null });
  });
  it("strings are trimmed of AIS '@' padding and capped; empty → null", () => {
    expect(parseShipLite({ mmsi: "431011305", lat: 1, lon: 1, name: "@@@@@@" })!.name).toBeNull();
    expect(parseShipLite({ mmsi: "431011305", lat: 1, lon: 1, name: "X".repeat(500) })!.name).toHaveLength(32);
    expect(parseShipStatic({ mmsi: "431011305", destination: "BUSAN@@@@", call_sign: "  " })).toMatchObject({ destination: "BUSAN", call_sign: null });
  });
  it("ShipState keeps class/provider; ShipStatic validates ETA ranges and dimensions", () => {
    expect(parseShipState({ mmsi: "440123456", lat: 35, lon: 129, class: "B", provider: "fixture", rot: -128.5 })).toMatchObject({ class: "B", provider: "fixture", rot: -128.5 });
    const st = parseShipStatic({ mmsi: "440123456", eta_month: 0, eta_day: 12, eta_hour: 24, eta_minute: 60, imo: 0, dim_a: 100, draught_m: 30 })!;
    expect(st).toMatchObject({ eta_month: null, eta_day: 12, eta_hour: null, eta_minute: null, imo: null, dim_a: 100, draught_m: null });
  });
  it("grid cells: malformed and empty cells are dropped", () => {
    const cells = parseGridCells([[35, 129.5, 12, "cargo"], [95, 0, 1, "x"], [10, 10, 0, "cargo"], "junk", [20, 120, 3, 84], [20, 121, 2.5, "cargo"]]);
    // 네 원소 칸(선종별 수 없음 — 계약 v5 §B2 이전 서버)은 counts null
    expect(cells).toEqual([{ lat: 35, lon: 129.5, count: 12, category: "cargo", counts: null }, { lat: 20, lon: 120, count: 3, category: "tanker", counts: null }]);
    expect(gridFeatures(cells).features[0].properties).toMatchObject({ count: 12, label: "12", cat: "cargo" });
    expect([fmtCount(999), fmtCount(1234), fmtCount(45_600)]).toEqual(["999", "1.2k", "46k"]);
  });
});

describe("ship card formatting (contract v2 §B4)", () => {
  it("ETA needs all four fields, is shown in KST (crew input, no year — contract v5 §G20: no UTC on screen); otherwise —", () => {
    expect(fmtShipEta({ eta_month: 9, eta_day: 30, eta_hour: 6, eta_minute: 5 })).toBe("09-30 15:05 KST · 선원 입력 · 연도 없음");
    expect(fmtShipEta({ eta_month: 9, eta_day: 30, eta_hour: null, eta_minute: 5 })).toBe("—");
    expect(fmtShipEta(null)).toBe("—");
  });
  it("size is A+B × C+D (reported); a zero sum is the ITU default = unknown", () => {
    expect(fmtShipSize({ dim_a: 150, dim_b: 40, dim_c: 12, dim_d: 20 })).toBe("190 × 32 m · 보고값");
    expect(fmtShipSize({ dim_a: 0, dim_b: 0, dim_c: 0, dim_d: 0 })).toBe("—");
    expect(fmtShipSize({ dim_a: 0, dim_b: 90, dim_c: null, dim_d: 8 })).toBe("90 × — m · 보고값"); // 기준점 모름(A=0)이어도 길이는 합
  });
  it("draught 0 = not available; 25.5 = 25.5 m or more (USCG NAVCEN)", () => {
    expect(fmtDraught(0)).toBe("—");
    expect(fmtDraught(null)).toBe("—");
    expect(fmtDraught(8.4)).toBe("8.4 m · 보고값");
    expect(fmtDraught(25.5)).toBe("25.5 m 이상 · 보고값");
  });
  it("navigation status 15 is 'undefined' (not entered), out-of-range is —", () => {
    expect(navStatusLabel(0)).toBe("기관 사용 항해 중 (0)");
    expect(navStatusLabel(5)).toBe("계류 (5)");
    expect(navStatusLabel(15)).toContain("미정의");
    expect(navStatusLabel(16)).toBe("—");
    expect(navStatusLabel(null)).toBe("—");
  });
  it("type = code + class; motion shows — per missing value; position source badges", () => {
    expect(fmtShipType(84)).toBe("84 · 유조선·탱커");
    expect(fmtShipType(null)).toBe("— (미보고)");
    expect(fmtCourse({ cog_deg: null, heading_deg: 33 })).toBe("— / 33°"); // 속력은 두 단위로 따로(계약 v5 §A — tests/units-v5)
    expect(positionBadge("estimated")).toEqual({ text: "추정 위치", tone: "est" });
    expect(positionBadge("manual")).toEqual({ text: "수동 위치", tone: "est" });
    expect(positionBadge("epfs")).toBeNull();
    expect(positionBadge(null)).toBeNull();
  });
  it("position source (contract v3 §B): epfs is an electronic fixing device report; null and legacy 'gnss' are unknown (—)", () => {
    expect(positionSourceLabel("epfs")).toBe("전자 위치 장치(EPFS) · 선박 보고");
    expect(positionSourceLabel(null)).toBe("—");
    // 옛 값 gnss(0–60·누락이 섞임)는 받자마자 모름으로
    expect(parseShipLite({ mmsi: "431011305", lat: 1, lon: 1, position_source: "gnss" })!.position_source).toBeNull();
    expect(positionSourceLabel(parseShipLite({ mmsi: "431011305", lat: 1, lon: 1, position_source: "gnss" })!.position_source)).toBe("—");
    expect(parseShipLite({ mmsi: "431011305", lat: 1, lon: 1, position_source: "epfs" })!.position_source).toBe("epfs");
    expect(parseShipLite({ mmsi: "431011305", lat: 1, lon: 1, position_source: null })!.position_source).toBeNull();
    for (const k of ["estimated", "manual", "inoperative"] as const) expect(positionSourceLabel(k)).not.toBe("—");
  });
  it("IMO field: 1,000,000–9,999,999 is an IMO number, 10,000,000 and above is a flag-state official number (USCG NAVCEN)", () => {
    expect(imoField(9_123_456)).toEqual({ label: "IMO", value: "9123456" });
    expect(imoField(1_000_000)).toEqual({ label: "IMO", value: "1000000" });
    expect(imoField(9_999_999).label).toBe("IMO");
    expect(imoField(10_000_000)).toEqual({ label: "기국 공식 번호", value: "10000000" });
    expect(imoField(12_345_678).label).toBe("기국 공식 번호");
    expect(imoField(null)).toEqual({ label: "IMO", value: "—" });
    // 스키마 범위(1,000,000–1,073,741,823) 밖은 모름
    expect(parseShipStatic({ mmsi: "440123456", imo: 999_999 })!.imo).toBeNull();
    expect(parseShipStatic({ mmsi: "440123456", imo: 1_073_741_823 })!.imo).toBe(1_073_741_823);
    expect(parseShipStatic({ mmsi: "440123456", imo: 1_073_741_824 })!.imo).toBeNull();
  });
});

// ---------------------------------------------------------------- 지도 표현

const lite = (over: Partial<ShipLite> = {}): ShipLite => ({
  mmsi: "538004068", lat: 25.1, lon: 120.7, sog_kn: 11, cog_deg: 36, heading_deg: 33, ship_type: 70, name: "TONY SMITH",
  seen_at: iso(NOW - 30_000), position_source: "epfs", nav_status: 0, ...over,
});

describe("ship symbol: heading → cog → none (never drawn as north when unknown)", () => {
  it("rotation source and angle", () => {
    expect(shipRotation({ heading_deg: 33, cog_deg: 36 })).toEqual({ mode: "heading", deg: 33 });
    expect(shipRotation({ heading_deg: null, cog_deg: 36 })).toEqual({ mode: "cog", deg: 36 });
    expect(shipRotation({ heading_deg: null, cog_deg: null })).toEqual({ mode: "none", deg: 0 });
  });
  it("feature properties: category, stale after 15 min, unknown age, selected", () => {
    const fc = shipFeatures([
      lite(), lite({ mmsi: "111111111", seen_at: iso(NOW - 16 * 60_000), heading_deg: null, ship_type: null }),
      lite({ mmsi: "222222222", seen_at: null, heading_deg: null, cog_deg: null }),
    ], "538004068", NOW);
    const p = fc.features.map((f) => f.properties!);
    expect(p[0]).toMatchObject({ cat: "cargo", rot_mode: "heading", rot: 33, stale: false, age_unknown: false, selected: true });
    expect(p[1]).toMatchObject({ cat: "unknown", rot_mode: "cog", rot: 36, stale: true, selected: false });
    expect(p[2]).toMatchObject({ rot_mode: "none", rot: 0, age_unknown: true, stale: false });
  });
  it("the style expressions evaluate as intended (MapLibre spec implementation)", () => {
    expect(String(evalExpr(SHIP_ICON_EXPR, "layout_symbol.icon-image", { rot_mode: "heading" }))).toBe("ship-hull");
    expect(String(evalExpr(SHIP_ICON_EXPR, "layout_symbol.icon-image", { rot_mode: "cog" }))).toBe("ship-hull-cog");
    expect(String(evalExpr(SHIP_ICON_EXPR, "layout_symbol.icon-image", { rot_mode: "none" }))).toBe("ship-nodir");
    expect(evalExpr(SHIP_ROTATE_EXPR, "layout_symbol.icon-rotate", { rot_mode: "none", rot: 250 })).toBe(0);
    expect(evalExpr(SHIP_ROTATE_EXPR, "layout_symbol.icon-rotate", { rot_mode: "cog", rot: 250 })).toBe(250);
    expect(colorHex(evalExpr(SHIP_COLOR_EXPR, "paint_symbol.icon-color", { cat: "tanker" }))).toBe(SHIP_CATEGORY_COLOR.tanker);
    expect(colorHex(evalExpr(SHIP_COLOR_EXPR, "paint_symbol.icon-color", { cat: "whatever" }))).toBe(SHIP_CATEGORY_COLOR.unknown);
    expect(colorHex(evalExpr(SHIP_COLOR_EXPR, "paint_symbol.icon-color", { cat: "cargo", selected: true }))).toBe("#ffffff");
    expect(evalExpr(SHIP_OPACITY_EXPR, "paint_symbol.icon-opacity", { stale: true })).toBe(0.35);
    expect(evalExpr(SHIP_OPACITY_EXPR, "paint_symbol.icon-opacity", { age_unknown: true })).toBe(0.7);
    const r1 = evalExpr(SHIP_GRID_RADIUS_EXPR, "paint_circle.circle-radius", { count: 1 }) as number;
    const r100 = evalExpr(SHIP_GRID_RADIUS_EXPR, "paint_circle.circle-radius", { count: 100 }) as number;
    const r10k = evalExpr(SHIP_GRID_RADIUS_EXPR, "paint_circle.circle-radius", { count: 10_000 }) as number;
    expect(r1).toBeLessThan(r100);
    expect(r100).toBeLessThan(r10k);
  });
  it("every ship source/layer validates against the style spec and starts hidden, below the aircraft", () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, Path2D: g.Path2D };
    const noop = () => {};
    const ctx = { fillStyle: "", strokeStyle: "", lineWidth: 0, fill: noop, stroke: noop, setLineDash: noop, save: noop, restore: noop, translate: noop, scale: noop,
      getImageData: () => ({ width: 48, height: 48, data: new Uint8ClampedArray(48 * 48 * 4) }) };
    g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
    g.Path2D = class { constructor(public d: string) {} };
    const style = { version: 8 as const, sources: {} as Record<string, unknown>, layers: [] as { id: string; layout?: { visibility?: string } }[] };
    const images: string[] = [];
    const befores: (string | undefined)[] = [];
    try {
      addShipLayers({
        addImage: (id: string) => { images.push(id); },
        addSource: (id: string, src: unknown) => { style.sources[id] = src; },
        addLayer: (layer: { id: string }, before?: string) => { style.layers.push(layer); befores.push(before); },
        getLayer: (id: string) => (id === "aircraft-symbol" ? {} : undefined),
      } as never);
    } finally { g.document = saved.document; g.Path2D = saved.Path2D; }
    expect(images).toEqual([...SHIP_IMAGES]);
    expect(style.layers.map((l) => l.id)).toEqual([...SHIP_LAYERS]);
    expect(style.layers.every((l) => l.layout?.visibility === "none")).toBe(true);
    expect(befores.every((b) => b === "aircraft-symbol")).toBe(true);
    expect(validateStyleMin(style as never).map((e) => e.message)).toEqual([]);
  });
  it("tooltips carry only data values; names are plain text", () => {
    const t = shipTip(lite({ heading_deg: null, position_source: "estimated", seen_at: iso(NOW - 20 * 60_000), name: "<img src=x>" }), NOW);
    expect(t.title).toBe("<img src=x>"); // renderTip 는 textContent 로만 넣는다
    expect(t.flags.map((f) => f.text)).toEqual(expect.arrayContaining(["추정 위치", "침로 기준(선수방위 없음)"]));
    expect(t.flags.some((f) => f.text.startsWith("STALE"))).toBe(true);
    expect(shipGridTip({ count: 1234, cat: "cargo" }, 2).title).toBe("선박 1,234척");
  });
});

// ---------------------------------------------------------------- 항적(REST + 실시간, 공백)

describe("selected ship track: REST MultiLineString + live appends, gaps drawn as dashed connectors", () => {
  const T0 = Date.parse("2026-09-28T00:00:00Z");
  it("GeoJSON MultiLineString with segment times and gaps", () => {
    const t = shipTrackFromRest({
      type: "Feature",
      geometry: { type: "MultiLineString", coordinates: [[[129, 35], [129.01, 35.01], [999, 1]], [[129.1, 35.1], [129.11, 35.11]]] },
      properties: { segments: [{ start: iso(T0), end: iso(T0 + 600_000) }, { from: iso(T0 + 3_600_000), to: iso(T0 + 3_660_000) }] },
      gaps: [{ started_at: iso(T0 + 900_000), ended_at: iso(T0 + 1_200_000), reason: "disconnect" }],
    });
    expect(t.segs.map((s) => s.pts.length)).toEqual([2, 2]); // 범위 밖 좌표는 버림
    expect(t.segs[1].startMs).toBe(T0 + 3_600_000);
    const fc = shipTrackFeatures(t);
    expect(fc.features.map((f) => f.properties!.kind)).toEqual(["track", "gap", "track"]);
    expect(fc.features[1].properties!.label).toBe("AIS 공백 09:10–10:00 KST"); // 00:10Z–01:00Z 를 한국 표준시 먼저, UTC 함께
  });
  it("points with ts are split at > 15 min jumps and at AIS gaps of 60 s or more (contract v3 §D)", () => {
    const pts = [0, 60, 120, 1200, 1260, 1400].map((s, i) => ({ ts: iso(T0 + s * 1000), lon: 129 + i * 0.01, lat: 35 }));
    const t = shipTrackFromRest({
      points: pts,
      gaps: [{ started_at: iso(T0 + 70_000), ended_at: iso(T0 + 100_000) }, { started_at: iso(T0 + 1280_000), ended_at: iso(T0 + 1380_000) }],
    });
    expect(t.segs.map((s) => s.pts.length)).toEqual([3, 2, 1]); // 30 s 공백은 끊지 않는다
    const labels = shipTrackFeatures(t).features.filter((f) => f.properties!.kind === "gap").map((f) => f.properties!.label);
    expect(labels).toEqual(["기록 없음 09:02–09:20 KST", "AIS 공백 09:21–09:23 KST"]);
  });
  it("a closed gap shorter than 60 s neither breaks the line nor is labelled 'AIS 공백'; 60 s and open gaps do", () => {
    const pts = [0, 60].map((s, i) => ({ ts: iso(T0 + s * 1000), lon: 129 + i * 0.01, lat: 35 }));
    const split = (gap: AisGap) => shipTrackFromRest({ points: pts, gaps: [gap] }).segs.length;
    expect(split({ started_at: iso(T0 + 1_000), ended_at: iso(T0 + 60_000), reason: null })).toBe(1); // 59 s
    expect(split({ started_at: iso(T0), ended_at: iso(T0 + 60_000), reason: null })).toBe(2); // 60 s
    expect(split({ started_at: iso(T0 + 30_000), ended_at: null, reason: null })).toBe(2); // 열린 공백
    // 구간 사이 라벨도 같은 규칙: 짧은 공백만 있으면 "기록 없음"
    const t: ShipTrack = {
      segs: [{ pts: [[129, 35]], startMs: T0, endMs: T0 }, { pts: [[129.1, 35]], startMs: T0 + 20 * 60_000, endMs: T0 + 20 * 60_000 }],
      gaps: [{ started_at: iso(T0 + 60_000), ended_at: iso(T0 + 90_000), reason: null }],
    };
    expect(shipTrackFeatures(t).features.find((f) => f.properties!.kind === "gap")!.properties!.label).toBe("기록 없음 09:00–09:20 KST");
  });
  it("live points join the last segment, or start a new one after > 15 min / an AIS gap; stale and duplicate points are skipped", () => {
    const t: ShipTrack = { segs: [{ pts: [[129, 35]], startMs: T0, endMs: T0 }], gaps: [] };
    expect(appendShipTrack(t, { ts: T0, lon: 129.5, lat: 35 })).toBe(false); // 같은 시각
    expect(appendShipTrack(t, { ts: T0 + 60_000, lon: 129.01, lat: 35 })).toBe(true);
    expect(t.segs).toHaveLength(1);
    expect(appendShipTrack(t, { ts: T0 + 20 * 60_000, lon: 129.2, lat: 35 })).toBe(true);
    expect(t.segs).toHaveLength(2);
    t.gaps.push({ started_at: iso(T0 + 20.5 * 60_000), ended_at: iso(T0 + 21 * 60_000), reason: null }); // 30 s — 끊지 않는다
    expect(appendShipTrack(t, { ts: T0 + 21 * 60_000, lon: 129.205, lat: 35 })).toBe(true);
    expect(t.segs).toHaveLength(2);
    t.gaps.push({ started_at: iso(T0 + 21 * 60_000), ended_at: iso(T0 + 22 * 60_000), reason: null }); // 60 s
    expect(appendShipTrack(t, { ts: T0 + 22 * 60_000, lon: 129.21, lat: 35 })).toBe(true);
    expect(t.segs).toHaveLength(3);
  });
  it("without REST segment times the anchor (last observation known at selection) decides continuity", () => {
    const t = shipTrackFromRest({ type: "LineString", coordinates: [[129, 35], [129.01, 35]] });
    expect(t.segs[0].endMs).toBeNull();
    const cont = structuredClone(t);
    appendShipTrack(cont, { ts: T0 + 60_000, lon: 129.02, lat: 35 }, T0);
    expect(cont.segs).toHaveLength(1);
    const broken = structuredClone(t);
    appendShipTrack(broken, { ts: T0 + 3_600_000, lon: 129.5, lat: 35 }, T0);
    expect(broken.segs).toHaveLength(2);
    const unknown = structuredClone(t);
    appendShipTrack(unknown, { ts: T0 + 60_000, lon: 129.02, lat: 35 }, null); // 시각을 전혀 모르면 잇지 않는다(점선 "기록 공백")
    expect(shipTrackFeatures(unknown).features.map((f) => f.properties!.label ?? f.properties!.kind)).toEqual(["track", "기록 공백"]);
  });
  it("garbage responses give an empty track", () => {
    expect(shipTrackFromRest(null)).toEqual({ segs: [], gaps: [] });
    expect(shipTrackFromRest({ type: "Feature", geometry: { type: "Point", coordinates: [1, 2] } }).segs).toEqual([]);
  });
});

describe("track gaps follow the AIS status: an open gap is a placeholder (review 2026-09-28b #14)", () => {
  const X = Date.parse("2026-09-28T01:00:00Z");
  const Y = X + 5 * 60_000;
  const status = (open: number | null, last: [number, number] | null): Pick<AisStatus, "gap_open_since" | "last_gap"> => ({
    gap_open_since: open == null ? null : iso(open),
    last_gap: last ? { started_at: iso(last[0]), ended_at: iso(last[1]), reason: "disconnect" } : null,
  });
  it("the closed gap replaces the open one with the same started_at; later live points form one segment with no false 'AIS 공백' labels", () => {
    const t: ShipTrack = { segs: [{ pts: [[129, 35]], startMs: X - 60_000, endMs: X - 60_000 }], gaps: [] };
    expect(mergeStatusGaps(t, status(X, null), 0)).toBe(true);
    expect(t.gaps).toEqual([{ started_at: iso(X), ended_at: null, reason: null }]);
    expect(mergeStatusGaps(t, status(X, null), 0)).toBe(false); // 같은 상태를 다시 받아도(ship_selected 재전송) 그대로
    expect(mergeStatusGaps(t, status(null, [X, Y]), 0)).toBe(true);
    expect(t.gaps).toEqual([{ started_at: iso(X), ended_at: iso(Y), reason: "disconnect" }]);
    for (let i = 1; i <= 5; i++) appendShipTrack(t, { ts: Y + i * 60_000, lon: 129 + i * 0.01, lat: 35 });
    expect(t.segs).toHaveLength(2);
    const labels = shipTrackFeatures(t).features.filter((f) => f.properties!.kind === "gap").map((f) => f.properties!.label);
    expect(labels).toEqual(["AIS 공백 09:59–10:06 KST"]);
  });
  it("an open gap the status no longer reports is dropped (its end is unknown); a different open gap replaces it", () => {
    const t: ShipTrack = { segs: [], gaps: [{ started_at: iso(X), ended_at: null, reason: null }] };
    expect(mergeStatusGaps(t, status(null, null), 0)).toBe(true);
    expect(t.gaps).toEqual([]);
    t.gaps = [{ started_at: iso(X), ended_at: null, reason: null }];
    mergeStatusGaps(t, status(Y, null), 0);
    expect(t.gaps).toEqual([{ started_at: iso(Y), ended_at: null, reason: null }]);
    // 같은 시각을 다른 표기로 받아도 같은 공백
    t.gaps = [{ started_at: new Date(Y).toISOString().replace(".000Z", "Z"), ended_at: null, reason: null }];
    expect(mergeStatusGaps(t, status(Y, null), 0)).toBe(false);
  });
  it("unknown status leaves the list alone; a last gap that ended before the track window is not added", () => {
    const t: ShipTrack = { segs: [], gaps: [{ started_at: iso(X), ended_at: null, reason: null }] };
    expect(mergeStatusGaps(t, null, 0)).toBe(false);
    expect(t.gaps).toHaveLength(1);
    const u: ShipTrack = { segs: [], gaps: [] };
    expect(mergeStatusGaps(u, status(null, [X, Y]), Y + 1)).toBe(false);
    expect(u.gaps).toEqual([]);
  });
  it("REST gaps: the newest 200 are kept (not the oldest), open+closed with the same start collapse to the closed one", () => {
    const raw = Array.from({ length: 250 }, (_, i) => ({ started_at: iso(X + i * 600_000), ended_at: iso(X + i * 600_000 + 90_000) }));
    const t = shipTrackFromRest({ type: "Feature", geometry: { type: "LineString", coordinates: [[129, 35], [129.1, 35]] }, gaps: raw });
    expect(t.gaps).toHaveLength(200);
    expect(t.gaps[0].started_at).toBe(iso(X + 50 * 600_000));
    expect(t.gaps.at(-1)!.started_at).toBe(iso(X + 249 * 600_000));
    expect(t.gapsTruncated).toBe(true);
    const dup = shipTrackFromRest({ gaps: [{ started_at: iso(X), ended_at: null }, { started_at: iso(X), ended_at: iso(Y) }] });
    expect(dup.gaps).toEqual([{ started_at: iso(X), ended_at: iso(Y), reason: null }]);
    expect(dup.gapsTruncated).toBeUndefined();
    expect(shipTrackFromRest({ gaps: [], properties: {}, type: "Feature", geometry: null }).gapsTruncated).toBeUndefined();
    expect(shipTrackFromRest({ type: "Feature", geometry: null, properties: { gaps: [], gaps_truncated: true } }).gapsTruncated).toBe(true);
  });
  it("normalizeGaps sorts oldest first and reports drops; gapSummary counts all gaps and sums closed durations", () => {
    const g = (s: number, e: number | null): AisGap => ({ started_at: iso(s), ended_at: e == null ? null : iso(e), reason: null });
    const r = normalizeGaps([g(X + 2000, X + 3000), g(X, X + 30_000), g(X + 1000, null)], 2);
    expect(r.gaps.map((x) => x.started_at)).toEqual([iso(X + 1000), iso(X + 2000)]);
    expect(r.dropped).toBe(true);
    expect(gapSummary([g(X, X + 30_000), g(X + 60_000, X + 150_000), g(Y, null)])).toEqual({ count: 3, closedS: 120, openSinceMs: Y });
    expect(gapSummary([])).toEqual({ count: 0, closedS: 0, openSinceMs: null });
  });
});

describe("dense aircraft track: focus observations (≈5 s) are all appended", () => {
  it("every new observation extends the line", () => {
    const pts: TrackPt[] = [];
    const t0 = Date.parse("2026-09-28T02:00:00Z");
    for (let i = 0; i < 60; i++) expect(appendTrackPoint(pts, { ts: t0 + i * 5000, lon: 127 + i * 0.002, lat: 36, alt_ft: 30000 })).toBe(true);
    expect(trackFeatureCollection(pts).features).toHaveLength(59);
  });
});

// ---------------------------------------------------------------- AIS 상태

describe("AIS status badges (status.sources.ais)", () => {
  it("parses status.sources.ais; missing → null", () => {
    const a = parseAisStatus({ sources: { ais: { connected: true, lag_s: 3, msgs_per_s: 5.4, gap_open_since: null, last_gap: { started_at: iso(NOW - 3_600_000), ended_at: iso(NOW - 3_500_000) } } } }, 1000)!;
    expect(a).toMatchObject({ connected: true, lag_s: 3, msgs_per_s: 5.4, gap_open_since: null });
    expect(a.last_gap?.ended_at).toBe(iso(NOW - 3_500_000));
    expect(parseAisStatus({ region: {} }, 1)).toBeNull();
  });
  it("connected · msg/s · lag; lag grows with time since receipt when the connection is not live", () => {
    const a = parseAisStatus({ sources: { ais: { connected: true, lag_s: 3, msgs_per_s: 5.4 } } }, 1_000_000)!;
    expect(aisBadge(a, 1_010_000, true)).toMatchObject({ text: "AIS · 5.4 msg/s · lag 3s", tone: "ok" });
    expect(aisBadge(a, 1_200_000, false)).toMatchObject({ text: "AIS · 5.4 msg/s · lag 203s", tone: "warn" });
    expect(aisBadge({ ...a, connected: false }, 1_010_000, true)).toMatchObject({ text: "AIS 끊김", tone: "bad" });
    expect(aisBadge(null, 0, true)).toBeNull();
  });
  it("collector state (contract v3 §A): no key → neutral 'AIS 꺼짐 · 키 없음'; reconnecting is claimed only for connecting/backoff (review #15)", () => {
    const a = (state: unknown, connected: boolean | null = false) => parseAisStatus({ sources: { ais: { connected, state, lag_s: null, msgs_per_s: null } } }, 1_000_000)!;
    expect(a("disabled").state).toBe("disabled");
    expect(a("bogus").state).toBeNull();
    expect(a(undefined).state).toBeNull();
    const off = aisBadge(a("disabled"), 1_010_000, true)!;
    expect(off).toMatchObject({ text: "AIS 꺼짐 · 키 없음", tone: "muted" });
    expect(off.title).not.toContain("재연결");
    for (const st of ["connecting", "backoff"]) {
      expect(aisBadge(a(st), 1_010_000, true)).toMatchObject({ text: "AIS 끊김", tone: "bad", title: expect.stringContaining("재연결 중(지수 백오프)") });
    }
    for (const st of [null, "starting", "stopped"]) {
      const b = aisBadge(a(st), 1_010_000, true)!;
      expect(b).toMatchObject({ text: "AIS 끊김", tone: "bad" });
      expect(b.title).not.toContain("재연결");
    }
  });
  it("coverage boxes: either corner order, all-or-nothing validation, 1–16 boxes", () => {
    expect(parseAisCoverage([[46, 150, 18, 105]])).toEqual([{ s: 18, w: 105, n: 46, e: 150 }]);
    expect(parseAisCoverage([[18, 105, 46, 150]])).toEqual([{ s: 18, w: 105, n: 46, e: 150 }]);
    expect(parseAisCoverage([[-90, -180, 90, 0], [-90, 45, 90, 180]])).toHaveLength(2);
    expect(parseAisCoverage(null)).toBeNull();
    expect(parseAisCoverage([])).toBeNull();
    expect(parseAisCoverage([[18, 105, 46]])).toBeNull();
    expect(parseAisCoverage([[18, 105, 46, 150], [91, 0, 10, 10]])).toBeNull(); // 하나라도 틀리면 전체를 모름으로
    expect(parseAisCoverage([[18, 105, 18, 150]])).toBeNull(); // 넓이 0
    expect(parseAisCoverage([["18", 105, 46, 150]])).toBeNull();
    expect(parseAisCoverage(Array.from({ length: 17 }, () => [0, 0, 1, 1]))).toBeNull();
    expect(parseAisCoverage(Array.from({ length: 16 }, () => [0, 0, 1, 1]))).toHaveLength(16);
    expect(parseAisStatus({ sources: { ais: { connected: true, coverage: [[46, 150, 18, 105]] } } }, 0)!.coverage).toEqual([{ s: 18, w: 105, n: 46, e: 150 }]);
    expect(parseAisStatus({ sources: { ais: { connected: true, coverage: null } } }, 0)!.coverage).toBeNull();
  });
  it("coverage outline: one box is a rectangle; the operational setting draws only the 0°E and 45°E meridians (antimeridian and poles are not edges)", () => {
    const segs = (boxes: AisBox[] | null) => aisCoverageFeatures(boxes).features.map((f) => f.geometry.coordinates);
    const rect = segs(parseAisCoverage([[46, 150, 18, 105]]));
    expect(rect).toHaveLength(4);
    expect(rect).toEqual(expect.arrayContaining([[[105, 18], [105, 46]], [[150, 18], [150, 46]], [[105, 18], [150, 18]], [[105, 46], [150, 46]]]));
    const ops = segs(parseAisCoverage([[-90, -180, 90, 0], [-90, 45, 90, 180]]));
    expect(ops).toEqual([[[0, -85.0511], [0, 85.0511]], [[45, -85.0511], [45, 85.0511]]]);
    expect(segs(null)).toEqual([]);
  });
  it("coverage outline of overlapping boxes is the union boundary (no line inside the covered area)", () => {
    const boxes = parseAisCoverage([[0, 0, 10, 10], [5, 5, 15, 15], [0, 0, 10, 10]])!;
    const inside = (lat: number, lon: number) => boxes.some((b) => lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e);
    const fs = aisCoverageFeatures(boxes).features;
    expect(fs).toHaveLength(8); // L 자 두 개가 겹친 모양의 바깥 둘레: 변 8개(같은 상자 두 번은 한 번만)
    for (const f of fs) {
      const [[x1, y1], [x2, y2]] = f.geometry.coordinates;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, d = 1e-3;
      const sides = x1 === x2 ? [inside(my, mx - d), inside(my, mx + d)] : [inside(my - d, mx), inside(my + d, mx)];
      expect(sides[0] !== sides[1]).toBe(true); // 한쪽만 범위 안 = 진짜 경계
    }
  });
  it("gap badge: open gap, or a gap that ended within 30 min", () => {
    const base = { connected: true, lag_s: 1, msgs_per_s: 1, received_at: 0, state: null, coverage: null };
    expect(aisGapBadge({ ...base, gap_open_since: "2026-09-28T02:50:00Z", last_gap: null }, NOW)).toMatchObject({ text: "AIS 공백 11:50 KST 부터 · 진행 중", open: true });
    const ended = { started_at: "2026-09-28T02:40:00Z", ended_at: "2026-09-28T02:45:00Z", reason: null };
    expect(aisGapBadge({ ...base, gap_open_since: null, last_gap: ended }, NOW)).toMatchObject({ text: "AIS 공백 11:40–11:45 KST", open: false });
    expect(aisGapBadge({ ...base, gap_open_since: null, last_gap: { ...ended, ended_at: "2026-09-28T02:20:00Z" } }, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------- 수요(demand)

describe("demand chips (contract v2 §A3/§B4): only what the server reported", () => {
  const since = iso(NOW - 3 * 60_000 - 5_000);
  const d = (focus: unknown, hot: unknown = null): DemandInfo => parseDemand({ type: "demand", focus, hot }, 0);
  it("parse: unknown states and malformed hex/cell are dropped (not guessed)", () => {
    expect(d({ hex: "71c123", state: "active", interval_s: 5, since }).focus).toMatchObject({ hex: "71c123", state: "active", interval_s: 5 });
    expect(d({ hex: "71C123", state: "active" }).focus).toBeNull();
    expect(d({ hex: "71c123", state: "turbo" }).focus).toBeNull();
    expect(d(null, { cell: "35.5:139.5:150", radius_nm: 150, state: "active", interval_s: 30 }).hot).toMatchObject({ cell: "35.5:139.5:150", radius_nm: 150 });
    expect(d(null, { cell: "x", state: "active", interval_s: -1 }).hot).toMatchObject({ cell: null, interval_s: null });
  });
  it("focus: every state has its own wording; the cadence appears only when reported", () => {
    const f = (state: string, extra: Record<string, unknown> = {}) => focusChip(d({ hex: "71c123", state, since, ...extra }), "71c123", NOW)?.text;
    expect(f("active", { interval_s: 5 })).toBe("집중 추적 5초 · 3분째");
    expect(f("active")).toBe("집중 추적 · 3분째");
    expect(f("pending")).toBe("집중 추적 대기");
    expect(f("throttled", { interval_s: 10 })).toBe("호출 상한으로 지연 · 10초 간격");
    expect(f("not_found")).toBe("공급자에서 찾지 못함");
    expect(f("error")).toBe("집중 추적 오류");
    expect(f("expired_session_cap")).toContain("30분 상한");
    expect(focusChip(d({ hex: "71c123", state: "active", interval_s: 5 }), "abcdef", NOW)).toBeNull(); // 다른 항공기에 대한 보고
    expect(elapsedLabel(iso(NOW - 30_000), NOW)).toBe("1분 미만");
  });
  it("hot: radius and cadence from the server; covered_by_region says so; map chip prefers focus when selected", () => {
    const h = (state: string, extra: Record<string, unknown> = {}) => hotChip(d(null, { cell: "35.5:139.5:150", radius_nm: 150, state, ...extra }))?.text;
    expect(h("active", { interval_s: 30 })).toBe("핫 리전 30초 갱신(반경 150 NM)");
    expect(h("pending")).toBe("핫 리전 대기(반경 150 NM)");
    expect(h("throttled", { interval_s: 60 })).toBe("핫 리전 호출 상한으로 지연 · 60초 간격(반경 150 NM)");
    expect(h("covered_by_region")).toBe("관심 지역 수집 범위 안");
    const both = d({ hex: "71c123", state: "active", interval_s: 5, since }, { radius_nm: 100, state: "active", interval_s: 30 });
    expect(mapDemandChip(both, "71c123", NOW)?.kind).toBe("focus");
    expect(mapDemandChip(both, null, NOW)?.kind).toBe("hot");
  });
});

// ---------------------------------------------------------------- 저장·목록·출처

describe("per-viewer layer prefs (localStorage, try/catch)", () => {
  const mem = (): KV & { m: Map<string, string> } => { const m = new Map<string, string>(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } }; };
  it("round-trips known boolean keys only", () => {
    const kv = mem();
    saveLayers({ radar: true, sigmet: false, aircraft: true, ships: true, airports: true, tracks: true, prediction: false }, kv);
    expect(loadLayers(kv)).toEqual({ radar: true, sigmet: false, aircraft: true, ships: true, airports: true, tracks: true, prediction: false });
    kv.m.set("wakeline.layers", JSON.stringify({ ships: "yes", aircraft: false, evil: true }));
    expect(loadLayers(kv)).toEqual({ aircraft: false });
  });
  it("corrupt JSON, oversized values and throwing storage fall back to defaults", () => {
    const kv = mem();
    kv.m.set("wakeline.layers", "{not json");
    expect(loadLayers(kv)).toBeNull();
    kv.m.set("wakeline.layers", JSON.stringify({ ships: true, pad: "x".repeat(2000) }));
    expect(loadLayers(kv)).toBeNull();
    const boom: KV = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
    expect(loadLayers(boom)).toBeNull();
    expect(() => saveLayers({ radar: true, sigmet: true, aircraft: true, ships: true, airports: true, tracks: true, prediction: true }, boom)).not.toThrow();
    expect(loadLayers(null)).toBeNull();
  });
});

describe("ship list (select without the canvas)", () => {
  it("named ships first by name, then MMSI; filter by name or MMSI; capped", () => {
    const ships = [lite({ mmsi: "300000000", name: null }), lite({ mmsi: "200000000", name: "BRAVO" }), lite({ mmsi: "100000000", name: "ALPHA" })];
    expect(shipList(ships, "").items.map((s) => s.mmsi)).toEqual(["100000000", "200000000", "300000000"]);
    expect(shipList(ships, "brav").items.map((s) => s.mmsi)).toEqual(["200000000"]);
    expect(shipList(ships, "3000").items.map((s) => s.mmsi)).toEqual(["300000000"]);
    expect(shipList(ships, "", 2)).toMatchObject({ total: 3 });
  });
});

describe("attribution names the AIS source", () => {
  it("footer text and map credit include 'Ships: aisstream.io (AIS)'", () => {
    expect(attributionText()).toContain("Ships: aisstream.io (AIS)");
    expect(mapAttributionHtml()).toContain('Ships: <a href="https://aisstream.io"');
    expect(mapAttributionHtml()).toContain("aisstream.io</a> (AIS)");
  });
});

// ---------------------------------------------------------------- 컴포넌트 렌더

describe("ShipCard / ShipPanel / MapChips / AircraftCard demand chip (server render)", () => {
  beforeEach(() => resetData());
  afterEach(() => resetData());

  it("ship card: every field is present and unknown values render as —", () => {
    setData({
      shipSelected: {
        mmsi: "431011305", received_at: 0, static: null,
        state: { ...lite({ mmsi: "431011305", name: "KIMITSU MARU", heading_deg: null, cog_deg: null, sog_kn: null, nav_status: null, position_source: "manual" }), rot: null, provider: "fixture", msg_type: "PositionReport", class: "A" },
      },
    });
    const html = renderToStaticMarkup(createElement(ShipCard, { mmsi: "431011305" }));
    for (const k of ["선박명", "MMSI", "호출부호", "IMO", "선종", "크기", "흘수", "출발지(보고)", "목적지(보고)", "ETA", "속력/침로/선수방위", "항해 상태", "위치 출처", "관측 시각"]) {
      expect(html).toContain(`data-field="${k}"`);
    }
    const esc = (k: string) => k.replace(/[()]/g, "\\$&");
    const field = (k: string) => new RegExp(`data-field="${esc(k)}"[^>]*>.*?<span class="text-right">(.*?)</span></div>`).exec(html)?.[1];
    expect(field("호출부호")).toContain("—");
    expect(field("IMO")).toContain("—");
    expect(field("크기")).toBe("—");
    expect(field("흘수")).toBe("—");
    expect(field("목적지(보고)")).toBe("—");
    expect(field("출발지(보고)")).toBe("— AIS 에는 출발지 항목이 없습니다");
    expect(field("ETA")).toBe("—");
    expect(field("항해 상태")).toBe("—");
    expect(field("선박명")).toBe("KIMITSU MARU");
    expect(html).toContain("수동 위치");
    expect(html).toContain("방향 모름");
  });
  it("ship card: flag-state official numbers are not labelled IMO; position source epfs / unknown (review #6, #16)", () => {
    const state = (src: ShipLite["position_source"]) => ({ ...lite({ mmsi: "431011305", position_source: src }), rot: null, provider: "fixture", msg_type: "PositionReport", class: "A" as const });
    const stat = (imo: number | null) => parseShipStatic({ mmsi: "431011305", imo })!;
    const field = (html: string, k: string) => new RegExp(`data-field="${k}"[^>]*><span[^>]*>(.*?)</span><span class="text-right">(.*?)</span></div>`).exec(html);
    setData({ shipSelected: { mmsi: "431011305", received_at: 0, static: stat(12_345_678), state: state("epfs") } });
    let html = renderToStaticMarkup(createElement(ShipCard, { mmsi: "431011305" }));
    expect(field(html, "IMO")?.[1]).toBe("기국 공식 번호");
    expect(field(html, "IMO")?.[2]).toContain("12345678");
    expect(field(html, "위치 출처")?.[2]).toBe("전자 위치 장치(EPFS) · 선박 보고");
    expect(html).not.toContain("GNSS");
    setData({ shipSelected: { mmsi: "431011305", received_at: 0, static: stat(9_123_456), state: state(null) } });
    html = renderToStaticMarkup(createElement(ShipCard, { mmsi: "431011305" }));
    expect(field(html, "IMO")?.[1]).toBe("IMO");
    expect(field(html, "IMO")?.[2]).toContain("9123456");
    expect(field(html, "위치 출처")?.[2]).toBe("—");
    expect(html).not.toContain('data-testid="ship-pos-badge"');
  });
  it("ship card: gap summary (count · total seconds), the 60 s line-break rule, then the latest 5 gaps", () => {
    const T = Date.parse("2026-09-28T01:00:00Z");
    const gaps: AisGap[] = Array.from({ length: 7 }, (_, i) => ({ started_at: iso(T + i * 600_000), ended_at: iso(T + i * 600_000 + (i + 1) * 10_000), reason: null }));
    setData({ shipTrack: { mmsi: "431011305", loaded: true, error: null, gaps, gapsTruncated: false, segments: 2, fromMs: null } });
    const html = renderToStaticMarkup(createElement(ShipCard, { mmsi: "431011305" }));
    expect(html).toContain("최근 6 h 수신 공백 7회 · 합계 280 s");
    expect(html).toContain("60 s 이상 공백에서만 선을 끊습니다(저장 간격 60 s)");
    expect(html.replace(/<[^>]+>/g, "").match(/수신 공백 \d\d-\d\d/g)).toHaveLength(5); // 구간은 <DualRange>(KST · UTC 두 부분)
    expect(html).toContain("· 70 s"); // 가장 최근 공백의 길이
    setData({ shipTrack: { mmsi: "431011305", loaded: true, error: null, gaps: gaps.slice(0, 1), gapsTruncated: true, segments: 1, fromMs: null } });
    expect(renderToStaticMarkup(createElement(ShipCard, { mmsi: "431011305" }))).toContain("수신 공백 1회 이상(최신 목록만)");
    // 기록 조회에 실패했고 받은 공백도 없으면 "0회"라고 하지 않는다
    setData({ shipTrack: { mmsi: "431011305", loaded: true, error: "HTTP 503", gaps: [], gapsTruncated: false, segments: 0, fromMs: null } });
    expect(renderToStaticMarkup(createElement(ShipCard, { mmsi: "431011305" }))).not.toContain("ship-gap-summary");
    setData({ shipTrack: { mmsi: "431011305", loaded: true, error: null, gaps: [], gapsTruncated: false, segments: 1, fromMs: null } });
    expect(renderToStaticMarkup(createElement(ShipCard, { mmsi: "431011305" }))).toContain("최근 6 h 수신 공백 0회 · 합계 0 s");
    // 기록 조회에 실패했는데 상태로 받은 공백이 있으면: 6 h 전체라고 하지 않는다(리뷰 후속)
    setData({ shipTrack: { mmsi: "431011305", loaded: true, error: "HTTP 503", gaps: gaps.slice(0, 1), gapsTruncated: false, segments: 0, fromMs: null } });
    const failed = renderToStaticMarkup(createElement(ShipCard, { mmsi: "431011305" }));
    expect(failed).toContain("선택 뒤 받은 수신 공백 1회");
    expect(failed).toContain("기록 조회 실패 — 6 h 전체가 아님");
    expect(failed).not.toContain("최근 6 h 수신 공백");
  });
  it("gap summary counts only the part of each gap inside the track window", () => {
    const T = Date.parse("2026-09-28T01:00:00Z");
    const gaps: AisGap[] = [
      { started_at: iso(T - 3_600_000), ended_at: iso(T + 60_000), reason: null }, // 창보다 1 h 먼저 시작 → 창 안 60 s 만
      { started_at: iso(T + 120_000), ended_at: iso(T + 150_000), reason: null },
      { started_at: iso(T - 7_200_000), ended_at: iso(T - 3_700_000), reason: null }, // 창 밖
    ];
    expect(gapSummary(gaps, T, T + 3_600_000)).toEqual({ count: 2, closedS: 90, openSinceMs: null });
    expect(gapSummary(gaps)).toEqual({ count: 3, closedS: 3660 + 30 + 3500, openSinceMs: null });
  });
  it("REST track: lines follow the server's segments even when the gap list was truncated to the newest 200", () => {
    const T = Date.parse("2026-09-28T01:00:00Z");
    const oldOutage = { started_at: iso(T + 60_000), ended_at: iso(T + 660_000), reason: "old" }; // 10분 — 잘려 나간 가장 오래된 공백
    const shortOnes = Array.from({ length: 249 }, (_, i) => ({ started_at: iso(T + 900_000 + i * 20_000), ended_at: iso(T + 900_000 + i * 20_000 + 3_000), reason: null }));
    const pts = [0, 60, 720, 780].map((s) => ({ ts: iso(T + s * 1000), lon: 129 + s / 10_000, lat: 35 }));
    const resp = {
      type: "Feature",
      geometry: { type: "MultiLineString", coordinates: [[[129, 35], [129.006, 35]], [[129.072, 35], [129.078, 35]]] },
      properties: { segments: [{ start: iso(T), end: iso(T + 60_000), points: 2 }, { start: iso(T + 720_000), end: iso(T + 780_000), points: 2 }], gaps_truncated: true },
      points: pts,
      gaps: [oldOutage, ...shortOnes].slice(-200),
    };
    const tr = shipTrackFromRest(resp);
    expect(tr.segs.map((x) => x.pts.length)).toEqual([2, 2]);
    expect(tr.gapsTruncated).toBe(true);
    // 서버 구간에 속하지 않는 점(앞뒤가 끊긴 한 점)은 따로 둔다
    const lone = shipTrackFromRest({ ...resp, points: [...pts.slice(0, 2), { ts: iso(T + 400_000), lon: 129.04, lat: 35 }, ...pts.slice(2)] });
    expect(lone.segs.map((x) => x.pts.length)).toEqual([2, 1, 2]);
  });
  it("AIS disabled (no key): the ship list and chip say so instead of waiting forever (review #15)", () => {
    setData({ ships: { mode: "waiting", version: 1, count: 0, total: 0, ts: null, cell_deg: null, capped: false, grid: [] } });
    const panel = () => renderToStaticMarkup(createElement(ShipPanelView, { selected: null, shipsOn: true }));
    const chip = () => renderToStaticMarkup(createElement(MapChipsView, { hex: null, shipsOn: true }));
    expect(panel()).toContain("선박 수신 대기");
    setData({ ais: parseAisStatus({ sources: { ais: { connected: false, state: "disabled" } } }, 0) });
    expect(panel()).toContain("AIS 수집이 꺼져 있습니다");
    expect(chip()).toContain("AIS 꺼짐(키 없음)");
  });
  it("legend: 'ship coverage' entry only while the ships layer is on and the status carries a coverage", () => {
    const base = useUi.getState().layers;
    const legend = (ships: boolean) => renderToStaticMarkup(createElement(MapLegendView, { id: "lg", layers: { ...base, ships }, radarSource: "rainviewer" }));
    expect(legend(true)).not.toContain("선박 수신 범위");
    setData({ ais: parseAisStatus({ sources: { ais: { connected: true, coverage: [[-90, -180, 90, 0], [-90, 45, 90, 180]] } } }, 0) });
    expect(legend(true)).toContain("선박 수신 범위(운영 설정)");
    expect(legend(false)).not.toContain("선박 수신 범위");
    // 전 해역 구독이면 그릴 경계가 없다 → 범례도 없다
    setData({ ais: parseAisStatus({ sources: { ais: { connected: true, coverage: [[-90, -180, 90, 180]] } } }, 0) });
    expect(legend(true)).not.toContain("선박 수신 범위");
  });
  it("ship card: WS says the ship left the live set → no stale values presented as current", () => {
    setData({ shipSelected: { mmsi: "431011305", received_at: 0, static: null, state: null } });
    const html = renderToStaticMarkup(createElement(ShipCard, { mmsi: "431011305" }));
    expect(html).toContain("실시간 목록에 없음");
  });
  it("ship panel: list of ships in view when nothing is selected; off/grid states explained", () => {
    shipStates.set("100000000", lite({ mmsi: "100000000", name: "ALPHA" }));
    setData({ ships: { mode: "points", version: 1, count: 1, total: 1, ts: null, cell_deg: null, capped: false, grid: [] } });
    const panel = (shipsOn: boolean) => renderToStaticMarkup(createElement(ShipPanelView, { selected: null, shipsOn }));
    expect(panel(true)).toContain('data-mmsi="100000000"');
    setData({ ships: { mode: "grid", version: 2, count: 3, total: 40, ts: null, cell_deg: 2, capped: false, grid: [] } });
    expect(panel(true)).toContain("격자");
    expect(panel(false)).toContain("선박 레이어가 꺼져 있습니다");
  });
  it("map chips: grid mode says ships are aggregated; demand chip only while the connection is live", () => {
    setData({ ships: { mode: "grid", version: 2, count: 3, total: 1234, ts: null, cell_deg: 2, capped: false, grid: [] } });
    const chips = (hex: string | null, shipsOn = true) => renderToStaticMarkup(createElement(MapChipsView, { hex, shipsOn }));
    const html = chips(null);
    expect(html).toContain('data-mode="grid"');
    expect(html).toContain("선박 1.2k척 · 2° 격자 3칸으로 묶음");
    expect(chips(null, false)).toBe("");
    const demand = parseDemand({ focus: { hex: "71c123", state: "active", interval_s: 5 }, hot: { radius_nm: 100, state: "active", interval_s: 30 } }, 0);
    setData({ demand, conn: "open", lastRxAt: -1 }); // 서버 렌더의 시계는 0 → 1 ms 전 수신 = 실시간
    expect(chips("71c123")).toContain("집중 추적 5초");
    expect(chips(null)).toContain("핫 리전 30초 갱신(반경 100 NM)");
    setData({ conn: "closed" });
    expect(chips("71c123")).not.toContain("집중 추적");
  });
  it("aircraft card: demand chip for the selected hex, or an explicit 'not received yet'", () => {
    setData({ conn: "open", lastRxAt: -1, demand: parseDemand({ focus: { hex: "71c123", state: "throttled", interval_s: 10 } }, 0) });
    expect(renderToStaticMarkup(createElement(AircraftCard, { hex: "71c123" }))).toContain("호출 상한으로 지연 · 10초 간격");
    setData({ demand: null });
    expect(renderToStaticMarkup(createElement(AircraftCard, { hex: "71c123" }))).toContain("집중 추적 상태 수신 전");
  });
});
