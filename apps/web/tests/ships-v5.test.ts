/**
 * 계약 v5 §B 웹 — B2 격자 칸의 선종별 수(다섯째 원소) · B3 선종 필터 · 선택 선박 표시 · 항적 기간·점 툴팁 · 카드 행 · 선박 표 · 통합 검색.
 * MMSI·선명은 합성(SYNTHETIC) 값이다.
 */
import { existsSync, readFileSync } from "node:fs";
import { featureFilter } from "@maplibre/maplibre-gl-style-spec";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendShipTrack, filterGridCells, gridFeatures, notLiveText, parseGridCells, SHIP_CATEGORIES, SHIP_CATEGORY_COLOR, sortShipRows, type ShipRow, type ShipSortKey, SHIP_TRACK_HOURS, shipTrackFromRest, shipTrackPointFeatures, type ShipCategory,
} from "@/lib/ships";
import { shipCategoryFilter } from "@/lib/ship-layers";
import { shipGridTip, shipTrackPointTip } from "@/lib/tooltip";
import { loadShipCats, saveShipCats, SHIP_CATS_KEY, type KV } from "@/lib/prefs";
import { resetData, setData, shipStates } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { MapLegendView } from "@/components/MapLegend";
import { LayerPanelView } from "@/components/LayerPanel";
import { ShipTable } from "@/components/ShipTable";
import { MapChipsView } from "@/components/MapChips";
import { parseShipDetail, ShipCard, ShipCardView, ShipPanelView } from "@/components/ShipCard";

const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

/** 계약 v5 §B2 의 순서(웹 SHIP_CATEGORIES = Java ShipCategory 선언 순서) */
const CONTRACT_ORDER = ["cargo", "tanker", "passenger", "fishing", "tug", "pleasure", "hsc", "special", "military", "other", "unknown"];
const all = (): Set<ShipCategory> => new Set(SHIP_CATEGORIES);
const without = (...c: ShipCategory[]) => { const s = all(); for (const x of c) s.delete(x); return s; };
/** 선종별 수 배열(순서 = SHIP_CATEGORIES) */
const counts = (o: Partial<Record<ShipCategory, number>>) => SHIP_CATEGORIES.map((c) => o[c] ?? 0);

describe("ship category order (contract v5 §B2)", () => {
  it("SHIP_CATEGORIES is the contract order", () => {
    expect([...SHIP_CATEGORIES]).toEqual(CONTRACT_ORDER);
  });
  it("SHIP_CATEGORIES equals the shared vector schemas/vectors/ship-categories.v1.json (api ShipCategory asserts the same file)", () => {
    // 저장소 밖(웹 이미지 빌드 등)에서는 공유 파일이 없다 — 그때는 위의 계약 순서 시험만
    const shared = new URL("../../../schemas/vectors/ship-categories.v1.json", import.meta.url);
    if (!existsSync(shared)) return;
    const v = JSON.parse(readFileSync(shared, "utf8")) as { version: number; order: string[] };
    expect(v.version).toBe(1);
    expect([...SHIP_CATEGORIES]).toEqual(v.order);
  });
});

describe("ships_grid cells with per-category counts (contract v5 §B2)", () => {
  it("reads the 5th element as counts in SHIP_CATEGORIES order; 4-element cells (older servers) have counts null", () => {
    const cells = parseGridCells([
      [35.25, 129.25, 5, "cargo", counts({ cargo: 3, tanker: 1, fishing: 1 })],
      [34.75, 128.75, 2, "tanker"],
    ]);
    expect(cells).toHaveLength(2);
    expect(cells[0]).toEqual({ lat: 35.25, lon: 129.25, count: 5, category: "cargo", counts: counts({ cargo: 3, tanker: 1, fishing: 1 }) });
    expect(cells[1]).toEqual({ lat: 34.75, lon: 128.75, count: 2, category: "tanker", counts: null });
  });
  it("counts that do not fit (wrong length, negative, fractional, non-number, sum ≠ count) are not trusted → null", () => {
    const bad = [
      counts({ cargo: 5 }).slice(0, 10), // 원소 10개
      [...counts({ cargo: 5 }), 0], // 12개
      counts({ cargo: 6, tanker: -1 }),
      counts({ cargo: 4.5, tanker: 0.5 }),
      counts({ cargo: 5 }).map((n, i) => (i === 3 ? "0" : n)),
      counts({ cargo: 4 }), // 합 4 ≠ 5
      "cargo:5",
    ];
    for (const b of bad) expect(parseGridCells([[1, 2, 5, "cargo", b]])[0].counts).toBeNull();
  });
});

