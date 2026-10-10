/**
 * 출시 QA 2차(docs/qa/2026-10-release) — 관심 대상 실행기(components/watch/WatchRunner · ADR-037).
 * QA-704: 첫 답은 기준(사건 없음 — lib/watch diffWatch, "막 더한 대상은 이번 답이 기준")인데, 목록을 비우면 조회가 멈추고 이전 답(prev)이 그대로 남는다 —
 *         같은 대상을 다시 더하면 오래된 답과 비교해, 그사이 이미 열려 있던 알림이 '진입'으로 알려진다(배너 · 브라우저 알림).
 * QA-705: WS 알림의 기준(시작할 때 있던 알림 — 사건 아님)을 첫 전체 목록이 오기 전(alertsVersion null)에 잡는다 — 실행기가 붙을 때 알림 목록이 비어 있으면
 *         뒤에 오는 전체 목록(이미 열려 있던 알림)이 모두 '새 알림'으로 알려진다.
 * QA-706: 숨은 탭 예외는 "알림을 허락했을 때만"(ADR-037 §5 — 끄는 법: 브라우저에서 허락을 거둔다 · 코드 주석 "허락 취소 … 곧바로 멈춘다")인데, 허락 상태는
 *         모듈을 불러올 때와 단추를 누를 때만 읽는다 — 브라우저 설정에서 거둬도 숨은 탭 조회가 계속된다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "../helpers/mini-dom";
import { mounter } from "../helpers/mount";
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

const NOW = Date.parse("2026-10-10T03:00:00Z");
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const advance = (ms: number) => m.act(() => { vi.advanceTimersByTime(ms); });
const setHidden = async (hidden: boolean) => { dom.document.hidden = hidden; await m.act(() => dom.document.dispatch("visibilitychange")); };
const AC = { kind: "aircraft" as const, id: "71be01" };
const wsAlert = (id: number): Alert => ({ id, kind: "OBSERVED", hex: "71be01", sigmet_id: "RKRR S1", hazard: "TS", entered_at: "2026-10-10T02:00:00Z", evidence: {}, estimated: false });

function answers(open: () => number[]) {
  let asked = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.startsWith("/api/v1/watch?")) asked++;
    return json({ aircraft: [{ hex: "71be01", found: true, open_alerts: open().map((id) => ({ id, kind: "OBSERVED", zone_type: "sigmet", hazard: "TS", entered_at: "2026-10-10T02:00:00Z" })), closed_alerts: [] }],
      ships: [], airports: [], closed_window_s: 900, closed_dropped: 0 });
  });
  return () => asked;
}
function notifications(permission: string) {
  const shown: string[] = [];
  const N = Object.assign(class { onclick = null; constructor(title: string) { shown.push(title); } close() {} }, { permission, requestPermission: async () => permission });
  vi.stubGlobal("Notification", N);
  return { shown, set: (p: string) => { (N as { permission: string }).permission = p; } };
}
async function start(targets: { kind: "aircraft"; id: string }[], permission: "granted" | "default") {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
  vi.stubGlobal("self", globalThis);
  useWatch.setState({ targets, permission });
  const { WatchRunner } = await import("@/components/watch/WatchRunner");
  await m.render(m.React.createElement(WatchRunner));
  await m.settle();
}

describe("QA-704 re-added target is a new baseline", () => {
  it("emptying the list and adding the same aircraft back does not report its long-open alert as an entry", async () => {
    let open: number[] = [];
    answers(() => open);
    const n = notifications("granted");
    await start([AC], "granted");          // 첫 답(열린 알림 없음) = 기준
    await m.act(() => useWatch.setState({ targets: [] }));
    await advance(60_000);
    open = [77];                           // 목록이 빈 동안 알림 77 이 열렸다
    await m.act(() => useWatch.setState({ targets: [AC] }));   // 다시 더함 — 이번 답이 기준이어야 한다
    await m.settle();
    expect(n.shown).toEqual([]);
    expect(m.allByTestId("watch-event")).toHaveLength(0);
  });
});

describe("QA-705 WS baseline waits for the first full alert list", () => {
  it("alerts already open when the first full list arrives are not reported as new", async () => {
    answers(() => [1]);
    const n = notifications("granted");
    await start([AC], "granted");          // WS 알림 목록이 아직 비어 있다(alertsVersion null)
    await m.act(() => setData({ alerts: new Map([[1, wsAlert(1)]]), alertsVersion: 5 }));   // 첫 전체 목록 — 1 은 이미 열려 있던 알림
    await m.settle();
    expect(n.shown).toEqual([]);
  });
});

describe("QA-706 revoking the notification permission stops hidden-tab polling", () => {
  it("after the browser permission becomes denied, a hidden tab makes no more requests", async () => {
    const asked = answers(() => []);
    const n = notifications("granted");
    await start([AC], "granted");
    await setHidden(true);
    await advance(30_000);
    await m.settle();
    const before = asked();
    n.set("denied");                       // 브라우저 설정에서 허락을 거뒀다
    for (let i = 0; i < 4; i++) { await advance(30_000); await m.settle(); }
    expect(asked()).toBe(before);
  });
});
