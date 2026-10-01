/**
 * 통합 검색의 선택은 마지막 것만 지도를 움직인다(web-review B3 · PLAN W3).
 * 위치를 모르는 항공기 A(DB 기록만)를 고르면 REST 상세를 기다린다. 그동안 B 를 고르면, 늦게 온 A 의 상세가 지도를 A 로 옮기고 안내 문구를 덮으면 안 된다.
 * 호출부호 · hex 는 합성 값이다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom, type MiniElement } from "./helpers/mini-dom";
import { mounter, propsOf } from "./helpers/mount";
import { resetData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";

const dom = installMiniDom();
// react-dom 은 불러올 때 'oninput' in document 로 input 이벤트 지원을 본다(search-ships-mount 와 같은 준비)
(dom.document as unknown as Record<string, unknown>).oninput = null;
const g = globalThis as Record<string, unknown>;
g.addEventListener = () => {};
g.removeEventListener = () => {};
const m = mounter(dom);
let AircraftSearch: typeof import("@/components/AircraftSearch").AircraftSearch;
const initialUi = useUi.getState();
beforeAll(async () => { await m.load(); ({ AircraftSearch } = await import("@/components/AircraftSearch")); });
afterAll(() => { dom.restore(); delete g.addEventListener; delete g.removeEventListener; });
beforeEach(() => { resetData(); useUi.setState(initialUi, true); });
afterEach(async () => { await m.unmount(); vi.unstubAllGlobals(); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const HITS = { items: [
  { hex: "aaaaaa", callsign: "AAA1", last_seen: "2026-09-29T00:00:00Z" }, // DB 기록만 — 위치는 REST 상세로
  { hex: "bbbbbb", callsign: "BBB2", live: true, lat: 37.5, lon: 127.0 },
] };
const input = () => m.byTestId("aircraft-search-input")!;
/** React 는 루트 컨테이너에서 이벤트를 받는다 — 대상 요소를 target 으로 한 원시 이벤트 */
const fire = (type: string, target: MiniElement) => m.act(() => dom.container.dispatch(type, { type, target, bubbles: true, preventDefault() {}, stopPropagation() {} }));
const items = () => m.allByTestId("aircraft-search-item");
const status = () => m.find((e) => e.getAttribute("aria-live") === "polite" && e.getAttribute("id")?.endsWith("-status") === true)?.textContent ?? "";

describe("search: only the latest choice moves the map (web-review B3)", () => {
  it("a late detail answer for an earlier aircraft does not fly the map there or overwrite the message", async () => {
    let detailA!: (r: Response) => void;
    vi.stubGlobal("fetch", async (url: string) => url.startsWith("/api/v1/aircraft/search") ? json(200, HITS)
      : url === "/api/v1/aircraft/aaaaaa" ? new Promise<Response>((r) => { detailA = r; })
      : url.startsWith("/api/v1/ships/search") ? json(200, { items: [] }) : json(404, {}));
    await m.render(m.React.createElement(AircraftSearch));
    (input() as unknown as { value: string }).value = "AA";
    await fire("input", input());
    await m.settle(300); // 디바운스 250 ms
    expect(items()).toHaveLength(2);
    await m.act(() => { void propsOf(items()[0]).onClick(); }); // A: 위치를 몰라 상세를 기다린다(목록은 닫힘)
    await m.act(() => propsOf(input()).onFocus());               // 다시 열고
    await m.act(() => { void propsOf(items()[1]).onClick(); }); // B: 실시간 위치 — 곧바로 이동
    expect(useUi.getState().flyTo).toMatchObject({ lon: 127.0, lat: 37.5 });
    detailA(json(200, { hex: "aaaaaa", state: { hex: "aaaaaa", lat: 10, lon: 20 } }));
    await m.settle();
    expect(useUi.getState().selectedHex).toBe("bbbbbb");
    expect(useUi.getState().flyTo).toMatchObject({ lon: 127.0, lat: 37.5 });
    expect(status()).toBe("BBB2 선택 — 지도 이동");
  });

  it("the latest choice still uses its own detail answer (a DB-only aircraft chosen last flies when its position arrives)", async () => {
    let detailA!: (r: Response) => void;
    vi.stubGlobal("fetch", async (url: string) => url.startsWith("/api/v1/aircraft/search") ? json(200, HITS)
      : url === "/api/v1/aircraft/aaaaaa" ? new Promise<Response>((r) => { detailA = r; })
      : url.startsWith("/api/v1/ships/search") ? json(200, { items: [] }) : json(404, {}));
    await m.render(m.React.createElement(AircraftSearch));
    (input() as unknown as { value: string }).value = "AA";
    await fire("input", input());
    await m.settle(300);
    await m.act(() => { void propsOf(items()[0]).onClick(); });
    detailA(json(200, { hex: "aaaaaa", state: { hex: "aaaaaa", lat: 10, lon: 20 } }));
    await m.settle();
    expect(useUi.getState().selectedHex).toBe("aaaaaa");
    expect(useUi.getState().flyTo).toMatchObject({ lon: 20, lat: 10 });
    expect(status()).toBe("AAA1 선택 — 지도 이동");
  });
});
