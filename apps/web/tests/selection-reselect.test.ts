/**
 * 같은 항공기를 다시 고르면 WS select 를 다시 보낸다(components/map/useSelectionTracks) — 서버는 select 마다 선택 시각을 새로 잡아 집중 추적 30분 상한 뒤
 * "다시 선택하면 이어짐"(lib/demand expired_session_cap 칩)이 그대로 된다. 다시 고를 때 항적은 지우지 않고 REST 도 다시 부르지 않는다.
 * 첫 선택에는 select 가 한 번만 나간다. 선택 해제(빈 곳 클릭마다 select(null))는 되풀이해 보내지 않는다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { FakeMap } from "./helpers/fake-maplibre";
import { mounter } from "./helpers/mount";
import { resetData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";

const TRACK = "/api/v1/aircraft/abc123/track";
const rec = vi.hoisted(() => ({ asked: [] as string[], selects: [] as (string | null)[] }));
vi.mock("@/lib/maplibre", async (orig) => {
  const fake = (await import("./helpers/fake-maplibre")).fakeMaplibreModule;
  return { ...(await orig<typeof import("@/lib/maplibre")>()), maplibre: () => fake, loadMaplibre: async () => fake };
});
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  apiGet: (p: string) => {
    const path = p.split("?")[0];
    rec.asked.push(path);
    // 선택 항공기의 DB 항적 두 점(선 하나) — 다른 요청은 답하지 않는다
    if (path === TRACK) return Promise.resolve({ points: [
      { ts: "2026-10-18T00:00:00Z", lon: 127.0, lat: 37.0, alt_ft: 30000 },
      { ts: "2026-10-18T00:00:10Z", lon: 127.01, lat: 37.01, alt_ft: 30000 },
    ] });
    return new Promise(() => {});
  },
}));
vi.mock("@/lib/ws", () => ({
  WakelineWsClient: class { connect() {} subscribe() {} subscribeWithoutMap() {} close() {} pause() {} resume() {} select(h: string | null) { rec.selects.push(h); } selectShip() {} setLayers() {} },
}));
class FakeWorker { onmessage = null; postMessage() {} terminate() {} }

const dom = installMiniDom();
(globalThis as Record<string, unknown>).Worker = FakeWorker;
const m = mounter(dom);
const initialUi = useUi.getState();
beforeAll(() => m.load());
afterAll(() => { dom.restore(); delete (globalThis as Record<string, unknown>).Worker; });
beforeEach(() => {
  rec.asked.length = 0; rec.selects.length = 0; FakeMap.instances.length = 0; resetData(); useUi.setState(initialUi, true);
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
});
afterEach(async () => { await m.unmount(); vi.unstubAllGlobals(); });

async function mount() {
  const { MapView } = await import("@/components/MapView");
  await m.render(m.React.createElement(MapView));
  const map = FakeMap.instances.at(-1)!;
  await m.act(() => { map.fire("style.load"); map.fire("load"); });
  rec.selects.length = 0; // 지도를 만들 때 새 피드에 알린 처음 선택(null)은 세지 않는다
  return map;
}
const trackLines = (map: FakeMap) => (map.getSource("tracks")?.data as { features: unknown[] } | undefined)?.features.length ?? 0;

describe("choosing the selected aircraft again", () => {
  it("re-sends select without clearing the track or asking the REST track again", async () => {
    const map = await mount();
    await m.act(async () => { useUi.getState().select("abc123"); });
    expect(rec.selects).toEqual(["abc123"]); // 첫 선택은 한 번만
    expect(rec.asked.filter((p) => p === TRACK)).toHaveLength(1);
    expect(trackLines(map)).toBe(1);

    await m.act(async () => { useUi.getState().select("abc123"); });
    expect(rec.selects).toEqual(["abc123", "abc123"]);
    expect(rec.asked.filter((p) => p === TRACK)).toHaveLength(1);
    expect(trackLines(map)).toBe(1);
  });

  it("does not repeat a deselect", async () => {
    await mount();
    await m.act(async () => { useUi.getState().select("abc123"); });
    await m.act(async () => { useUi.getState().select(null); });
    await m.act(async () => { useUi.getState().select(null); });
    expect(rec.selects).toEqual(["abc123", null]);
  });
});
