/**
 * IM-21 — 지도를 그리지 못하는 두 경우가 지도 자리만 바꾼다(상태 바 · 알림 패널 · 레이더 줄 · 재생 조작 줄은 남는다).
 * 1) 지도 컴포넌트 청크나 MapLibre(public 배포본)를 받지 못함: 지도 자리에 까닭 · 청크 확인 · '다시 시도'(조각과 같은 표시 — components/LazyPart),
 *    다시 시도는 실제로 다시 받는다. 전에는 next/dynamic 의 거절이 화면 전체의 오류 경계(app/error.tsx)까지 올라가 상황판 전체가 오류 화면이 되었고,
 *    그 '다시 시도'는 같은 거절된 lazy 를 다시 그려 망이 돌아와도 돌아오지 않았다(loadMaplibre 는 다시 불리지 않았다).
 * 2) WebGL2 를 만들 수 없음(MapLibre 의 Map 생성자가 GPUInitializationError): 지도 자리에 안내와 지도 없는 알림 화면(/m). 다른 예외는 지금처럼 위로 올라간다.
 * 3) 지도와 함께 만드는 실시간 피드(WS · 워커 — components/map/useLiveFeed)는 두 경우 모두 없다.
 *    - 1) 중 MapLibre 만 받지 못함(Q4 b1 — 지도 컴포넌트 청크는 받음): 페이지가 그 청크의 지도 없는 피드(MaplessFeed)를 실패 자리 옆에 둔다 — 2) 와 같은
 *      연결 하나. 다시 시도로 지도가 뜨면 내린다 — 넘겨받기 순서는 [지도 없음 연결, 지도 없음 닫기, 지도 연결](동시에 열린 클라이언트 ≤ 1 · 새 연결 상태를 덮지 않음).
 *      MapLibre 가 지도 청크보다 먼저 실패해도(청크는 아직 받는 중) 같다 — 받는 중을 받지 못함으로 보지 않는다.
 *    - 1) 중 지도 컴포넌트 청크를 받지 못함(Q4 b2 — 피드 코드가 그 청크에 있다): 연결을 시도하지 않는다(R9): 남은 상태 바의 연결 칩과 알림 패널은
 *      '처음 연결하는 중' · '수신 대기 중'이 아니라 실시간 수신을 하지 않는다고 말한다(스토어 conn "off"). 실패 자리를 보이기 전에 그 청크를 다시 받지 않는다
 *      (모듈 받기 시도 1번). 다시 시도로 지도가 뜨면 연결부터 원래대로.
 *    - 2) 에서는 지도 없는 피드(Q4 — components/map/useMaplessFeed)가 워커 없이 연결 하나를 연다: 지도 없는 구독(subscribeWithoutMap)으로 알림 · SIGMET ·
 *      레이더 · 피드 상태만 받고, 상태 바 · 지도 자리 칩은 항공기 · 선박 위치를 받지 않는다고 적는다. 선택해도 select 를 보내지 않는다(집중 추적 안 함 — Q-B).
 *      탭이 숨겨지면 그 연결을 멈추고(pause) 다시 보이면 잇는다(resume) — 지도 피드와 같다.
 *      관심 대상 실행기 조각은 지도 'load' 를 기다리지 않고 곧바로 받는다(Q-C).
 *    가짜 WS 클라이언트의 connect() 는 실제 것처럼 conn "connecting" 을 적고, close() 는 실제 것처럼 마지막으로 연결한 클라이언트일 때만 conn "closed" 를 적는다
 *    (lib/ws connectTurn). 연결 · 닫기 · 멈춤(pause) · 잇기(resume)를 지도 없는 구독인지와 함께 순서대로 적는다(events).
 * - next/dynamic 은 실제 빌드가 쓰는 구현(next/dist/shared/lib/app-dynamic — 모듈을 평가할 때 lazy 를 한 번 만든다)으로 바꿔 시험한다.
 *   vitest 의 기본 해석은 pages 쪽 구현이라 이 동작이 보이지 않는다.
 * - 경계는 Next 의 실제 ErrorBoundaryHandler 에 실제 app/error.tsx 를 붙인다(라우트의 오류 경계와 같은 자리).
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { find, propsOf } from "./helpers/mount";

vi.mock("next/dynamic", async () => ({ default: (await import("next/dist/shared/lib/app-dynamic.js")).default }));

const ctl = vi.hoisted(() => ({
  loadFails: false, mapThrows: null as null | "gpu" | "other", loads: 0, maps: 0, connects: 0,
  workers: 0, subscribes: 0, maplessSubs: 0, selects: 0, closes: 0, pauses: 0, resumes: 0, watchRunners: 0,
  events: [] as string[], open: 0, maxOpen: 0, turn: 0, mapViewLoads: 0,
}));
vi.mock("@/lib/maplibre", async (orig) => {
  const fakeMod = (await import("./helpers/fake-maplibre")).fakeMaplibreModule;
  const Base = fakeMod.Map;
  class MaybeThrowingMap extends Base {
    constructor(o: Record<string, unknown>) {
      if (ctl.mapThrows === "gpu") throw new fakeMod.GPUInitializationError("Failed to initialize WebGL2 context");
      if (ctl.mapThrows === "other") throw new Error("boom in Map constructor");
      super(o);
      ctl.maps++;
    }
  }
  const fake = { ...fakeMod, Map: MaybeThrowingMap };
  return {
    ...(await orig<typeof import("@/lib/maplibre")>()),
    maplibre: () => fake,
    loadMaplibre: async () => {
      ctl.loads++;
      if (ctl.loadFails) throw new TypeError("Failed to fetch dynamically imported module: http://localhost:8700/maplibre/6.11.2/maplibre-gl.mjs");
      return fake;
    },
  };
});
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), apiGet: () => new Promise(() => {}) }));
// connect() 는 실제 클라이언트(lib/ws)처럼 연결 상태를 적는다 — 피드가 시작됐는지를 상태 바 글자로 본다. 스토어는 마운트마다 새 모듈이라(vi.resetModules —
// mock 의 factory 결과는 남는다) 그 마운트의 setData 를 mount() 가 store 에 넣는다
const store = vi.hoisted(() => ({ setData: null as null | ((p: Partial<import("@/lib/store").ServerData>) => void) }));
vi.mock("@/lib/ws", () => ({
  WakelineWsClient: class {
    private noMap = false;
    private on = false;
    private turn = 0;
    private log(what: string) { ctl.events.push(`${this.noMap ? "mapless" : "map"} ${what}`); }
    connect() {
      ctl.connects++;
      if (!this.on) { this.on = true; ctl.open++; ctl.maxOpen = Math.max(ctl.maxOpen, ctl.open); }
      this.turn = ++ctl.turn;
      this.log("connect");
      store.setData?.({ conn: "connecting", reconnectAttempt: 0 });
    }
    subscribe() { ctl.subscribes++; }
    subscribeWithoutMap() { ctl.maplessSubs++; this.noMap = true; }
    close() {
      ctl.closes++;
      if (this.on) { this.on = false; ctl.open--; this.log("close"); }
      if (this.turn === ctl.turn) store.setData?.({ conn: "closed", demand: null });
    }
    select() { ctl.selects++; }
    selectShip() { ctl.selects++; }
    pause() { ctl.pauses++; this.log("pause"); }
    resume() { ctl.resumes++; this.log("resume"); }
    setLayers() {}
  },
}));
// 관심 대상 실행기(ADR-037 — DashboardParts 의 WatchRunnerPart)가 그려졌는가: 조각을 받은 뒤에만 SidePanel 이 그린다
vi.mock("@/components/WatchPanel", async (orig) => ({
  ...(await orig<typeof import("@/components/WatchPanel")>()),
  WatchRunner: () => { ctl.watchRunners++; return null; },
}));
const reports: { message: string; component?: string }[] = [];
vi.mock("@/lib/errorReport", async (orig) => ({
  ...(await orig<typeof import("@/lib/errorReport")>()),
  reportClientError: (input: { message: string; component?: string }) => { reports.push(input); return "sent"; },
}));
class FakeWorker { onmessage = null; constructor() { ctl.workers++; } postMessage() {} terminate() {} }

const dom = installMiniDom();
const g = globalThis as Record<string, unknown>;
g.Worker = FakeWorker;
let React: typeof import("react");
let root: import("react-dom/client").Root | null = null;
afterAll(() => { dom.restore(); delete g.Worker; });
afterEach(async () => {
  if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  reports.length = 0;
  dom.document.hidden = false;
  Object.assign(ctl, { loadFails: false, mapThrows: null, loads: 0, maps: 0, connects: 0, workers: 0, subscribes: 0, maplessSubs: 0, selects: 0, closes: 0, pauses: 0, resumes: 0, watchRunners: 0, events: [], open: 0, maxOpen: 0, turn: 0, mapViewLoads: 0 });
  vi.doUnmock("@/components/MapView");
});

const container = () => dom.container as unknown as MiniElement;
const byId = (id: string) => find((e) => e.getAttribute?.("data-testid") === id, container());
const has = (id: string) => byId(id) != null;
/** 상태 바의 연결 칩(lib/statusbar connChip) · 알림 패널의 '목록을 받기 전' 줄 */
const connText = () => byId("conn")?.textContent ?? null;
const alertsWaitingText = () => byId("alerts-waiting")?.textContent ?? null;
/** 지도가 없어 실시간 피드를 시작하지 않음 — 상태 바 · 알림 패널이 그렇게 말한다(연결 중 · 수신 대기라고 하지 않는다) */
const expectNoLiveFeed = async () => {
  expect(ctl.connects, "no WS client connects without a map").toBe(0);
  expect(connText()).toContain("실시간 수신 안 함");
  expect(connText()).not.toContain("connecting");
  expect(byId("conn")?.getAttribute("title")).toContain("지도를 띄우지 못해");
  expect(byId("conn")?.getAttribute("title")).not.toContain("처음 연결하는 중");
  expect(alertsWaitingText()).toContain("실시간 수신 안 함");
  expect(alertsWaitingText()).not.toContain("수신 대기 중");
  expect((await import("@/lib/store")).getData().conn).toBe("off");
};
const settle = async (n = 15) => { for (let i = 0; i < n; i++) await React.act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

/** 페이지를 새 모듈로(지도 dynamic 은 모듈을 평가할 때 만들어진다) Next 의 라우트 오류 경계 안에 마운트한다 */
async function mount(pagePath: "@/app/page" | "@/app/replay/page", pathname: string) {
  vi.resetModules();
  store.setData = (await import("@/lib/store")).setData;
  React = await import("react");
  const { createRoot } = await import("react-dom/client");
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("location", { origin: "http://localhost:8700", pathname, search: "", hash: "", reload: () => {} });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const de = (dom.document as unknown as { documentElement: Record<string, unknown> }).documentElement;
  de.dataset ??= {};
  const Page = (await import(pagePath)).default as import("react").ComponentType;
  const RouteError = (await import("@/app/error")).default;
  const { ErrorBoundaryHandler } = await import("next/dist/client/components/error-boundary");
  root = createRoot(dom.container as never);
  await React.act(async () => {
    root!.render(React.createElement(ErrorBoundaryHandler as never, { pathname, errorComponent: RouteError } as never, React.createElement(Page)));
  });
  await settle();
}
const click = async (id: string) => {
  const b = byId(id);
  expect(b, id).not.toBeNull();
  await React.act(async () => { propsOf(b!).onClick(); });
  await settle();
};

describe("dashboard '/': a map that cannot be drawn replaces only the map slot", () => {
  it("control: nothing fails — the map is there, no error screen", async () => {
    await mount("@/app/page", "/");
    expect(has("error-screen")).toBe(false);
    expect(has("statusbar")).toBe(true);
    expect(has("map")).toBe(true);
    expect(ctl).toMatchObject({ loads: 1, maps: 1, connects: 1, workers: 1, maplessSubs: 0 });
    expect(connText()).toContain("WS connecting");
    expect(alertsWaitingText()).toContain("알림 목록 수신 대기 중");
  });

  it("MapLibre fails to load once (the map chunk came — Q4 b1): the status bar, alerts panel and radar row stay; the map slot shows the reason and a retry that loads again; a map-less feed opens beside it and hands over to the map's feed", async () => {
    ctl.loadFails = true;
    await mount("@/app/page", "/");
    expect(has("error-screen"), "the whole dashboard was replaced by the route error screen").toBe(false);
    for (const id of ["statusbar", "side-panel-content", "radar-timeline"]) expect(has(id), id).toBe(true);
    const err = byId("lazy-error");
    expect(err?.getAttribute("data-part")).toBe("지도");
    expect(err?.getAttribute("role")).toBe("alert");
    expect(err?.textContent).toContain("지도 — 화면 코드를 받지 못했습니다");
    expect(err?.textContent).toContain("maplibre-gl.mjs");
    expect(ctl).toMatchObject({ loads: 1, maps: 0 }); // 처음 실패를 보일 때는 다시 받지 않는다
    expect(reports.map((r) => r.component)).toEqual(["lazy:지도"]); // 시스템 로그에 한 번(조각과 같은 보고)
    const { getData } = await import("@/lib/store");
    // 받은 지도 청크의 지도 없는 피드: 연결 하나 · 워커 없음 · 지도 없는 구독 — 'off'(실시간 수신 안 함)가 아니다
    expect(ctl).toMatchObject({ connects: 1, workers: 0, maplessSubs: 1, subscribes: 0 });
    expect(ctl.events).toEqual(["mapless connect"]);
    expect(getData()).toMatchObject({ conn: "connecting", mapless: true });
    expect(connText()).toBe("WS connecting · 지도 없음");
    expect(alertsWaitingText()).toContain("알림 목록 수신 대기 중");
    expect(byId("mapless-chip")?.textContent).toBe("지도 없음 — 항공기 · 선박 위치를 받지 않음");
    expect(ctl.watchRunners).toBeGreaterThan(0); // 관심 대상 실행기를 곧바로 받는다(Q-C)

    ctl.loadFails = false; // 망이 돌아왔다
    await click("lazy-retry");
    expect(ctl).toMatchObject({ loads: 2, maps: 1, connects: 2, workers: 1, maplessSubs: 1, subscribes: 1 });
    expect(has("lazy-error")).toBe(false);
    expect(has("map")).toBe(true);
    expect(has("statusbar")).toBe(true);
    // 넘겨받기: 지도 없는 피드를 닫은 뒤에 지도 피드가 연결한다 — 한 탭에 연결은 한 번에 하나(IP 당 상한), 늦은 닫기가 새 연결 상태를 덮지 않는다
    expect(ctl.events).toEqual(["mapless connect", "mapless close", "map connect"]);
    expect(ctl.maxOpen).toBeLessThanOrEqual(1);
    expect(getData()).toMatchObject({ conn: "connecting", mapless: false });
    // 지도가 뜨면 피드가 원래대로(연결 중 · 수신 대기) — 지도 없음 표시는 내린다
    expect(connText()).toContain("WS connecting");
    expect(connText()).not.toContain("지도 없음");
    expect(connText()).not.toContain("실시간 수신 안 함");
    expect(has("mapless-chip")).toBe(false);
    expect(alertsWaitingText()).toContain("알림 목록 수신 대기 중");
  });

  it("the map chunk itself fails to load (Q4 b2): the map slot shows the reason; no feed starts (the feed code is in that chunk) and the status bar says so; retry draws the map and its feed connects", async () => {
    vi.doMock("@/components/MapView", () => { ctl.mapViewLoads++; throw new TypeError("Failed to fetch dynamically imported module: http://localhost:8700/_next/static/chunks/mapview.js"); });
    await mount("@/app/page", "/");
    expect(has("error-screen"), "the whole dashboard was replaced by the route error screen").toBe(false);
    for (const id of ["statusbar", "side-panel-content", "radar-timeline"]) expect(has(id), id).toBe(true);
    expect(byId("lazy-error")?.getAttribute("data-part")).toBe("지도");
    // 받지 못한 지도 청크를 실패 자리를 보이기 전에 또 받지 않는다 — Turbopack 런타임은 받지 못한 청크를 지워 같은 import() 가 처음부터 다시 받는다(내장 재시도 포함)
    expect(ctl.mapViewLoads, "map chunk load attempts before the error slot shows").toBe(1);
    expect(ctl).toMatchObject({ maps: 0, maplessSubs: 0 });
    expect(ctl.events).toEqual([]);
    expect(has("mapless-chip")).toBe(false);
    await expectNoLiveFeed();

    vi.doUnmock("@/components/MapView"); // 망이 돌아왔다
    await click("lazy-retry");
    expect(ctl).toMatchObject({ maps: 1, connects: 1, maplessSubs: 0 });
    expect(ctl.events).toEqual(["map connect"]);
    expect(has("lazy-error")).toBe(false);
    expect(has("map")).toBe(true);
    expect(connText()).toContain("WS connecting");
    expect(connText()).not.toContain("실시간 수신 안 함");
    expect(alertsWaitingText()).toContain("알림 목록 수신 대기 중");
  });

  it("MapLibre fails while the map chunk is still loading (Q4 b1 race): the page does not take that chunk for failed — the map-less feed opens, not 'off'", async () => {
    let arrive!: () => void;
    const gate = new Promise<void>((r) => { arrive = r; });
    // 지도 청크가 MapLibre 의 실패보다 늦게 온다: Promise.all 은 먼저 온 거절로 곧바로 거절하므로 페이지의 catch 가 돌 때 청크는 아직 받는 중이다.
    // 실제 런타임은 받는 중인 청크의 두 번째 import() 에 같은 약속을 돌려주지만, vitest 는 팩토리가 끝나지 않은 모듈의 두 번째 import() 를 기다리지 않고
    // 곧바로 푼다 — 그래서 여기서는 기다림이 아니라 '받는 중'을 '받지 못함'(b2 → 'off')으로 잘못 보지 않는지를 본다
    vi.doMock("@/components/MapView", async (importOriginal) => { await gate; return importOriginal(); });
    ctl.loadFails = true;
    await mount("@/app/page", "/");
    arrive();
    await settle();
    expect(has("error-screen")).toBe(false);
    expect(byId("lazy-error")?.textContent).toContain("maplibre-gl.mjs"); // 까닭은 MapLibre — 지도 청크가 아니다
    expect(ctl).toMatchObject({ loads: 1, maps: 0, connects: 1, workers: 0, maplessSubs: 1, subscribes: 0 });
    expect(ctl.events).toEqual(["mapless connect"]);
    expect((await import("@/lib/store")).getData()).toMatchObject({ conn: "connecting", mapless: true });
    expect(connText()).toBe("WS connecting · 지도 없음");
    expect(connText()).not.toContain("실시간 수신 안 함");
    expect(byId("mapless-chip")?.textContent).toBe("지도 없음 — 항공기 · 선박 위치를 받지 않음");
  });

  it("WebGL2 cannot be created (GPUInitializationError): the status bar and alerts panel stay; the map slot says why and links the map-less alerts screen (/m)", async () => {
    ctl.mapThrows = "gpu";
    await mount("@/app/page", "/");
    expect(has("error-screen")).toBe(false);
    for (const id of ["statusbar", "side-panel-content", "radar-timeline"]) expect(has(id), id).toBe(true);
    const note = byId("map-no-webgl");
    expect(note?.textContent).toContain("WebGL2 를 쓸 수 없어 지도를 그리지 않음");
    expect(find((e) => e.tagName === "A" && e.getAttribute("href") === "/m", note!)).not.toBeNull();
    expect(ctl.maps).toBe(0);
  });

  it("WebGL2 cannot be created: the map-less feed opens one WS connection without a worker, says what it does not receive, sends no select and closes when leaving (Q4)", async () => {
    ctl.mapThrows = "gpu";
    await mount("@/app/page", "/");
    const { getData } = await import("@/lib/store");
    const { useUi } = await import("@/lib/ui-store");
    // 연결 하나 · 워커 없음 · 지도 없는 구독(지도 화면 구독이 아니다)
    expect(ctl).toMatchObject({ maps: 0, connects: 1, workers: 0, maplessSubs: 1, subscribes: 0 });
    expect(getData()).toMatchObject({ conn: "connecting", mapless: true });
    // 상태 바: 실제 연결 상태 + 지도 없음 — 'off'(실시간 수신 안 함)가 아니다
    expect(connText()).toBe("WS connecting · 지도 없음");
    expect(byId("conn")?.getAttribute("title")).toContain("지도 없이 연 연결 — 알림 · SIGMET · 레이더 · 피드 상태만 받고 항공기 · 선박 위치는 받지 않음(서버 수요를 만들지 않는 구독)");
    expect(byId("aircraft-count")?.textContent).toContain("—");
    expect(byId("aircraft-count")?.getAttribute("title")).toBe("지도 없음 — 항공기 위치를 받지 않음");
    // 알림 목록은 이 연결로 온다 — 기다리는 중이라고 적는다
    expect(alertsWaitingText()).toContain("알림 목록 수신 대기 중");
    // 관심 대상 실행기를 지도 'load'(없다) · 1분 뒤 다시 받기를 기다리지 않고 곧바로 받아 그린다(Q-C)
    expect(ctl.watchRunners).toBeGreaterThan(0);
    // 지도 자리 칩: 칩 하나 — 선박 레이어를 켜도 선박 '수신 대기'가 아니다
    await React.act(async () => { useUi.getState().setLayers({ ships: true }); });
    await settle(3);
    expect(byId("mapless-chip")?.textContent).toBe("지도 없음 — 항공기 · 선박 위치를 받지 않음");
    expect(has("ships-chip")).toBe(false);
    expect(has("demand-map-chip")).toBe(false);
    // 항공기를 골라도 select 를 보내지 않는다(집중 추적 수요를 만들지 않는다 — Q-B)
    await React.act(async () => { useUi.getState().select("71c123"); });
    await settle(3);
    expect(ctl.selects).toBe(0);
    // 화면을 떠나면 연결을 닫고 지도 없음 표시를 지운다
    const r = root!;
    root = null;
    await React.act(async () => { r.unmount(); });
    expect(ctl.closes).toBe(1);
    expect(getData().mapless).toBe(false);
  });

  it("WebGL2 cannot be created: a hidden tab pauses the map-less feed's connection and showing the tab resumes it, like the map's feed (Q4)", async () => {
    ctl.mapThrows = "gpu";
    await mount("@/app/page", "/");
    expect(ctl).toMatchObject({ maps: 0, connects: 1, maplessSubs: 1, pauses: 0, resumes: 0 });
    dom.document.hidden = true;
    await React.act(async () => { dom.document.dispatch("visibilitychange"); });
    expect(ctl).toMatchObject({ pauses: 1, resumes: 0 });
    dom.document.hidden = false;
    await React.act(async () => { dom.document.dispatch("visibilitychange"); });
    expect(ctl).toMatchObject({ pauses: 1, resumes: 1 });
    // 멈추고 잇는 것은 지도 없는 연결 하나다
    expect(ctl.events).toEqual(["mapless connect", "mapless pause", "mapless resume"]);
  });

  it("any other Map constructor error still goes up to the route error screen (not swallowed)", async () => {
    ctl.mapThrows = "other";
    await mount("@/app/page", "/");
    expect(has("error-screen")).toBe(true);
    expect(has("map-no-webgl")).toBe(false);
  });
});

describe("replay '/replay': the same rules for the replay map", () => {
  it("MapLibre fails to load once: the replay controls stay; the map slot shows the reason; retry loads again and draws the map", async () => {
    ctl.loadFails = true;
    await mount("@/app/replay/page", "/replay");
    expect(has("error-screen")).toBe(false);
    expect(has("replay-controls")).toBe(true);
    expect(byId("lazy-error")?.getAttribute("data-part")).toBe("재생 지도");
    expect(ctl).toMatchObject({ loads: 1, maps: 0 });
    ctl.loadFails = false;
    await click("lazy-retry");
    expect(ctl).toMatchObject({ loads: 2, maps: 1 });
    expect(has("lazy-error")).toBe(false);
    expect(has("replay-controls")).toBe(true);
  });

  it("WebGL2 cannot be created: the replay controls stay and the map slot says why", async () => {
    ctl.mapThrows = "gpu";
    await mount("@/app/replay/page", "/replay");
    expect(has("error-screen")).toBe(false);
    expect(has("replay-controls")).toBe(true);
    expect(byId("map-no-webgl")?.textContent).toContain("WebGL2 를 쓸 수 없어 지도를 그리지 않음");
  });

  it("any other Map constructor error still goes up to the route error screen", async () => {
    ctl.mapThrows = "other";
    await mount("@/app/replay/page", "/replay");
    expect(has("error-screen")).toBe(true);
  });
});
