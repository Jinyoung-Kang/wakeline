/**
 * 상황판 지도의 포인터 · 그리기 규칙(characterization — MapView 안의 함수를 lib 로 옮기기 전에 지금 동작을 고정한다, web-review §3.3):
 * - 호버 · 클릭이 고르는 레이어(우선순위, 보이는 레이어만)와 레이어마다의 툴팁 · 클릭 동작
 * - 워커 렌더 → 항공기 소스(속성 · 선택 표시), 감시 공항 소스(오래됨 · 같은 내용이면 다시 넣지 않음), SIGMET 소스(만료 제외 · '안에 항공기' · 같으면 다시 넣지 않음)
 * 최소 DOM + MapLibre 대역(tests/helpers/fake-maplibre). 툴팁은 DOM 대신 Tip 값 그대로 받는다(renderTip 대역).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { FakeMap } from "./helpers/fake-maplibre";
import { aircraftStates, getData, resetData, setData, shipStates } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { aircraftTip, airportTip, shipGridTip, shipTip, shipTrackPointTip, sigmetTip } from "@/lib/tooltip";
import { trafficGridTip } from "@/lib/traffic-grid";
import { registerLayerTip } from "@/lib/map-ready";
import { RECEPTION_FILL_LAYER } from "@/lib/reception-meta";
import type { AircraftState, RenderState } from "@/lib/types";
import { selectedShipLabel, selectedShipPos, type ShipLite } from "@/lib/ships";
import { aircraftFeatureCollection, airportLayerFeatures, syncFrames } from "@/lib/maplayers";
import { sigmetLayerData } from "@/lib/sigmet";
import { clickAction, hoverKey, pickByPriority, PICK_LAYERS, tipFor, visiblePickLayers, type TipContext } from "@/lib/map-pointer";

const rec = vi.hoisted(() => ({ tips: [] as unknown[], workers: [] as { onmessage: ((ev: unknown) => void) | null }[] }));

vi.mock("@/lib/maplibre", async (orig) => {
  const fake = (await import("./helpers/fake-maplibre")).fakeMaplibreModule;
  /** 툴팁 내용(Tip)을 적는 팝업 대역 — 나머지는 tests/helpers/fake-maplibre 의 팝업과 같다 */
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
  constructor() { rec.workers.push(this); }
  postMessage() {}
  terminate() {}
}

const dom = installMiniDom();
(globalThis as Record<string, unknown>).Worker = FakeWorker;
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let MapView: typeof import("@/components/MapView").MapView;
const initialUi = useUi.getState();
const NOW = Date.parse("2026-09-28T03:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const AIRPORTS_URL = "/api/v1/airports?watched=true";
const AIRPORTS = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [126.45, 37.46] }, properties: { icao: "RKSI", name: "Incheon", flight_cat: "IFR", obs_time: iso(NOW - 30 * 60_000) } },
    { type: "Feature", geometry: { type: "Point", coordinates: [126.79, 37.56] }, properties: { icao: "RKSS", name: "Gimpo", flight_cat: "VFR", obs_time: iso(NOW - 3 * 3600_000) } },
  ],
};

beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ MapView } = await import("@/components/MapView"));
});
afterAll(() => { dom.restore(); delete (globalThis as Record<string, unknown>).Worker; });

let root: Root | null = null;
const settle = (ms = 40) => React.act(async () => { await new Promise((r) => setTimeout(r, ms)); });
async function act(fn: () => void) { await React.act(async () => { fn(); }); }
type Hit = { layer: { id: string }; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };
const hit = (layer: string, properties: Record<string, unknown>, coordinates: [number, number] = [127, 37]): Hit => ({ layer: { id: layer }, properties, geometry: { type: "Point", coordinates } });
let hits: Hit[] = [];
let asked: string[][] = [];
async function mount() {
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(React.createElement(MapView)); });
  const map = FakeMap.instances[FakeMap.instances.length - 1];
  (map as unknown as { queryRenderedFeatures: (pt: unknown, o: { layers: string[] }) => Hit[] }).queryRenderedFeatures = (_pt, o) => {
    asked.push([...o.layers]);
    return hits.filter((h) => o.layers.includes(h.layer.id));
  };
  await act(() => { map.fire("style.load"); map.fire("load"); });
  await settle();
  return map;
}
const ev = { point: { x: 10, y: 20 }, lngLat: { lng: 127, lat: 37 } };
async function hover(map: FakeMap, ...h: Hit[]) { hits = h; await act(() => map.fire("mousemove", ev)); await settle(); return rec.tips[rec.tips.length - 1]; }
async function click(map: FakeMap, ...h: Hit[]) { hits = h; await act(() => map.fire("click", ev)); }

