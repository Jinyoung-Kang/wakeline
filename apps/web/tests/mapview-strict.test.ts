/**
 * MapView 를 StrictMode 로 마운트했을 때(next dev — next.config reactStrictMode: true — 와 cacheComponents 의 Activity 처럼 효과가 마운트 → 정리 → 마운트)
 * 살아남는 것은 두 번째 지도 하나와 그 지도의 것뿐이어야 한다(characterization — MapView 를 Hook 여섯 묶음으로 나누기 전에 지금 동작을 고정한다,
 * web-review §3.2 · §3.4 21–24). 묶음마다:
 * - 지도 수명: 첫 지도는 지워지고 다시 꾸미지 않는다 · 상황판 지도 손잡이 · 기본 레이어 · 출처 표기 · onFirstLoad 는 두 번째 지도의 것 · 대체 스타일 시계는 두 번째 지도만
 * - 실시간 피드: 열린 WS 클라이언트 · 워커는 하나씩(연결 · 구독 · 시작) · 그 워커의 렌더가 살아남은 지도에 그린다 · 탭 숨김은 그 하나만 멈춘다 · 뷰포트 구독
 * - 조회: 기상청 레이더 · 감시 공항 조회기는 하나씩 — 답은 살아남은 지도에, 주기마다 요청 하나
 * - 포인터: 호버 · 클릭은 살아남은 지도에 한 번만 달린다
 * - 기상 · 선박 레이어: 스토어에 이미 있던 레이더 프레임 · 커버리지 · 기상청 프레임 · 선박 · 선종 필터 · 연안 교통량이 살아남은 지도에 그려진다
 * - 선택 항적: 고른 항공기 · 선박의 항적을 받아 살아남은 지도에 그리고, 열린 WS 클라이언트에 선택을 알린다
 * SIGMET · AIS 수신 범위는 mapview-lifecycle 의 StrictMode 시험(web-review B8)이 본다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { FakeMap } from "./helpers/fake-maplibre";
import { mounter } from "./helpers/mount";
import { getData, resetData, setData, shipStates } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { dashboardMap } from "@/lib/map-ready";
import { TRAFFIC_POLL_MS, TRAFFIC_URL } from "@/lib/traffic-grid";
import type { RenderState } from "@/lib/types";
import type { ShipLite } from "@/lib/ships";

type Logged = { log: string[] };
const rec = vi.hoisted(() => ({
  clients: [] as Logged[], workers: [] as (Logged & { onmessage: ((ev: unknown) => void) | null })[], tips: [] as unknown[],
  api: [] as string[], replies: {} as Record<string, () => Promise<unknown>>, fetches: [] as string[], fetchReplies: {} as Record<string, () => Response>,
}));

vi.mock("@/lib/maplibre", async (orig) => {
  const fake = (await import("./helpers/fake-maplibre")).fakeMaplibreModule;
  class RecPopup {
    open = false;
    constructor(public opts?: unknown) {}
    setDOMContent(c: unknown) { rec.tips.push(c); return this; }
    setLngLat() { return this; }
    addTo() { this.open = true; return this; }
    isOpen() { return this.open; }
    remove() { this.open = false; return this; }
  }
  const mod = { ...fake, Popup: RecPopup };
  return { ...(await orig<typeof import("@/lib/maplibre")>()), maplibre: () => mod, loadMaplibre: async () => mod };
});
vi.mock("@/lib/tooltip", async (orig) => ({ ...(await orig<typeof import("@/lib/tooltip")>()), renderTip: (tip: unknown) => tip }));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  apiGet: (p: string) => { rec.api.push(p); return rec.replies[p.split("?")[0]]?.() ?? new Promise(() => {}); },
}));
vi.mock("@/lib/ws", () => ({
  WakelineWsClient: class {
    log: string[] = [];
    constructor() { rec.clients.push(this); }
    connect() { this.log.push("connect"); }
    subscribe() { this.log.push("subscribe"); }
    close() { this.log.push("close"); }
    pause() { this.log.push("pause"); }
    resume() { this.log.push("resume"); }
    select(h: string | null) { this.log.push(`select ${h}`); }
    selectShip(m: string | null) { this.log.push(`selectShip ${m}`); }
    setLayers(a: boolean, s: boolean) { this.log.push(`setLayers ${a} ${s}`); }
  },
}));

class FakeWorker {
  onmessage: ((ev: unknown) => void) | null = null;
  log: string[] = [];
  constructor(public url: string) { rec.workers.push(this); }
  postMessage(msg: { type: string }) { this.log.push(msg.type); }
  terminate() { this.log.push("terminate"); }
}

const dom = installMiniDom();
(globalThis as Record<string, unknown>).Worker = FakeWorker;
const m = mounter(dom);
let MapView: typeof import("@/components/MapView").MapView;
const initialUi = useUi.getState();
const NOW = Date.parse("2026-09-29T03:00:00Z");
const KR = "/api/v1/radar/kr";
const AP = "/api/v1/airports?watched=true";

beforeAll(async () => { await m.load(); ({ MapView } = await import("@/components/MapView")); });
afterAll(() => { dom.restore(); delete (globalThis as Record<string, unknown>).Worker; });
beforeEach(() => {
  rec.clients.length = 0; rec.workers.length = 0; rec.tips.length = 0; rec.api.length = 0; rec.replies = {}; rec.fetches.length = 0; rec.fetchReplies = {};
  FakeMap.instances.length = 0; resetData(); useUi.setState(initialUi, true);
  vi.stubGlobal("fetch", (url: string) => { rec.fetches.push(url); const r = rec.fetchReplies[url]; return r ? Promise.resolve(r()) : new Promise<Response>(() => {}); });
});
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); dom.document.hidden = false; });

const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const asked = (url: string) => rec.fetches.filter((u) => u === url).length;
const features = (map: FakeMap, id: string) => (map.getSource(id)?.data as { features: unknown[] } | undefined)?.features ?? [];
const flush = () => m.act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
const openClients = () => rec.clients.filter((c) => !c.log.includes("close"));
const liveWorkers = () => rec.workers.filter((w) => !w.log.includes("terminate"));
/** StrictMode 로 마운트하고 살아남은(두 번째) 지도의 스타일 · load 를 낸다 */
async function mountStrict(props: { onFirstLoad?: () => void } = {}, opts: { load?: boolean } = {}) {
  await m.render(m.React.createElement(MapView, props), { strict: true });
  expect(FakeMap.instances).toHaveLength(2);
  const map = FakeMap.instances[1];
  if (opts.load !== false) await m.act(() => { map.fire("style.load"); map.fire("load"); });
  return map;
}

