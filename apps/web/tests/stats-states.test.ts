/**
 * 통계(/stats) 패널마다 받는 중 · 받음 · 실패를 따로 안다(2026-09-30 22:49 KST 배포 직후 설명서 캡처: api 재시작 6분 뒤 DB 가 바쁠 때 네 패널이 모두
 * '자료 없음 — 집계 전인지 기록이 없는지 이 응답으로는 구분할 수 없습니다'로 찍혔고, 몇 분 뒤 같은 화면에 자료가 있었다 — 받는 중 · 실패를 '자료 없음'으로 보였다).
 * - 받는 중: 공유 진행 표시(lib/busy · globals.css .busy-appear · .busy-bar · .skeleton) — '불러오는 중'(role=status, 처음부터 DOM 에)과 막대 · 자리 표시가
 *   BUSY_APPEAR_DELAY_MS 뒤에 보인다. 빈 상태 문구(statsEmptyText)는 받은 응답에만 쓴다.
 * - 실패: 그 패널만 '조회 실패' + HTTP 상태 · 요청 id(ErrorNote · RequestIdCopy — 계약 v5 §C8) + '다시 시도'(그 패널만 다시 받는다). 다른 패널은 그대로.
 * - 패널마다 data-state(loading · ready · empty · error) — 시험 · 설명서 캡처(scripts/guide-screenshots.mjs)가 읽는다.
 * 실제 react-dom 으로 마운트(최소 DOM + fetch 대역). 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { STATS_FAILED_TEXT, STATS_LOADING_TEXT, statsEmptyText, statsPanelState } from "@/lib/stats";

const dom = installMiniDom();
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
});
afterAll(() => dom.restore());
let root: Root | null = null;
afterEach(async () => {
  if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const all = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container, out: MiniElement[] = []): MiniElement[] => {
  if (pred(from)) out.push(from);
  for (const c of from.childNodes) if (c instanceof MiniElement) all(pred, c, out);
  return out;
};
const panels = () => all((e) => e.getAttribute?.("data-stats-panel") != null);
const panel = (id: string) => panels().find((p) => p.getAttribute("data-stats-panel") === id)!;
const states = () => Object.fromEntries(panels().map((p) => [p.getAttribute("data-stats-panel"), p.getAttribute("data-state")]));
const byTestId = (id: string, from: MiniElement = dom.container) => all((e) => e.getAttribute?.("data-testid") === id, from)[0] ?? null;
const cls = (e: MiniElement) => new Set((e.getAttribute("class") ?? "").split(/\s+/));
const ancestors = (e: MiniElement) => { const out: MiniElement[] = []; for (let p = e.parentNode; p instanceof MiniElement; p = p.parentNode) out.push(p); return out; };
/** React 가 host 요소에 붙여 둔 props(이벤트 처리기) — 최소 DOM 에는 이벤트 전파가 없으므로 처리기를 직접 부른다 */
const propsOf = (e: MiniElement): Record<string, (...a: unknown[]) => unknown> => {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  return (e as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[k!];
};
const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });

const Z = { day_zone: "Asia/Seoul" };
const DAY = "2026-09-28"; // 01:00 KST 09-29 의 어제(KST)
const FIR = "/api/v1/stats/sigmet?group=fir";
const HAZ = "/api/v1/stats/sigmet?group=hazard";
const TRAFFIC = (d: string) => `/api/v1/stats/traffic?day=${d}`;
const ALERTS = "/api/v1/stats/alerts";
const OK: Record<string, unknown> = {
  [FIR]: { items: [{ day: DAY, dim: "RKRR", value: 4 }], days: [], aggregated: true, ...Z },
  [HAZ]: { items: [], days: [], aggregated: true, ...Z },
  [TRAFFIC(DAY)]: { day: DAY, items: [{ day: DAY, dim: "00", value: 3 }], aggregated: true, scope: null, region: null, ...Z },
  [ALERTS]: { items: [], days: [], aggregated: false, ...Z },
};
const json = (body: unknown, status = 200, type = "application/json") => new Response(JSON.stringify(body), { status, headers: { "Content-Type": type } });
const FAIL_503 = () => json({ detail: "stats unavailable", code: "STORE_UNAVAILABLE", request_id: "feedface0000beef" }, 503, "application/problem+json");

