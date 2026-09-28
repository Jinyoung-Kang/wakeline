/**
 * MapView 의 계약 v5 §B3 선박 기능(실제 react-dom 마운트 — 최소 DOM + MapLibre 대역):
 * 선종 필터(점 모드 MapLibre filter · 격자 칸 다시 세기) · 선택 선박 고리+라벨(격자 모드 포함) · 항적 기간(6/12/24 h) · 항적 점(호버 툴팁 자료).
 * MMSI·선명은 합성(SYNTHETIC) 값이다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { FakeMap } from "./helpers/fake-maplibre";
import { resetData, setData, shipStates } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { parseGridCells, SHIP_CATEGORIES, type ShipCategory, type ShipLite } from "@/lib/ships";
import { SHIP_SYMBOL_TEXT_EXPR } from "@/lib/ship-layers";

const rec = vi.hoisted(() => ({ api: [] as string[], responses: new Map<string, unknown>(), failures: new Map<string, unknown>(), selectShip: [] as (string | null)[] }));

vi.mock("@/lib/maplibre", async (orig) => {
  const fake = (await import("./helpers/fake-maplibre")).fakeMaplibreModule;
  return { ...(await orig<typeof import("@/lib/maplibre")>()), maplibre: () => fake, loadMaplibre: async () => fake };
});
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  apiGet: (p: string) => {
    rec.api.push(p);
    for (const [prefix, err] of rec.failures) if (p.startsWith(prefix)) return Promise.reject(err);
    for (const [prefix, body] of rec.responses) if (p.startsWith(prefix)) return Promise.resolve(body);
    return new Promise(() => {});
  },
}));
vi.mock("@/lib/ws", () => ({
  WakelineWsClient: class {
    connect() {}
    subscribe() {}
    close() {}
    pause() {}
    resume() {}
    select() {}
    selectShip(m: string | null) { rec.selectShip.push(m); }
    setLayers() {}
  },
}));

class FakeWorker { onmessage: ((ev: unknown) => void) | null = null; postMessage() {} terminate() {} }

const dom = installMiniDom();
(globalThis as Record<string, unknown>).Worker = FakeWorker;
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let MapView: typeof import("@/components/MapView").MapView;
const initialUi = useUi.getState();

beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ MapView } = await import("@/components/MapView"));
});
afterAll(() => { dom.restore(); delete (globalThis as Record<string, unknown>).Worker; });

let root: Root | null = null;
async function mountLoaded() {
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(React.createElement(MapView)); });
  const map = FakeMap.instances[FakeMap.instances.length - 1];
  await React.act(async () => { map.fire("style.load"); map.fire("load"); });
  return map;
}
async function act(fn: () => void) { await React.act(async () => { fn(); }); }
const counts = (o: Partial<Record<ShipCategory, number>>) => SHIP_CATEGORIES.map((c) => o[c] ?? 0);
const lite = (mmsi: string, over: Partial<ShipLite> = {}): ShipLite => ({
  mmsi, lat: 35, lon: 129, sog_kn: 10, cog_deg: 90, heading_deg: 91, ship_type: 70, name: `SYN ${mmsi.slice(-3)}`, seen_at: "2026-09-28T02:59:00Z", position_source: null, nav_status: 0, ...over,
});
type FC = { features: { properties: Record<string, unknown>; geometry: { coordinates: unknown } }[] };
const fc = (map: FakeMap, id: string) => map.getSource(id)!.data as FC;

beforeEach(() => {
  rec.api.length = 0; rec.responses.clear(); rec.failures.clear(); rec.selectShip.length = 0; FakeMap.instances.length = 0; resetData();
  useUi.setState(initialUi, true);
  useUi.setState({ layers: { ...initialUi.layers, ships: true } });
});
afterEach(async () => { if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); } });

describe("category filter on the map (contract v5 §B3)", () => {
  it("points mode: the ship symbol layer gets a category filter; all on → no filter", async () => {
    const map = await mountLoaded();
    shipStates.set("100000001", lite("100000001"));
    await act(() => setData({ ships: { mode: "points", version: 1, count: 1, total: 1, ts: null, cell_deg: null, capped: false, grid: [] } }));
    expect(map.filters.get("ship-symbol") ?? null).toBeNull();
    await act(() => useUi.getState().toggleShipCat("cargo"));
    expect(map.filters.get("ship-symbol")).toEqual(["in", ["coalesce", ["get", "cat"], "unknown"], ["literal", SHIP_CATEGORIES.filter((c) => c !== "cargo")]]);
    await act(() => useUi.getState().toggleShipCat("cargo"));
    expect(map.filters.get("ship-symbol")).toBeNull();
  });

  it("grid mode: cells are recounted from the per-category counts and cells at 0 are not drawn", async () => {
    const map = await mountLoaded();
    const grid = parseGridCells([[35.25, 129.25, 5, "cargo", counts({ cargo: 3, tanker: 2 })], [34.75, 128.75, 2, "cargo", counts({ cargo: 2 })]]);
    await act(() => setData({ ships: { mode: "grid", version: 1, count: 2, total: 7, ts: null, cell_deg: 0.5, capped: false, grid } }));
    expect(fc(map, "ship-grid").features.map((f) => f.properties.count)).toEqual([5, 2]);
    await act(() => useUi.getState().toggleShipCat("cargo"));
    expect(fc(map, "ship-grid").features.map((f) => [f.properties.count, f.properties.cat, f.properties.all])).toEqual([[2, "tanker", 5]]);
  });
});

describe("selected ship is always drawn with a ring and a label (contract v5 §B3)", () => {
  const selState = (mmsi: string, over: Partial<ShipLite> = {}) => ({ ...lite(mmsi, over), rot: null, provider: "fixture", msg_type: "PositionReport", class: "A" as const });

  it("layers: ring + icon + label above the ship symbols, label not tied to zoom, toggled with the ships layer", async () => {
    const map = await mountLoaded();
    for (const id of ["ship-selected-ring", "ship-selected-icon", "ship-selected-label"]) expect(map.getLayer(id)).toBeDefined();
    expect(map.getLayer("ship-selected-label")!.layout["text-field"]).toEqual(["get", "label"]);
    expect(map.getLayer("ship-selected-label")!.layout["text-allow-overlap"]).toBe(true);
    expect(map.getLayer("ship-symbol")!.layout["text-field"]).toEqual(SHIP_SYMBOL_TEXT_EXPR); // 선택 선박 이름은 선택 라벨만
    expect(map.getLayer("ship-selected-ring")!.layout.visibility).toBe("visible");
    await act(() => useUi.getState().toggleLayer("ships"));
    expect(map.getLayer("ship-selected-ring")!.layout.visibility).toBe("none");
  });

  it("grid mode: the selected ship is drawn (icon + ring + name) at its latest reported position", async () => {
    const map = await mountLoaded();
    const grid = parseGridCells([[35.25, 129.25, 5, "cargo"]]);
    await act(() => setData({ ships: { mode: "grid", version: 1, count: 1, total: 5, ts: null, cell_deg: 0.5, capped: false, grid } }));
    await act(() => useUi.getState().selectShip("200000001"));
    await act(() => setData({ shipSelected: { mmsi: "200000001", received_at: 0, static: null, state: selState("200000001", { lat: 35.1, lon: 129.2, name: "SYN ALPHA" }) } }));
    const f = fc(map, "ship-selected").features;
    expect(f).toHaveLength(1);
    expect(f[0].geometry.coordinates).toEqual([129.2, 35.1]);
    expect(f[0].properties).toMatchObject({ mmsi: "200000001", label: "SYN ALPHA", icon: true, cat: "cargo", rot_mode: "heading" });
  });

  it("points mode: the symbol layer already draws it — ring and label only, at the symbol's position; hidden by the category filter → icon too", async () => {
    const map = await mountLoaded();
    shipStates.set("200000002", lite("200000002", { name: null, lat: 34, lon: 128 }));
    await act(() => setData({ ships: { mode: "points", version: 1, count: 1, total: 1, ts: null, cell_deg: null, capped: false, grid: [] } }));
    await act(() => useUi.getState().selectShip("200000002"));
    let f = fc(map, "ship-selected").features;
    expect(f[0].properties).toMatchObject({ label: "200000002", icon: false }); // 이름을 모르면 MMSI
    expect(f[0].geometry.coordinates).toEqual([128, 34]);
    await act(() => useUi.getState().toggleShipCat("cargo"));
    f = fc(map, "ship-selected").features;
    expect(f[0].properties.icon).toBe(true);
  });

  it("no known position (not live) → nothing drawn; deselect clears", async () => {
    const map = await mountLoaded();
    await act(() => useUi.getState().selectShip("200000003"));
    await act(() => setData({ shipSelected: { mmsi: "200000003", received_at: 0, static: null, state: null } }));
    expect(fc(map, "ship-selected").features).toHaveLength(0);
    shipStates.set("200000004", lite("200000004"));
    await act(() => setData({ ships: { mode: "points", version: 2, count: 1, total: 1, ts: null, cell_deg: null, capped: false, grid: [] } }));
    await act(() => useUi.getState().selectShip("200000004"));
    expect(fc(map, "ship-selected").features).toHaveLength(1);
    await act(() => useUi.getState().selectShip(null));
    expect(fc(map, "ship-selected").features).toHaveLength(0);
  });
});

describe("selected ship track: period and hover points (contract v5 §B3)", () => {
  const trackCalls = () => rec.api.filter((p) => p.includes("/track?"));
  const windowH = (p: string) => {
    const q = new URLSearchParams(p.split("?")[1]);
    return (Date.parse(q.get("to")!) - Date.parse(q.get("from")!)) / 3600_000;
  };

  it("requests the chosen window (6 h default, then 12 / 24 h) and records it for the card", async () => {
    await mountLoaded();
    await act(() => useUi.getState().selectShip("200000001"));
    expect(trackCalls()).toHaveLength(1);
    expect(windowH(trackCalls()[0])).toBe(6);
    await act(() => useUi.getState().setShipTrackHours(24));
    expect(trackCalls()).toHaveLength(2);
    expect(windowH(trackCalls()[1])).toBe(24);
    const { getData } = await import("@/lib/store");
    expect(getData().shipTrack).toMatchObject({ mmsi: "200000001", hours: 24, loaded: false });
    // 기간만 바꾸면 항적만 다시 받는다 — WS select_ship 을 다시 보내지 않는다
    expect(rec.selectShip.filter((m) => m === "200000001")).toHaveLength(1);
  });

  it("track points become a hoverable point layer (shown with ships + tracks); live observations are added", async () => {
    const T = Date.parse("2026-09-28T02:00:00Z");
    rec.responses.set("/api/v1/ships/200000001/track", {
      type: "Feature", geometry: { type: "MultiLineString", coordinates: [] }, properties: {},
      points: [{ ts: new Date(T).toISOString(), lon: 129, lat: 35, sog_kn: 12.3, nav_status: 0 }, { ts: new Date(T + 60_000).toISOString(), lon: 129.01, lat: 35 }],
      gaps: [],
    });
    const map = await mountLoaded();
    expect(map.getLayer("ship-track-point")).toBeDefined();
    await act(() => useUi.getState().selectShip("200000001"));
    await act(async () => { await Promise.resolve(); });
    expect(fc(map, "ship-track-points").features.map((f) => f.properties.sog)).toEqual([12.3, null]);
    expect(map.getLayer("ship-track-point")!.layout.visibility).toBe("visible");
    const st = { ...lite("200000001", { lat: 35, lon: 129.02, sog_kn: 11, nav_status: 5, seen_at: new Date(T + 120_000).toISOString() }), rot: null, provider: "fixture", msg_type: "PositionReport", class: "A" as const };
    await act(() => setData({ shipSelected: { mmsi: "200000001", received_at: 0, static: null, state: st } }));
    expect(fc(map, "ship-track-points").features.map((f) => [f.properties.sog, f.properties.nav, f.properties.src])).toEqual([[12.3, 0, "rest"], [null, null, "rest"], [11, 5, "live"]]);
    await act(() => useUi.getState().toggleLayer("tracks"));
    expect(map.getLayer("ship-track-point")!.layout.visibility).toBe("none");
  });

  it("v5-G5: a failed track request keeps the server's request id for the card (null when there is none)", async () => {
    const { ApiError } = await import("@/lib/api");
    const { getData } = await import("@/lib/store");
    rec.failures.set("/api/v1/ships/200000001/track", new ApiError(503, "data store temporarily unavailable; retry later", 10, "UNAVAILABLE", "7ac47ac47ac47ac4"));
    rec.failures.set("/api/v1/ships/200000002/track", new TypeError("Failed to fetch"));
    await mountLoaded();
    await act(() => useUi.getState().selectShip("200000001"));
    await act(async () => { await Promise.resolve(); });
    expect(getData().shipTrack).toMatchObject({ mmsi: "200000001", loaded: true, error: "data store temporarily unavailable; retry later", requestId: "7ac47ac47ac47ac4" });
    await act(() => useUi.getState().selectShip("200000002"));
    await act(async () => { await Promise.resolve(); });
    expect(getData().shipTrack).toMatchObject({ mmsi: "200000002", loaded: true, error: "Failed to fetch", requestId: null });
  });
});
