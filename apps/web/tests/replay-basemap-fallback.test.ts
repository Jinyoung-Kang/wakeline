/**
 * QA-301 — 재생 지도는 배경지도 스타일(외부 OpenFreeMap)을 받지 못하면 MapLibre 'load' 가 오지 않아 항공기 · SIGMET · 조회 상자 레이어가 만들어지지 않았다
 * (ReplayMap 은 STYLE_URL 만 — 대체 스타일 · 시간 제한 · 알림이 없었다). 상태 줄은 "110 aircraft · 24 SIGMET" 인데 지도는 빈 검은 화면이었다.
 * 이제 상황판과 같은 규칙(R-01 — lib/basemap-fallback): 오류(sourceId 없음) · 시간 제한이면 로컬 대체 스타일로 한 번 바꾸고 알리며(onBasemapFailed),
 * 그 위에 그 시각의 기록을 그린다. 배경지도를 그리지 않았으면 배경지도 크레딧을 붙이지 않는다.
 */
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { FakeMap } from "./helpers/fake-maplibre";

vi.mock("maplibre-gl", async () => (await import("./helpers/fake-maplibre")).fakeMaplibreModule);

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); });

const FRAME = {
  at: "2026-10-01T18:00:00Z", aircraft: [{ hex: "71c591", lat: 36.5, lon: 127.8, alt_ft: 35000, track_deg: 90, callsign: "KAL1" }],
  sigmets: [], radar: null,
} as unknown as import("@/lib/replay").ReplayFrame;

async function mount(onBasemapFailed: (v: boolean) => void) {
  const { ReplayMap } = await import("@/components/ReplayMap");
  vi.spyOn(console, "error").mockImplementation(() => {});
  await m.render(m.React.createElement(ReplayMap, { frame: FRAME, onBbox: () => {}, onPick: () => {}, showRadar: true, onBasemapFailed }));
  return FakeMap.instances[FakeMap.instances.length - 1];
}
const credit = (map: FakeMap) => {
  const c = map.controls.find((x) => (x as { inner?: unknown }).inner) as { inner: { opts: { customAttribution: string } } } | undefined;
  return c?.inner.opts.customAttribution ?? "";
};

describe("replay map: the same basemap fallback as the dashboard (R-01)", () => {
  it("a failed style request → local fallback style once, the page is told, and the frame's aircraft are drawn on it (no basemap credit)", async () => {
    const told: boolean[] = [];
    const map = await mount((v) => told.push(v));
    await m.act(() => map.fire("error", { type: "error", error: new Error("AJAXError: Failed to fetch (0): https://tiles.openfreemap.org/styles/dark") }));
    expect(map.styleSet).toHaveLength(1);
    expect((map.styleSet[0] as { layers: { id: string }[] }).layers[0].id).toBe("wakeline-no-basemap");
    expect(told).toEqual([true]);
    await m.act(() => { map.fire("style.load"); map.fire("load"); });
    const ac = map.getSource("aircraft")?.data as { features: { properties: { hex: string } }[] };
    expect(ac.features.map((f) => f.properties.hex)).toEqual(["71c591"]);
    expect(map.getSource("replay-query")).toBeDefined();
    expect(credit(map)).toContain("Replay: 로컬 PostGIS 기록");
    expect(credit(map)).not.toContain("OpenFreeMap"); // 그리지 않은 배경지도의 출처는 붙이지 않는다
    // 늦게 온 오류 · 이벤트가 다시 바꾸지 않는다
    await m.act(() => map.fire("error", { type: "error", error: new Error("AbortError") }));
    expect(map.styleSet).toHaveLength(1);
    // 떠나면 알림을 거둔다
    await m.unmount();
    expect(told).toEqual([true, false]);
  });

  it("a style host that hangs (no error) falls back after STYLE_LOAD_TIMEOUT_MS; a style that loads in time does not", async () => {
    const { STYLE_LOAD_TIMEOUT_MS } = await import("@/lib/maplayers");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const told: boolean[] = [];
    const hung = await mount((v) => told.push(v));
    await m.act(() => { vi.advanceTimersByTime(STYLE_LOAD_TIMEOUT_MS - 1); });
    expect(hung.styleSet).toHaveLength(0);
    await m.act(() => { vi.advanceTimersByTime(1); });
    expect(hung.styleSet).toHaveLength(1);
    expect(told).toEqual([true]);
    await m.unmount();

    const ok = await mount(() => {});
    await m.act(() => { ok.fire("style.load"); ok.fire("load"); vi.advanceTimersByTime(STYLE_LOAD_TIMEOUT_MS * 2); });
    expect(ok.styleSet).toHaveLength(0);
    expect(credit(ok)).toContain("OpenFreeMap"); // 배경지도를 그렸으면 그 출처
  });

  it("the replay page shows the notice in its map notes (role=status) from the map's report", () => {
    const page = readFileSync(new URL("../app/replay/page.tsx", import.meta.url), "utf8");
    expect(page).toMatch(/onBasemapFailed=\{setBasemapFailed\}/);
    expect(page).toMatch(/basemapFailed \? <span [^>]*role="status" data-testid="basemap-failed">배경지도를 불러오지 못함/);
  });
});
