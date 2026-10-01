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
