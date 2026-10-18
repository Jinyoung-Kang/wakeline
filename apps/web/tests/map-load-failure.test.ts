/**
 * IM-21 — 지도를 그리지 못하는 두 경우가 지도 자리만 바꾼다(상태 바 · 알림 패널 · 레이더 줄 · 재생 조작 줄은 남는다).
 * 1) 지도 컴포넌트 청크나 MapLibre(public 배포본)를 받지 못함: 지도 자리에 까닭 · 청크 확인 · '다시 시도'(조각과 같은 표시 — components/LazyPart),
 *    다시 시도는 실제로 다시 받는다. 전에는 next/dynamic 의 거절이 화면 전체의 오류 경계(app/error.tsx)까지 올라가 상황판 전체가 오류 화면이 되었고,
 *    그 '다시 시도'는 같은 거절된 lazy 를 다시 그려 망이 돌아와도 돌아오지 않았다(loadMaplibre 는 다시 불리지 않았다).
 * 2) WebGL2 를 만들 수 없음(MapLibre 의 Map 생성자가 GPUInitializationError): 지도 자리에 안내와 지도 없는 알림 화면(/m). 다른 예외는 지금처럼 위로 올라간다.
 * - next/dynamic 은 실제 빌드가 쓰는 구현(next/dist/shared/lib/app-dynamic — 모듈을 평가할 때 lazy 를 한 번 만든다)으로 바꿔 시험한다.
 *   vitest 의 기본 해석은 pages 쪽 구현이라 이 동작이 보이지 않는다.
 * - 경계는 Next 의 실제 ErrorBoundaryHandler 에 실제 app/error.tsx 를 붙인다(라우트의 오류 경계와 같은 자리).
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { find, propsOf } from "./helpers/mount";

vi.mock("next/dynamic", async () => ({ default: (await import("next/dist/shared/lib/app-dynamic.js")).default }));

const ctl = vi.hoisted(() => ({ loadFails: false, mapThrows: null as null | "gpu" | "other", loads: 0, maps: 0 }));
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
vi.mock("@/lib/ws", () => ({
  WakelineWsClient: class { connect() {} subscribe() {} close() {} pause() {} resume() {} select() {} selectShip() {} setLayers() {} },
}));
const reports: { message: string; component?: string }[] = [];
vi.mock("@/lib/errorReport", async (orig) => ({
  ...(await orig<typeof import("@/lib/errorReport")>()),
  reportClientError: (input: { message: string; component?: string }) => { reports.push(input); return "sent"; },
}));
class FakeWorker { onmessage = null; postMessage() {} terminate() {} }

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
  Object.assign(ctl, { loadFails: false, mapThrows: null, loads: 0, maps: 0 });
});

const container = () => dom.container as unknown as MiniElement;
const byId = (id: string) => find((e) => e.getAttribute?.("data-testid") === id, container());
const has = (id: string) => byId(id) != null;
const settle = async (n = 15) => { for (let i = 0; i < n; i++) await React.act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

/** 페이지를 새 모듈로(지도 dynamic 은 모듈을 평가할 때 만들어진다) Next 의 라우트 오류 경계 안에 마운트한다 */
async function mount(pagePath: "@/app/page" | "@/app/replay/page", pathname: string) {
  vi.resetModules();
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
    expect(ctl).toMatchObject({ loads: 1, maps: 1 });
  });

  it("MapLibre fails to load once: the status bar, alerts panel and radar row stay; the map slot shows the reason and a retry that loads again", async () => {
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

    ctl.loadFails = false; // 망이 돌아왔다
    await click("lazy-retry");
    expect(ctl).toMatchObject({ loads: 2, maps: 1 });
    expect(has("lazy-error")).toBe(false);
    expect(has("map")).toBe(true);
    expect(has("statusbar")).toBe(true);
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
