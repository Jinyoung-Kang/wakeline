/**
 * MapView 생명주기(실제 react-dom 으로 마운트 — 최소 DOM + MapLibre 대역). 서버 렌더 시험이 닿지 못하는 useEffect·정리 함수를 실행한다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { FakeMap } from "./helpers/fake-maplibre";
import { getData, resetData, setData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";

const rec = vi.hoisted(() => ({ calls: [] as string[], api: [] as string[] }));

vi.mock("@/lib/maplibre", async (orig) => {
  const fake = (await import("./helpers/fake-maplibre")).fakeMaplibreModule;
  return { ...(await orig<typeof import("@/lib/maplibre")>()), maplibre: () => fake, loadMaplibre: async () => fake };
});
vi.mock("@/lib/api", () => ({ apiGet: (p: string) => { rec.api.push(p); return new Promise(() => {}); } }));
vi.mock("@/lib/ws", () => ({
  WakelineWsClient: class {
    constructor() { rec.calls.push("client:new"); }
    connect() { rec.calls.push("connect"); }
    subscribe() { rec.calls.push("subscribe"); }
    close() { rec.calls.push("close"); }
    pause() {}
    resume() {}
    select() {}
    selectShip() {}
    setLayers() {}
  },
}));

class FakeWorker {
  onmessage: ((ev: unknown) => void) | null = null;
  constructor(public url: string) { rec.calls.push(`worker:new ${url}`); }
  postMessage(m: { type: string }) { rec.calls.push(`worker:${m.type}`); }
  terminate() { rec.calls.push("worker:terminate"); }
}

const dom = installMiniDom();
(globalThis as Record<string, unknown>).Worker = FakeWorker;
type R = typeof import("react");
type Root = import("react-dom/client").Root;
let React: R;
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
async function mount() {
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(React.createElement(MapView)); });
  return FakeMap.instances[FakeMap.instances.length - 1];
}
async function act(fn: () => void) { await React.act(async () => { fn(); }); }

beforeEach(() => { rec.calls.length = 0; rec.api.length = 0; FakeMap.instances.length = 0; resetData(); useUi.setState(initialUi, true); });
afterEach(async () => { if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); } });

describe("MapView lifecycle (R-01: live data does not wait for the external basemap style)", () => {
  it("starts the worker, WS connection, viewport subscription and REST polls before the map style loads", async () => {
    const map = await mount();
    expect(map).toBeDefined();
    expect(map.listenerCount("load")).toBeGreaterThan(0); // 스타일은 아직 오지 않았다(load 없음)
    expect(rec.calls).toContain("connect");
    expect(rec.calls).toContain("worker:start");
    expect(rec.calls).toContain("subscribe");
    expect(rec.api).toContain("/api/v1/radar/kr");
    expect(rec.api).toContain("/api/v1/airports?watched=true");
  });

  it("a failed style request falls back to a local background-only style, says so, and the data layers still get drawn", async () => {
    const map = await mount();
    await act(() => map.fire("error", { type: "error", error: new Error("AJAXError: Failed to fetch (0): https://tiles.openfreemap.org/styles/dark") }));
    expect(map.styleSet).toHaveLength(1);
    const fallback = map.styleSet[0] as { sources: Record<string, unknown>; layers: { type: string }[] };
    expect(Object.keys(fallback.sources)).toEqual([]); // 외부 요청 없음
    expect(fallback.layers.map((l) => l.type)).toEqual(["background"]);
    expect(validateStyleMin(fallback as never).map((e) => e.message)).toEqual([]);
    expect(dom.container.textContent).toContain("배경지도를 불러오지 못함");
    await act(() => { map.fire("style.load"); map.fire("load"); });
    expect(map.getSource("aircraft")).toBeDefined();
    expect(map.getSource("sigmets")).toBeDefined();
  });

  it("tile/source errors after the style loaded do not replace the style", async () => {
    const map = await mount();
    await act(() => { map.fire("style.load"); map.fire("load"); });
    await act(() => map.fire("error", { type: "error", sourceId: "openmaptiles", error: new Error("tile") }));
    await act(() => map.fire("error", { type: "error", error: new Error("sprite") }));
    expect(map.styleSet).toHaveLength(0);
    expect(dom.container.textContent).not.toContain("배경지도를 불러오지 못함");
  });

  it("data that arrives before the style loads is drawn once on load, and deferred draws do not pile up", async () => {
    const map = await mount();
    const before = map.listenerCount("load");
    const fc = (id: string) => ({ type: "FeatureCollection", features: [{ type: "Feature", properties: { id, valid_from: "2026-09-28T00:00:00Z", valid_to: "2099-01-01T00:00:00Z" }, geometry: { type: "Polygon", coordinates: [[[126, 35], [128, 35], [128, 37], [126, 35]]] } }] });
    for (let i = 0; i < 20; i++) await act(() => setData({ sigmets: fc(`S${i}`) as never, alerts: new Map() }));
    expect(map.listenerCount("load")).toBeLessThanOrEqual(before + 1);
    await act(() => { map.fire("style.load"); map.fire("load"); });
    const drawn = map.getSource("sigmets")!.data as { features: { properties: { id: string } }[] };
    expect(drawn.features.map((f) => f.properties.id)).toEqual(["S19"]);
  });

  it("unmount closes the WS client, terminates the worker and removes the map", async () => {
    const map = await mount();
    await React.act(async () => { root!.unmount(); });
    root = null;
    expect(rec.calls).toContain("close");
    expect(rec.calls).toContain("worker:terminate");
    expect(map.removed).toBe(true);
    expect(getData().conn).toBe("closed");
  });
});

describe("MapView KMA radar layers (R-11)", () => {
  const kr = (available: boolean) => ({
    available, latest_tm: "202609281200", georeferenced: true, legend: null, attribution: "기상청", meta: { fetched_at: "2026-09-28T03:00:00Z", stale: false },
    coordinates: available ? [[120, 40], [135, 40], [135, 30], [120, 30]] as [number, number][] : null,
    frames: available ? [{ tm: "202609281150", obs_tm: "202609281150", fetched_at: "x", echo_cells: 10, url: "/api/v1/radar/kr/202609281150.png" }, { tm: "202609281200", obs_tm: "202609281200", fetched_at: "x", echo_cells: 12, url: "/api/v1/radar/kr/202609281200.png" }] : [],
  });

  it("removes the drawn KMA echo when the server reports the radar unavailable (no stale echo left on the map)", async () => {
    const map = await mount();
    await act(() => { map.fire("style.load"); map.fire("load"); });
    await act(() => useUi.setState({ radarSource: "kma" }));
    await act(() => setData({ radarKr: kr(true) }));
    expect(map.layerIds("kmar-")).toEqual(["kmar-202609281200"]); // 보일 프레임(최신)만 지연 추가
    expect(map.getLayer("kmar-202609281200")!.layout.visibility).toBe("visible");
    await act(() => setData({ radarKr: kr(false) }));
    expect(map.layerIds("kmar-")).toEqual([]);
    expect([...map.sources.keys()].filter((id) => id.startsWith("kmar-"))).toEqual([]);
    // 다시 available 이 되면 다시 그린다
    await act(() => setData({ radarKr: kr(true) }));
    expect(map.layerIds("kmar-")).toEqual(["kmar-202609281200"]);
  });

  it("an unavailable response before anything was drawn is a no-op", async () => {
    const map = await mount();
    await act(() => { map.fire("style.load"); map.fire("load"); });
    await act(() => setData({ radarKr: kr(false) }));
    expect(map.layerIds("kmar-")).toEqual([]);
  });
});