describe("category filter on the grid (contract v5 §B3)", () => {
  const cells = parseGridCells([
    [35.25, 129.25, 5, "cargo", counts({ cargo: 3, tanker: 1, fishing: 1 })],
    [34.75, 128.75, 2, "fishing", counts({ fishing: 2 })],
    [33.25, 126.25, 4, "tanker", counts({ tanker: 2, passenger: 2 })],
    [30.25, 122.25, 7, "cargo"], // 구 서버(선종별 수 없음)
  ]);
  it("all categories on: the server's cells as they are", () => {
    const r = filterGridCells(cells, all());
    expect(r.cells.map((c) => [c.count, c.category, c.unfiltered])).toEqual([[5, "cargo", false], [2, "fishing", false], [4, "tanker", false], [7, "cargo", false]]);
    expect(r).toMatchObject({ total: 18, allTotal: 18, unfilteredCells: 0, active: false });
  });
  it("hiding categories recounts each cell from its counts, drops cells that reach 0 and re-picks the most common shown category", () => {
    const r = filterGridCells(cells, without("cargo", "fishing"));
    // 칸 1: 유조선 1 · 칸 2: 0척 → 그리지 않음 · 칸 3: 유조선 2 = 여객 2 → 순서가 앞인 tanker · 칸 4: 선종별 수 없음 → 그대로(필터 미적용 표시)
    expect(r.cells.map((c) => [c.lat, c.count, c.category, c.all, c.unfiltered])).toEqual([
      [35.25, 1, "tanker", 5, false], [33.25, 4, "tanker", 4, false], [30.25, 7, "cargo", 7, true],
    ]);
    expect(r).toMatchObject({ total: 12, allTotal: 18, unfilteredCells: 1, active: true });
    const none = filterGridCells(cells, new Set());
    expect(none.cells.map((c) => c.lat)).toEqual([30.25]); // 선종별 수가 없는 칸만 남는다(지어내지 않는다 — 표시로 밝힌다)
  });
  it("grid features carry the shown count, the total before filtering and a per-category breakdown for the tooltip", () => {
    const f = gridFeatures(filterGridCells(cells, without("cargo")).cells).features;
    expect(f[0].properties).toMatchObject({ count: 2, label: "2", cat: "tanker", all: 5, unfiltered: false, breakdown: "화물선 3(숨김) · 유조선·탱커 1 · 어선 1" });
    expect(f[3].properties).toMatchObject({ count: 7, all: 7, unfiltered: true, breakdown: "" });
    const tip = shipGridTip(f[0].properties!, 0.5);
    expect(tip.title).toBe("선박 2척 · 선종 필터 적용(칸 전체 5척)");
    expect(Object.fromEntries(tip.rows)).toMatchObject({ MOST: "유조선·탱커", "BY TYPE": "화물선 3(숨김) · 유조선·탱커 1 · 어선 1" });
    const old = shipGridTip(f[3].properties!, 0.5);
    expect(old.title).toBe("선박 7척");
    expect(Object.fromEntries(old.rows)["BY TYPE"]).toBe("— (서버가 선종별 수를 보내지 않음)");
    expect(old.flags.map((x) => x.text)).toContain("선종별 수 없음(구 서버) — 선종 필터를 적용하지 못한 전체 수");
  });
});

// ---------------------------------------------------------------- §B3 선종 필터(토글 · 저장 · 지도 식 · 칩 · 목록)

