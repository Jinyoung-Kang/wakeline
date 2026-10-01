/**
 * 상황판 지도의 연안 교통량 레이어(ADR-023) — 실제 react-dom 으로 MapView 를 마운트(최소 DOM + MapLibre 대역).
 * 기본 끔(조회하지 않는다) → 켜면 /api/v1/traffic/grid 를 조회해 GeoJSON 소스 하나에 칸을 싣고 레이어를 보인다(레이더 자리 아래) →
 * 같은 ETag(304)면 소스를 다시 쓰지 않는다 → 끄면 조회를 멈추고 칸을 비운다. 받아 둔 ok 값이 이 브라우저 시계로 stale_after_s 를 넘기면
 * (조회가 실패해 새 답이 없어도) 칸을 그리지 않는다(검토 지적).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { FakeMap } from "./helpers/fake-maplibre";
import { getData, resetData, setData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { parseTrafficGrid, TRAFFIC_LAYERS, TRAFFIC_POLL_MS, TRAFFIC_SOURCE, TRAFFIC_URL } from "@/lib/traffic-grid";

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

class FakeWorker {
  onmessage: ((ev: unknown) => void) | null = null;
  postMessage() {}
  terminate() {}
}

/** regDt 가 ageS 초 전인 ok 응답(이 브라우저 시계 기준 — 칸을 그릴지는 시계로도 본다) */
function okBody(ageS = 70) {
  const reg = Date.now() - Math.round(ageS * 1000);
  const utc = new Date(reg).toISOString();
  const kst = new Date(reg + 9 * 3600_000).toISOString().replace(/Z$/, "+09:00");
  return {
    available: true, status: "ok", reg_dt_kst: kst, reg_dt_utc: utc, fetched_at: utc, age_s: Math.round(ageS), stale_after_s: 900,
    total: 2, total_count: 2, partial: false, rejected: 0, resolved: 2, unresolved: 0, pending: 0, not_found: 0, off_grid: 0, failed: 0,
    invalid_cells: 0, cell_deg: 0.025, cells: [["GR4_F2K41_C3", 37.45, 126.6, 12, 34], ["GR4_F2K41_D3", 37.425, 126.6, 102, 100]], source: {}, time_zone: "x", meta: { stale: false },
  };
}
const ok200 = () => new Response(JSON.stringify(okBody()), { status: 200, headers: { ETag: '"ta"' } });

const dom = installMiniDom();
(globalThis as Record<string, unknown>).Worker = FakeWorker;
const calls: { url: string; inm: string | undefined }[] = [];
let answer: () => Response = ok200;
const realFetch = globalThis.fetch;
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
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    // 이 시험은 연안 교통량만 본다 — 지도의 다른 조회(기상청 레이더 · 감시 공항 — lib/etag-poller)는 끝나지 않는다(apiGet 대역과 같게)
    if (url !== TRAFFIC_URL) return new Promise<Response>(() => {});
    calls.push({ url, inm: (init?.headers as Record<string, string> | undefined)?.["If-None-Match"] });
    return answer();
  }) as typeof fetch;
});
afterAll(() => { dom.restore(); delete (globalThis as Record<string, unknown>).Worker; globalThis.fetch = realFetch; });

let root: Root | null = null;
async function mount() {
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(React.createElement(MapView)); });
  const map = FakeMap.instances[FakeMap.instances.length - 1];
  await React.act(async () => { map.fire("style.load"); map.fire("load"); });
  return map;
}
const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const source = (map: FakeMap) => map.getSource(TRAFFIC_SOURCE)!.data as GeoJSON.FeatureCollection;

beforeEach(() => { calls.length = 0; FakeMap.instances.length = 0; resetData(); useUi.setState(initialUi, true); });
afterEach(async () => { if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); } });