beforeEach(() => {
  rec.tips.length = 0; rec.workers.length = 0; hits = []; asked = [];
  FakeMap.instances.length = 0; resetData(); useUi.setState(initialUi, true);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.stubGlobal("fetch", (url: string) => (url === AIRPORTS_URL
    ? Promise.resolve(new Response(JSON.stringify(AIRPORTS), { status: 200, headers: { "Content-Type": "application/geo+json" } }))
    : new Promise<Response>(() => {})));
});
afterEach(async () => {
  if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
  vi.useRealTimers(); vi.unstubAllGlobals(); resetData();
});

describe("map pointer: which layer is picked (characterization)", () => {
  it("asks only the pick layers that exist and are visible, in priority order; picks by priority, not by the order MapLibre returns", async () => {
    useUi.setState({ layers: { ...initialUi.layers, ships: true, traffic: true } });
    const map = await mount();
    await click(map, hit("sigmet-fill", { id: "S1" }), hit("aircraft-symbol", { hex: "71c081" }), hit("ship-symbol", { mmsi: "440123456" }));
    expect(asked[0]).toEqual(["aircraft-symbol", "ship-symbol", "ship-selected-icon", "ship-track-point", "ship-grid-circle", "airport-circle", "sigmet-fill", "traffic-grid-fill"]);
    expect(useUi.getState().selectedHex).toBe("71c081");
    await act(() => useUi.setState({ layers: { ...useUi.getState().layers, ships: false, traffic: false, aircraft: false } }));
    asked = [];
    await click(map, hit("sigmet-fill", { id: "S1" }));
    expect(asked[0]).toEqual(["airport-circle", "sigmet-fill"]); // 숨긴 레이어(항공기 · 선박 · 교통량)는 묻지 않는다
    expect(useUi.getState().selectedSigmet).toBe("S1");
  });
});

describe("map click actions (characterization)", () => {
  it("aircraft → select it; ship (valid MMSI) → select the ship; an invalid MMSI does nothing", async () => {
    useUi.setState({ layers: { ...initialUi.layers, ships: true } });
    const map = await mount();
    await click(map, hit("aircraft-symbol", { hex: "71c081" }));
    expect(useUi.getState().selectedHex).toBe("71c081");
    await click(map, hit("ship-symbol", { mmsi: "440123456" }));
    expect(useUi.getState().selectedShip).toBe("440123456");
    await click(map, hit("ship-symbol", { mmsi: "12" }));
    expect([useUi.getState().selectedShip, useUi.getState().selectedHex]).toEqual(["440123456", "71c081"]);
  });
  it("the selected ship's icon or track point keeps the selection; airport and SIGMET open their cards", async () => {
    useUi.setState({ layers: { ...initialUi.layers, ships: true } });
    const map = await mount();
    await act(() => { useUi.getState().select("71c081"); useUi.getState().selectShip("440123456"); });
    await click(map, hit("ship-selected-icon", { mmsi: "440123456" }));
    await click(map, hit("ship-track-point", { ts: NOW }));
    expect([useUi.getState().selectedHex, useUi.getState().selectedShip]).toEqual(["71c081", "440123456"]);
    await click(map, hit("airport-circle", { icao: "RKSI" }));
    expect(useUi.getState().selectedAirport).toBe("RKSI");
    await click(map, hit("sigmet-fill", { id: "S9" }));
    expect(useUi.getState().selectedSigmet).toBe("S9");
  });
  it("a ship grid cell zooms in on it (7 – 12, two steps past the map zoom); empty map and a traffic cell clear the aircraft and ship selection", async () => {
    useUi.setState({ layers: { ...initialUi.layers, ships: true, traffic: true } });
    const map = await mount();
    const eases: unknown[] = [];
    (map as unknown as { easeTo: (o: unknown) => void }).easeTo = (o) => { eases.push(o); };
    await click(map, hit("ship-grid-circle", { count: 12 }, [129.5, 35.1]));
    expect(eases).toEqual([{ center: [129.5, 35.1], zoom: 8, duration: 800, essential: true }]);
    await act(() => { useUi.getState().select("71c081"); useUi.getState().selectShip("440123456"); });
    await click(map, hit("traffic-grid-fill", { g: "c1" }));
    expect([useUi.getState().selectedHex, useUi.getState().selectedShip]).toEqual([null, null]);
    await act(() => { useUi.getState().select("71c081"); useUi.getState().selectShip("440123456"); });
    await click(map);
    expect([useUi.getState().selectedHex, useUi.getState().selectedShip]).toEqual([null, null]);
  });
});