/** fetch 대역: 주소마다 응답(함수면 부를 때마다 — 끝나지 않는 Promise 로 '받는 중'을 붙잡는다). 부른 주소를 순서대로 적는다 */
function stub(routes: Record<string, unknown | (() => Promise<Response> | Response)>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (typeof r === "function") return (r as () => Promise<Response> | Response)();
    return r === undefined ? json({ detail: "no such resource" }, 404) : json(r);
  });
  return calls;
}
const never = () => new Promise<Response>(() => {});
async function mount() {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-09-28T16:00:00Z") });
  vi.stubGlobal("self", globalThis); // next/link 가 self.requestIdleCallback 을 찾는다
  const StatsPage = (await import("@/app/stats/page")).default;
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(createElement(StatsPage)); });
  await settle();
}
const EMPTY_UNKNOWN = statsEmptyText(undefined, null, "2026-09-29");

describe("stats panels: loading, loaded and failed are told apart — a slow or failed load is never shown as 'no data'", () => {
  it("statsPanelState: loading · error · ready (drawable rows) · empty (a loaded response with nothing to draw)", () => {
    expect(statsPanelState({ status: "loading" }, false)).toBe("loading");
    expect(statsPanelState({ status: "failed", error: new Error("x") }, false)).toBe("error");
    expect(statsPanelState({ status: "loaded", resp: {} }, true)).toBe("ready");
    expect(statsPanelState({ status: "loaded", resp: {} }, false)).toBe("empty");
  });

  it("while the four requests are in flight every panel is 'loading' with the shared busy pattern — no empty-state text anywhere", async () => {
    stub({ [FIR]: never, [HAZ]: never, [TRAFFIC(DAY)]: never, [ALERTS]: never });
    await mount();
    expect(states()).toEqual({ fir: "loading", hazard: "loading", traffic: "loading", alerts: "loading" });
    // 패널 본문 어디에도 빈 상태 문구가 없다(머리말의 '빈 칸은 집계 전·자료 없음을 구분해 표시'는 화면 설명이라 패널만 본다)
    for (const p of panels()) {
      const text = p.textContent;
      for (const t of ["자료 없음 —", "자료가 없습니다", "집계되지 않았습니다", EMPTY_UNKNOWN]) expect(text, `${p.getAttribute("data-stats-panel")}: ${t}`).not.toContain(t);
    }
    expect(all((e) => e.getAttribute?.("data-testid") === "stats-empty")).toHaveLength(0);
    for (const p of panels()) {
      const st = all((e) => e.getAttribute?.("role") === "status", p)[0];
      expect(st?.textContent, p.getAttribute("data-stats-panel")!).toContain(STATS_LOADING_TEXT);
      // 글자 · 막대 · 자리 표시 모두 공유 나타남 지연(.busy-appear) 안 — 빨리 끝나는 조회는 번쩍이지 않는다. 글자(role=status)는 처음부터 DOM 에
      expect([st, ...ancestors(st)].some((a) => cls(a).has("busy-appear"))).toBe(true);
      expect(all((e) => cls(e).has("busy-bar"), p)).toHaveLength(1);
      expect(all((e) => cls(e).has("skeleton"), p).length).toBeGreaterThanOrEqual(2);
      // 알림이 미뤄지지 않게 role=status 는 aria-busy 조상 밖(자리 표시만 aria-busy)
      expect(ancestors(st).some((a) => a.getAttribute("aria-busy") === "true")).toBe(false);
    }
    // 집계 날짜 고르기(설명서 번호 4)는 받는 동안에도 있다
    expect(all((e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === "집계 날짜(KST)")).toHaveLength(1);
  });

  it("loaded responses: 'ready' when rows are drawn, 'empty' with statsEmptyText only for a loaded response", async () => {
    stub(OK);
    await mount();
    expect(states()).toEqual({ fir: "ready", hazard: "empty", traffic: "ready", alerts: "empty" });
    expect(byTestId("stats-empty", panel("hazard"))!.textContent).toBe(statsEmptyText(true, null, "2026-09-29"));
    expect(byTestId("stats-empty", panel("alerts"))!.textContent).toBe(statsEmptyText(false, null, "2026-09-29"));
    expect(all((e) => cls(e).has("busy-bar"))).toHaveLength(0);
    expect(byTestId("stats-error")).toBeNull();
  });

  it("one of four failing: that panel says 조회 실패 with HTTP status and request id and offers 다시 시도; the other three load as usual", async () => {
    let alertsFail = true;
    const calls = stub({ ...OK, [ALERTS]: () => (alertsFail ? FAIL_503() : json(OK[ALERTS])) });
    await mount();
    expect(states()).toEqual({ fir: "ready", hazard: "empty", traffic: "ready", alerts: "error" });
    const p = panel("alerts");
    expect(p.textContent).toContain(STATS_FAILED_TEXT);
    expect(p.textContent).toContain("HTTP 503");
    expect(byTestId("stats-empty", p)).toBeNull();
    for (const t of ["자료 없음 —", "자료가 없습니다", "집계되지 않았습니다"]) expect(p.textContent).not.toContain(t);
    expect(p.textContent).toContain("자료가 있는지 알 수 없습니다"); // 받지 못함의 뜻을 적는다('자료 없음'이 아님)
    expect(byTestId("request-id", p)!.textContent).toContain("feedface0000beef");
    expect(all((e) => e.getAttribute?.("role") === "alert", p)).toHaveLength(1);
    // 다른 패널에는 오류가 없다(한 요청의 실패가 다른 패널을 비우지 않는다)
    for (const id of ["fir", "hazard", "traffic"]) expect(byTestId("stats-error", panel(id)), id).toBeNull();
    // 다시 시도: 그 패널만 다시 받는다 — 받는 동안 '불러오는 중', 받으면 빈 상태 문구
    const before = calls.length;
    alertsFail = false;
    const retry = byTestId("stats-retry", p)!;
    expect(retry.textContent).toBe("다시 시도");
    await React.act(async () => { propsOf(retry).onClick({}); });
    await settle();
    expect(calls.slice(before)).toEqual([ALERTS]);
    expect(states()).toEqual({ fir: "ready", hazard: "empty", traffic: "ready", alerts: "empty" });
  });

  it("a network failure (no HTTP status) is still 조회 실패 — not 자료 없음", async () => {
    stub({ ...OK, [FIR]: () => Promise.reject(new TypeError("Failed to fetch")) });
    await mount();
    expect(states().fir).toBe("error");
    expect(panel("fir").textContent).toContain(STATS_FAILED_TEXT);
    expect(panel("fir").textContent).toContain("Failed to fetch");
    expect(byTestId("stats-empty", panel("fir"))).toBeNull();
  });

  it("each panel settles on its own: a slow request keeps only its panel loading", async () => {
    let release: (r: Response) => void = () => {};
    stub({ ...OK, [TRAFFIC(DAY)]: () => new Promise<Response>((r) => { release = r; }) });
    await mount();
    expect(states()).toEqual({ fir: "ready", hazard: "empty", traffic: "loading", alerts: "empty" });
    await React.act(async () => { release(json(OK[TRAFFIC(DAY)])); });
    await settle();
    expect(states().traffic).toBe("ready");
  });

  it("changing the day reloads only the traffic panel (loading, then the new day); a late answer for the previous day is dropped", async () => {
    const other = "2026-09-27";
    let releaseOld: (r: Response) => void = () => {};
    let releaseNew: (r: Response) => void = () => {};
    const calls = stub({
      ...OK,
      [TRAFFIC(DAY)]: () => new Promise<Response>((r) => { releaseOld = r; }),
      [TRAFFIC(other)]: () => new Promise<Response>((r) => { releaseNew = r; }),
    });
    await mount();
    const before = calls.length;
    const input = all((e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === "집계 날짜(KST)")[0];
    await React.act(async () => { propsOf(input).onChange({ target: { value: other } }); });
    await settle();
    expect(calls.slice(before)).toEqual([TRAFFIC(other)]);
    expect(states().traffic).toBe("loading");
    // 이전 날짜의 응답이 늦게 와도 새 날짜 패널에 그리지 않는다
    await React.act(async () => { releaseOld(json(OK[TRAFFIC(DAY)])); });
    await settle();
    expect(states().traffic).toBe("loading");
    await React.act(async () => { releaseNew(json({ day: other, items: [], aggregated: true, scope: null, region: null, ...Z })); });
    await settle();
    expect(states().traffic).toBe("empty");
    expect(byTestId("stats-empty", panel("traffic"))!.textContent).toBe(statsEmptyText(true, other, "2026-09-29"));
  });
});