describe("category filter UI (contract v5 §B3)", () => {
  beforeEach(() => { resetData(); useUi.setState({ shipCats: [...SHIP_CATEGORIES], layers: { ...useUi.getState().layers, ships: true } }); });
  afterEach(() => { resetData(); useUi.setState({ shipCats: [...SHIP_CATEGORIES] }); });

  it("stored only in this browser: hidden categories round-trip; unknown names and garbage are ignored", () => {
    const mem = new Map<string, string>();
    const kv: KV = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); } };
    expect(loadShipCats(kv)).toBeNull();
    saveShipCats(["cargo", "tanker", "passenger", "tug", "pleasure", "hsc", "special", "military", "other"], kv);
    expect(JSON.parse(mem.get(SHIP_CATS_KEY)!)).toEqual({ hidden: ["fishing", "unknown"] });
    expect(loadShipCats(kv)).toEqual(["cargo", "tanker", "passenger", "tug", "pleasure", "hsc", "special", "military", "other"]);
    mem.set(SHIP_CATS_KEY, JSON.stringify({ hidden: ["cargo", "submarine", 3] }));
    expect(loadShipCats(kv)).toEqual(SHIP_CATEGORIES.filter((c) => c !== "cargo"));
    for (const junk of ["{", "[]", '"x"', JSON.stringify({ hidden: "cargo" })]) { mem.set(SHIP_CATS_KEY, junk); expect(loadShipCats(kv)).toBeNull(); }
    const broken: KV = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(loadShipCats(broken)).toBeNull();
    expect(() => saveShipCats([], broken)).not.toThrow();
  });

  it("toggle keeps SHIP_CATEGORIES order", () => {
    useUi.getState().toggleShipCat("fishing");
    expect(useUi.getState().shipCats).not.toContain("fishing");
    useUi.getState().toggleShipCat("fishing");
    expect(useUi.getState().shipCats).toEqual([...SHIP_CATEGORIES]);
  });

  it("points mode: a MapLibre filter on the category (none when everything is on)", () => {
    expect(shipCategoryFilter(new Set(SHIP_CATEGORIES))).toBeNull();
    const f = shipCategoryFilter(new Set(SHIP_CATEGORIES.filter((c) => c !== "cargo" && c !== "unknown")))!;
    const ff = featureFilter(f as never, "filter");
    const pass = (cat: unknown) => ff.filter({ zoom: 8 } as never, { type: 1, properties: cat === undefined ? {} : { cat } } as never);
    expect(pass("tanker")).toBe(true);
    expect(pass("cargo")).toBe(false);
    expect(pass(undefined)).toBe(false); // 분류가 없으면 unknown 으로 본다(지도 색과 같은 규칙)
    expect(featureFilter(shipCategoryFilter(new Set())! as never, "filter").filter({ zoom: 8 } as never, { type: 1, properties: { cat: "tanker" } } as never)).toBe(false);
  });

  it("legend: every category is a toggle with its state and the count shown (선종 필터 n/11)", () => {
    // 서버 렌더에서 zustand 훅은 초기 상태를 읽는다 — 표시 부분(View)에 지금 상태를 인자로
    const legend = () => renderToStaticMarkup(createElement(MapLegendView, { id: "lg", layers: useUi.getState().layers, radarSource: "rainviewer", shipCats: useUi.getState().shipCats }));
    let html = legend();
    expect(html).toContain("선종 필터 11/11");
    for (const c of SHIP_CATEGORIES) expect(html).toMatch(new RegExp(`aria-pressed="true"[^>]*data-testid="ship-cat-${c}"`));
    expect(html).not.toContain('data-testid="ship-cats-all"');
    useUi.getState().toggleShipCat("cargo");
    useUi.getState().toggleShipCat("fishing");
    html = legend();
    expect(html).toContain("선종 필터 9/11");
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="ship-cat-cargo"/);
    expect(html).toContain('data-testid="ship-cats-all"');
  });

  it("layer panel shows the filter count next to the ships toggle", () => {
    useUi.getState().toggleShipCat("tug");
    const panel = () => renderToStaticMarkup(createElement(LayerPanelView, { layers: useUi.getState().layers, shipCats: useUi.getState().shipCats, legendOpen: false }));
    expect(panel()).toMatch(/data-testid="ship-cat-filter-chip"[^>]*>선종 필터 10\/11</);
    useUi.setState({ layers: { ...useUi.getState().layers, ships: false } });
    expect(panel()).not.toContain("ship-cat-filter-chip");
  });

  it("map chip: points and grid say how many are shown under the filter; unfiltered old cells are called out", () => {
    const lite = (mmsi: string, ship_type: number | null) => ({ mmsi, lat: 35, lon: 129, sog_kn: null, cog_deg: null, heading_deg: null, ship_type, name: null, seen_at: null, position_source: null, nav_status: null });
    shipStates.set("100000001", lite("100000001", 70));
    shipStates.set("100000002", lite("100000002", 70));
    shipStates.set("100000003", lite("100000003", 30));
    setData({ ships: { mode: "points", version: 1, count: 3, total: 3, ts: null, cell_deg: null, capped: false, grid: [] }, viewport: { bbox: [120, 30, 135, 40], zoom: 8 } });
    const chip = () => text(renderToStaticMarkup(createElement(MapChipsView, { hex: null, shipsOn: true, shipCats: useUi.getState().shipCats })));
    expect(chip()).toContain("선박 3척 · 화면 안 · AIS");
    useUi.getState().toggleShipCat("cargo");
    expect(chip()).toContain("선박 1척 · 화면 안 3척 중 · 선종 필터 10/11 · AIS");
    useUi.getState().toggleShipCat("fishing");
    expect(chip()).toContain("선박 0척 표시 — 선종 필터 9/11 로 화면 안 3척 모두 숨김");
    const grid = parseGridCells([[35.25, 129.25, 5, "cargo", counts({ cargo: 3, tanker: 2 })], [30.25, 122.25, 7, "cargo"]]);
    setData({ ships: { mode: "grid", version: 2, count: 2, total: 12, ts: null, cell_deg: 0.5, capped: false, grid }, viewport: { bbox: [120, 30, 135, 40], zoom: 5 } });
    expect(chip()).toContain("선박 9척 · 선종 필터 9/11(전체 12척) · 0.5° 격자 2칸으로 묶음");
    expect(chip()).toContain("1칸은 선종별 수 없음(구 서버 — 필터 미적용)");
  });

  it("ship list in view follows the same filter and says so", () => {
    const lite = (mmsi: string, name: string, ship_type: number | null) => ({ mmsi, lat: 35, lon: 129, sog_kn: null, cog_deg: null, heading_deg: null, ship_type, name, seen_at: null, position_source: null, nav_status: null });
    shipStates.set("100000001", lite("100000001", "ALPHA", 70));
    shipStates.set("100000002", lite("100000002", "BRAVO", 30));
    setData({ ships: { mode: "points", version: 1, count: 2, total: 2, ts: null, cell_deg: null, capped: false, grid: [] } });
    useUi.getState().toggleShipCat("fishing");
    const html = renderToStaticMarkup(createElement(ShipPanelView, { selected: null, shipsOn: true, shipCats: useUi.getState().shipCats }));
    expect(html).toContain('data-mmsi="100000001"');
    expect(html).not.toContain('data-mmsi="100000002"');
    expect(text(html)).toContain("선종 필터 10/11 · 1척 숨김");
  });
});