describe("coastal traffic layer on the dashboard map", () => {
  it("is off by default: layers exist but are hidden and nothing is fetched", async () => {
    const map = await mount();
    await settle();
    expect(calls).toEqual([]);
    for (const id of TRAFFIC_LAYERS) expect(map.getLayer(id)?.layout.visibility).toBe("none");
    expect(map.getLayer(TRAFFIC_LAYERS[0])?.before).toBe("radar-slot"); // 레이더 · SIGMET · 항공기 · 선박 아래
  });

  it("turning it on fetches once, fills one GeoJSON source and shows the layers; a 304 does not rewrite the source; turning it off empties it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const map = await mount();
      await React.act(async () => { useUi.getState().toggleLayer("traffic"); });
      await settle();
      await settle();
      expect(calls.map((c) => c.url)).toEqual([TRAFFIC_URL]);
      expect(getData().trafficGrid.version).toBe(1);
      const fc = source(map);
      expect(fc.features).toHaveLength(2);
      expect(fc.features[0].properties).toEqual({ g: "GR4_F2K41_C3", v: 12, d: 34 });
      for (const id of TRAFFIC_LAYERS) expect(map.getLayer(id)?.layout.visibility).toBe("visible");

      // 다음 조회(90 s)는 If-None-Match 로 — 같은 내용(304)이면 조회 상태만 바뀌고 소스는 다시 쓰지 않는다
      const src = map.getSource(TRAFFIC_SOURCE)!;
      let writes = 0;
      const orig = src.setData.bind(src);
      src.setData = (d: unknown) => { writes++; return orig(d); };
      answer = () => new Response(null, { status: 304 });
      await React.act(async () => { vi.advanceTimersByTime(TRAFFIC_POLL_MS); });
      await settle();
      expect(calls).toHaveLength(2);
      expect(calls[1].inm).toBe('"ta"');
      expect(getData().trafficGrid.version).toBe(1);
      expect(getData().trafficGrid.checkedAt).not.toBeNull();
      expect(writes).toBe(0);

      await React.act(async () => { useUi.getState().toggleLayer("traffic"); });
      await settle();
      expect(source(map).features).toEqual([]);
      for (const id of TRAFFIC_LAYERS) expect(map.getLayer(id)?.layout.visibility).toBe("none");
      await React.act(async () => { vi.advanceTimersByTime(TRAFFIC_POLL_MS * 3); });
      expect(calls).toHaveLength(2); // 끄면 조회하지 않는다
    } finally {
      vi.useRealTimers();
      answer = ok200;
    }
  });

  it("a stale or disabled answer draws no cells", async () => {
    answer = () => new Response(JSON.stringify({ ...okBody(1000), status: "stale", available: false }), { status: 200, headers: { ETag: '"ts"' } });
    const map = await mount();
    await React.act(async () => { useUi.getState().toggleLayer("traffic"); });
    await settle();
    await settle();
    expect(getData().trafficGrid.data?.status).toBe("stale");
    expect(source(map).features).toEqual([]);
    answer = ok200;
  });

  it("a kept ok value that has aged past stale_after_s is not drawn when the layer comes back on and the refresh fails", async () => {
    // 오래전에 받은 ok 값(regDt 20분 전)이 스토어에 남아 있고, 다시 켰을 때 조회가 실패한다 — api 가 '멈춤'이라고 말할 기회가 없다
    setData({ trafficGrid: { data: parseTrafficGrid(okBody(1200)), etag: '"ta"', error: null, version: 3, checkedAt: 1 } });
    answer = () => new Response(null, { status: 503 });
    const map = await mount();
    await React.act(async () => { useUi.getState().toggleLayer("traffic"); });
    await settle();
    await settle();
    expect(calls.map((c) => c.url)).toEqual([TRAFFIC_URL]);
    expect(getData().trafficGrid.error).toBe("HTTP 503");
    expect(source(map).features).toEqual([]);
    answer = ok200;
  });

  it("drawn cells are cleared the moment the value ages past stale_after_s, even with no new answer", async () => {
    answer = () => new Response(JSON.stringify(okBody(899.7)), { status: 200, headers: { ETag: '"tz"' } });
    const map = await mount();
    await React.act(async () => { useUi.getState().toggleLayer("traffic"); });
    await settle();
    await settle();
    expect(source(map).features).toHaveLength(2);
    await React.act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    expect(source(map).features).toEqual([]);
    expect(calls).toHaveLength(1); // 새 조회 없이(90 s 전) — 시계만으로
    answer = ok200;
  });
});
