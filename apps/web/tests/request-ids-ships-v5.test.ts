/**
 * 계약 v5 §G5: 선박 카드의 상세(REST) 오류 · 통합 검색 실패 · 선박 항적(MapView) 오류 문구에도 요청 id — 복사 단추 · /logs 링크(§C8 과 같은 모양).
 * 요청 id 가 없으면(서버가 주지 않음 · 네트워크 오류) 그 칸은 없다 — 지어내지 않는다.
 * MMSI·선명은 합성(SYNTHETIC) 값이다. 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { ApiError } from "@/lib/api";
import { resetData, setData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";

const dom = installMiniDom();
// react-dom 은 'oninput' in document 로 input 이벤트 지원을 본다(search-ships-mount.test.ts 와 같다). 검색은 window 에 "/" 키 처리기를 단다
(dom.document as unknown as Record<string, unknown>).oninput = null;
const g = globalThis as Record<string, unknown>;
g.addEventListener = () => {};
g.removeEventListener = () => {};
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
const initialUi = useUi.getState();
beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
});
afterAll(() => { dom.restore(); delete g.addEventListener; delete g.removeEventListener; });
let root: Root | null = null;
beforeEach(() => { resetData(); useUi.setState(initialUi, true); });
afterEach(async () => {
  if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
  vi.unstubAllGlobals();
  resetData();
});

const find = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container): MiniElement | null => {
  if (pred(from)) return from;
  for (const c of from.childNodes) { const f = c instanceof MiniElement ? find(pred, c) : null; if (f) return f; }
  return null;
};
const byTestId = (id: string) => find((e) => e.getAttribute?.("data-testid") === id);
const copyButtonFor = (rid: string, from: MiniElement) => find((e) => e.getAttribute?.("aria-label") === `요청 id ${rid} 복사`, from);
const settle = (ms = 30) => React.act(async () => { await new Promise((r) => setTimeout(r, ms)); });
async function mount(el: React.ReactElement) {
  vi.stubGlobal("self", globalThis); // next/link 의 가시성 효과
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(el); });
  await settle();
}
const problem = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/problem+json" } });

describe("v5-G5 ship card: the REST detail failure shows the request id", () => {
  it("mounted: the server detail and the request id with a copy button and a /logs link", async () => {
    vi.stubGlobal("fetch", async () => problem(503, { detail: "ship history store unavailable", code: "UNAVAILABLE", request_id: "5b1b5b1b5b1b5b1b" }));
    const { ShipCard } = await import("@/components/ShipCard");
    await mount(createElement(ShipCard, { mmsi: "431011305" }));
    const e = byTestId("ship-detail-error")!;
    expect(e.textContent).toContain("상세(REST) 조회 실패 — 실시간으로 받은 값만 표시");
    expect(e.textContent).toContain("ship history store unavailable");
    expect(e.textContent).toContain("5b1b5b1b5b1b5b1b");
    expect(copyButtonFor("5b1b5b1b5b1b5b1b", e)).not.toBeNull();
    expect(find((x) => x.tagName === "A", e)?.getAttribute("href")).toBe("/logs#rid=5b1b5b1b5b1b5b1b");
  });
  it("rendered: a plain error (no request id — e.g. network) shows only the message", async () => {
    const { ShipCardView } = await import("@/components/ShipCard");
    const html = renderToStaticMarkup(createElement(ShipCardView, { mmsi: "431011305", detail: null, error: new TypeError("Failed to fetch"), now: 0 }));
    expect(html).toContain("Failed to fetch");
    expect(html).not.toContain('data-testid="request-id"');
    const old = renderToStaticMarkup(createElement(ShipCardView, { mmsi: "431011305", detail: null, error: "HTTP 500", now: 0 }));
    expect(old).toContain("(HTTP 500)"); // 문자열 오류도 그대로
  });
});

describe("v5-G5 ship card: the track (MapView) failure shows the request id", () => {
  it("the track line keeps the Korean explanation and adds the request id; none when the server gave none", async () => {
    const { ShipCardView } = await import("@/components/ShipCard");
    setData({ shipTrack: { mmsi: "431011305", loaded: true, error: "data store temporarily unavailable; retry later", requestId: "7ac47ac47ac47ac4", gaps: [], gapsTruncated: false, segments: 0, fromMs: null } });
    const html = renderToStaticMarkup(createElement(ShipCardView, { mmsi: "431011305", detail: null, error: null, now: 0 }));
    const line = /<div[^>]*data-testid="ship-track-error"[^>]*>.*?<\/div>/.exec(html)![0];
    expect(line).toContain("기록 조회 실패 — 선택한 뒤 받은 관측만 이어 그립니다");
    expect(line).toContain("7ac47ac47ac47ac4");
    expect(line).toContain('aria-label="요청 id 7ac47ac47ac47ac4 복사"');
    setData({ shipTrack: { mmsi: "431011305", loaded: true, error: "Failed to fetch", gaps: [], gapsTruncated: false, segments: 0, fromMs: null } });
    const plain = renderToStaticMarkup(createElement(ShipCardView, { mmsi: "431011305", detail: null, error: null, now: 0 }));
    expect(plain).toContain("Failed to fetch");
    expect(plain).not.toContain('data-testid="request-id"');
  });
  it("trackError keeps the message and the request id of an ApiError (null otherwise)", async () => {
    const { trackError } = await import("@/lib/track");
    expect(trackError(new ApiError(503, "down", 10, "UNAVAILABLE", "7ac47ac47ac47ac4"))).toEqual({ error: "down", requestId: "7ac47ac47ac47ac4" });
    expect(trackError(new ApiError(404, "no track"))).toEqual({ error: "no track", requestId: null });
    expect(trackError(new TypeError("Failed to fetch"))).toEqual({ error: "Failed to fetch", requestId: null });
    expect(trackError("x")).toEqual({ error: "x", requestId: null });
  });
});

describe("v5-G5 unified search: a failed group shows the request id", () => {
  it("rendered: each failed group adds the request id after its Korean text; the other group is untouched", async () => {
    const { SearchResultsView } = await import("@/components/AircraftSearch");
    const html = renderToStaticMarkup(createElement(SearchResultsView, {
      uid: "s", now: 0, active: -1, shipSort: null, onShipSort: () => {}, onChooseAircraft: () => {}, onChooseShip: () => {}, onHover: () => {},
      aircraft: { hits: [], state: "error" as const, msg: "항공기 검색 실패 (boom)", error: new ApiError(500, "boom", null, "INTERNAL", "a1c0a1c0a1c0a1c0") },
      ships: { hits: [], state: "error" as const, msg: "요청이 많아 잠시 제한됨 — 잠시 후 다시", error: new ApiError(429, "slow down", 30, "RATE_LIMITED", "5e1f5e1f5e1f5e1f") },
    }));
    const a = /<div[^>]*data-testid="search-error-aircraft"[^>]*>.*?<\/div>/.exec(html)![0];
    expect(a).toContain("항공기 검색 실패 (boom)");
    expect(a).toContain('aria-label="요청 id a1c0a1c0a1c0a1c0 복사"');
    const s = /<div[^>]*data-testid="search-error-ships"[^>]*>.*?<\/div>/.exec(html)![0];
    expect(s).toContain("요청이 많아 잠시 제한됨");
    expect(s).toContain('aria-label="요청 id 5e1f5e1f5e1f5e1f 복사"');
    expect(s).not.toContain("a1c0a1c0a1c0a1c0");
  });
  it("mounted: a ship search that fails with a problem+json keeps its request id from the api", async () => {
    vi.stubGlobal("fetch", async (u: string) => (String(u).startsWith("/api/v1/ships/")
      ? problem(503, { detail: "ship search unavailable", code: "UNAVAILABLE", request_id: "5ea75ea75ea75ea7" })
      : new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const { AircraftSearch } = await import("@/components/AircraftSearch");
    await mount(createElement(AircraftSearch));
    const input = byTestId("aircraft-search-input")!;
    (input as unknown as { value: string }).value = "SYN";
    await React.act(async () => { dom.container.dispatch("input", { type: "input", target: input, bubbles: true, preventDefault() {}, stopPropagation() {} }); });
    await settle(300);
    const s = byTestId("search-error-ships")!;
    expect(s.textContent).toContain("선박 검색 실패 (ship search unavailable)");
    expect(copyButtonFor("5ea75ea75ea75ea7", s)).not.toBeNull();
    expect(byTestId("search-error-aircraft")).toBeNull(); // 항공기 묶음은 성공(0건)
  });
});