describe("map lifecycle under StrictMode", () => {
  it("the first map is removed; the dashboard handle, the base layers, the credit control and onFirstLoad belong to the second", async () => {
    const { CompactAttribution } = await import("@/lib/map-attribution");
    let firstLoads = 0;
    const map = await mountStrict({ onFirstLoad: () => { firstLoads++; } }, { load: false });
    const gone = FakeMap.instances[0];
    expect(gone.removed).toBe(true);
    expect(map.removed).toBe(false);
    expect(dashboardMap()).toBe(map);
    await m.act(() => { map.fire("style.load"); map.fire("load"); });
    expect(firstLoads).toBe(1);
    for (const id of ["aircraft", "sigmets", "airports", "tracks", "prediction", "ships", "ship-track", "traffic-grid"]) expect(map.getSource(id), id).toBeDefined();
    expect(map.controls.filter((c) => c instanceof CompactAttribution)).toHaveLength(1);
    expect(gone.sources.size).toBe(0); // 지운 지도에는 아무것도 그리지 않았다
    expect(gone.controls.filter((c) => c instanceof CompactAttribution)).toHaveLength(0);
    await m.unmount();
    expect(map.removed).toBe(true);
    expect(dashboardMap()).toBeNull();
  });

  it("only the surviving map falls back to the local style when its style never comes; leaving clears the notice", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { STYLE_LOAD_TIMEOUT_MS } = await import("@/lib/maplayers");
    const map = await mountStrict({}, { load: false });
    await m.act(() => { vi.advanceTimersByTime(STYLE_LOAD_TIMEOUT_MS); });
    expect(map.styleSet).toHaveLength(1);
    expect(FakeMap.instances[0].styleSet).toHaveLength(0);
    expect(useUi.getState().basemapFailed).toBe(true);
    await m.unmount();
    expect(useUi.getState().basemapFailed).toBe(false);
  });
});

