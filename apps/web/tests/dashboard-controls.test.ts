/**
 * 상황판 조작부 연결 점검(사용자 요청 2026-09-30 "의도한 대로 배치 · 구현 · 작동하는지 확인"): 누름 → UI 상태 → 지도 · 화면.
 * - 레이어 단추 8개: 상태(aria-pressed)와 그 레이어가 가진 지도 층의 visibility 가 함께 바뀐다(레이더는 지금 출처의 프레임 층).
 * - 범례 단추(aria-expanded · aria-controls) · 선종 필터 칩(누르면 범례를 편다).
 * - 오른쪽 패널 탭 5개(aria-pressed · 내용) · 알림 범위 단추(관심 지역 / 전세계 — 수 줄이 무엇을 셌는지 말한다).
 * - 레이더 타임라인: 출처(RainViewer / 기상청 — 쓸 수 없으면 비활성) · 애니메이션 · 슬라이더(멈추고 그 프레임) · LATEST(최신으로) · 범례·정합(열고 닫기).
 * - 모든 조작부의 시험 id 가 시험(단위 또는 e2e)에 나온다 — ⓘ 출처(maplibregl-ctrl-attrib)는 tests/map-attribution.test.ts,
 *   연안 교통량 상태 줄은 tests/traffic-grid.test.ts, 선종 항목은 tests/ships-v5.test.ts 가 이미 다룬다.
 * 수정 전 코드에서 LATEST 단추에 시험 id 가 없어 이 파일이 실패하는 것을 먼저 확인했다(radar-latest 를 붙였다).
 */
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { FakeMap } from "./helpers/fake-maplibre";
import { resetData, setData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { TRAFFIC_LAYERS } from "@/lib/traffic-grid";
import type { KrRadar, PublicStatus } from "@/lib/types";

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
class FakeWorker { onmessage: ((ev: unknown) => void) | null = null; postMessage() {} terminate() {} }

const dom = installMiniDom();
(globalThis as Record<string, unknown>).Worker = FakeWorker;
type R = typeof import("react");
type Root = import("react-dom/client").Root;
let React: R;
let createRoot: typeof import("react-dom/client").createRoot;
const initialUi = useUi.getState();
beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
});
afterAll(() => { dom.restore(); delete (globalThis as Record<string, unknown>).Worker; });

let root: Root | null = null;
beforeEach(() => { FakeMap.instances.length = 0; resetData(); useUi.setState(initialUi, true); });
afterEach(async () => { if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); } vi.unstubAllGlobals(); });

