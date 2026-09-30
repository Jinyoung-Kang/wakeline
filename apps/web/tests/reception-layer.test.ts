/**
 * 관측 수신 범위 레이어 조각(ADR-027 · components/ReceptionLayer — 레이어를 켤 때 받는다, ADR-026): 실제 react-dom 으로 상태 줄을 마운트하고
 * (최소 DOM) 상황판 지도는 MapLibre 대역을 lib/map-ready 에 알린다.
 * 켜져 있는 동안만 조회 → 소스 하나에 칸을 싣고 레이어를 연안 교통량 아래에 보인다(지도가 아직 load 전이면 load 뒤) → 이 화면의 칸 수를 스토어에(칩 · 0척 알림) →
 * 툴팁을 등록 → 끄면(언마운트) 조회를 멈추고 숨기고 비우고 칸 수 · 툴팁을 지운다. 지도가 먼저 지워졌으면 그 지도를 건드리지 않는다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { FakeMap } from "./helpers/fake-maplibre";
import { getData, resetData, setData } from "@/lib/store";
import { layerTip, setDashboardMap } from "@/lib/map-ready";
import { RECEPTION_LAYERS, RECEPTION_POLL_MS, RECEPTION_SOURCE, RECEPTION_URL } from "@/lib/reception";
import { RECEPTION_FILL_LAYER } from "@/lib/reception-meta";

function body() {
  return {
    cell_deg: 0.5,
    window: { hours: 24, bucket_s: 3600, from: "2026-09-29T09:00:00Z", to: "2026-09-30T09:40:12.345Z" },
    since: "2026-09-29T09:00:00Z", covered: "full", api_started_at: "2026-09-30T09:37:25.500Z", live_from: "2026-09-30T09:37:00Z",
    bootstrap: { state: "done", hours_loaded: 25, hours_total: 25, rows: 1234, loaded_from: "2026-09-29T09:00:00Z", finished_at: "2026-09-30T09:38:10.100Z" },
    generated_at: "2026-09-30T09:40:12.345Z",
    cells: [[139.5, 35.0, 0.5, 12, 40, "2026-09-30T08:59:59Z"], [126.0, 37.0, 0.5, 304, 5120, "2026-09-30T09:40:01Z"]],
    cell_count: 2, positions: 5160, truncated: false, dropped_positions: 0, limits: { max_cells: 16000, max_ship_cells: 200000 },
    sampling: "first_fix_per_60s", note: "x", time_zone: "x", meta: { stale: false },
  };
}

const dom = installMiniDom();
const calls: string[] = [];
const realFetch = globalThis.fetch;
type R = typeof import("react");
type Root = import("react-dom/client").Root;
let React: R;
let createRoot: typeof import("react-dom/client").createRoot;
let ReceptionStatus: typeof import("@/components/ReceptionLayer").ReceptionStatus;

beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ ReceptionStatus } = await import("@/components/ReceptionLayer"));
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body()), { status: 200, headers: { ETag: '"o1"' } });
  }) as typeof fetch;
});
afterAll(() => { dom.restore(); globalThis.fetch = realFetch; });

let root: Root | null = null;
async function mount() {
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(React.createElement(ReceptionStatus)); });
}
async function unmount() {
  if (!root) return;
  const r = root;
  root = null;
  await React.act(async () => { r.unmount(); });
}
const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
/** 기본 레이어가 올라간(load 뒤) 상황판 지도 대역 — 연안 교통량 레이어가 있다 */
function loadedMap() {
  const map = new FakeMap({});
  map.addSource("aircraft", {});
  map.addLayer({ id: "traffic-grid-fill", type: "fill" });
  return map;
}
const features = (map: FakeMap) => (map.getSource(RECEPTION_SOURCE)!.data as GeoJSON.FeatureCollection).features;

beforeEach(() => { calls.length = 0; FakeMap.instances.length = 0; resetData(); setDashboardMap(null); });
afterEach(async () => { await unmount(); setDashboardMap(null); });

