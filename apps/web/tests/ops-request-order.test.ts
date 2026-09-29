/**
 * /ops 탭마다 어떤 응답을 화면에 반영하는가(lib/ops RequestOrder) — 늦게 온 이전 응답은 버리되, 새로고침(15 s)보다 느린 응답과 그 실패는 버리지 않는다.
 * 기준 요청(쓰기 뒤 · 해결 표시 토글 · refresh 단추)은 그 전에 떠난 요청의 응답을 모두 버린다.
 */
import { describe, expect, it } from "vitest";
import { RequestOrder } from "@/lib/ops";

describe("RequestOrder: which answer a tab applies", () => {
  it("an answer slower than the next periodic request is applied when nothing newer came back (a late failure is not lost)", () => {
    const o = new RequestOrder();
    const a = o.begin(false), b = o.begin(false);
    expect(o.busy).toBe(true);
    expect(o.settle(a)).toBe(true); // b 는 아직 — a 가 지금 알 수 있는 가장 새 값
    expect(o.settle(b)).toBe(true);
    expect(o.busy).toBe(false);
  });
  it("an answer older than one already applied is dropped", () => {
    const o = new RequestOrder();
    const a = o.begin(false), b = o.begin(false);
    expect(o.settle(b)).toBe(true);
    expect(o.settle(a)).toBe(false);
  });
  it("a barrier (after a write · a mode toggle · the refresh button) drops every answer from requests that left before it, even if it lands first", () => {
    const o = new RequestOrder();
    const before = o.begin(false);
    const barrier = o.begin(true);
    expect(o.settle(before)).toBe(false); // 기준 요청보다 먼저 떠났다 — 쓰기 전 · 다른 해결 표시의 값
    const after = o.begin(false);
    expect(o.settle(after)).toBe(true); // 기준 뒤에 떠난 주기 요청은 반영
    expect(o.settle(barrier)).toBe(false); // 더 새 응답이 이미 반영됐다
    expect(o.busy).toBe(false);
  });
});