async function mount(...els: React.ReactElement[]) {
  vi.stubGlobal("self", globalThis);
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(React.createElement(React.Fragment, null, ...els)); });
}
const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
const find = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container): MiniElement | null => {
  if (pred(from)) return from;
  for (const c of from.childNodes) { const f = c instanceof MiniElement ? find(pred, c) : null; if (f) return f; }
  return null;
};
const byId = (id: string) => find((e) => e.getAttribute?.("data-testid") === id);
const propsOf = (e: MiniElement): Record<string, (...a: unknown[]) => unknown> => {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  return (e as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[k!];
};
const click = (e: MiniElement | null) => act(() => { propsOf(e!).onClick({ preventDefault() {} }); });

const KR = {
  available: true, latest_tm: "202609281200", georeferenced: true, legend: [[0, [0, 200, 255]]], attribution: "기상청", meta: { fetched_at: new Date().toISOString(), stale: false },
  coordinates: [[120, 40], [135, 40], [135, 30], [120, 30]],
  frames: [{ tm: "202609281150", obs_tm: "202609281150", fetched_at: "x", echo_cells: 10, url: "/k/1.png" }, { tm: "202609281200", obs_tm: "202609281200", fetched_at: "x", echo_cells: 12, url: "/k/2.png" }],
} as unknown as KrRadar;

describe("layer toggles: button → ui state → the map layers that layer owns", () => {
  it("each of the eight buttons flips aria-pressed and the visibility of its map layers (both ways)", async () => {
    const { MapView } = await import("@/components/MapView");
    const { LayerPanel } = await import("@/components/LayerPanel");
    await mount(React.createElement(MapView), React.createElement(LayerPanel));
    const map = FakeMap.instances.at(-1)!;
    await act(() => { map.fire("style.load"); map.fire("load"); });
    await act(() => { useUi.setState({ radarSource: "kma" }); setData({ radarKr: KR }); });
    const owned: Record<string, string[]> = {
      sigmet: ["sigmet-fill", "sigmet-line"], aircraft: ["aircraft-symbol"], airports: ["airport-circle", "airport-label"],
      tracks: ["track-line", "track-gap"], prediction: ["prediction-line", "prediction-label"], traffic: [...TRAFFIC_LAYERS], ships: ["ship-symbol", "ship-grid-circle"],
    };
    const shown = (ids: string[]) => ids.map((id) => map.getLayer(id)?.layout.visibility ?? "missing");
    const radarShown = () => map.layerIds("kmar-").some((id) => map.getLayer(id)!.layout.visibility === "visible");
    for (const k of ["radar", "sigmet", "aircraft", "ships", "airports", "tracks", "prediction", "traffic"] as const) {
      const btn = byId(`layer-${k}`)!;
      expect(btn, k).not.toBeNull();
      const before = useUi.getState().layers[k] === true;
      expect(btn.getAttribute("aria-pressed"), k).toBe(String(before));
      for (const on of [!before, before]) {
        await click(btn);
        expect(useUi.getState().layers[k] === true, k).toBe(on);
        expect(byId(`layer-${k}`)!.getAttribute("aria-pressed"), k).toBe(String(on));
        if (k === "radar") expect(radarShown(), "radar").toBe(on);
        else expect(shown(owned[k]), k).toEqual(owned[k].map(() => (on ? "visible" : "none")));
      }
    }
  });
});

describe("legend toggle and the ship-category chip", () => {
  it("범례 opens and closes the legend (aria-expanded, aria-controls names it only while open); the 선종 필터 chip opens it", async () => {
    const { LayerPanel } = await import("@/components/LayerPanel");
    await mount(React.createElement(LayerPanel));
    await act(() => useUi.getState().setLegendOpen(false));
    const t = () => byId("legend-toggle")!;
    expect([t().getAttribute("aria-expanded"), t().getAttribute("aria-controls"), byId("map-legend")]).toEqual(["false", null, null]);
    await click(t());
    expect([t().getAttribute("aria-expanded"), t().getAttribute("aria-controls")]).toEqual(["true", "map-legend"]);
    expect(byId("map-legend")!.getAttribute("id")).toBe("map-legend");
    await click(t());
    expect(byId("map-legend")).toBeNull();
    await act(() => useUi.setState({ layers: { ...useUi.getState().layers, ships: true } }));
    await click(byId("ship-cat-filter-chip"));
    expect(useUi.getState().legendOpen).toBe(true);
    expect(byId("map-legend")).not.toBeNull();
  });
});

describe("right panel tabs and the alert scope buttons", () => {
  it("each tab shows its content and is the only pressed tab; the alert list stays mounted (hidden) under other tabs", async () => {
    const { SidePanel } = await import("@/components/SidePanel");
    await mount(React.createElement(SidePanel));
    const content: Record<string, () => MiniElement | null> = {
      aircraft: () => find((e) => e.textContent?.startsWith("지도에서 항공기를 클릭하거나") && e.tagName === "DIV"),
      ship: () => byId("ship-panel-off"), sigmet: () => byId("sigmet-list"), airport: () => byId("airport-list"), alerts: () => byId("alert-panel"),
    };
    for (const p of ["aircraft", "ship", "sigmet", "airport", "alerts"] as const) {
      await click(byId(`tab-${p}`));
      expect(useUi.getState().panel).toBe(p);
      for (const q of ["alerts", "aircraft", "ship", "sigmet", "airport"]) expect(byId(`tab-${q}`)!.getAttribute("aria-pressed"), `${p}/${q}`).toBe(String(q === p));
      expect(content[p](), p).not.toBeNull();
      const alertsWrap = byId("alert-panel")!.parentNode as MiniElement;
      expect(alertsWrap.hasAttribute("hidden"), p).toBe(p !== "alerts");
    }
  });
  it("관심 지역 / 전세계: the pressed button and the counts line agree on the scope", async () => {
    const { AlertPanel } = await import("@/components/AlertPanel");
    setData({ conn: "open", lastRxAt: Date.now(), alertsVersion: 1, status: { region: { center: [36.5, 127.8], radius_nm: 250 } } as unknown as PublicStatus });
    await mount(React.createElement(AlertPanel));
    expect(byId("alerts-counts")!.textContent).toContain("관심 지역 · 반경 250 NM");
    await click(byId("alerts-scope-world"));
    expect(byId("alerts-scope-world")!.getAttribute("aria-pressed")).toBe("true");
    expect(byId("alerts-scope-region")!.getAttribute("aria-pressed")).toBe("false");
    expect(byId("alerts-counts")!.textContent).toMatch(/전세계$/);
    await click(byId("alerts-scope-region"));
    expect(byId("alerts-scope-region")!.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("radar timeline controls", () => {
  const RV = { host: "https://tilecache.rainviewer.com", generated: 1, past: [0, 1, 2].map((i) => ({ time: 1_790_000_000 + i * 600, path: `/v2/radar/${i}` })), fetched_at: new Date().toISOString(), provider: "rainviewer" };
  it("source, animation, slider, LATEST and 범례·정합 each change what they say", async () => {
    const { RadarTimeline } = await import("@/components/RadarTimeline");
    setData({ radar: RV as never, radarKr: { ...KR, available: false, frames: [] } as never });
    await mount(React.createElement(RadarTimeline));
    // 기상청을 쓸 수 없으면 단추는 비활성(이유는 title) — 쓸 수 있게 되면 누를 수 있다
    expect(byId("radar-src-kma")!.hasAttribute("disabled")).toBe(true);
    await act(() => setData({ radarKr: KR }));
    expect(byId("radar-src-kma")!.hasAttribute("disabled")).toBe(false);
    await click(byId("radar-src-kma"));
    expect(useUi.getState().radarSource).toBe("kma");
    expect(byId("radar-src-kma")!.getAttribute("aria-pressed")).toBe("true");
    await click(byId("radar-src-rv"));
    expect(useUi.getState().radarSource).toBe("rainviewer");
    // 애니메이션: 켜고 끈다(이름이 바뀐다)
    await click(byId("radar-play"));
    expect(useUi.getState().radarPlaying).toBe(true);
    expect(byId("radar-play")!.getAttribute("aria-label")).toBe("레이더 애니메이션 정지");
    // 슬라이더: 그 프레임에서 멈춘다
    const slider = find((e) => e.getAttribute?.("aria-label") === "레이더 프레임")!;
    await act(() => { propsOf(slider).onChange({ target: { value: "1" } }); });
    expect([useUi.getState().radarFrameIndex, useUi.getState().radarPlaying]).toEqual([1, false]);
    // LATEST: 최신 프레임(null)으로, 애니메이션 멈춤
    await click(byId("radar-play"));
    await click(byId("radar-latest"));
    expect([useUi.getState().radarFrameIndex, useUi.getState().radarPlaying]).toEqual([null, false]);
    // 범례·정합: 열고, 패널의 닫기로 닫는다
    await click(byId("kr-radar-toggle"));
    expect(byId("kr-radar-panel")).not.toBeNull();
    expect(byId("kr-radar-toggle")!.getAttribute("aria-pressed")).toBe("true");
    await click(find((e) => e.tagName === "BUTTON" && e.textContent === "닫기", byId("kr-radar-panel")!));
    expect(byId("kr-radar-panel")).toBeNull();
  });
});

describe("every dashboard control's test id appears in a unit test or an e2e spec", () => {
  it("layer buttons, legend, ship-category chip, radar controls, 범례·정합, tabs, alert scope, 상세, ⓘ attribution", () => {
    const dirs = [new URL("./", import.meta.url), new URL("../e2e/", import.meta.url)];
    // 이 describe 의 목록 자체는 세지 않는다(자기 자신을 가리키지 않게) — 이 파일은 위쪽 동작 시험 부분만
    const self = (t: string) => t.slice(0, t.indexOf('describe("every dashboard control'));
    const corpus = dirs.flatMap((d) => readdirSync(d).filter((f) => /\.ts$/.test(f)).map((f) => {
      const t = readFileSync(new URL(f, d), "utf8");
      return f === "dashboard-controls.test.ts" && d.href.endsWith("/tests/") ? self(t) : t;
    })).join("\n");
    const ids = [
      ...["radar", "sigmet", "aircraft", "ships", "airports", "tracks", "prediction", "traffic"].map((k) => `layer-${k}`),
      "legend-toggle", "ship-cat-filter-chip", "radar-src-rv", "radar-src-kma", "radar-play", "radar-latest", "kr-radar-toggle",
      ...["alerts", "aircraft", "ship", "sigmet", "airport"].map((p) => `tab-${p}`), "alerts-scope-region", "alerts-scope-world",
      "statusbar-details-toggle", "maplibregl-ctrl-attrib",
    ];
    // 시험 id 를 템플릿으로 만드는 곳(`layer-${k}` · `tab-${p}`)은 그 목록 이름으로 찾는다
    const seen = (id: string) => corpus.includes(id) || (/^(layer|tab)-/.test(id) && corpus.includes(`\`${id.split("-")[0]}-\${`) && corpus.includes(`"${id.slice(id.indexOf("-") + 1)}"`));
    expect(ids.filter((id) => !seen(id))).toEqual([]);
  });
});