describe("map hover tooltips (characterization)", () => {
  const ST: AircraftState = { hex: "71c081", callsign: "KAL081", lat: 36.5, lon: 127.8, alt_ft: 34000, seen_at: iso(NOW - 5_000), provider: "adsb_fi" };
  const SHIP = { mmsi: "440123456", name: "SYN ALPHA", lat: 35.1, lon: 129.1, sog_kn: 12.3, cog_deg: 90, heading_deg: 91, nav_status: 0, ship_type: 70, seen_at: iso(NOW - 60_000) } as unknown as ShipLite;
  it("aircraft: the render's flags with the full state (the WS selected state for the selected aircraft, else the snapshot copy)", async () => {
    const map = await mount();
    aircraftStates.set("71c081", { ...ST, callsign: "SNAP" });
    const props = { hex: "71c081", callsign: "KAL081", alt_ft: 34000, stale: false, estimated: true, emergency: false, age_unknown: false, on_ground: false, track_deg: 90 };
    expect(await hover(map, hit("aircraft-symbol", props))).toEqual(aircraftTip(props, { ...ST, callsign: "SNAP" }, NOW));
    await act(() => setData({ selected: { hex: "71c081", state: ST, prediction: null, received_at: 0 } }));
    const n = rec.tips.length;
    await hover(map, hit("aircraft-symbol", props));
    expect(rec.tips.length).toBe(n); // 같은 지점이면 1 s 안에는 다시 만들지 않는다(위치만 옮긴다)
    vi.setSystemTime(NOW + 2_000);
    expect(await hover(map, hit("aircraft-symbol", props))).toEqual(aircraftTip(props, ST, NOW + 2_000));
  });
  it("ships: the listed ship; the selected ship's icon prefers the WS selected state; a track point names the selected ship; a grid cell uses the cell size", async () => {
    useUi.setState({ layers: { ...initialUi.layers, ships: true } });
    const map = await mount();
    shipStates.set(SHIP.mmsi, SHIP);
    expect(await hover(map, hit("ship-symbol", { mmsi: SHIP.mmsi }))).toEqual(shipTip(SHIP, NOW));
    const live = { ...SHIP, sog_kn: 3 } as never;
    await act(() => { setData({ shipSelected: { mmsi: SHIP.mmsi, state: live, static: { name: "SYN STATIC" } } as never }); useUi.getState().selectShip(SHIP.mmsi); });
    expect(await hover(map, hit("ship-selected-icon", { mmsi: SHIP.mmsi }))).toEqual(shipTip(live, NOW));
    const pt = { ts: NOW - 60_000, sog: 3, cog: 90, hdg: 91, nav: 0, src: "live" };
    expect(await hover(map, hit("ship-track-point", pt))).toEqual(shipTrackPointTip(pt, "SYN ALPHA"));
    await act(() => setData({ ships: { ...getData().ships, cell_deg: 0.5 } }));
    expect(await hover(map, hit("ship-grid-circle", { count: 7, all: 7 }))).toEqual(shipGridTip({ count: 7, all: 7 }, 0.5));
    // 선박 사본이 없는 선박 기호에는 툴팁이 없다
    const before = rec.tips.length;
    await hover(map, hit("ship-symbol", { mmsi: "440999999" }));
    expect(rec.tips.length).toBe(before);
  });
  it("track point label: the WS selected name, then its static name, then the listed name, then MMSI", async () => {
    useUi.setState({ layers: { ...initialUi.layers, ships: true } });
    const map = await mount();
    const pt = { ts: NOW, src: "stored" };
    await act(() => { useUi.getState().selectShip("440777777"); });
    expect(await hover(map, hit("ship-track-point", pt))).toEqual(shipTrackPointTip(pt, "MMSI 440777777"));
    shipStates.set("440777777", { ...SHIP, mmsi: "440777777", name: "LISTED" });
    vi.setSystemTime(NOW + 2_000);
    expect(await hover(map, hit("ship-track-point", pt))).toEqual(shipTrackPointTip(pt, "LISTED"));
    await act(() => setData({ shipSelected: { mmsi: "440777777", state: null, static: { name: "STATIC" } } as never }));
    vi.setSystemTime(NOW + 4_000);
    expect(await hover(map, hit("ship-track-point", pt))).toEqual(shipTrackPointTip(pt, "STATIC"));
  });
  it("airport: the watched airport's properties; SIGMET: the store's SIGMET with the drawn 'inside'; traffic cell; a registered layer tip", async () => {
    useUi.setState({ layers: { ...initialUi.layers, traffic: true } });
    const map = await mount();
    expect(await hover(map, hit("airport-circle", { icao: "RKSI" }))).toEqual(airportTip(AIRPORTS.features[0].properties as never, NOW));
    const sg = { id: "S1", hazard: "TS", fir_id: "RKRR", series_id: "A1", valid_from: iso(NOW - 3600_000), valid_to: iso(NOW + 3600_000), base_ft: null, top_ft: 35000, raw_text: "" };
    await act(() => setData({ sigmets: { type: "FeatureCollection", features: [{ type: "Feature", properties: sg, geometry: null }] } as never }));
    expect(await hover(map, hit("sigmet-fill", { id: "S1", inside: true }))).toEqual(sigmetTip({ ...sg, inside: true } as never, NOW));
    expect(await hover(map, hit("traffic-grid-fill", { g: "c1", v: 3 }))).toEqual(trafficGridTip({ g: "c1", v: 3 }, getData().trafficGrid.data));
    map.addLayer({ id: RECEPTION_FILL_LAYER, type: "fill" });
    const off = registerLayerTip(RECEPTION_FILL_LAYER, (p) => ({ title: `cell ${String(p.c)}`, rows: [], flags: [] }));
    expect(await hover(map, hit(RECEPTION_FILL_LAYER, { c: 9 }))).toEqual({ title: "cell 9", rows: [], flags: [] });
    off();
  });
});

