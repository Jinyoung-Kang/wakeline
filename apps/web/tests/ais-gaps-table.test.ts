/**
 * "AIS 수신 공백" 탭의 오류는 그 기간의 것만 보인다(web-review B17 · PLAN W17 — 공항 카드 B5 와 같은 갈래).
 * 다른 기간을 불러오는 동안 앞 기간의 실패(과 그 요청 id)가 남으면 지금 고른 기간이 실패한 것처럼 읽힌다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";

const dom = installMiniDom();
const m = mounter(dom);
let AisGapsTable: typeof import("@/components/logs/AisGapsTable").AisGapsTable;
beforeAll(async () => { await m.load(); ({ AisGapsTable } = await import("@/components/logs/AisGapsTable")); });
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const NOW = Date.parse("2026-09-29T02:00:00Z");
const fromOf = (ms: number) => `/api/v1/ais/gaps?from=${encodeURIComponent(new Date(NOW - ms).toISOString())}`;
const problem = (status: number, rid: string) => new Response(JSON.stringify({ detail: "gaps store unavailable", request_id: rid }), { status, headers: { "Content-Type": "application/problem+json" } });
const alert = () => m.find((e) => e.getAttribute("role") === "alert", m.byTestId("ais-gaps")!)?.textContent ?? "";

describe("AIS gaps tab: an error belongs to its period (web-review B17)", () => {
  it("the 1 h failure is not shown while 24 h loads; 24 h's own failure is", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    vi.stubGlobal("self", globalThis); // 요청 id 의 /logs 링크(next/link)
    let day!: (r: Response) => void;
    vi.stubGlobal("fetch", async (url: string) => url === fromOf(3_600_000) ? problem(503, "1111aaaa1111aaaa")
      : url === fromOf(86_400_000) ? new Promise<Response>((r) => { day = r; }) : new Response("{}", { status: 404 }));
    await m.render(m.React.createElement(AisGapsTable, { initialPeriod: "1h" }));
    await m.settle();
    expect(alert()).toContain("1111aaaa1111aaaa");
    await m.click(m.button("24 h"));
    expect(alert()).toBe("");
    day(problem(502, "2222bbbb2222bbbb"));
    await m.settle();
    expect(alert()).toContain("2222bbbb2222bbbb");
    expect(alert()).not.toContain("1111aaaa1111aaaa");
  });
});

// 표도 그 기간의 것만(web-review B17 의 나머지 — useApiResource 의 열쇠별 결과): 다른 기간을 받는 동안 앞 기간의 표를 지금 고른 기간처럼 두지 않고,
// 받는 중이라고 말한다(명시적 상태). '새로고침'도 받는 동안 그렇다고 말한다.
describe("AIS gaps tab: the table belongs to its period and loading is said", () => {
  const ok = (to: string, starts: string[]) => new Response(JSON.stringify({
    from: "2026-09-28T02:00:00Z", to, truncated: false,
    items: starts.map((s) => ({ scope: "33,124,39,132", started_at: s, ended_at: "2026-09-29T01:30:00Z", reason: "ws closed", provider: "aisstream" })),
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  const rows = () => m.allByTestId("ais-gap-row").length;
  const loading = () => m.byTestId("ais-gaps-loading");
  it("switching period: the previous period's rows are not shown; 'loading' until the new rows come", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    vi.stubGlobal("self", globalThis);
    let day!: (r: Response) => void;
    vi.stubGlobal("fetch", async (url: string) => url === fromOf(3_600_000) ? ok("2026-09-29T02:00:00Z", ["2026-09-29T01:10:00Z"])
      : url === fromOf(86_400_000) ? new Promise<Response>((r) => { day = r; }) : new Response("{}", { status: 404 }));
    await m.render(m.React.createElement(AisGapsTable, { initialPeriod: "1h" }));
    await m.settle();
    expect([rows(), loading()]).toEqual([1, null]);
    await m.click(m.button("24 h"));
    expect(rows()).toBe(0);
    expect(loading()?.getAttribute("role")).toBe("status");
    expect(loading()?.textContent).toBe("AIS 수신 공백 불러오는 중…");
    day(ok("2026-09-29T02:00:00Z", ["2026-09-29T01:10:00Z", "2026-09-28T10:00:00Z"]));
    await m.settle();
    expect([rows(), loading()]).toEqual([2, null]);
  });
  it("새로고침 says it is loading and asks again; a failure shows that failure, not the table from before", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    vi.stubGlobal("self", globalThis);
    let n = 0;
    let second!: (r: Response) => void;
    vi.stubGlobal("fetch", async (url: string) => (url !== fromOf(3_600_000) ? new Response("{}", { status: 404 })
      : ++n === 1 ? ok("2026-09-29T02:00:00Z", ["2026-09-29T01:10:00Z"]) : new Promise<Response>((r) => { second = r; })));
    await m.render(m.React.createElement(AisGapsTable, { initialPeriod: "1h" }));
    await m.settle();
    await m.click(m.button("새로고침"));
    expect([n, rows(), loading() != null]).toEqual([2, 0, true]);
    second(problem(503, "3333cccc3333cccc"));
    await m.settle();
    expect([rows(), loading()]).toEqual([0, null]);
    expect(alert()).toContain("3333cccc3333cccc");
  });
});
