/**
 * 공항 탭 목록과 SIGMET 카드의 '안에 있는 항공기' 목록 — 받는 중 · 실패 · 받음 상태(characterization: useApiResource 로 옮기기 전에 지금 동작을 고정한다,
 * web-review §5 gap 4 — 두 조회 모두 시험이 없었다).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { resetData, setData } from "@/lib/store";

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.unstubAllGlobals(); resetData(); });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("airport tab list (characterization)", () => {
  const AP = (icao: string) => ({ type: "Feature", geometry: { type: "Point", coordinates: [126.45, 37.46] }, properties: { icao, name: icao, flight_cat: "VFR", obs_time: "2026-09-28T00:30:00Z" } });
  async function mountList(reply: () => Promise<Response>) {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => { calls.push(url); return reply(); });
    const { AirportList } = await import("@/components/AirportList");
    await m.render(m.React.createElement(AirportList));
    return calls;
  }
  const head = () => m.find((e) => e.getAttribute("class") === "label")!.textContent;
  const items = () => m.allByTestId("airport-list-item").map((e) => e.getAttribute("data-icao"));
  it("loading: says so, no count; one request (watched airports)", async () => {
    const calls = await mountList(() => new Promise<Response>(() => {}));
    await m.settle();
    expect(head()).toBe("감시 공항 ");
    expect(dom.container.textContent).toContain("공항 목록 불러오는 중…");
    expect(calls).toEqual(["/api/v1/airports?watched=true"]);
  });
  it("loaded: the count and the airports; none → 감시 공항이 없습니다; a features value that is not a list → none", async () => {
    await mountList(async () => json(200, { type: "FeatureCollection", features: [AP("RKSS"), AP("RKSI"), { properties: { icao: 7 } }] }));
    await m.settle();
    expect([head(), items()]).toEqual(["감시 공항 2", ["RKSI", "RKSS"]]);
    await m.unmount();
    await mountList(async () => json(200, { type: "FeatureCollection", features: [] }));
    await m.settle();
    expect(dom.container.textContent).toContain("감시 공항이 없습니다.");
    await m.unmount();
    await mountList(async () => json(200, { features: "x" }));
    await m.settle();
    expect([head(), dom.container.textContent.includes("감시 공항이 없습니다.")]).toEqual(["감시 공항 0", true]);
  });
  it("failed (HTTP error, a null body or a null feature): the error line, no count", async () => {
    for (const reply of [async () => json(503, { detail: "down" }), async () => json(200, null), async () => json(200, { features: [null] })]) {
      await mountList(reply);
      await m.settle();
      expect(head()).toBe("감시 공항 ");
      expect(dom.container.textContent).toContain("공항 목록을 불러오지 못했습니다 — 지도에서 공항을 클릭하세요.");
      await m.unmount();
    }
  });
});

describe("SIGMET card: aircraft inside (characterization)", () => {
  const sg = (id: string) => ({ type: "Feature", geometry: null, properties: { id, hazard: "TS", fir_id: "RKRR", series_id: "A1", valid_from: "2026-09-28T00:00:00Z", valid_to: "2099-01-01T00:00:00Z", raw_text: "RAW" } });
  const inside = () => m.find((e) => e.getAttribute("class") === "mt-2 label" && e.textContent.startsWith("Aircraft inside"))!.textContent;
  const hexes = () => (m.byTestId("sigmet-inside") ? m.findAll((e) => e.tagName === "BUTTON", m.byTestId("sigmet-inside")!).map((b) => b.getAttribute("data-hex")) : null);
  it("unknown (—) while loading and on failure; the server's list when it answers; a body without a list stays unknown", async () => {
    setData({ sigmets: { type: "FeatureCollection", features: [sg("S1"), sg("S2"), sg("S3")] } as never });
    const replies: Record<string, () => Promise<Response>> = {
      "/api/v1/sigmets/S1": async () => json(200, { aircraft_inside: ["71c081", "abc123"] }),
      "/api/v1/sigmets/S2": async () => json(503, { detail: "down" }),
      "/api/v1/sigmets/S3": async () => json(200, { aircraft_inside: "71c081" }),
    };
    let hold: ((r: Response) => void) | null = null;
    vi.stubGlobal("fetch", (url: string) => (hold === null && url === "/api/v1/sigmets/S1" ? new Promise<Response>((r) => { hold = r; }) : replies[url]()));
    vi.stubGlobal("self", globalThis);
    const { SigmetCard } = await import("@/components/SigmetCard");
    await m.render(m.React.createElement(SigmetCard, { id: "S1" }));
    expect([inside(), hexes()]).toEqual(["Aircraft inside (—)", null]);
    hold!(await replies["/api/v1/sigmets/S1"]());
    await m.settle();
    expect([inside(), hexes()]).toEqual(["Aircraft inside (2)", ["71c081", "abc123"]]);
    await m.render(m.React.createElement(SigmetCard, { id: "S2" }));
    expect([inside(), hexes()]).toEqual(["Aircraft inside (—)", null]); // 다른 SIGMET 의 목록을 보이지 않는다
    await m.settle();
    expect([inside(), hexes()]).toEqual(["Aircraft inside (—)", null]);
    await m.render(m.React.createElement(SigmetCard, { id: "S3" }));
    await m.settle();
    expect([inside(), hexes()]).toEqual(["Aircraft inside (—)", null]);
  });
});
