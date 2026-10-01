/**
 * 선택 항적 요청(components/map/useSelectionTracks)은 다른 선택 · 기간 · 화면을 떠날 때 끊긴다(AbortSignal) — 끊은 요청의 답은 이미 쓰지 않았고
 * (화면 동작은 같다), 이제 요청 자체도 남지 않는다. 다음 선택의 요청은 끊지 않는다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { FakeMap } from "./helpers/fake-maplibre";
import { mounter } from "./helpers/mount";
import { resetData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";

const rec = vi.hoisted(() => ({ asked: [] as { path: string; signal: AbortSignal | undefined }[] }));
vi.mock("@/lib/maplibre", async (orig) => {
  const fake = (await import("./helpers/fake-maplibre")).fakeMaplibreModule;
  return { ...(await orig<typeof import("@/lib/maplibre")>()), maplibre: () => fake, loadMaplibre: async () => fake };
});
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  apiGet: (p: string, o?: { signal?: AbortSignal }) => { rec.asked.push({ path: p.split("?")[0], signal: o?.signal }); return new Promise(() => {}); },
}));
vi.mock("@/lib/ws", () => ({
  WakelineWsClient: class { connect() {} subscribe() {} close() {} pause() {} resume() {} select() {} selectShip() {} setLayers() {} },
}));
class FakeWorker { onmessage = null; postMessage() {} terminate() {} }

const dom = installMiniDom();
(globalThis as Record<string, unknown>).Worker = FakeWorker;
const m = mounter(dom);
const initialUi = useUi.getState();
beforeAll(() => m.load());
afterAll(() => { dom.restore(); delete (globalThis as Record<string, unknown>).Worker; });
beforeEach(() => {
  rec.asked.length = 0; FakeMap.instances.length = 0; resetData(); useUi.setState(initialUi, true);
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
});
afterEach(async () => { await m.unmount(); vi.unstubAllGlobals(); });

const request = (path: string) => rec.asked.filter((a) => a.path === path);
async function mount() {
  const { MapView } = await import("@/components/MapView");
  await m.render(m.React.createElement(MapView));
  const map = FakeMap.instances.at(-1)!;
  await m.act(() => { map.fire("style.load"); map.fire("load"); });
}

describe("selection track requests are aborted when superseded", () => {
  it("aircraft: choosing another aborts the first request, not the second; leaving aborts the second", async () => {
    await mount();
    await m.act(() => useUi.getState().select("aaaaaa"));
    await m.act(() => useUi.getState().select("bbbbbb"));
    const [a] = request("/api/v1/aircraft/aaaaaa/track");
    const [b] = request("/api/v1/aircraft/bbbbbb/track");
    expect(a.signal?.aborted).toBe(true);
    expect(b.signal?.aborted).toBe(false);
    await m.unmount();
    expect(b.signal?.aborted).toBe(true);
  });

  it("ship: a new period aborts the request for the old one; deselecting aborts the current one", async () => {
    useUi.setState({ layers: { ...initialUi.layers, ships: true } });
    await mount();
    await m.act(() => useUi.getState().selectShip("200000001"));
    await m.act(() => useUi.getState().setShipTrackHours(24));
    const [six, day] = request("/api/v1/ships/200000001/track");
    expect(six.signal?.aborted).toBe(true);
    expect(day.signal?.aborted).toBe(false);
    await m.act(() => useUi.getState().selectShip(null));
    expect(day.signal?.aborted).toBe(true);
  });
});
