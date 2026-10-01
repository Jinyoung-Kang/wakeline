/**
 * 화면 안 선박 목록(ShipList — 선박 탭, 선택 없음)이 1 s 시계마다 하는 일(web-review §4 P2, CTO 리뷰 Phase 4 — docs/PERF.md §11).
 * 표는 경과 칸 때문에 1 s 마다 다시 그리지만, 화면 안 선박 전부를 거르고 정렬하는 일은 선박 메시지 · 거르기 글자 · 선종 필터 · 정렬이 바뀔 때만 한다 —
 * 시계를 따라가는 것은 '경과' 정렬뿐이다(경과가 시계로 바뀐다). 50줄을 보이려고 매초 전체를 정렬하지 않는다.
 * 횟수는 결정적이라 CI 가 본다. 걸린 시간(React Profiler actualDuration — 개발 빌드 · 최소 DOM)은 WAKELINE_PERF=1 일 때만 재고 찍는다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { resetData, setData, shipStates } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import type { ShipLite } from "@/lib/ships";

const rec = vi.hoisted(() => ({ list: 0, sort: 0 }));
vi.mock("@/lib/ship-card", async (orig) => {
  const m = await orig<typeof import("@/lib/ship-card")>();
  return { ...m, shipList: (...a: Parameters<typeof m.shipList>) => { rec.list++; return m.shipList(...a); } };
});
vi.mock("@/lib/ships", async (orig) => {
  const m = await orig<typeof import("@/lib/ships")>();
  return { ...m, sortShipRows: (...a: Parameters<typeof m.sortShipRows>) => { rec.sort++; return m.sortShipRows(...a); } };
});

const dom = installMiniDom();
const m = mounter(dom);
const initialUi = useUi.getState();
const NOW = Date.parse("2026-09-29T03:00:00Z");
beforeAll(() => m.load());
afterAll(() => dom.restore());
beforeEach(() => { resetData(); useUi.setState({ ...initialUi, layers: { ...initialUi.layers, ships: true } }, true); });
afterEach(async () => { await m.unmount(); vi.useRealTimers(); });

/** 합성 선박 N척(SYNTHETIC — 이름 · 선종 · 관측 시각을 20분에 걸쳐 흩는다) */
function fill(n: number, version = 1) {
  shipStates.clear();
  for (let i = 0; i < n; i++) {
    const mmsi = String(440000000 + i);
    const s: ShipLite = { mmsi, lat: 34 + (i % 100) / 50, lon: 126 + (i % 97) / 40, sog_kn: i % 20, cog_deg: i % 360, heading_deg: null, ship_type: [30, 52, 60, 70, 80][i % 5],
      name: i % 7 ? `SYN ${(i * 7919) % 100000}` : null, seen_at: new Date(NOW - (i % 1200) * 1000).toISOString(), position_source: null, nav_status: i % 9 };
    shipStates.set(mmsi, s);
  }
  setData({ ships: { mode: "points", version, count: n, total: n, ts: null, cell_deg: null, capped: false, grid: [] } });
}
/** 목록을 마운트하고 시계 10번(10 s) 동안의 커밋 수 · actualDuration 합 · 다시 거른 · 정렬한 횟수 */
async function mountList() {
  const { ShipPanelView } = await import("@/components/ShipCard");
  const P = m.React.Profiler;
  const prof = { commits: 0, ms: 0 };
  await m.render(m.React.createElement(P, { id: "ship-list", onRender: (_id: string, _phase: string, actual: number) => { prof.commits++; prof.ms += actual; } },
    m.React.createElement(ShipPanelView, { selected: null, shipsOn: true })));
  await m.settle();
  const ticks = async (n = 10) => {
    prof.commits = 0; prof.ms = 0; rec.list = 0; rec.sort = 0;
    for (let i = 0; i < n; i++) await m.act(() => { vi.advanceTimersByTime(1000); });
    return { commits: prof.commits, ms: prof.ms, list: rec.list, sort: rec.sort };
  };
  return { ticks };
}

describe("ship list: the clock re-renders the table but does not re-filter or re-sort every ship", () => {
  it("name sort (default): 10 ticks → 10 commits, 0 filter and 0 sort runs; age sort follows the clock; a ships message runs each once", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
    fill(500);
    const { ticks } = await mountList();
    expect(m.allByTestId("ship-list-item")).toHaveLength(50);
    const name = await ticks();
    expect(name.commits).toBe(10); // 경과 칸
    expect([name.list, name.sort]).toEqual([0, 0]);
    await m.click(m.byTestId("ship-list-sort-age"));
    const age = await ticks();
    expect([age.list, age.sort]).toEqual([0, 10]); // 경과 정렬만 시계를 따라간다 — 거르기는 다시 하지 않는다
    rec.list = 0; rec.sort = 0;
    await m.act(() => fill(500, 2));
    expect([rec.list, rec.sort]).toEqual([1, 1]);
  });

  it.runIf(process.env.WAKELINE_PERF)("measure: React work per 10 ticks at 1k / 5k / 10k ships (name and age sort)", async () => {
    const out: string[] = [];
    const run = async (n: number, sortAge: boolean) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
      fill(n);
      const { ticks } = await mountList();
      if (sortAge) await m.click(m.byTestId("ship-list-sort-age"));
      await ticks(5); // 데우기
      const ms = (await ticks()).ms;
      await m.unmount();
      vi.useRealTimers();
      return ms;
    };
    for (let i = 0; i < 3; i++) await run(5000, true); // JIT 데우기(버림)
    for (const n of [1000, 5000, 10000]) {
      for (const sortAge of [false, true]) {
        const runs: number[] = [];
        for (let r = 0; r < 7; r++) runs.push(await run(n, sortAge));
        runs.sort((a, b) => a - b);
        out.push(`ships ${n} · ${sortAge ? "age" : "name"} sort: median ${runs[3].toFixed(1)} ms / 10 ticks (min ${runs[0].toFixed(1)} · max ${runs[6].toFixed(1)})`);
      }
    }
    process.stdout.write(`[perf] ShipList\n${out.join("\n")}\n`);
  }, 300_000);
});
