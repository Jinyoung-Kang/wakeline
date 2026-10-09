/**
 * 관심 대상 실행기(ADR-037 · SPEC F4-4 · F4-5): 숨은 탭 요청 수(관심 대상 0개 · 알림 미허락이면 0건, 허락 + 관심 대상이면 30 s 에 1건) ·
 * 조회 사건과 WS 알림이 같은 사건을 두 번 알리지 않음 · 배너는 늘, 브라우저 알림은 허락했을 때만.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { resetData, setData } from "@/lib/store";
import { useWatch } from "@/lib/watch-store";
import type { Alert } from "@/lib/types";

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => {
  await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); resetData(); dom.document.hidden = false;
  useWatch.setState({ targets: [], banner: [], state: null, error: null, checkedAt: null, permission: "unsupported" });
});

const NOW = Date.parse("2026-10-09T10:00:00Z");
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const advance = (ms: number) => m.act(() => { vi.advanceTimersByTime(ms); });
const setHidden = async (hidden: boolean) => { dom.document.hidden = hidden; await m.act(() => dom.document.dispatch("visibilitychange")); };
const AC = { kind: "aircraft" as const, id: "71be01" };
const wsAlert = (id: number): Alert => ({ id, kind: "OBSERVED", hex: "71be01", sigmet_id: "RKRR S1", hazard: "TS", entered_at: "2026-10-09T10:00:00Z", evidence: {}, estimated: false });

function answers(open: () => number[]) {
  let asked = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.startsWith("/api/v1/watch?")) asked++;
    return json({ aircraft: [{ hex: "71be01", found: true, open_alerts: open().map((id) => ({ id, kind: "OBSERVED", zone_type: "sigmet", hazard: "TS", entered_at: "2026-10-09T10:00:00Z" })), closed_alerts: [] }],
      ships: [], airports: [], closed_window_s: 900, closed_dropped: 0 });
  });
  return () => asked;
}
function notifications(permission: string) {
  const shown: string[] = [];
  vi.stubGlobal("Notification", Object.assign(class { onclick = null; constructor(title: string) { shown.push(title); } close() {} }, { permission, requestPermission: async () => permission }));
  return shown;
}
async function start(targets: { kind: "aircraft"; id: string }[], permission: "granted" | "default") {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
  useWatch.setState({ targets, permission });
  const { WatchRunner } = await import("@/components/watch/WatchRunner");
  await m.render(m.React.createElement(WatchRunner));
  await m.settle();
}

describe("watch runner: hidden-tab requests", () => {
  it("no targets → no requests at all, visible or hidden", async () => {
    const asked = answers(() => []);
    notifications("granted");
    await start([], "granted");
    await advance(60_000);
    await setHidden(true);
    await advance(120_000);
    expect(asked()).toBe(0);
  });
  it("targets but notifications not granted → nothing while hidden; one request right away when shown again", async () => {
    const asked = answers(() => []);
    notifications("default");
    await start([AC], "default");
    expect(asked()).toBe(1); // 목록이 있으면 곧바로 기준
    await setHidden(true);
    await advance(120_000);
    await m.settle();
    expect(asked()).toBe(1);
    await setHidden(false);
    await m.settle();
    expect(asked()).toBe(2);
  });
  it("targets and granted → one request per 30 s while hidden (and no extra visible-timer request)", async () => {
    const asked = answers(() => []);
    notifications("granted");
    await start([AC], "granted");
    await setHidden(true);
    for (let i = 0; i < 4; i++) { await advance(30_000); await m.settle(); }
    expect(asked()).toBe(1 + 4);
  });
});

describe("watch runner: events", () => {
  it("a new alert from the poll shows a banner and one browser notification; the WS copy of it does not notify again", async () => {
    let open: number[] = [];
    answers(() => open);
    const shown = notifications("granted");
    await start([AC], "granted");
    expect(m.byTestId("watch-banner")).toBeNull(); // 첫 답은 기준
    open = [42];
    await advance(30_000);
    await m.settle();
    expect(m.allByTestId("watch-event")).toHaveLength(1);
    expect(shown).toEqual(["항공기 71be01 — 진입"]);
    await m.act(() => setData({ alerts: new Map([[42, wsAlert(42)]]) }));
    await advance(30_000);
    await m.settle();
    expect(shown).toHaveLength(1);
  });
  it("a WS alert for a watched aircraft notifies at once; alerts present at start are the baseline", async () => {
    setData({ alerts: new Map([[1, wsAlert(1)]]) });
    answers(() => []);
    const shown = notifications("default"); // 허락 안 함 — 배너만
    await start([AC], "default");
    expect(m.byTestId("watch-banner")).toBeNull();
    await m.act(() => setData({ alerts: new Map([[1, wsAlert(1)], [2, wsAlert(2)], [3, { ...wsAlert(3), hex: "aaaaaa" }]]) }));
    await m.settle();
    expect(m.allByTestId("watch-event")).toHaveLength(1);
    expect(shown).toEqual([]);
    await m.click(m.button("닫기"));
    expect(m.byTestId("watch-banner")).toBeNull();
  });
});
