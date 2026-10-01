// lib/use-visible-interval(PLAN §5 결정 2 · web-review B12/B13): 보일 때만 주기 호출, 숨긴 동안 거른 것이 있으면 다시 보일 때 곧바로,
// fn 이 바뀌어도 주기를 다시 걸지 않는다.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";

const dom = installMiniDom();
const m = mounter(dom);
let useVisibleInterval: typeof import("@/lib/use-visible-interval").useVisibleInterval;
beforeAll(async () => { await m.load(); ({ useVisibleInterval } = await import("@/lib/use-visible-interval")); });
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); dom.document.hidden = false; });

const calls: string[] = [];
function Probe({ label, ms }: { label: string; ms: number | null }) {
  useVisibleInterval(() => { calls.push(label); }, ms);
  return null;
}
const render = (label: string, ms: number | null) => m.render(m.React.createElement(Probe, { label, ms }));
const advance = (ms: number) => m.act(() => { vi.advanceTimersByTime(ms); });
const setHidden = async (hidden: boolean) => { dom.document.hidden = hidden; await m.act(() => dom.document.dispatch("visibilitychange")); };

describe("useVisibleInterval", () => {
  it("calls every period while the tab is visible", async () => {
    vi.useFakeTimers();
    calls.length = 0;
    await render("a", 15_000);
    await advance(45_000);
    expect(calls).toEqual(["a", "a", "a"]);
  });

  it("skips while hidden and calls once at once when shown again after a skipped period", async () => {
    vi.useFakeTimers();
    calls.length = 0;
    await render("a", 15_000);
    await setHidden(true);
    await advance(60_000);
    expect(calls).toEqual([]);
    await setHidden(false);
    expect(calls).toEqual(["a"]);
    await advance(15_000);
    expect(calls).toEqual(["a", "a"]);
  });

  it("a short hide with no skipped period does not add a call", async () => {
    vi.useFakeTimers();
    calls.length = 0;
    await render("a", 15_000);
    await advance(5_000);
    await setHidden(true);
    await advance(5_000);
    await setHidden(false);
    expect(calls).toEqual([]);
    await advance(5_000);
    expect(calls).toEqual(["a"]);
  });

  it("a new callback is used without re-arming the period; null stops it", async () => {
    vi.useFakeTimers();
    calls.length = 0;
    await render("a", 15_000);
    await advance(10_000);
    await render("b", 15_000); // 렌더마다 새 함수 — 주기는 그대로(10 s 뒤가 아니라 5 s 뒤)
    await advance(5_000);
    expect(calls).toEqual(["b"]);
    await render("b", null);
    await advance(60_000);
    expect(calls).toEqual(["b"]);
  });
});
