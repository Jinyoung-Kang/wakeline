/**
 * 지도 칩의 화면 낭독기 알림(web-review B7 · PLAN §5 결정 3): 상태가 바뀔 때만 알린다 — 선박 모드(개별 · 격자 · 수신 대기 · 0척과 그 까닭)와
 * 경고(전송 상한 · AIS 공백)가 켜지고 꺼질 때. 수(척 · 칸)는 알리지 않는다: 선박 메시지(서버 fan-out 10 s 이상 간격)마다 수가 바뀌어 다시 읽혔다.
 * 수요 칩(집중 추적 · 핫 리전)도 상태가 바뀔 때만 — 오류 · 호출 상한 · 찾지 못함을 알리고, 주기 · 경과 분은 알리지 않는다(리뷰 cto-2026-10 최종).
 * 알림 영역은 첫 글자보다 먼저(빈 채로) 있다 — 글자와 함께 생기는 영역은 대부분의 화면 낭독기가 읽지 않는다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installMiniDom, type MiniElement } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { parseDemand } from "@/lib/demand";
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

describe("map chips: the demand chip's state is announced too — its numbers are not (decision 3)", () => {
  const HEX = "71c123";
  const NOW = Date.parse("2026-09-29T02:00:00Z");
  // 경과 분은 시계(lib/clock)의 지금으로 센다 — 시각을 고정해 '4분째'가 4분 미만으로 읽히지 않게
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW }); });
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
  const focus = (state: string, o: Record<string, unknown> = {}) => ({ demand: parseDemand({ focus: { hex: HEX, state, interval_s: 5, since: ago(3), ...o } }, 0) });
  const hot = (state: string) => ({ demand: parseDemand({ hot: { radius_nm: 100, state, interval_s: 30 } }, 0) });
  const chips = (hex: string | null, shipsOn = false) => m.render(m.React.createElement(MapChipsView, { hex, shipsOn }));

  it("focus: a new interval or elapsed minute changes the chip, not the announcement; error · 호출 상한 · 찾지 못함 are announced", async () => {
    setData({ conn: "open", lastRxAt: NOW, ...focus("active") });
    await chips(HEX);
    expect(m.byTestId("demand-map-chip")!.textContent).toBe("집중 추적 5초 · 3분째");
    const active = live();
    expect(active).toContain("집중 추적");
    expect(active).not.toMatch(/\d/);
    await m.act(() => setData(focus("active", { interval_s: 10, since: ago(4) })));
    expect(m.byTestId("demand-map-chip")!.textContent).toBe("집중 추적 10초 · 4분째");
    expect(live()).toBe(active);
    for (const [state, says] of [["error", "집중 추적 오류"], ["throttled", "호출 상한으로 지연"], ["not_found", "공급자에서 찾지 못함"]] as const) {
      await m.act(() => setData(focus(state)));
      expect(live()).toContain(says);
      expect(live()).not.toMatch(/\d/); // 호출 상한의 '· 5초 간격'은 보이는 칩에만
    }
  });

  it("hot region: active and error are told apart; the interval and radius are not announced", async () => {
    setData({ conn: "open", lastRxAt: NOW, ...hot("active") });
    await chips(null);
    expect(m.byTestId("demand-map-chip")!.textContent).toBe("핫 리전 30초 갱신(반경 100 NM)");
    const active = live();
    expect(active).toContain("핫 리전");
    expect(active).not.toMatch(/\d/);
    await m.act(() => setData(hot("error")));
    expect(live()).toContain("핫 리전 조회 오류");
    expect(live()).not.toBe(active);
  });

  it("both live regions are there, empty, before their first text — the first state is read too", async () => {
    setData({ conn: "open", lastRxAt: NOW, viewport: { bbox: [126, 34, 129, 37], zoom: 8 }, ais: AIS as never });
    await chips(null);
    const shipsRegion = m.byTestId("ships-chip-status");
    const demandRegion = m.byTestId("demand-chip-status");
    expect(shipsRegion?.textContent).toBe("");
    expect(demandRegion?.textContent).toBe("");
    await m.act(() => setData({ ...points(120, 1), ...focus("pending") }));
    await chips(HEX, true);
    expect(m.byTestId("ships-chip-status")).toBe(shipsRegion);
    expect(shipsRegion!.textContent).toBe("선박 개별 표시(AIS)");
    expect(m.byTestId("demand-chip-status")).toBe(demandRegion);
    expect(demandRegion!.textContent).toContain("집중 추적 대기");
  });
});