describe("map sources drawn from data (characterization)", () => {
  it("worker render → aircraft features (id = hex, the render's flags, selected for the chosen aircraft)", async () => {
    const map = await mount();
    await act(() => useUi.getState().select("bbbbbb"));
    const states: RenderState[] = [
      { hex: "aaaaaa", lat: 36, lon: 127, alt_ft: 1000, track_deg: 10, callsign: "A1", estimated: false, stale: false, age_unknown: false, on_ground: false, emergency: false } as RenderState,
      { hex: "bbbbbb", lat: 35, lon: 128, alt_ft: null, track_deg: null, callsign: null, estimated: true, stale: true, age_unknown: true, on_ground: null, emergency: true } as RenderState,
    ];
    await act(() => rec.workers[0].onmessage!({ data: { type: "render", states } }));
    expect((map.getSource("aircraft")!.data as GeoJSON.FeatureCollection).features).toEqual([
      { type: "Feature", id: "aaaaaa", properties: { hex: "aaaaaa", callsign: "A1", alt_ft: 1000, track_deg: 10, on_ground: false, stale: false, age_unknown: false, estimated: false, emergency: false, selected: false }, geometry: { type: "Point", coordinates: [127, 36] } },
      { type: "Feature", id: "bbbbbb", properties: { hex: "bbbbbb", callsign: null, alt_ft: null, track_deg: null, on_ground: null, stale: true, age_unknown: true, estimated: true, emergency: true, selected: true }, geometry: { type: "Point", coordinates: [128, 35] } },
    ]);
  });
  it("watched airports get a stale flag (METAR older than 2 h); the same content is not set again", async () => {
    const map = await mount();
    const src = map.getSource("airports")!;
    const fs = (src.data as GeoJSON.FeatureCollection).features;
    expect(fs.map((f) => [f.properties!.icao, f.properties!.stale])).toEqual([["RKSI", false], ["RKSS", true]]);
    let sets = 0;
    const orig = src.setData.bind(src);
    src.setData = (d: unknown) => { sets++; return orig(d); };
    await act(() => map.fire("load")); // 다시 그리기 요청 — 같은 내용
    expect(sets).toBe(0);
  });
  it("SIGMETs: expired (or without a polygon) ones are not drawn; 'inside' only for an observed alert of a SIGMET in force; the same result is not set again", async () => {
    const map = await mount();
    const POLY = { type: "MultiPolygon", coordinates: [[[[126, 35], [128, 35], [128, 37], [126, 35]]]] };
    const sg = (id: string, from: number, to: number) => ({ type: "Feature", properties: { id, hazard: "TS", valid_from: iso(from), valid_to: iso(to) }, geometry: POLY });
    const fc = { type: "FeatureCollection", features: [sg("S1", NOW - 3600_000, NOW + 3600_000), sg("S2", NOW - 7200_000, NOW - 60_000), sg("S3", NOW + 600_000, NOW + 7200_000), sg("S4", NOW - 600_000, NOW + 600_000), { ...sg("S5", NOW - 600_000, NOW + 600_000), geometry: null }] };
    const alert = (id: number, sigmet: string, kind: string) => [id, { id, kind, sigmet_id: sigmet, hex: `a${id}` }] as const;
    await act(() => setData({ sigmets: fc as never, alerts: new Map([alert(1, "S1", "OBSERVED"), alert(2, "S3", "OBSERVED"), alert(3, "S4", "PREDICTED")]) as never }));
    await settle();
    const src = map.getSource("sigmets")!;
    const drawn = (src.data as GeoJSON.FeatureCollection).features.map((f) => [f.properties!.id, f.properties!.inside, f.properties!.pending ?? false]);
    expect(drawn).toEqual([["S1", true, false], ["S3", false, true], ["S4", false, false]]);
    let sets = 0;
    const orig = src.setData.bind(src);
    src.setData = (d: unknown) => { sets++; return orig(d); };
    await act(() => setData({ alerts: new Map([alert(1, "S1", "OBSERVED"), alert(2, "S3", "OBSERVED"), alert(3, "S4", "PREDICTED")]) as never }));
    await settle();
    expect(sets).toBe(0);
    await act(() => setData({ alerts: new Map([alert(3, "S4", "OBSERVED")]) as never }));
    await settle();
    expect(sets).toBe(1);
    expect((src.data as GeoJSON.FeatureCollection).features.map((f) => [f.properties!.id, f.properties!.inside])).toEqual([["S1", false], ["S3", false], ["S4", true]]);
  });
});