// ---------------------------------------------------------------- §B3 항적 기간 · 항적 점(호버)

describe("ship track points and period (contract v5 §B3)", () => {
  const T = Date.parse("2026-09-28T01:00:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  it("REST points keep speed, course, heading and navigation status as the API gave them (missing or out of range → null)", () => {
    const tr = shipTrackFromRest({
      points: [
        { ts: iso(T), lon: 129, lat: 35, sog_kn: 12.3, cog_deg: 123.4, heading_deg: 120, nav_status: 0 },
        { ts: iso(T + 60_000), lon: 129.01, lat: 35 }, // 속력·상태 없음(키 없음 = 모름)
        { ts: iso(T + 120_000), lon: 129.02, lat: 35, sog_kn: 102.3, cog_deg: 360, heading_deg: 511, nav_status: 16 }, // 범위 밖 → 모름
      ],
      gaps: [],
    });
    expect(tr.points).toEqual([
      { ts: T, lon: 129, lat: 35, sog_kn: 12.3, cog_deg: 123.4, heading_deg: 120, nav_status: 0, src: "rest" },
      { ts: T + 60_000, lon: 129.01, lat: 35, sog_kn: null, cog_deg: null, heading_deg: null, nav_status: null, src: "rest" },
      { ts: T + 120_000, lon: 129.02, lat: 35, sog_kn: null, cog_deg: null, heading_deg: null, nav_status: null, src: "rest" },
    ]);
    const fc = shipTrackPointFeatures(tr);
    expect(fc.features).toHaveLength(3);
    expect(fc.features[0].properties).toEqual({ ts: iso(T), sog: 12.3, cog: 123.4, hdg: 120, nav: 0, src: "rest" });
    expect(fc.features[0].geometry.coordinates).toEqual([129, 35]);
  });
  it("live observations appended after selection become hover points too (source marked live)", () => {
    const tr = shipTrackFromRest({ points: [{ ts: iso(T), lon: 129, lat: 35, sog_kn: 10 }], gaps: [] });
    expect(appendShipTrack(tr, { ts: T + 60_000, lon: 129.01, lat: 35, sog_kn: 11, cog_deg: 90, heading_deg: null, nav_status: 5 })).toBe(true);
    expect(tr.points!.at(-1)).toEqual({ ts: T + 60_000, lon: 129.01, lat: 35, sog_kn: 11, cog_deg: 90, heading_deg: null, nav_status: 5, src: "live" });
    expect(appendShipTrack(tr, { ts: T + 60_000, lon: 129.02, lat: 35 })).toBe(false); // 같은 시각 — 점도 늘지 않는다
    expect(tr.points).toHaveLength(2);
  });
  it("hover tooltip: time (UTC), speed in kn · km/h, course and navigation status — '—' when the point has none", () => {
    const t = shipTrackPointTip({ ts: iso(T), sog: 12.3, cog: 123.4, hdg: 120, nav: 0, src: "rest" }, "SYN ALPHA");
    expect(t.title).toBe("항적 점");
    expect(t.subtitle).toBe("SYN ALPHA");
    expect(Object.fromEntries(t.rows)).toEqual({ "TIME UTC": "09-28 01:00:00Z", SOG: "12.3 kn · 22.8 km/h", COG: "123.4°", STATUS: "기관 사용 항해 중 (0)" });
    expect(t.flags.map((f) => f.text)).toEqual(["저장 기록 · 60 s 창의 첫 보고"]);
    const u = shipTrackPointTip({ ts: iso(T), src: "live" }, null);
    expect(Object.fromEntries(u.rows)).toEqual({ "TIME UTC": "09-28 01:00:00Z", SOG: "—", COG: "—", STATUS: "—" });
    expect(u.flags.map((f) => f.text)).toEqual(["실시간 관측 · 선택한 뒤 받은 값"]);
  });
  it("period options are 6 / 12 / 24 h (REST ≤ 24 h)", () => {
    expect([...SHIP_TRACK_HOURS]).toEqual([6, 12, 24]);
    expect(useUi.getState().shipTrackHours).toBe(6);
    useUi.getState().setShipTrackHours(24);
    expect(useUi.getState().shipTrackHours).toBe(24);
    useUi.getState().setShipTrackHours(6);
  });
  it("ship card: period buttons and texts follow the loaded track window", () => {
    resetData();
    setData({ shipTrack: { mmsi: "431011305", loaded: true, error: null, gaps: [], gapsTruncated: false, segments: 1, fromMs: null, hours: 12 } });
    const html = renderToStaticMarkup(createElement(ShipCard, { mmsi: "431011305" }));
    for (const h of SHIP_TRACK_HOURS) expect(html).toMatch(new RegExp(`data-testid="ship-track-hours-${h}"`));
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="ship-track-hours-6"/); // 선택 상태는 ui-store(서버 렌더는 초기값)
    expect(text(html)).toContain("항적 · 최근 12 h");
    expect(text(html)).toContain("최근 12 h 수신 공백 0회");
    expect(text(html)).toContain("항적 점에 마우스를 올리면 시각(UTC)·속력·침로·항해 상태");
    resetData();
  });
});

