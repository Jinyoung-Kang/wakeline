/**
 * 지도 화면은 지도 청크 · MapLibre 를 첫 그리기가 화면에 나온 뒤에 받기 시작한다(lib/after-paint — PERF §15 · ADR-026 개정 2026-10-02).
 * 규칙: Paint Timing 'first-contentful-paint' 항목(이미 지난 것 포함)이 오면 그다음 작업에서 풀린다. Paint Timing 이 없으면 rAF → setTimeout 0.
 * 숨은 탭 · 창 없음은 기다리지 않는다. 기다리는 동안 숨겨지면 곧바로. 신호가 끝내 없으면 MAX_WAIT_MS 뒤.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { afterFirstPaint, MAX_WAIT_MS, type PaintEnv } from "@/lib/after-paint";

type Entry = { name: string };
function env({ visibility = "visible", paintTiming = true, painted = false } = {}) {
  const frames: (() => void)[] = [];
  const timers = new Map<number, { cb: () => void; ms: number }>();
  let seq = 0;
  const listeners = new Map<string, Set<() => void>>();
  const observers: { cb: (l: { getEntries(): Entry[] }) => void; observed: unknown; disconnected: boolean }[] = [];
  const doc = {
    visibilityState: visibility,
    addEventListener: (t: string, cb: () => void) => { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(cb); },
    removeEventListener: (t: string, cb: () => void) => { listeners.get(t)?.delete(cb); },
  };
  class PO {
    static supportedEntryTypes = paintTiming ? ["paint", "longtask"] : ["longtask"];
    rec: (typeof observers)[number];
    constructor(cb: (l: { getEntries(): Entry[] }) => void) { this.rec = { cb, observed: null, disconnected: false }; observers.push(this.rec); }
    observe(o: unknown) { this.rec.observed = o; }
    disconnect() { this.rec.disconnected = true; }
  }
  const e: PaintEnv = {
    requestAnimationFrame: (cb) => frames.push(cb),
    setTimeout: (cb, ms) => { timers.set(++seq, { cb, ms }); return seq; },
    clearTimeout: (h) => { timers.delete(h as number); },
    document: doc,
    performance: { getEntriesByName: (n: string) => (painted && n === "first-contentful-paint" ? [{}] : []) },
    PerformanceObserver: PO,
  };
  return {
    e, frames, timers, listeners, observers,
    /** ms 가 정확히 그 값인 타이머만 돌린다(0 = 다음 작업, MAX_WAIT_MS = 안전장치) */
    run: (ms: number) => { for (const [k, t] of [...timers]) if (t.ms === ms) { timers.delete(k); t.cb(); } },
    paint: (name = "first-contentful-paint") => observers.forEach((o) => !o.disconnected && o.cb({ getEntries: () => [{ name }] })),
    hide: () => { doc.visibilityState = "hidden"; listeners.get("visibilitychange")?.forEach((f) => f()); },
  };
}
const settled = async (p: Promise<void>) => { let ok = false; void p.then(() => { ok = true; }); await new Promise((r) => setTimeout(r, 0)); return ok; };

describe("afterFirstPaint", () => {
  it("waits for the first-contentful-paint entry (presented), then the next task — buffered, so a paint before the call counts too", async () => {
    const t = env();
    const p = afterFirstPaint(t.e);
    expect(t.observers[0].observed).toEqual({ type: "paint", buffered: true });
    expect(await settled(p)).toBe(false);
    t.paint("first-paint"); // 내용 없는 첫 그리기는 아니다
    t.run(0);
    expect(await settled(p)).toBe(false);
    t.paint();
    expect(await settled(p)).toBe(false); // 관찰자 콜백 안이 아니라 그다음 작업에서
    t.run(0);
    expect(await settled(p)).toBe(true);
    expect(t.observers[0].disconnected).toBe(true);
    expect(t.timers.size).toBe(0); // 안전장치 타이머도 지웠다
    expect(t.listeners.get("visibilitychange")?.size ?? 0).toBe(0);
  });

  it("does not wait when the page has already painted (scripts arrived after the first paint — slow networks)", async () => {
    const t = env({ painted: true });
    expect(await settled(afterFirstPaint(t.e))).toBe(true);
    expect(t.observers).toHaveLength(0);
  });

  it("without Paint Timing: a frame (rAF) and the task after it", async () => {
    const t = env({ paintTiming: false });
    const p = afterFirstPaint(t.e);
    expect(t.observers).toHaveLength(0);
    expect(await settled(p)).toBe(false);
    t.frames.splice(0).forEach((f) => f());
    expect(await settled(p)).toBe(false);
    t.run(0);
    expect(await settled(p)).toBe(true);
  });

  it("does not wait in a hidden tab (it does not paint) — as before, the map loads at once", async () => {
    const t = env({ visibility: "hidden" });
    expect(await settled(afterFirstPaint(t.e))).toBe(true);
    expect(t.observers).toHaveLength(0);
  });

  it("stops waiting when the tab is hidden while waiting, and a late paint does nothing", async () => {
    const t = env();
    const p = afterFirstPaint(t.e);
    t.hide();
    expect(await settled(p)).toBe(true);
    expect(t.observers[0].disconnected).toBe(true);
    t.paint(); t.run(0);
  });

  it("gives up waiting after MAX_WAIT_MS without a paint entry (safety net)", async () => {
    const t = env();
    const p = afterFirstPaint(t.e);
    t.run(MAX_WAIT_MS);
    expect(await settled(p)).toBe(true);
  });

  it("does not wait without a window (server)", async () => {
    expect(await settled(afterFirstPaint(null))).toBe(true);
  });

  it("both map screens start their map chunk and MapLibre after the first paint", () => {
    const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    expect(read("app/page.tsx")).toMatch(/dynamic\(\(\) => afterFirstPaint\(\)\.then\(\(\) => Promise\.all\(\[import\("@\/components\/MapView"\), loadMaplibre\(\)\]\)\)/);
    expect(read("app/replay/page.tsx")).toMatch(/dynamic\(\(\) => afterFirstPaint\(\)\.then\(\(\) => Promise\.all\(\[import\("@\/components\/ReplayMap"\), loadMaplibre\(\)\]\)\)/);
  });
});
