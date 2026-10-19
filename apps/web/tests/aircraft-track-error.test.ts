/**
 * 선택 항공기의 DB 항적(REST /aircraft/{hex}/track, 최근 2 h) 조회 실패를 말없이 버리지 않는다(IM-23): api 는 기록이 없는 항공기(전세계 등)에도
 * 200 + 빈 points 로 답하므로, 거절은 실제 실패(503 · 500 · 망 실패)뿐이다. 선박 항적(계약 v5 §G5)과 같은 모양으로 실패와 요청 id 를 스토어에 두고,
 * 항공기 카드는 'DB 기록(최근 2 h)을 이어 붙였다' 대신 '기록 조회 실패 — 선택한 뒤 받은 관측만'을 적는다. 끊긴 요청(AbortError)은 쓰지 않는다.
 * hex · 요청 id 는 합성(SYNTHETIC) 값이다. 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { FakeMap } from "./helpers/fake-maplibre";
import { mounter } from "./helpers/mount";
import { ApiError } from "@/lib/api";
import { getData, resetData, setData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";

const HEX = "abc123";
const TRACK = `/api/v1/aircraft/${HEX}/track`;
const RID = "7ac47ac47ac47ac4";
const rec = vi.hoisted(() => ({ replies: new Map<string, () => Promise<unknown>>() }));
vi.mock("@/lib/maplibre", async (orig) => {
  const fake = (await import("./helpers/fake-maplibre")).fakeMaplibreModule;
  return { ...(await orig<typeof import("@/lib/maplibre")>()), maplibre: () => fake, loadMaplibre: async () => fake };
});
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  apiGet: (p: string, o?: { signal?: AbortSignal }) => {
    const reply = rec.replies.get(p.split("?")[0]);
    if (reply) return reply();
    // 답을 정하지 않은 요청은 끊길 때까지 기다렸다가 AbortError 로 거절한다(lib/api 의 fetch 와 같게)
    return new Promise((_, reject) => o?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))));
  },
}));
vi.mock("@/lib/ws", () => ({
  WakelineWsClient: class { connect() {} subscribe() {} subscribeWithoutMap() {} close() {} pause() {} resume() {} select() {} selectShip() {} setLayers() {} },
}));
class FakeWorker { onmessage = null; postMessage() {} terminate() {} }

const dom = installMiniDom();
(globalThis as Record<string, unknown>).Worker = FakeWorker;
const m = mounter(dom);
const initialUi = useUi.getState();
let AircraftCard: typeof import("@/components/AircraftCard").AircraftCard;
beforeAll(async () => { await m.load(); ({ AircraftCard } = await import("@/components/AircraftCard")); });
afterAll(() => { dom.restore(); delete (globalThis as Record<string, unknown>).Worker; });
beforeEach(() => {
  rec.replies.clear(); FakeMap.instances.length = 0; resetData(); useUi.setState(initialUi, true);
  vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
});
afterEach(async () => { await m.unmount(); vi.unstubAllGlobals(); resetData(); });

async function mount() {
  const { MapView } = await import("@/components/MapView");
  await m.render(m.React.createElement(MapView));
  const map = FakeMap.instances.at(-1)!;
  await m.act(() => { map.fire("style.load"); map.fire("load"); });
}
const card = (hex = HEX) => renderToStaticMarkup(createElement(AircraftCard, { hex }));
const trackError = (html: string) => /<div[^>]*data-testid="aircraft-track-error"[^>]*>.*?<\/div>/.exec(html)?.[0] ?? null;
const RECORD_TEXT = "항적 선은 DB 기록(최근 2 h)에 실시간 관측을 이어 붙인 것입니다";

describe("selected aircraft: a failed DB track is said on the card (IM-23)", () => {
  it("503 with a request id: the store keeps the failure and the card says only live points since selection, with the request id", async () => {
    rec.replies.set(TRACK, () => Promise.reject(new ApiError(503, "data store temporarily unavailable; retry later", 10, "UNAVAILABLE", RID)));
    await mount();
    await m.act(async () => { useUi.getState().select(HEX); });
    expect(getData().aircraftTrack).toEqual({ hex: HEX, loaded: true, error: "data store temporarily unavailable; retry later", requestId: RID });
    const html = card();
    const line = trackError(html);
    expect(line).not.toBeNull();
    expect(line).toContain("기록 조회 실패 — 선택한 뒤 받은 관측만 이어 그립니다");
    expect(line).toContain("data store temporarily unavailable; retry later");
    expect(line).toContain(`aria-label="요청 id ${RID} 복사"`);
    expect(html).not.toContain(RECORD_TEXT); // 기록을 이어 붙였다고 말하지 않는다
  });

  it("200 with no points (no record — e.g. a global-only aircraft): no failure, the card keeps the record sentence", async () => {
    rec.replies.set(TRACK, () => Promise.resolve({ points: [] }));
    await mount();
    await m.act(async () => { useUi.getState().select(HEX); });
    expect(getData().aircraftTrack).toEqual({ hex: HEX, loaded: true, error: null, requestId: null });
    const html = card();
    expect(trackError(html)).toBeNull();
    expect(html).toContain(RECORD_TEXT);
  });

  it("an aborted request (another aircraft chosen) writes nothing; deselecting clears the state", async () => {
    await mount();
    await m.act(async () => { useUi.getState().select(HEX); });
    expect(getData().aircraftTrack).toEqual({ hex: HEX, loaded: false, error: null, requestId: null });
    await m.act(async () => { useUi.getState().select("def456"); }); // abc123 의 요청은 AbortError 로 끝난다
    expect(getData().aircraftTrack).toEqual({ hex: "def456", loaded: false, error: null, requestId: null });
    await m.act(async () => { useUi.getState().select(null); });
    expect(getData().aircraftTrack).toBeNull();
  });

  it("rendered: a failure without a request id (network) shows only the message; another aircraft's failure is not shown", () => {
    setData({ aircraftTrack: { hex: HEX, loaded: true, error: "Failed to fetch", requestId: null } });
    const line = trackError(card())!;
    expect(line).toContain("기록 조회 실패 — 선택한 뒤 받은 관측만 이어 그립니다 (Failed to fetch)");
    expect(line).not.toContain('data-testid="request-id"');
    const other = card("def456");
    expect(trackError(other)).toBeNull();
    expect(other).toContain(RECORD_TEXT);
  });
});
