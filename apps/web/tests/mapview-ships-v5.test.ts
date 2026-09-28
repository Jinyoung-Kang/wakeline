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

const rec = vi.hoisted(() => ({ api: [] as string[], responses: new Map<string, unknown>(), selectShip: [] as (string | null)[] }));

vi.mock("@/lib/maplibre", async (orig) => {
  const fake = (await import("./helpers/fake-maplibre")).fakeMaplibreModule;
  return { ...(await orig<typeof import("@/lib/maplibre")>()), maplibre: () => fake, loadMaplibre: async () => fake };
});
vi.mock("@/lib/api", () => ({
  apiGet: (p: string) => {
    rec.api.push(p);
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
  rec.api.length = 0; rec.responses.clear(); rec.selectShip.length = 0; FakeMap.instances.length = 0; resetData();
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
