/**
 * 관심 대상 실행기 조각(AWS 리뷰 2026-10 D-3): 첫 화면 뒤 미리 받기 한 번이 성공해야만 실행기가 그려졌다 — 그 받기가 실패하면(순단 · 옛 청크)
 * 다시 받는 곳이 없어 그 세션 내내 조회 · 배너 · 알림이 없고 관심 탭은 '확인 중…'에 멈췄다. 이제 1분 뒤부터 다시 받는다(간격은 두 배씩).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";

const part = vi.hoisted(() => ({ loaded: false, calls: 0, failFirst: 1, listeners: new Set<() => void>() }));
vi.mock("@/components/DashboardParts", async () => {
  const { createElement: h, useSyncExternalStore } = await import("react");
  const none = () => null;
  const WatchRunnerPart = Object.assign(() => h("div", { "data-testid": "watch-runner" }), {
    useLoaded: () => useSyncExternalStore((l: () => void) => { part.listeners.add(l); return () => { part.listeners.delete(l); }; }, () => part.loaded, () => false),
    preload: async () => {
      part.calls++;
      if (part.calls <= part.failFirst) throw new Error("chunk load failed");
      part.loaded = true;
      for (const l of part.listeners) l();
    },
  });
  return { AircraftCardPart: none, AirportCardPart: none, AirportListPart: none, ShipPanelPart: none, SigmetCardPart: none, SigmetListPart: none,
    WarningPanelPart: none, WatchPanelPart: none, WatchRunnerPart };
});
vi.mock("@/components/AlertPanel", () => ({ AlertPanel: () => null }));

const dom = installMiniDom();
/** 가짜 setTimeout 을 옮기고 그 사이의 promise 를 비운다(m.settle 은 진짜 setTimeout 을 기다려 가짜 시계에서는 멈춘다) */
const pass = (ms: number) => m.act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); Object.assign(part, { loaded: false, calls: 0, failFirst: 1 }); });

describe("watch runner part retry", () => {
  it("a failed preload is retried after a minute, then with doubling gaps, until the runner is drawn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    part.failFirst = 2;
    const { SidePanel } = await import("@/components/SidePanel");
    await m.render(m.React.createElement(SidePanel));
    expect(m.byTestId("watch-runner")).toBeNull();
    await pass(59_999);
    expect(part.calls).toBe(0);                           // 첫 화면 뒤 미리 받기를 앞당기지 않는다
    await pass(1);
    expect(part.calls).toBe(1);                           // 실패
    await pass(119_999);
    expect(part.calls).toBe(1);
    await pass(1);
    expect(part.calls).toBe(2);                           // 또 실패(2분 뒤)
    await pass(240_000);
    expect(part.calls).toBe(3);                           // 4분 뒤 — 성공
    expect(m.byTestId("watch-runner")).not.toBeNull();
    await pass(3_600_000);
    expect(part.calls).toBe(3);                           // 받은 뒤에는 더 받지 않는다
  });
  it("leaving the dashboard stops the retries", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    part.failFirst = 99;
    const { SidePanel } = await import("@/components/SidePanel");
    await m.render(m.React.createElement(SidePanel));
    await pass(60_000);
    expect(part.calls).toBe(1);
    await m.unmount();
    await pass(3_600_000);
    expect(part.calls).toBe(1);
  });
});
