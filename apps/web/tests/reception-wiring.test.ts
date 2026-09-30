/**
 * 관측 수신 범위(ADR-027)의 첫 화면 쪽 배선: 레이어 단추(선박 옆 · 기본 끔 · 이 브라우저에 기억) · 켜면 오른쪽 칸에 조각 자리(받는 동안 진행 표시) ·
 * 범례 절(잰 값 — 구독 범위 아님) · 선박 칩(이 화면에 관측 수신 칸 N개) · 상황판 지도 한 곳(lib/map-ready — MapView 가 알리고 지우기 전에 비운다) ·
 * 준비된 뒤 그리기 · 나중에 붙는 레이어의 툴팁 등록.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { FakeMap } from "./helpers/fake-maplibre";
import { loadLayers, saveLayers } from "@/lib/prefs";
import { resetData, setData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { dashboardMap, layerTip, onReady, registerLayerTip, setDashboardMap } from "@/lib/map-ready";
import { RECEPTION_BINS, RECEPTION_LAYER_LABEL, RECEPTION_LEGEND_NOTE } from "@/lib/reception-meta";
import { SHIPS_ZERO_TEXT } from "@/lib/ships";
import { MapLegendView } from "@/components/MapLegend";
import { LayerPanelView } from "@/components/LayerPanel";
import { MapChipsView } from "@/components/MapChips";

vi.mock("@/lib/maplibre", async (orig) => {
  const fake = (await import("./helpers/fake-maplibre")).fakeMaplibreModule;
  return { ...(await orig<typeof import("@/lib/maplibre")>()), maplibre: () => fake, loadMaplibre: async () => fake };
});
vi.mock("@/lib/api", () => ({ apiGet: () => new Promise(() => {}) }));
vi.mock("@/lib/ws", () => ({
  WakelineWsClient: class {
    connect() {}
    subscribe() {}
    close() {}
    pause() {}
    resume() {}
    select() {}
    selectShip() {}
    setLayers() {}
  },
}));

const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&#x27;/g, "'");
const initial = useUi.getState();

describe("layer button, part slot, legend and chip", () => {
  beforeEach(() => { resetData(); useUi.setState(initial, true); });
  afterEach(() => { resetData(); useUi.setState(initial, true); });

  it("is off by default, sits right after the ships button, and is remembered like the other layers", () => {
    expect(useUi.getState().layers.reception).toBe(false);
    const html = renderToStaticMarkup(createElement(LayerPanelView, { layers: useUi.getState().layers, shipCats: [], legendOpen: false }));
    const ids = [...html.matchAll(/data-testid="layer-(\w+)"/g)].map((m) => m[1]);
    expect(ids.indexOf("reception")).toBe(ids.indexOf("ships") + 1);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="layer-reception"/);
    expect(text(html)).toContain(RECEPTION_LAYER_LABEL);
    expect(html).not.toContain("관측 수신 범위 불러오는 중");
    const m = new Map<string, string>();
    const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    saveLayers({ ...useUi.getState().layers, reception: true }, kv);
    expect(loadLayers(kv)?.reception).toBe(true);
  });

  it("when on, the right column holds the lazily loaded part (its loading text first — the code is not on the first screen)", () => {
    const html = text(renderToStaticMarkup(createElement(LayerPanelView, { layers: { ...useUi.getState().layers, reception: true }, shipCats: [], legendOpen: false })));
    expect(html).toContain("관측 수신 범위");
    expect(html).toContain("불러오는 중");
  });

  it("the legend says it is measured reception, not the subscription area — with the ships scale; only when on", () => {
    const layers = useUi.getState().layers;
    const on = renderToStaticMarkup(createElement(MapLegendView, { id: "l", layers: { ...layers, reception: true }, radarSource: "rainviewer" }));
    expect(on).toContain('data-testid="legend-reception"');
    const t = text(on);
    expect(t).toContain(RECEPTION_LEGEND_NOTE);
    expect(RECEPTION_LEGEND_NOTE).toContain("구독 범위(점선)가 아니다");
    for (const b of RECEPTION_BINS) expect(t).toContain(b.label);
    expect(t).toContain("표시용 선택");
    expect(t).not.toContain("UTC");
    expect(renderToStaticMarkup(createElement(MapLegendView, { id: "l", layers, radarSource: "rainviewer" }))).not.toContain("legend-reception");
    // 선박 레이어의 수신 범위(운영 설정) 설명은 실제로 받은 곳이 이 레이어라고 가리킨다
    const ais = { connected: true, state: "receiving", coverage: [{ s: 18, w: 105, n: 46, e: 150 }] };
    setData({ ais: ais as never });
    const ships = renderToStaticMarkup(createElement(MapLegendView, { id: "l", layers: { ...layers, ships: true }, radarSource: "rainviewer" }));
    expect(ships).toContain(RECEPTION_LAYER_LABEL); // 수신 범위(운영 설정) 줄의 설명(title)
  });

  it("the ships chip carries the observed cells in view once the layer data is loaded", () => {
    setData({
      ships: { mode: "points", version: 1, count: 0, total: 0, ts: null, cell_deg: null, capped: false, grid: [] },
      ais: { connected: true, state: "receiving", coverage: [{ s: 18, w: 105, n: 46, e: 150 }], shards: null } as never,
      viewport: { bbox: [124, 33, 132, 39], zoom: 8 },
      receptionInView: { cells: 4, covered: "full" },
    });
    const chip = renderToStaticMarkup(createElement(MapChipsView, { hex: null, shipsOn: true }));
    expect(text(chip)).toContain(`${SHIPS_ZERO_TEXT} · 이 화면에 관측 수신 칸 4개(최근 24 h)`);
    expect(chip).toMatch(/title="[^"]*이 화면에 관측 수신 칸 4개/);
    setData({ receptionInView: null });
    expect(text(renderToStaticMarkup(createElement(MapChipsView, { hex: null, shipsOn: true })))).not.toContain("관측 수신");
  });
});

describe("the dashboard map handle (lib/map-ready)", () => {
  const dom = installMiniDom();
  class FakeWorker { onmessage = null; postMessage() {} terminate() {} }
  (globalThis as Record<string, unknown>).Worker = FakeWorker;
  let React: typeof import("react");
  let createRoot: typeof import("react-dom/client").createRoot;
  let MapView: typeof import("@/components/MapView").MapView;
  beforeAll(async () => {
    React = await import("react");
    ({ createRoot } = await import("react-dom/client"));
    ({ MapView } = await import("@/components/MapView"));
  });
  afterAll(() => { dom.restore(); delete (globalThis as Record<string, unknown>).Worker; });

  it("MapView announces its map and clears it before removing the map", async () => {
    FakeMap.instances.length = 0;
    const root = createRoot(dom.container as never);
    await React.act(async () => { root.render(createElement(MapView)); });
    const map = FakeMap.instances.at(-1)!;
    expect(dashboardMap()).toBe(map);
    let seenAtRemove: unknown = "unset";
    const remove = map.remove.bind(map);
    map.remove = () => { seenAtRemove = dashboardMap(); remove(); };
    await React.act(async () => { root.unmount(); });
    expect(seenAtRemove).toBeNull();
    expect(dashboardMap()).toBeNull();
  });

  it("onReady runs now on a loaded map, otherwise once after load with the last request per key", () => {
    const map = new FakeMap({});
    const log: string[] = [];
    onReady(map as never, "k", () => log.push("a"));
    onReady(map as never, "k", () => log.push("b"));
    onReady(map as never, "j", () => log.push("c"));
    expect(log).toEqual([]);
    map.addSource("aircraft", {});
    map.fire("load");
    expect(log).toEqual(["b", "c"]);
    onReady(map as never, "k", () => log.push("d"));
    expect(log).toEqual(["b", "c", "d"]);
    expect(map.listenerCount("load")).toBe(0);
  });

  it("layer tips: register, look up, and unregister only your own function", () => {
    const f = () => null;
    const g = () => null;
    const off = registerLayerTip("x-fill", f);
    expect(layerTip("x-fill")).toBe(f);
    const offG = registerLayerTip("x-fill", g);
    off(); // 이미 g 로 바뀌었다 — g 를 지우지 않는다
    expect(layerTip("x-fill")).toBe(g);
    offG();
    expect(layerTip("x-fill")).toBeUndefined();
    setDashboardMap(null);
  });
});
