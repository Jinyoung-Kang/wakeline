/**
 * QA-309 — 통계 날짜 칸(집계 날짜(KST), max = 어제)이 입력을 검사하지 않아 ↑ 키나 직접 입력으로 미래 날짜(한 달 뒤)를 넣으면 그 날로 조회하고
 * "아직 집계되지 않았습니다 — 다음 03:30 KST 집계 뒤 채워집니다"라고 약속했다. 이제 max 보다 뒤는 조회하지 않고 최근 집계 날짜로 되돌리며 그렇다고 말한다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter, propsOf } from "./helpers/mount";
import { STATS_FUTURE_DAY_NOTE, statsEmptyText, statsPickDay } from "@/lib/stats";

describe("statsPickDay · statsEmptyText: no future day is queried or promised", () => {
  it("a calendar day up to max is taken; later → max (clamped); not a day → null (unchanged)", () => {
    expect(statsPickDay("2026-09-30", "2026-10-01")).toEqual({ day: "2026-09-30", clamped: false });
    expect(statsPickDay("2026-10-01", "2026-10-01")).toEqual({ day: "2026-10-01", clamped: false });
    expect(statsPickDay("2026-11-01", "2026-10-01")).toEqual({ day: "2026-10-01", clamped: true });
    expect(statsPickDay("", "2026-10-01")).toBeNull();
    expect(statsPickDay("2026-02-30", "2026-10-01")).toBeNull();
  });
  it("a day after today never gets the 'filled after the next run' promise", () => {
    const t = statsEmptyText(false, "2026-11-01", "2026-10-02");
    expect(t).not.toContain("채워집니다");
    expect(t).toContain("아직 오지 않은 날짜");
    expect(statsEmptyText(false, "2026-10-01", "2026-10-02")).toContain("다음 03:30 KST 집계 뒤 채워집니다"); // 지난 날은 그대로
  });
});

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("/stats date field", () => {
  it("typing a day a month ahead asks nothing for it, goes back to yesterday (KST) and says why", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { asked.push(url); return new Promise<Response>(() => {}); });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-01T16:00:00Z") }); // 10-02 01:00 KST — 어제 = 10-01
    vi.stubGlobal("self", globalThis);
    await m.render(m.React.createElement((await import("@/app/stats/page")).default));
    await m.settle();
    const input = m.find((e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === "집계 날짜(KST)")!;
    expect(input.getAttribute("max")).toBe("2026-10-01");
    expect(m.byTestId("stats-day-clamped")!.textContent).toBe("");
    await m.act(() => propsOf(input).onChange({ target: { value: "2026-11-01" } }));
    await m.settle();
    expect(asked.filter((u) => u.includes("day=2026-11-01"))).toEqual([]);
    expect((m.find((e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === "집계 날짜(KST)") as unknown as { value: string }).value).toBe("2026-10-01");
    expect(m.byTestId("stats-day-clamped")!.textContent).toBe(STATS_FUTURE_DAY_NOTE);
    // 바른 날짜를 넣으면 안내를 거두고 그 날로 묻는다
    await m.act(() => propsOf(input).onChange({ target: { value: "2026-09-30" } }));
    await m.settle();
    expect(asked).toContain("/api/v1/stats/traffic?day=2026-09-30");
    expect(m.byTestId("stats-day-clamped")!.textContent).toBe("");
  });
});
