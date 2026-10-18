/**
 * QA-1463: 알림 근거 화면(공항 기상 이력과 같은 lib/use-retry-after)은 503 + Retry-After 에 그만큼 뒤 한 번 다시 받고, 또 실패하면 더 부르지 않으며
 * '다시 시도' 단추를 둔다. 404(없는 번호)에는 단추가 없다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom, visibleText } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { retryAfterMs } from "@/lib/use-retry-after";
import { ApiError } from "@/lib/api";

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.unstubAllGlobals(); });

const unavailable = () => new Response(JSON.stringify({ status: 503, detail: "data store temporarily unavailable; retry later", code: "UNAVAILABLE" }),
  { status: 503, headers: { "Content-Type": "application/problem+json", "Retry-After": "1" } });

async function mountAlert(answers: (() => Response)[]) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return (answers.shift() ?? unavailable)(); });
  vi.stubGlobal("self", globalThis);
  const AlertPage = (await import("@/app/alerts/[id]/page")).default;
  await m.render(m.React.createElement(AlertPage, { params: Promise.resolve({ id: "123" }) }));
  await m.settle();
  await m.settle();
  return calls;
}

describe("retry after a transient 503 (QA-1463)", () => {
  it("retryAfterMs: only a 503 that carries Retry-After", () => {
    expect(retryAfterMs(new ApiError(503, "x", 10))).toBe(10_000);
    expect(retryAfterMs(new ApiError(503, "x", null))).toBeNull();
    expect(retryAfterMs(new ApiError(429, "x", 10))).toBeNull();
    expect(retryAfterMs(new Error("x"))).toBeNull();
  });

  it("asks once more after Retry-After, then stops; the retry button stays", async () => {
    const calls = await mountAlert([unavailable, unavailable, unavailable]);
    expect(calls).toHaveLength(1);
    expect(visibleText(m.byTestId("retry-note")!)).toContain("1초 뒤 자동으로 한 번 다시 불러옵니다");
    await m.settle(1_200);
    await m.settle();
    expect(calls).toHaveLength(2);
    await m.settle(1_200);
    expect(calls).toHaveLength(2); // 다시 받은 요청도 실패 — 더 부르지 않는다
    expect(visibleText(m.byTestId("retry-note")!)).toContain("자동으로 한 번 다시 불렀으나 또 실패");
    await m.click(m.byTestId("retry-button"));
    expect(calls).toHaveLength(3);
  });

  it("no retry button for a 404 (the same answer every time)", async () => {
    await mountAlert([() => new Response(JSON.stringify({ status: 404, detail: "not found" }), { status: 404, headers: { "Content-Type": "application/problem+json" } })]);
    expect(m.byTestId("alert-page-error")).not.toBeNull();
    expect(m.byTestId("retry-button")).toBeNull();
  });
});

/**
 * IM-22: 상황판의 공항 카드 · 공항 탭 목록 · 선박 카드 상세(처음 기록 · 마지막 저장 위치)도 같은 공개 조회(PublicReadGate — 허가 고갈이면 503 + Retry-After)를
 * 부른다. 전에는 한 번 받고 실패에 머물렀다(카드를 닫았다 다시 열어야 받았다). 이제 같은 Hook(lib/use-retry-after)으로 한 번 다시 받고, 또 실패하면 '다시 시도'.
 * 공항 카드의 문구는 공항 기상 이력 화면과 같은 airportErrorText(서버 영문 detail 을 그대로 보이지 않는다).
 */