// ---------------------------------------------------------------- §B3 카드: 처음 기록 · 마지막 저장 위치 · 실시간 아님

describe("ship card: first recorded / last stored position and the not-live state (contract v5 §B3)", () => {
  beforeEach(() => resetData());
  afterEach(() => resetData());
  const NOW = Date.parse("2026-09-28T03:00:00Z");

  it("REST detail: first_recorded_at and last_position_at are read (bad or missing → null)", () => {
    const d = parseShipDetail("431011305", { state: null, static: null, first_recorded_at: "2026-09-20T01:02:03Z", last_position_at: "2026-09-28T02:59:00Z", meta: {} });
    expect(d).toMatchObject({ first_recorded_at: "2026-09-20T01:02:03Z", last_position_at: "2026-09-28T02:59:00Z", db_unavailable: false });
    const e = parseShipDetail("431011305", { first_recorded_at: "yesterday", last_position_at: 5 });
    expect(e).toMatchObject({ first_recorded_at: null, last_position_at: null });
  });

  it("not-live text: hh:mm UTC on the same UTC day, the date otherwise, — when nothing is stored", () => {
    expect(notLiveText("2026-09-28T02:59:00Z", NOW)).toBe("실시간 아님 · 마지막 저장 02:59 UTC");
    expect(notLiveText("2026-09-27T23:10:00Z", NOW)).toBe("실시간 아님 · 마지막 저장 09-27 23:10 UTC");
    expect(notLiveText(null, NOW)).toBe("실시간 아님 · 마지막 저장 —");
  });

  it("card rows show both times with the elapsed time; a ship without a live state says it is not live", () => {
    const detail = parseShipDetail("431011305", { state: null, static: { name: "SYN BRAVO", ship_type: 70 }, first_recorded_at: "2026-09-20T01:02:03Z", last_position_at: "2026-09-28T01:00:00Z", meta: {} });
    const html = renderToStaticMarkup(createElement(ShipCardView, { mmsi: "431011305", detail, error: null, now: NOW }));
    const t = text(html);
    expect(t).toContain("처음 기록09-20 01:02:03Z");
    expect(t).toContain("마지막 저장 위치09-28 01:00:00Z (2h 00m 전)");
    expect(html).toContain('data-testid="ship-not-live"');
    expect(t).toContain("실시간 아님 · 마지막 저장 01:00 UTC");
    const none = renderToStaticMarkup(createElement(ShipCardView, { mmsi: "431011305", detail: parseShipDetail("431011305", { state: null, static: null }), error: null, now: NOW }));
    expect(text(none)).toContain("처음 기록—");
    expect(text(none)).toContain("마지막 저장 위치—");
    // 실시간 상태가 있으면 "실시간 아님" 이 아니다
    setData({ shipSelected: { mmsi: "431011305", received_at: 0, static: null, state: { mmsi: "431011305", lat: 35, lon: 129, sog_kn: 1, cog_deg: null, heading_deg: null, ship_type: 70, name: "SYN BRAVO", seen_at: "2026-09-28T02:59:00Z", position_source: null, nav_status: null, rot: null, provider: "fixture", msg_type: null, class: "A" } } });
    expect(renderToStaticMarkup(createElement(ShipCardView, { mmsi: "431011305", detail, error: null, now: NOW }))).not.toContain("ship-not-live");
  });
});

