/**
 * 상단 통합 검색(늘 마운트된 머리 줄)의 1 s 시계(web-review §4 P5, CTO 리뷰 Phase 4 — docs/PERF.md §11). 시계는 결과(선박 표의 경과 칸)를 보일 때만 필요하다 —
 * 결과가 닫혀 있으면 1 s 마다 다시 그리지 않는다. 상황판에서는 상태 바 · 지도 칩이 같은 1 s 시계를 늘 돌린다(여기서는 Ticker 가 그 자리).
 * 횟수는 결정적이라 CI 가 본다. 걸린 시간(React Profiler actualDuration)은 WAKELINE_PERF=1 일 때만 재고 찍는다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom, type MiniElement } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { resetData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";

const rec = vi.hoisted(() => ({ reply: null as ((p: string) => Promise<unknown>) | null }));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  apiGet: (p: string) => (rec.reply ? rec.reply(p) : new Promise(() => {})),
}));

const dom = installMiniDom();
// react-dom 은 불러올 때 'oninput' in document 로 input 이벤트 지원을 본다(tests/search-ships-mount 와 같은 준비)
(dom.document as unknown as Record<string, unknown>).oninput = null;
const g = globalThis as Record<string, unknown>;
g.addEventListener = () => {};
g.removeEventListener = () => {};
const m = mounter(dom);
const initialUi = useUi.getState();
const NOW = Date.parse("2026-09-29T03:00:00Z");
beforeAll(() => m.load());
afterAll(() => { dom.restore(); delete g.addEventListener; delete g.removeEventListener; });
beforeEach(() => { resetData(); useUi.setState(initialUi, true); });
afterEach(async () => { await m.unmount(); vi.useRealTimers(); });

const AIRCRAFT = { items: [{ hex: "71c081", callsign: "SYN081", alt_ft: 34000, lat: 36, lon: 127 }] };
const SHIPS = { items: Array.from({ length: 10 }, (_, i) => ({
  mmsi: String(440123450 + i), name: `SYN ${i}`, call_sign: null, imo: null, ship_type: 70, category: "cargo", live: true, lat: 35.1, lon: 129.1, sog_kn: 12.3,
  seen_at: new Date(NOW - (i + 1) * 60_000).toISOString(), last_position_at: null, last_seen_at: null,
})), meta: { q: "SYN", count: 10 } };

async function mountSearch() {
  const { AircraftSearch } = await import("@/components/AircraftSearch");
  const { ShipTablePart } = await import("@/components/DashboardParts");
  await ShipTablePart.preload();
  const { useNow } = await import("@/lib/clock");
  /** 상태 바 · 지도 칩 자리: 같은 1 s 시계를 늘 돌린다 */
  const Ticker = () => { useNow(1000); return null; };
  const prof = { commits: 0, ms: 0 };
  await m.render(m.React.createElement(m.React.Fragment, null, m.React.createElement(Ticker),
    m.React.createElement(m.React.Profiler, { id: "search", onRender: (_i: string, _p: string, actual: number) => { prof.commits++; prof.ms += actual; } },
      m.React.createElement(AircraftSearch))));
  await m.settle();
  const ticks = async (n = 10) => {
    prof.commits = 0; prof.ms = 0;
    for (let i = 0; i < n; i++) await m.act(() => { vi.advanceTimersByTime(1000); });
    return { commits: prof.commits, ms: prof.ms };
  };
  const input = () => m.byTestId("aircraft-search-input")!;
  const fire = (type: string, target: MiniElement, extra: Record<string, unknown> = {}) =>
    m.act(() => { dom.container.dispatch(type, { type, target, bubbles: true, preventDefault() {}, stopPropagation() {}, ...extra }); });
  const typeText = async (v: string) => { (input() as unknown as { value: string }).value = v; await fire("input", input()); await m.settle(300); };
  const key = (k: string) => fire("keydown", input(), { key: k });
  return { ticks, typeText, key };
}

describe("the search header renders on the 1 s clock only while its results are open", () => {
  it("closed: 10 ticks → 0 commits; results open: 10 commits (ship ages); closed again with Esc: 0", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
    rec.reply = (p) => Promise.resolve(p.startsWith("/api/v1/ships/") ? SHIPS : AIRCRAFT);
    const s = await mountSearch();
    expect((await s.ticks()).commits).toBe(0);
    await s.typeText("SYN");
    expect(m.byTestId("aircraft-search-results")).not.toBeNull();
    expect(m.allByTestId("ship-search-item")).toHaveLength(10);
    expect((await s.ticks()).commits).toBe(10);
    await s.key("Escape");
    expect(m.byTestId("aircraft-search-results")).toBeNull();
    expect((await s.ticks()).commits).toBe(0);
  });

  it.runIf(process.env.WAKELINE_PERF)("measure: React work per 10 ticks, results closed and open", async () => {
    const out: string[] = [];
    const run = async (open: boolean) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
      rec.reply = (p) => Promise.resolve(p.startsWith("/api/v1/ships/") ? SHIPS : AIRCRAFT);
      const s = await mountSearch();
      await s.typeText("SYN");
      if (!open) await s.key("Escape");
      await s.ticks(5);
      const r = await s.ticks();
      await m.unmount();
      vi.useRealTimers();
      return r;
    };
    for (let i = 0; i < 3; i++) await run(true);
    for (const open of [false, true]) {
      const runs: { commits: number; ms: number }[] = [];
      for (let r = 0; r < 7; r++) runs.push(await run(open));
      const ms = runs.map((x) => x.ms).sort((a, b) => a - b);
      out.push(`results ${open ? "open" : "closed"}: commits ${runs[0].commits} · median ${ms[3].toFixed(2)} ms / 10 ticks (min ${ms[0].toFixed(2)} · max ${ms[6].toFixed(2)})`);
    }
    process.stdout.write(`[perf] AircraftSearch\n${out.join("\n")}\n`);
  }, 300_000);
});