describe("dashboard cards retry after a transient 503 too (IM-22)", () => {
  const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const WX = ok({ airport: { icao: "RKSI", name: "RKSI Intl" }, latest: null, history: [] });
  const WATCHED = ok({ type: "FeatureCollection", features: [] });
  const DETAIL = ok({ state: null, static: null, meta: {}, first_recorded_at: "2026-10-01T00:00:00Z", last_position_at: "2026-10-17T23:00:00Z", last_seen_at: "2026-10-17T23:00:00Z" });
  /** 그 경로의 요청만 세고 답을 차례로 준다(다른 조회 — 선박 카드의 해상특보 줄 — 는 답하지 않는다) */
  function stubFetch(path: string, answers: (() => Response)[]) {
    const calls: string[] = [];
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("fetch", async (url: string) => {
      if (url !== path) return new Promise<Response>(() => {});
      calls.push(url);
      return (answers.shift() ?? unavailable)();
    });
    return calls;
  }
  const cards = [
    {
      name: "AirportCard", path: "/api/v1/airports/RKSI/wx", body: WX, testId: "airport-card",
      mount: async () => { const { AirportCard } = await import("@/components/AirportCard"); return m.React.createElement(AirportCard, { icao: "RKSI" }); },
      recovered: (text: string) => expect(text).toContain("RKSI Intl"),
    },
    {
      name: "AirportList", path: "/api/v1/airports?watched=true", body: WATCHED, testId: "airport-list",
      mount: async () => { const { AirportList } = await import("@/components/AirportList"); return m.React.createElement(AirportList); },
      recovered: (text: string) => expect(text).toContain("감시 공항이 없습니다."),
    },
    {
      name: "ShipCard", path: "/api/v1/ships/431011305", body: DETAIL, testId: "ship-card",
      mount: async () => { const { ShipCard } = await import("@/components/ShipCard"); return m.React.createElement(ShipCard, { mmsi: "431011305" }); },
      recovered: () => {
        expect(m.byTestId("ship-detail-error")).toBeNull();
        const first = m.find((e) => e.getAttribute?.("data-field") === "처음 기록")!;
        expect(visibleText(first)).not.toContain("—");
      },
    },
  ];
  for (const c of cards) {
    it(`${c.name}: a first 503 + Retry-After 1 recovers with a second request`, async () => {
      const calls = stubFetch(c.path, [unavailable, c.body]);
      await m.render(await c.mount());
      await m.settle();
      expect(calls).toHaveLength(1);
      expect(visibleText(m.byTestId("retry-note")!)).toContain("1초 뒤 자동으로 한 번 다시 불러옵니다");
      await m.settle(1_200);
      await m.settle();
      expect(calls).toHaveLength(2);
      expect(m.byTestId("retry-note")).toBeNull();
      c.recovered(visibleText(m.byTestId(c.testId)!));
    });
    it(`${c.name}: when the retry fails too it stops and leaves the retry button`, async () => {
      const calls = stubFetch(c.path, [unavailable, unavailable, c.body]);
      await m.render(await c.mount());
      await m.settle();
      await m.settle(1_200);
      await m.settle();
      expect(calls).toHaveLength(2);
      await m.settle(1_200);
      expect(calls).toHaveLength(2); // 다시 받은 요청도 실패 — 더 부르지 않는다
      expect(visibleText(m.byTestId("retry-note")!)).toContain("자동으로 한 번 다시 불렀으나 또 실패");
      await m.click(m.byTestId("retry-button"));
      await m.settle();
      expect(calls).toHaveLength(3);
      c.recovered(visibleText(m.byTestId(c.testId)!));
    });
  }
  it("AirportCard: the error says it in Korean like the airport history page (airportErrorText), with the request id", async () => {
    stubFetch("/api/v1/airports/RKSI/wx", [() => new Response(JSON.stringify({ status: 503, detail: "data store temporarily unavailable; retry later", code: "UNAVAILABLE", request_id: "feedface0000beef" }),
      { status: 503, headers: { "Content-Type": "application/problem+json", "Retry-After": "1" } })]);
    const { AirportCard } = await import("@/components/AirportCard");
    await m.render(m.React.createElement(AirportCard, { icao: "RKSI" }));
    await m.settle();
    const text = visibleText(m.byTestId("airport-card")!);
    expect(text).toContain("기상 이력을 불러오지 못했습니다(HTTP 503).");
    expect(text).not.toContain("data store temporarily unavailable");
    expect(text).toContain("feedface0000beef");
  });
});
