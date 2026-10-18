/**
 * 공항 카드의 오류는 그 공항의 것만 보인다(web-review B5 · PLAN W5). 다음 공항을 불러오는 동안 앞 공항의 오류 · 요청 id · '로그 보기' 링크가 남으면
 * 운영자가 엉뚱한 요청의 로그를 찾는다. wx 는 이미 icao 로 맞춰 본다(AircraftCard · ShipCard 의 오류도 id 로 묶는다).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";

const dom = installMiniDom();
const m = mounter(dom);
let AirportCard: typeof import("@/components/AirportCard").AirportCard;
beforeAll(async () => { await m.load(); ({ AirportCard } = await import("@/components/AirportCard")); });
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.unstubAllGlobals(); });

const problem = (status: number, detail: string, rid: string) =>
  new Response(JSON.stringify({ detail, request_id: rid }), { status, headers: { "Content-Type": "application/problem+json" } });
const WX = (icao: string) => ({ airport: { icao, name: `${icao} Intl` }, latest: null, history: [] });

describe("AirportCard error belongs to its airport (web-review B5)", () => {
  it("the previous airport's error (and its request id) is not shown while the next airport loads", async () => {
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("fetch", async (url: string) => url === "/api/v1/airports/RKSI/wx" ? problem(503, "wx store unavailable", "feedface0000beef") : new Promise<Response>(() => {}));
    await m.render(m.React.createElement(AirportCard, { icao: "RKSI" }));
    await m.settle();
    // 문구는 공항 기상 이력 화면과 같은 airportErrorText(IM-22 — 서버 영문 detail 대신 한국어 + HTTP 상태) + 요청 id
    expect(m.byTestId("airport-card-error")!.textContent).toContain("기상 이력을 불러오지 못했습니다(HTTP 503).");
    expect(m.byTestId("airport-card-error")!.textContent).toContain("feedface0000beef");
    await m.render(m.React.createElement(AirportCard, { icao: "RKSS" }));
    await m.settle();
    const text = m.byTestId("airport-card")!.textContent;
    expect(text).toContain("Airport · RKSS");
    expect(text).not.toContain("HTTP 503");
    expect(text).not.toContain("feedface0000beef");
  });

  it("the next airport's own error and data replace the earlier ones", async () => {
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("fetch", async (url: string) => url === "/api/v1/airports/RKSI/wx" ? problem(503, "wx store unavailable", "feedface0000beef")
      : url === "/api/v1/airports/RKSS/wx" ? problem(502, "upstream down", "cafe0000cafe0000")
      : new Response(JSON.stringify(WX("RKPC")), { status: 200, headers: { "Content-Type": "application/json" } }));
    await m.render(m.React.createElement(AirportCard, { icao: "RKSI" }));
    await m.settle();
    await m.render(m.React.createElement(AirportCard, { icao: "RKSS" }));
    await m.settle();
    expect(m.byTestId("airport-card")!.textContent).toContain("기상 이력을 불러오지 못했습니다(HTTP 502).");
    expect(m.byTestId("airport-card")!.textContent).toContain("cafe0000cafe0000");
    expect(m.byTestId("airport-card")!.textContent).not.toContain("HTTP 503");
    expect(m.byTestId("airport-card")!.textContent).not.toContain("feedface0000beef");
    await m.render(m.React.createElement(AirportCard, { icao: "RKPC" }));
    await m.settle();
    expect(m.byTestId("airport-card")!.textContent).toContain("RKPC Intl");
    expect(m.byTestId("airport-card-error")).toBeNull();
  });
});
