/**
 * MapView 생명주기(실제 react-dom 으로 마운트 — 최소 DOM + MapLibre 대역). 서버 렌더 시험이 닿지 못하는 useEffect·정리 함수를 실행한다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { FakeMap } from "./helpers/fake-maplibre";
import { getData, resetData, setData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { fmtKstMinute } from "@/lib/time";

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

  it("keeps the visible map bounds (unwrapped, as MapLibre gives them) for the list-selection pan check (R-08)", async () => {
    await mount();
    // FakeMap.getBounds() = 120,30,135,43 — 구독 bbox(WS 대역이 기록)와 별도로, 화면 그대로
    expect(getData().mapBounds).toEqual([120, 30, 135, 43]);
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

  describe("a style host that hangs (packets dropped — no error event for minutes)", () => {
    const STYLE_TIMEOUT_MS = 15_000; // lib/maplayers STYLE_LOAD_TIMEOUT_MS(근거는 그 주석)
    beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
    afterEach(() => { vi.useRealTimers(); });

    it("switches to the local fallback style and says so when style.load has not come by the timeout", async () => {
      expect((await import("@/lib/maplayers")).STYLE_LOAD_TIMEOUT_MS).toBe(STYLE_TIMEOUT_MS);
      const map = await mount();
      await act(() => { vi.advanceTimersByTime(STYLE_TIMEOUT_MS - 1); });
      expect(map.styleSet).toHaveLength(0);
      // 수정 전: 'error' 가 오지 않으면 대체 스타일로 바꾸지 않았다 — 데이터는 오는데 지도 레이어·배너 없이 빈 화면
      await act(() => { vi.advanceTimersByTime(1); });
      expect(map.styleSet).toHaveLength(1);
      expect((map.styleSet[0] as { layers: { id: string }[] }).layers[0].id).toBe("wakeline-no-basemap");
      expect(dom.container.textContent).toContain("배경지도를 불러오지 못함");
      await act(() => { map.fire("style.load"); map.fire("load"); });
      expect(map.getSource("aircraft")).toBeDefined();
    });

    it("a style that answers late after the switch does not flip the map back (no second setStyle, banner stays)", async () => {
      const map = await mount();
      await act(() => { vi.advanceTimersByTime(STYLE_TIMEOUT_MS); });
      expect(map.styleSet).toHaveLength(1);
      // 대체 스타일의 style.load/load, 그리고 혹시 늦게 도착한 원래 스타일의 이벤트·오류
      await act(() => { map.fire("style.load"); map.fire("load"); map.fire("style.load"); });
      await act(() => map.fire("error", { type: "error", error: new Error("AbortError") }));
      await act(() => { vi.advanceTimersByTime(STYLE_TIMEOUT_MS * 4); });
      expect(map.styleSet).toHaveLength(1);
      expect(dom.container.textContent).toContain("배경지도를 불러오지 못함");
    });

    it("a style that loads in time cancels the timer; an error fallback is not repeated by the timer; unmount clears it", async () => {
      const ok = await mount();
      await act(() => { vi.advanceTimersByTime(STYLE_TIMEOUT_MS - 1000); ok.fire("style.load"); ok.fire("load"); });
      await act(() => { vi.advanceTimersByTime(STYLE_TIMEOUT_MS * 2); });
      expect(ok.styleSet).toHaveLength(0);
      expect(dom.container.textContent).not.toContain("배경지도를 불러오지 못함");
      await React.act(async () => { root!.unmount(); });
      root = null;

      const failed = await mount();
      await act(() => failed.fire("error", { type: "error", error: new Error("AJAXError: Failed to fetch (0)") }));
      await act(() => { vi.advanceTimersByTime(STYLE_TIMEOUT_MS * 2); });
      expect(failed.styleSet).toHaveLength(1);
      await React.act(async () => { root!.unmount(); });
      root = null;

      const gone = await mount();
      await React.act(async () => { root!.unmount(); });
      root = null;
      vi.advanceTimersByTime(STYLE_TIMEOUT_MS * 2);
      expect(gone.styleSet).toHaveLength(0); // 떠난 지도에 스타일을 바꾸지 않는다
    });
  });

  it("the fallback banner sits at the top left under the zoom control, clear of the bottom-right credit line (R-01)", async () => {
    const map = await mount();
    await act(() => map.fire("error", { type: "error", error: new Error("AJAXError: Failed to fetch (0)") }));
    const find = (n: MiniElement): MiniElement | null => {
      if (n.getAttribute?.("data-testid") === "basemap-failed") return n;
      for (const c of n.childNodes) { const f = c instanceof MiniElement ? find(c) : null; if (f) return f; }
      return null;
    };
    const cls = find(dom.container)?.getAttribute("class")?.split(/\s+/) ?? [];
    // 수정 전: absolute bottom-10 left-3 — 1440x900 에서 줄바꿈된 출처 표기(AttributionControl, 오른쪽 아래 · 최대 760 px)의 왼쪽을 가렸다
    expect(cls.filter((c) => /^bottom-/.test(c))).toEqual([]);
    // 줌 버튼(위 10 px + 29 px × 2 ≈ 70 px) 아래 · 지도 폭의 절반까지만(오른쪽 위 레이어 버튼·범례와 겹치지 않게 줄바꿈)
    expect(cls).toEqual(expect.arrayContaining(["absolute", "top-20", "left-3", "max-w-[50%]"]));
  });

  it("the map credit is MapLibre's compact attribution (ⓘ) with every data source, added once on load (user request 2026-09-29)", async () => {
    const { CompactAttribution } = await import("@/lib/map-attribution");
    const map = await mount();
    await act(() => { map.fire("style.load"); map.fire("load"); });
    const ctl = map.controls.filter((c) => c instanceof CompactAttribution);
    expect(ctl).toHaveLength(1);
    const inner = (ctl[0] as unknown as { inner: { opts: { compact: boolean; customAttribution: string } } }).inner;
    expect(inner.opts.compact).toBe(true);
    for (const s of ["adsb.lol", "OpenSky Network", "aisstream.io", "AviationWeather.gov", "RainViewer", "기상청 API허브"]) expect(inner.opts.customAttribution).toContain(s);
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

  it("a frame re-downloaded with more radar sites (new ?v= image URL, same tm) replaces its layer — the old partial image is not kept (ADR-021)", async () => {
    const map = await mount();
    await act(() => { map.fire("style.load"); map.fire("load"); });
    await act(() => useUi.setState({ radarSource: "kma" }));
    const at = (v: number, stations: number) => ({
      ...kr(true), frames: [{ tm: "202609281200", obs_tm: "202609281200", fetched_at: "x", echo_cells: 12, url: `/api/v1/radar/kr/202609281200.png?v=${v}`, stations, stations_ref: 15, partial: stations < 15 }],
    });
    await act(() => setData({ radarKr: at(1000, 7) as never }));
    expect(map.layerIds("kmar-")).toEqual(["kmar-202609281200-1000"]);
    expect(map.getSource("kmar-202609281200-1000")?.spec.url).toBe("/api/v1/radar/kr/202609281200.png?v=1000");
    await act(() => setData({ radarKr: at(2000, 15) as never }));
    expect(map.layerIds("kmar-")).toEqual(["kmar-202609281200-2000"]);
    expect(map.getSource("kmar-202609281200-1000")).toBeUndefined();
  });

  it("an unavailable response before anything was drawn is a no-op", async () => {
    const map = await mount();
    await act(() => { map.fire("style.load"); map.fire("load"); });
    await act(() => setData({ radarKr: kr(false) }));
    expect(map.layerIds("kmar-")).toEqual([]);
  });
});

describe("RadarTimeline: KMA chosen but unavailable says why (R-11)", () => {
  /** 타임라인만 마운트(클라이언트 렌더 — 서버 렌더는 zustand 초기 상태를 읽어 radarSource 를 바꿀 수 없다) */
  async function mountTimeline() {
    const { RadarTimeline } = await import("@/components/RadarTimeline");
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(React.createElement(RadarTimeline)); });
  }
  const byTestId = (id: string) => {
    const walk = (n: MiniElement): MiniElement | null => {
      if (n.getAttribute?.("data-testid") === id) return n;
      for (const c of n.childNodes) { const f = c instanceof MiniElement ? walk(c) : null; if (f) return f; }
      return null;
    };
    return walk(dom.container);
  };
  const unavailable = (o: Record<string, unknown> = {}) => ({
    available: false, status: "403", note: "활용신청 필요(API허브에서 레이더합성자료 신청 후 승인 대기)", latest_tm: "202609280130", georeferenced: false, coordinates: null, legend: null,
    frames: [], attribution: "기상청", meta: { fetched_at: "2026-09-28T01:31:00Z", stale: true }, ...o,
  });

  it("with source 'kma' and no usable frames the timeline shows '기상청 레이더 없음' with the server note and the last collection time", async () => {
    useUi.setState({ radarSource: "kma" });
    setData({ radarKr: unavailable() as never });
    await mountTimeline();
    // 수정 전: "—"와 "0 frames · 5 min · 기상청 HSR 500 m…"만 — 이유는 비활성 버튼의 title 에만 있었다
    const why = byTestId("radar-kr-unavailable");
    expect(why?.textContent).toBe("기상청 레이더 없음 — 활용신청 필요(API허브에서 레이더합성자료 신청 후 승인 대기) · 마지막 수집 09-28 10:31:00 KST"); // 01:31:00Z 를 한국 표준시 먼저, UTC 함께
    expect(dom.container.textContent).not.toContain("0 frames · 5 min");
  });

  it("the radar animation button does not reuse the menu word '재생' (R-60: '재생' already means the replay page)", async () => {
    useUi.setState({ radarSource: "rainviewer" });
    setData({ radarKr: null });
    await mountTimeline();
    const btn = byTestId("radar-play");
    expect(btn?.textContent).toBe("애니메이션 ▶");
    expect(btn?.getAttribute("aria-label")).toBe("레이더 애니메이션 재생");
    expect(dom.container.textContent).not.toMatch(/(^|[^이])재생/);
  });

  it("without a note or a collection time nothing is invented; RainViewer and a usable KMA feed keep the frame text", async () => {
    useUi.setState({ radarSource: "kma" });
    setData({ radarKr: unavailable({ note: "", status: null, meta: { fetched_at: null, stale: true } }) as never });
    await mountTimeline();
    expect(byTestId("radar-kr-unavailable")?.textContent).toBe("기상청 레이더 없음");
    await act(() => setData({ radarKr: null }));
    expect(byTestId("radar-kr-unavailable")?.textContent).toBe("기상청 레이더 없음 — 상태 수신 전");
    await act(() => useUi.setState({ radarSource: "rainviewer" }));
    expect(byTestId("radar-kr-unavailable")).toBeNull();
    await act(() => { useUi.setState({ radarSource: "kma" }); setData({ radarKr: { ...unavailable(), available: true, georeferenced: true, frames: [{ tm: "202609280130", obs_tm: "202609280130", fetched_at: "x", echo_cells: 1, url: "/u" }] } as never }); });
    expect(byTestId("radar-kr-unavailable")).toBeNull();
    expect(dom.container.textContent).toContain("1 frames · 5 min");
  });

  // ADR-021: 부분 합성 프레임 — 타임라인이 지금 프레임의 합성 크기를 적고, 부분 합성이면 경고 표시와 문장(툴팁), 프레임 띠에 프레임별 상태
  const krFrames = (until: string) => ({
    ...unavailable(), available: true, georeferenced: true, latest_tm: "202609281210",
    frames: [
      { tm: "202609281200", obs_tm: "202609281200", fetched_at: "x", echo_cells: 1, url: "/a" }, // 옛 항목 — 모름
      { tm: "202609281205", obs_tm: "202609281205", fetched_at: "x", echo_cells: 1, url: "/b", stations: 15, stations_ref: 15, partial: false },
      { tm: "202609281210", obs_tm: "202609281210", fetched_at: "x", echo_cells: 1, url: "/c", stations: 7, stations_ref: 15, partial: true, refetch_until: until },
    ],
  });
  const findAll = (pred: (n: MiniElement) => boolean) => {
    const out: MiniElement[] = [];
    const walk = (n: MiniElement) => { if (pred(n)) out.push(n); for (const c of n.childNodes) if (c instanceof MiniElement) walk(c); };
    walk(dom.container);
    return out;
  };

  /** 기한 표기(분까지 KST — lib/time fmtKstMinute). 지금 시각에 따라 달라 형식기로 만든다(형식은 tests/kst-time 이 본다) */
  const dueOf = (iso: string) => fmtKstMinute(iso);

  it("KMA timeline: the current frame's composite size, a warn marker for a partial frame and a per-frame strip (partial · at reference · no verdict)", async () => {
    useUi.setState({ radarSource: "kma" });
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    setData({ radarKr: krFrames(until) as never });
    await mountTimeline();
    expect(byTestId("kr-frame-composite")?.textContent).toBe("합성 7/15곳"); // 최신(마지막) 프레임
    const mark = byTestId("kr-frame-partial");
    expect(mark?.textContent).toBe("일부 합성");
    expect(mark?.getAttribute("title")).toBe(`일부 지점만 합성(7/15곳) — ${dueOf(until)}까지 다시 받기 대상(지점이 늘면 바꿈)`);
    expect(mark?.getAttribute("title")).toMatch(/— \d\d:\d\d KST까지/); // KST 만(계약 v5 §G20)
    const strip = byTestId("kr-frame-strip");
    expect(strip?.getAttribute("title")).toContain("기준 도달(지난 60분 최대와 같음 — 완전한지는 모름)");
    expect(strip?.getAttribute("title")).not.toContain("= 완전");
    const cells = findAll((n) => n.getAttribute?.("data-kr-frame") != null);
    expect(cells.map((c) => c.getAttribute("data-state"))).toEqual(["unknown", "at_ref", "partial"]);
    expect(cells[0].getAttribute("title")).toBe("12:00 KST · 합성 —"); // 기상청 tm(KST) 과 같은 순간의 UTC
    expect(cells[2].getAttribute("title")).toContain("12:10 KST · 합성 7/15곳 · 일부 지점만 합성(7/15곳)");
    // 다른 프레임으로 옮기면 그 프레임의 값: 기준 도달 → 경고 없음, 옛 항목 → "—"
    await act(() => useUi.setState({ krFrameIndex: 1 }));
    expect(byTestId("kr-frame-composite")?.textContent).toBe("합성 15/15곳");
    expect(byTestId("kr-frame-partial")).toBeNull();
    await act(() => useUi.setState({ krFrameIndex: 0 }));
    expect(byTestId("kr-frame-composite")?.textContent).toBe("합성 —");
  });

  it("KMA timeline: after the collector's refetch deadline the partial frame says only that the deadline passed (refetches unknown)", async () => {
    useUi.setState({ radarSource: "kma" });
    const until = new Date(Date.now() - 60_000).toISOString();
    setData({ radarKr: krFrames(until) as never });
    await mountTimeline();
    expect(byTestId("kr-frame-partial")?.getAttribute("title")).toBe(`일부 지점만 합성(7/15곳) — 다시 받기 기한 ${dueOf(until)} 지남`);
  });
});