describe("the moved map data helpers, directly (web-review §3.3)", () => {
  it("aircraftFeatureCollection: one point per render state; selected only for the given hex", () => {
    const st = { hex: "aaaaaa", lat: 1, lon: 2, alt_ft: null, track_deg: null, callsign: null, estimated: false, stale: false, age_unknown: false, on_ground: null, emergency: false } as RenderState;
    expect(aircraftFeatureCollection([st], null).features[0]).toMatchObject({ id: "aaaaaa", properties: { selected: false }, geometry: { coordinates: [2, 1] } });
    expect(aircraftFeatureCollection([st], "aaaaaa").features[0].properties!.selected).toBe(true);
    expect(aircraftFeatureCollection([], "aaaaaa").features).toEqual([]);
  });
  it("airportLayerFeatures: stale per METAR age; the key changes only with what is drawn", () => {
    const f = (obs: string) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [1, 2] }, properties: { icao: "RKSI", flight_cat: "IFR", obs_time: obs } });
    const fresh = airportLayerFeatures([f(iso(NOW - 60_000))], NOW), old = airportLayerFeatures([f(iso(NOW - 60_000))], NOW + 3 * 3600_000);
    expect([fresh.features[0].properties.stale, old.features[0].properties.stale]).toEqual([false, true]);
    expect(fresh.key).not.toBe(old.key);
    expect(airportLayerFeatures([f(iso(NOW - 60_000))], NOW + 1_000).key).toBe(fresh.key);
  });
  it("sigmetLayerData: inside for observed alerts of SIGMETs in force; the key ignores alert ids of SIGMETs not drawn", () => {
    const POLY = { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] };
    const fc = { type: "FeatureCollection", features: [{ type: "Feature", properties: { id: "S1", valid_from: iso(NOW - 1), valid_to: iso(NOW + 1_000) }, geometry: POLY }] } as never;
    const a = sigmetLayerData(fc, [{ kind: "OBSERVED", sigmet_id: "S1" }], NOW);
    expect(a.fc.features[0].properties!.inside).toBe(true);
    expect(sigmetLayerData(fc, [{ kind: "PREDICTED", sigmet_id: "S1" }], NOW).fc.features[0].properties!.inside).toBe(false);
    expect(sigmetLayerData(fc, [{ kind: "OBSERVED", sigmet_id: "S1" }, { kind: "OBSERVED", sigmet_id: "S9" }], NOW).key).toBe(a.key);
  });
  it("selectedShipPos / selectedShipLabel: the WS selected ship (same MMSI) first, then the listed copy", () => {
    const listed = new Map([["440000001", { lat: 1, lon: 2, name: "LISTED" }]]);
    expect(selectedShipPos("440000001", { mmsi: "440000001", state: { lat: 5, lon: 6 } }, listed)).toEqual({ lat: 5, lon: 6 });
    expect(selectedShipPos("440000001", { mmsi: "440000002", state: { lat: 5, lon: 6 } }, listed)).toEqual({ lat: 1, lon: 2 });
    expect(selectedShipPos("440000009", null, listed)).toBeNull();
    expect(selectedShipPos(null, null, listed)).toBeNull();
    expect(selectedShipLabel("440000001", { mmsi: "440000001", state: null, static: { name: "STATIC" } }, listed)).toBe("STATIC");
    expect(selectedShipLabel("440000009", null, listed)).toBe("MMSI 440000009");
    expect(selectedShipLabel(null, null, listed)).toBeNull();
  });
  it("syncFrames: only shown frames get a layer; hidden ones are switched off; frames that left the list are removed", () => {
    const map = new FakeMap({});
    const frame = (id: string) => ({ id, add: (m: unknown) => (m as FakeMap).addLayer({ id, type: "raster", layout: { visibility: "none" } }) });
    let ids = syncFrames(map as never, [], [frame("a"), frame("b")], new Map([[1, "current"]]), 0.7);
    expect([ids, map.layerIds(""), map.getLayer("b")!.paint["raster-opacity"], map.getLayoutProperty("b", "visibility")]).toEqual([["a", "b"], ["b"], 0.7, "visible"]);
    ids = syncFrames(map as never, ids, [frame("b")], new Map([[0, "preload"]]), 0.7);
    expect([ids, map.getLayer("b")!.paint["raster-opacity"]]).toEqual([["b"], 0]);
    syncFrames(map as never, ["b", "gone"], [frame("b")], new Map(), 0.7);
    expect(map.getLayoutProperty("b", "visibility")).toBe("none");
    syncFrames(map as never, ["b"], [], new Map(), 0.7);
    expect(map.layerIds("")).toEqual([]);
  });
});

