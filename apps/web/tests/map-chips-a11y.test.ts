/**
 * 지도 칩의 화면 낭독기 알림(web-review B7 · PLAN §5 결정 3): 상태가 바뀔 때만 알린다 — 선박 모드(개별 · 격자 · 수신 대기 · 0척과 그 까닭)와
 * 경고(전송 상한 · AIS 공백)가 켜지고 꺼질 때. 수(척 · 칸)는 알리지 않는다: 선박 메시지(서버 fan-out 10 s 이상 간격)마다 수가 바뀌어 다시 읽혔다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom, type MiniElement } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { resetData, setData, SHIPS_OFF } from "@/lib/store";

const dom = installMiniDom();
const m = mounter(dom);
let MapChipsView: typeof import("@/components/MapChips").MapChipsView;
beforeAll(async () => { await m.load(); ({ MapChipsView } = await import("@/components/MapChips")); });
afterAll(() => dom.restore());
beforeEach(() => resetData());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); resetData(); });

const AIS = { connected: true, lag_s: 1, msgs_per_s: 10, gap_open_since: null, last_gap: null, state: "ok", coverage: [{ s: 30, w: 120, n: 40, e: 135 }], received_at: 1 };
/** 칩 칸 안의 살아 있는 영역(aria-live · role=status/alert)의 글자 — 화면 낭독기가 바뀔 때 읽는 것 */
const live = () => m.findAll((e: MiniElement) => e.getAttribute("aria-live") != null || ["status", "alert"].includes(e.getAttribute("role") ?? ""), m.byTestId("map-chips")!)
  .map((e) => e.textContent).join(" | ");
const points = (n: number, version: number) => ({ ships: { ...SHIPS_OFF, mode: "points" as const, version, count: n, total: n } });

describe("map chips: the screen reader hears state changes, not counts (web-review B7, decision 3)", () => {
  async function mountChips() {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    setData({ conn: "open", viewport: { bbox: [126, 34, 129, 37], zoom: 8 }, ais: AIS as never, ...points(120, 1) });
    await m.render(m.React.createElement(MapChipsView, { hex: null, shipsOn: true }));
  }

  it("a new ship count changes the visible chip but not what is announced (no numbers in the live region)", async () => {
    await mountChips();
    expect(m.byTestId("ships-chip")!.textContent).toContain("120척");
    const before = live();
    expect(before).not.toMatch(/\d/);
    await m.act(() => setData(points(121, 2)));
    expect(m.byTestId("ships-chip")!.textContent).toContain("121척");
    expect(live()).toBe(before);
  });

  it("a change of mode or a warning turning on/off is announced", async () => {
    await mountChips();
    const p = live();
    expect(p).toContain("선박 개별 표시");
    await m.act(() => setData({ ships: { ...SHIPS_OFF, mode: "grid", version: 3, count: 40, total: 6000, cell_deg: 0.5, capped: false, grid: [] } }));
    const g = live();
    expect(g).toContain("격자");
    expect(g).not.toMatch(/\d/);
    await m.act(() => setData({ ais: { ...AIS, gap_open_since: "2026-09-29T00:00:00Z" } as never }));
    expect(live()).toContain("AIS 공백");
    await m.act(() => setData({ ships: { ...SHIPS_OFF, mode: "points", version: 4, count: 0, total: 0 }, ais: AIS as never }));
    expect(live()).toContain("화면 안 선박 0척");
    expect(live()).not.toContain("AIS 공백");
  });
});