describe("observed reception layer part", () => {
  it("fetches while mounted, draws one source under the coastal traffic layer, publishes cells in view, registers the tooltip and shows the status", async () => {
    const map = loadedMap();
    setDashboardMap(map as never);
    setData({ mapBounds: [120, 30, 135, 43] });
    await mount();
    await settle();
    await settle();
    expect(calls).toEqual([RECEPTION_URL]);
    expect(features(map)).toHaveLength(2);
    for (const id of RECEPTION_LAYERS) {
      expect(map.getLayer(id)?.layout.visibility).toBe("visible");
      expect(map.getLayer(id)?.before).toBe("traffic-grid-fill");
    }
    expect(getData().receptionInView).toEqual({ cells: 1, covered: "full", since: "2026-09-29T09:00:00Z", to: "2026-09-30T09:40:12.345Z", stale: false });
    const tip = layerTip(RECEPTION_FILL_LAYER)!({ g: "37,126", s: 304, n: 5120, t: "2026-09-30T09:40:01Z" });
    expect(tip?.title).toBe("관측 수신 칸");
    const text = dom.container.textContent;
    expect(text).toContain("관측 수신 범위(최근 24 h)");
    expect(text).toContain("칸 2개(0.5°) · 이 화면 1개 · 창 09-29 18:00 – 09-30 18:40 KST");
    expect(text).not.toContain("UTC");
    // 화면을 옮기면 이 화면의 칸 수도 바뀐다
    await React.act(async () => { setData({ mapBounds: [100, -50, 179, 60] }); });
    expect(getData().receptionInView).toEqual({ cells: 2, covered: "full", since: "2026-09-29T09:00:00Z", to: "2026-09-30T09:40:12.345Z", stale: false });
  });

  it("before the map's first load the layers wait for load (no draw on a map without base layers)", async () => {
    const map = new FakeMap({});
    setDashboardMap(map as never);
    await mount();
    await settle();
    await settle();
    expect(map.getSource(RECEPTION_SOURCE)).toBeUndefined();
    map.addSource("aircraft", {});
    await React.act(async () => { map.fire("load"); });
    expect(features(map)).toHaveLength(2);
    expect(map.getLayer(RECEPTION_LAYERS[0])?.before).toBe("radar-slot"); // 교통량 레이어가 없으면 레이더 자리 아래
  });

  it("turning it off stops polling, hides and empties the layers, and clears the cells in view and the tooltip", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const map = loadedMap();
      setDashboardMap(map as never);
      setData({ mapBounds: [120, 30, 135, 43] });
      await mount();
      await settle();
      await settle();
      expect(features(map)).toHaveLength(2);
      await unmount();
      for (const id of RECEPTION_LAYERS) expect(map.getLayer(id)?.layout.visibility).toBe("none");
      expect(features(map)).toEqual([]);
      expect(getData().receptionInView).toBeNull();
      expect(layerTip(RECEPTION_FILL_LAYER)).toBeUndefined();
      await React.act(async () => { vi.advanceTimersByTime(RECEPTION_POLL_MS * 3); });
      expect(calls).toHaveLength(1);
      expect(getData().reception?.version).toBe(1); // 받아 둔 값은 남는다(다시 켜면 ETag 로 묻는다)
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not touch a map that was already removed (the dashboard left first)", async () => {
    const map = loadedMap();
    setDashboardMap(map as never);
    await mount();
    await settle();
    await settle();
    let touched = 0;
    map.setLayoutProperty = () => { touched++; };
    setDashboardMap(null);
    await unmount();
    expect(touched).toBe(0);
  });

  /** 리뷰(2026-09-30): 조회가 거듭 실패해도 칩 · 0척 알림이 마지막 값을 '(최근 24 h)' 로 적었다 — 실패를 칩까지 넘긴다. 수정 전 실패. */
  it("a later failed fetch keeps the last cells in view but marks them stale for the chip and the zero notice", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const ok = globalThis.fetch;
    try {
      const map = loadedMap();
      setDashboardMap(map as never);
      setData({ mapBounds: [120, 30, 135, 43] });
      await mount();
      await settle();
      await settle();
      expect(getData().receptionInView).toMatchObject({ cells: 1, stale: false });
      globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
      await React.act(async () => { vi.advanceTimersByTime(RECEPTION_POLL_MS); });
      await settle();
      await settle();
      expect(getData().reception?.error).toBe("HTTP 503");
      expect(getData().receptionInView).toEqual({ cells: 1, covered: "full", since: "2026-09-29T09:00:00Z", to: "2026-09-30T09:40:12.345Z", stale: true });
    } finally {
      globalThis.fetch = ok;
      vi.useRealTimers();
    }
  });

  it("an error is shown in words with the last value kept", async () => {
    const map = loadedMap();
    setDashboardMap(map as never);
    setData({ reception: { data: null, etag: null, error: null, version: 0, checkedAt: null } });
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
    try {
      await mount();
      await settle();
      await settle();
      expect(dom.container.textContent).toContain("조회 실패 — HTTP 503");
      expect(getData().receptionInView).toBeNull();
      expect(features(map)).toEqual([]);
    } finally {
      globalThis.fetch = (async (url: string) => { calls.push(url); return new Response(JSON.stringify(body()), { status: 200, headers: { ETag: '"o1"' } }); }) as typeof fetch;
    }
  });
});
