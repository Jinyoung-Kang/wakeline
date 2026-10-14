/**
 * QA 2026-10-aws(docs/qa/2026-10-aws — 영역 web-code) QA-1303: /stats 의 날짜 칸(집계 날짜 KST)은 위쪽만 막는다(max = 어제 · QA-309 — 미래는 묻지 않고
 * 되돌린다). 아래쪽은 min 도 검사도 없어(lib/stats statsPickDay — 달력 날짜면 받는다, app/stats/page.tsx:68) api 가 받지 않는 날(1970-01-01 앞 —
 * platform.web.TimeParams.MIN_DAY · QA-001/207 수정)까지 그대로 묻는다. api 는 400 BAD_REQUEST 로 답하고(ProblemAdvice.badRequest — detail
 * "invalid parameter: day — out of the supported range 1970-01-01 – 9999-12-31"), 화면은 그 영어 서버 문구 아래 "응답을 받지 못해 자료가 있는지 알 수
 * 없습니다(‘자료 없음’이 아님)"와 '다시 시도'를 보인다 — 서버는 답했고 그날 자료는 있을 수 없으며(유닉스 시각 앞), 다시 시도해도 같다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom, visibleText } from "../helpers/mini-dom";
import { mounter, propsOf } from "../helpers/mount";
import { statsPickDay } from "@/lib/stats";

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const json = (status: number, body: unknown, type = "application/json") => new Response(JSON.stringify(body), { status, headers: { "Content-Type": type } });
/** api 의 답(코드 그대로): 1970-01-01 앞의 day 는 400 problem+json, 그 밖은 빈 KST 날짜 응답 */
function api(url: string): Response {
  const day = /[?&]day=([^&]+)/.exec(url)?.[1];
  if (day && day < "1970-01-01") {
    return json(400, { type: "https://wakeline.invalid/problems/bad-request", title: "bad request", status: 400,
      detail: "invalid parameter: day — out of the supported range 1970-01-01 – 9999-12-31", code: "BAD_REQUEST", request_id: "0123456789abcdef" }, "application/problem+json");
  }
  return json(200, { items: [], aggregated: false, day_zone: "Asia/Seoul", days: [] });
}

describe("QA-1303 /stats date field has no lower bound", () => {
  it("statsPickDay refuses (or clamps) a day the api can never answer — before 1970-01-01", () => {
    const p = statsPickDay("1969-12-31", "2026-10-13");
    console.info(`QA-1303 statsPickDay("1969-12-31") → ${JSON.stringify(p)}`);
    expect(p === null || p.day >= "1970-01-01").toBe(true);
  });

  it("the page does not ask the api for 1969-12-31 and does not show 'no answer — retry' for it", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { asked.push(url); return api(url); });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-13T16:00:00Z") }); // 10-14 01:00 KST — 어제 = 10-13
    vi.stubGlobal("self", globalThis);
    await m.render(m.React.createElement((await import("@/app/stats/page")).default));
    await m.settle();
    const input = m.find((e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === "집계 날짜(KST)")!;
    console.info(`QA-1303 date input min=${input.getAttribute("min")} max=${input.getAttribute("max")}`);
    await m.act(() => propsOf(input).onChange({ target: { value: "1969-12-31" } }));
    await m.settle();
    await m.settle();
    const panel = m.find((e) => e.getAttribute?.("data-stats-panel") === "traffic")!;
    const text = visibleText(panel);
    console.info(`QA-1303 asked=${JSON.stringify(asked.filter((u) => u.includes("traffic")))} traffic panel state=${panel.getAttribute("data-state")} text="${text}"`);
    expect(asked.filter((u) => u.includes("day=1969-12-31"))).toEqual([]);
    expect(text).not.toContain("응답을 받지 못해");
  });
});
