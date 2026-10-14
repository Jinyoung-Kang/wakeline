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