// ---------------------------------------------------------------- §B3 정렬 가능한 선박 표(목록 · 검색 결과)

describe("sortable ship table (contract v5 §B3)", () => {
  const NOW = Date.parse("2026-09-28T03:00:00Z");
  const row = (mmsi: string, over: Partial<ShipRow> = {}): ShipRow => ({
    mmsi, name: null, category: "unknown", sog_kn: null, nav_status: null, live: true, seen_at: null, last_position_at: null, ...over,
  });
  const rows = [
    row("300000003", { name: "CHARLIE", category: "tanker", sog_kn: 14, nav_status: 0, seen_at: "2026-09-28T02:59:00Z" }),
    row("300000001", { name: "ALPHA", category: "fishing", sog_kn: 3.2, nav_status: 7, seen_at: "2026-09-28T02:50:00Z" }),
    row("300000002", { category: "cargo", sog_kn: null, nav_status: null, seen_at: null }),
    row("300000004", { name: "bravo", category: "cargo", live: false, last_position_at: "2026-09-28T01:00:00Z" }),
  ];
  const order = (key: ShipSortKey, dir: "asc" | "desc") => sortShipRows(rows, { key, dir }, NOW).map((r) => r.mmsi.slice(-1)).join("");

  it("sorts by each column; unknown values always last; ties by MMSI", () => {
    expect(order("name", "asc")).toBe("1432"); // ALPHA, bravo, CHARLIE, 이름 없음
    expect(order("name", "desc")).toBe("3412");
    expect(order("mmsi", "asc")).toBe("1234");
    expect(order("cat", "asc")).toBe("2431"); // cargo(2, 4) · tanker · fishing — SHIP_CATEGORIES 순서
    expect(order("sog", "desc")).toBe("3124"); // 속력 모름은 방향과 상관없이 끝
    expect(order("sog", "asc")).toBe("1324");
    expect(order("nav", "asc")).toBe("3124");
    expect(order("age", "asc")).toBe("3142"); // 실시간 아님은 마지막 저장 시각으로 경과, 모름은 끝
    expect(order("age", "desc")).toBe("4132");
  });

  it("renders the columns with their units and the sort state; not-live rows say so", () => {
    const html = renderToStaticMarkup(createElement(ShipTable, { rows, now: NOW, sort: { key: "sog", dir: "desc" }, onSort: () => {}, onPick: () => {}, testId: "ship-list" }));
    expect(html).toMatch(/<th[^>]*aria-sort="descending"[^>]*>.*?속력/);
    for (const h of ["선종", "선명", "MMSI", "속력", "항해 상태", "경과"]) expect(text(html)).toContain(h);
    expect(html.match(/data-testid="ship-list-item"/g)).toHaveLength(4);
    const r3 = /data-mmsi="300000003".*?<\/tr>/.exec(html)![0];
    expect(r3).toContain(`background:${SHIP_CATEGORY_COLOR.tanker}`);
    expect(text(r3)).toContain("CHARLIE");
    expect(text(r3)).toContain("14.0 kn25.9 km/h");
    expect(r3).toContain('title="기관 사용 항해 중 (0)"');
    expect(text(r3)).toContain("1m 00s");
    const r4 = /data-mmsi="300000004".*?<\/tr>/.exec(html)![0];
    expect(text(r4)).toContain("실시간 아님");
    expect(text(r4)).toContain("저장 01:00 UTC");
    const r2 = /data-mmsi="300000002".*?<\/tr>/.exec(html)![0];
    expect(text(r2)).toContain("—");
  });

  it("the in-view ship list is this table", () => {
    resetData();
    shipStates.set("300000001", { mmsi: "300000001", lat: 35, lon: 129, sog_kn: 3.2, cog_deg: null, heading_deg: null, ship_type: 30, name: "ALPHA", seen_at: "2026-09-28T02:50:00Z", position_source: null, nav_status: 7 });
    setData({ ships: { mode: "points", version: 1, count: 1, total: 1, ts: null, cell_deg: null, capped: false, grid: [] } });
    const html = renderToStaticMarkup(createElement(ShipPanelView, { selected: null, shipsOn: true }));
    expect(html).toContain("<table");
    expect(html).toMatch(/data-testid="ship-list-item"[^>]*data-mmsi="300000001"|data-mmsi="300000001"[^>]*data-testid="ship-list-item"/);
    expect(text(html)).toContain("3.2 kn5.9 km/h");
    expect(text(html)).toContain("어로 중 (7)");
    resetData();
  });
});