describe("live feed under StrictMode", () => {
  const render = (hex: string): RenderState => ({ hex, lat: 36.5, lon: 127.8, alt_ft: 30000, track_deg: 90, callsign: "SYN1", estimated: false, stale: false, capped: false } as RenderState);

  it("one WS client and one worker stay open — started, connected and subscribed; the live worker's render draws on the surviving map", async () => {
    const map = await mountStrict();
    expect(openClients()).toHaveLength(1);
    expect(openClients()[0].log).toEqual(expect.arrayContaining(["connect", "subscribe"]));
    expect(liveWorkers()).toHaveLength(1);
    expect(liveWorkers()[0].log).toContain("start");
    await m.act(() => liveWorkers()[0].onmessage!({ data: { type: "render", states: [render("abc123")] } }));
    expect(features(map, "aircraft")).toHaveLength(1);
    await m.unmount();
    expect(openClients()).toHaveLength(0);
    expect(liveWorkers()).toHaveLength(0);
    expect(getData().conn).toBe("closed");
  });

  it("a hidden tab pauses the open client and stops the live worker only; showing the tab resumes them", async () => {
    await mountStrict();
    const [client] = openClients();
    const [worker] = liveWorkers();
    dom.document.hidden = true;
    await m.act(() => dom.document.dispatch("visibilitychange"));
    expect(rec.clients.filter((c) => c.log.includes("pause"))).toEqual([client]);
    expect(rec.workers.filter((w) => w.log.includes("stop"))).toEqual([worker]);
    dom.document.hidden = false;
    await m.act(() => dom.document.dispatch("visibilitychange"));
    expect(client.log.at(-1)).toBe("resume");
  });

  it("moving the surviving map re-subscribes the open client once, 300 ms after the last move", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const map = await mountStrict();
    const [client] = openClients();
    const before = client.log.filter((l) => l === "subscribe").length;
    await m.act(() => { map.fire("moveend"); vi.advanceTimersByTime(100); map.fire("moveend"); vi.advanceTimersByTime(299); });
    expect(client.log.filter((l) => l === "subscribe").length).toBe(before);
    await m.act(() => { vi.advanceTimersByTime(1); });
    expect(client.log.filter((l) => l === "subscribe").length).toBe(before + 1);
    expect(rec.clients.filter((c) => c !== client).every((c) => c.log.filter((l) => l === "subscribe").length <= 1)).toBe(true);
  });
});

describe("KR radar and watched-airport polls under StrictMode", () => {
  const FRAME = { tm: "202609291150", obs_tm: "202609291150", fetched_at: "2026-09-29T02:55:00Z", echo_cells: 12, url: "/api/v1/radar/kr/202609291150.png?v=1" };
  const KR_BODY = { available: true, latest_tm: "202609291150", georeferenced: true, coordinates: null, legend: null, frames: [FRAME], attribution: "기상청", meta: { fetched_at: "2026-09-29T02:55:00Z", stale: false } };
  const airport = (icao: string) => ({ type: "Feature", id: icao, geometry: { type: "Point", coordinates: [126.4, 37.4] }, properties: { icao, flight_cat: "VFR", obs_time: "2026-09-29T02:30:00Z" } });

  it("the answers reach the store and the surviving map; then one request per period (one live poller each)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
    rec.fetchReplies[KR] = json(KR_BODY);
    rec.fetchReplies[AP] = json({ type: "FeatureCollection", features: [airport("RKSI"), airport("RKSS")] });
    const map = await mountStrict();
    await flush();
    expect(getData().radarKr?.frames).toEqual([FRAME]);
    expect(features(map, "airports")).toHaveLength(2);
    const kr = asked(KR), ap = asked(AP);
    await m.act(() => { vi.advanceTimersByTime(60_000); });
    await flush();
    expect(asked(KR)).toBe(kr + 1);
    for (let i = 0; i < 4; i++) { // 한 주기씩(답이 오기 전의 다음 주기는 진행 중이라 건너뛴다)
      await m.act(() => { vi.advanceTimersByTime(60_000); });
      await flush();
    }
    expect(asked(KR)).toBe(kr + 5);
    expect(asked(AP)).toBe(ap + 1);
  });
});

describe("pointer under StrictMode", () => {
  type Hit = { layer: { id: string }; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };
  it("hover and click are wired once, on the surviving map", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const map = await mountStrict();
    let hits: Hit[] = [];
    (map as unknown as { queryRenderedFeatures: (pt: unknown, o: { layers: string[] }) => Hit[] }).queryRenderedFeatures = (_pt, o) => hits.filter((h) => o.layers.includes(h.layer.id));
    expect(map.listenerCount("click")).toBe(1);
    expect(map.listenerCount("mousemove")).toBe(1);
    expect(FakeMap.instances[0].listenerCount("click")).toBe(0);
    const ev = { point: { x: 1, y: 2 }, lngLat: { lng: 127, lat: 37 } };
    hits = [{ layer: { id: "aircraft-symbol" }, properties: { hex: "71c081", callsign: "SYN081" }, geometry: { type: "Point", coordinates: [127, 37] } }];
    await m.act(() => map.fire("click", ev));
    expect(useUi.getState().selectedHex).toBe("71c081");
    await m.act(() => map.fire("mousemove", ev));
    await m.settle(40);
    expect(rec.tips).toHaveLength(1);
  });
});