describe("lib/map-pointer, directly (web-review §3.3)", () => {
  const ctx = (o: Partial<TipContext> = {}): TipContext => ({
    now: NOW, selected: null, aircraft: new Map(), ships: new Map(), shipSelected: null, selectedShip: null, airports: [], sigmets: null, shipsCellDeg: null,
    trafficGrid: null, layerTip: () => undefined, ...o,
  });
  it("visiblePickLayers · pickByPriority", () => {
    const map = new FakeMap({});
    map.addLayer({ id: "sigmet-fill", type: "fill" });
    map.addLayer({ id: "aircraft-symbol", type: "symbol", layout: { visibility: "none" } });
    map.addLayer({ id: "airport-circle", type: "circle" });
    expect(visiblePickLayers(map as never)).toEqual(["airport-circle", "sigmet-fill"]);
    expect(pickByPriority([{ layer: { id: "sigmet-fill" } }, { layer: { id: "airport-circle" } }])).toEqual({ layer: { id: "airport-circle" } });
    expect(pickByPriority([{ layer: { id: "other" } }])).toBeNull();
    expect(PICK_LAYERS[0]).toBe("aircraft-symbol");
  });
  it("hoverKey: layer + the first id-like property, else the point's coordinates", () => {
    expect(hoverKey({ layer: { id: "ship-symbol" }, properties: { mmsi: "440000001", hex: "abc" }, geometry: { type: "Point", coordinates: [1, 2] } })).toBe("ship-symbol:abc");
    expect(hoverKey({ layer: { id: "ship-track-point" }, properties: { ts: 1 }, geometry: { type: "Point", coordinates: [1, 2] } })).toBe("ship-track-point:1,2");
    expect(hoverKey({ layer: { id: "sigmet-fill" }, properties: null, geometry: { type: "Polygon", coordinates: [] } })).toBe("sigmet-fill:");
  });
  it("tipFor: no tip for a ship, airport or SIGMET that is not in the current data; a registered layer tip comes before the SIGMET lookup", () => {
    expect(tipFor("ship-symbol", { mmsi: "440000001" }, ctx())).toBeNull();
    expect(tipFor("ship-selected-icon", { mmsi: "440000001" }, ctx())).toBeNull();
    expect(tipFor("airport-circle", { icao: "RKSI" }, ctx())).toBeNull();
    expect(tipFor("sigmet-fill", { id: "S1" }, ctx())).toBeNull();
    const t = { title: "x", rows: [], flags: [] };
    expect(tipFor("sigmet-fill", { id: "S1" }, ctx({ layerTip: (id) => (id === "sigmet-fill" ? () => t : undefined) }))).toBe(t);
  });
  it("clickAction", () => {
    const f = (id: string, properties: Record<string, unknown> = {}, geometry: GeoJSON.Geometry = { type: "Point", coordinates: [129, 35] }) => ({ layer: { id }, properties, geometry });
    expect(clickAction(f("aircraft-symbol", { hex: "abc" }), 6)).toEqual({ kind: "aircraft", hex: "abc" });
    expect(clickAction(f("ship-symbol", { mmsi: "440000001" }), 6)).toEqual({ kind: "ship", mmsi: "440000001" });
    expect(clickAction(f("ship-symbol", { mmsi: "1" }), 6)).toEqual({ kind: "keep" });
    expect(clickAction(f("ship-track-point"), 6)).toEqual({ kind: "keep" });
    expect([clickAction(f("ship-grid-circle"), 3), clickAction(f("ship-grid-circle"), 6), clickAction(f("ship-grid-circle"), 11)].map((a) => (a.kind === "zoom" ? a.zoom : a.kind)))
      .toEqual([7, 8, 12]);
    expect(clickAction(f("ship-grid-circle", {}, { type: "Polygon", coordinates: [] }), 6)).toEqual({ kind: "clear" });
    expect(clickAction(f("airport-circle", { icao: "RKSI" }), 6)).toEqual({ kind: "airport", icao: "RKSI" });
    expect(clickAction(f("sigmet-fill", { id: "S1" }), 6)).toEqual({ kind: "sigmet", id: "S1" });
    expect(clickAction(f("traffic-grid-fill", { g: "c" }), 6)).toEqual({ kind: "clear" });
    expect(clickAction(null, 6)).toEqual({ kind: "clear" });
  });
});
