/**
 * 알림 패널은 다른 탭을 보는 동안에도 마운트된 채 남는다(R-08 — 펼친 근거 · 범위 · 스크롤을 지킨다). 그동안 예측 행의 ETA 배지(1 s 시계)가 1초마다 다시
 * 그려졌다(web-review §4 P1, CTO 리뷰 Phase 4 — docs/PERF.md §11). 숨긴 동안은 React <Activity mode="hidden"> 로 효과(시계 · 스토어 구독)를 떼어 0번,
 * 다시 보이면 그 순간의 값으로 그린다. 상태(펼친 행)는 남는다.
 * 횟수는 결정적이라 CI 가 본다. 걸린 시간(React Profiler actualDuration — 개발 빌드 · 최소 DOM)은 WAKELINE_PERF=1 일 때만 재고 찍는다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { resetData, setData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import type { Alert, PublicStatus } from "@/lib/types";

const dom = installMiniDom();
const m = mounter(dom);
const initialUi = useUi.getState();
const NOW = Date.parse("2026-09-29T03:00:00Z");
const STATUS = { server_time: new Date(NOW).toISOString(), region: { center: [36.5, 127.8], radius_nm: 300, provider: "adsb_fi", aircraft: 1, lag_s: 1, stale: false, fetched_at: null } } as unknown as PublicStatus;
beforeAll(() => m.load());
afterAll(() => dom.restore());
beforeEach(() => { resetData(); useUi.setState(initialUi, true); });
afterEach(async () => { await m.unmount(); vi.useRealTimers(); resetData(); });

/** 관심 지역 안의 예측 알림 n개(SYNTHETIC) — ETA 는 eta_at 에서 1 s 마다 줄어든다 */
function fill(n: number) {
  const alerts = new Map<number, Alert>();
  for (let i = 1; i <= n; i++) {
    alerts.set(i, {
      id: i, kind: "PREDICTED", hex: `a${String(i).padStart(5, "0")}`, callsign: `SYN${i}`, sigmet_id: `S${i % 9}`, fir_id: "RKRR", hazard: "TS", entered_at: new Date(NOW - i * 1000).toISOString(),
      eta_s: 120 + i, eta_at: new Date(NOW + (120 + i) * 1000).toISOString(), alt_ft: 30000, evidence: { position: [36.5 + (i % 10) / 100, 127.8], judged_at: new Date(NOW).toISOString() }, estimated: true,
    } as unknown as Alert);
  }
  setData({ conn: "open", lastRxAt: NOW, alertsVersion: 1, alerts, status: STATUS });
}
async function mountPanel(panel: "alerts" | "aircraft") {
  const { SidePanelView } = await import("@/components/SidePanel");
  const prof = { commits: 0, ms: 0 };
  const el = (p: "alerts" | "aircraft") => m.React.createElement(m.React.Profiler, { id: "side", onRender: (_i: string, _p: string, actual: number) => { prof.commits++; prof.ms += actual; } },
    m.React.createElement(SidePanelView, { panel: p, hex: null, sigmet: null, airport: null }));
  await m.render(el(panel));
  await m.act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
  const ticks = async (n = 10) => {
    prof.commits = 0; prof.ms = 0;
    for (let i = 0; i < n; i++) await m.act(() => { vi.advanceTimersByTime(1000); });
    return { commits: prof.commits, ms: prof.ms };
  };
  const show = (p: "alerts" | "aircraft") => m.render(el(p));
  return { ticks, show };
}
const etaTexts = () => m.allByTestId("alert-eta").map((e) => e.textContent);

describe("alert panel hidden under another tab: the 1 Hz ETA badges do not render", () => {
  it("visible: 10 ticks → 10 commits; hidden: 10 ticks → 0 commits; shown again it shows the ETA of that moment and keeps the expanded row", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
    fill(20);
    const { ticks, show } = await mountPanel("alerts");
    expect(m.allByTestId("alert-item")).toHaveLength(20);
    expect((await ticks()).commits).toBe(10);
    await m.click(m.allByTestId("alert-toggle")[0]); // 펼친 행은 다른 탭을 보고 와도 남는다(R-08)
    const before = etaTexts()[0];
    await show("aircraft");
    expect((m.byTestId("alert-panel")!.parentNode as unknown as { hasAttribute(n: string): boolean }).hasAttribute("hidden")).toBe(true);
    expect((await ticks()).commits).toBe(0);
    await show("alerts");
    expect(m.allByTestId("alert-toggle")[0].getAttribute("aria-expanded")).toBe("true");
    const after = etaTexts()[0];
    expect(after).not.toBe(before); // 숨긴 10 s 만큼 줄어든 값(멈춘 값이 아니다)
    expect((await ticks()).commits).toBe(10);
  });

  it.runIf(process.env.WAKELINE_PERF)("measure: React work per 10 ticks with 50 / 225 / 525 predicted rows, visible and hidden", async () => {
    const out: string[] = [];
    const run = async (n: number, panel: "alerts" | "aircraft") => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
      fill(n);
      const { ticks } = await mountPanel(panel);
      await ticks(5); // 데우기
      const r = await ticks();
      await m.unmount();
      vi.useRealTimers();
      return r;
    };
    for (let i = 0; i < 3; i++) await run(225, "alerts"); // JIT 데우기(버림)
    for (const n of [50, 225, 525]) {
      for (const panel of ["alerts", "aircraft"] as const) {
        const runs: { commits: number; ms: number }[] = [];
        for (let r = 0; r < 7; r++) runs.push(await run(n, panel));
        const ms = runs.map((x) => x.ms).sort((a, b) => a - b);
        out.push(`${n} predicted · ${panel === "alerts" ? "visible" : "hidden"}: commits ${runs[0].commits} · median ${ms[3].toFixed(1)} ms / 10 ticks (min ${ms[0].toFixed(1)} · max ${ms[6].toFixed(1)})`);
      }
    }
    process.stdout.write(`[perf] AlertPanel\n${out.join("\n")}\n`);
  }, 300_000);
});