describe("weather and ship layers under StrictMode", () => {
  it("RainViewer frames and their coverage veil, then KMA frames, are drawn on the surviving map", async () => {
    setData({ radar: { host: "https://tilecache.rainviewer.com", generated: 1, past: [{ time: 1727578800, path: "/v2/radar/1727578800" }] } });
    useUi.setState({ radarSource: "rainviewer" });
    const map = await mountStrict();
    expect(map.layerIds("radar-1")).toEqual(["radar-1727578800"]);
    expect(map.getLayer("radar-1727578800")!.layout.visibility).toBe("visible");
    expect(map.getLayer("rv-coverage")!.layout.visibility).toBe("visible");
    await m.act(() => {
      useUi.setState({ radarSource: "kma" });
      setData({ radarKr: { available: true, latest_tm: "202609291150", georeferenced: true, legend: null, attribution: "기상청", meta: { fetched_at: "x", stale: false },
        coordinates: [[120, 40], [135, 40], [135, 30], [120, 30]], frames: [{ tm: "202609291150", obs_tm: "202609291150", fetched_at: "x", echo_cells: 3, url: "/k/1.png" }] } as never });
    });
    expect(map.layerIds("kmar-")).toEqual(["kmar-202609291150"]);
    expect(map.getLayer("rv-coverage")!.layout.visibility).toBe("none");
  });

  it("ships, the category filter and the coastal traffic cells are drawn on the surviving map by one traffic poller", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
    const reg = NOW - 70_000;
    rec.fetchReplies[TRAFFIC_URL] = () => new Response(JSON.stringify({
      available: true, status: "ok", reg_dt_kst: new Date(reg + 9 * 3600_000).toISOString().replace(/Z$/, "+09:00"), reg_dt_utc: new Date(reg).toISOString(), fetched_at: new Date(reg).toISOString(),
      age_s: 70, stale_after_s: 900, total: 2, total_count: 2, partial: false, rejected: 0, resolved: 2, unresolved: 0, pending: 0, not_found: 0, off_grid: 0, failed: 0,
      invalid_cells: 0, cell_deg: 0.025, cells: [["GR4_F2K41_C3", 37.45, 126.6, 12, 34], ["GR4_F2K41_D3", 37.425, 126.6, 102, 100]], source: {}, time_zone: "x", meta: { stale: false },
    }), { status: 200, headers: { ETag: '"ta"' } });
    useUi.setState({ layers: { ...initialUi.layers, ships: true, traffic: true } });
    useUi.getState().toggleShipCat("cargo");
    const lite: ShipLite = { mmsi: "200000001", lat: 35, lon: 129, sog_kn: 10, cog_deg: 90, heading_deg: 91, ship_type: 80, name: "SYN TANKER", seen_at: new Date(NOW - 60_000).toISOString(), position_source: null, nav_status: 0 };
    shipStates.set(lite.mmsi, lite);
    setData({ ships: { mode: "points", version: 1, count: 1, total: 1, ts: null, cell_deg: null, capped: false, grid: [] } });
    const map = await mountStrict();
    await flush();
    expect(features(map, "ships")).toHaveLength(1);
    expect(map.filters.get("ship-symbol")).not.toBeNull();
    expect(features(map, "traffic-grid")).toHaveLength(2);
    const before = asked(TRAFFIC_URL);
    await m.act(() => { vi.advanceTimersByTime(TRAFFIC_POLL_MS); });
    await flush();
    expect(asked(TRAFFIC_URL)).toBe(before + 1);
  });
});

describe("selection tracks under StrictMode", () => {
  it("an aircraft and a ship chosen before the map opened: their tracks are drawn on the surviving map and the open client is told", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    const t = (min: number) => new Date(NOW - min * 60_000).toISOString();
    rec.replies["/api/v1/aircraft/abc123/track"] = async () => ({ points: [{ ts: t(3), lon: 127, lat: 36 }, { ts: t(2), lon: 127.1, lat: 36.1 }] });
    rec.replies["/api/v1/ships/200000001/track"] = async () => ({
      type: "Feature", geometry: { type: "MultiLineString", coordinates: [] }, properties: {},
      points: [{ ts: t(20), lon: 129, lat: 35 }, { ts: t(19), lon: 129.01, lat: 35 }], gaps: [],
    });
    useUi.setState({ selectedHex: "abc123", selectedShip: "200000001", layers: { ...initialUi.layers, ships: true } });
    const map = await mountStrict();
    await flush();
    expect(features(map, "tracks").length).toBeGreaterThan(0);
    expect(features(map, "ship-track").length).toBeGreaterThan(0);
    expect(getData().shipTrack).toMatchObject({ mmsi: "200000001", loaded: true, error: null });
    const [client] = openClients();
    expect(client.log).toEqual(expect.arrayContaining(["select abc123", "selectShip 200000001", "setLayers true true"]));
  });
});
