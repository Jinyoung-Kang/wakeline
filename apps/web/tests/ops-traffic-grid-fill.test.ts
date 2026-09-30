/**
 * 운영 화면 — 연안 교통량 격자 위치 채우기 진행(ADR-023 2026-10-01 개정). 운영 질문 '채우기가 수렴하는가'를 DB · 컨테이너 로그 없이 본다:
 * 수집기 heartbeat 의 traffic_grid_* 필드(그려지는 칸 / 스냅샷 · 아는 칸 · 대기 · 대기열이 가득 차 못 넣음 · 부정 캐시 · 오늘 조회 · 상태와
 * 다음 때 · 마지막 채우기 한 번)를 그대로 보인다. 전에는 providers 탭이 heartbeat 의 *_at 시각만 보여 채우기 진행이 화면 어디에도 없었다.
 * 모르는 값은 "—", 시각은 KST 만(계약 v5 §G20).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { trafficGridFill } from "@/lib/traffic-grid-fill";
import { TrafficGridFill } from "@/components/TrafficGridFill";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { domUtcLeaks, htmlUtcLeaks, utcLeaks } from "./helpers/kst-only";
import { parseHtml } from "./helpers/html-tree";

/** 운영 스택 로그(2026-09-30 18:18:17Z 멈춤 · 18:55:05Z 스냅샷)와 같은 모양의 heartbeat — 수는 시험용 */
const HB: Record<string, string> = {
  traffic_grid_at: "2026-09-30T18:55:40Z",
  traffic_grid_state: "active",
  traffic_grid_resolved: "3504",
  traffic_grid_unresolved: "342",
  traffic_grid_cells_known: "7571",
  traffic_grid_pending: "4812",
  traffic_grid_failed: "0",
  traffic_grid_not_found: "15",
  traffic_grid_off_grid: "2",
  traffic_grid_not_queued: "0",
  traffic_grid_calls_wfs: "4350",
  traffic_grid_fill_state: "hour_window",
  traffic_grid_fill_resume_at: "2026-09-30T19:00:00Z",
  traffic_grid_fill_pass_at: "2026-09-30T18:18:17Z",
  traffic_grid_fill_pass_lookups: "290",
  traffic_grid_fill_pass_found: "268",
  traffic_grid_fill_pass_not_found: "15",
  traffic_grid_fill_pass_off_grid: "2",
  traffic_grid_fill_pass_errors: "5",
  fixture: "0",
};

const texts = (v: NonNullable<ReturnType<typeof trafficGridFill>>) => [v.state, ...v.items, v.pass].flatMap((i) => [i.text, i.title]);

describe("traffic grid fill line (lib)", () => {
  it("shows the collector's own numbers and times in KST", () => {
    const v = trafficGridFill(HB)!;
    expect(v.state.text).toBe("이 시의 채우기 몫을 다 씀 · 다음 10-01 04:00 KST");
    expect(v.state.tone).toBe("muted"); // 계획한 속도 제한 — 오류색이 아니다
    expect(Object.fromEntries(v.items.map((i) => [i.key, i.text]))).toEqual({
      drawn: "3,504 / 3,846", known: "7,571", pending: "4,812", not_queued: "0", not_found: "15", off_grid: "2", failed: "0", calls: "4,350",
    });
    expect(v.pass.text).toBe("마지막 채우기 10-01 03:18:17 KST 끝 — 조회 290 → 찾음 268 · 해양격자에 없음 15 · 격자 밖 2 · 오류 5");
    for (const t of texts(v)) expect(utcLeaks(t)).toEqual([]);
  });

  it("does not draw without the fill fields (no key · fixture · an older collector) and never fills unknowns with 0", () => {
    expect(trafficGridFill(undefined)).toBeNull();
    expect(trafficGridFill({ traffic_grid_state: "no_key", traffic_grid_at: "2026-09-30T18:55:40Z" })).toBeNull();
    const v = trafficGridFill({ traffic_grid_cells_known: "12", traffic_grid_resolved: "", traffic_grid_pending: "x", traffic_grid_fill_state: "" })!;
    expect(v.items.find((i) => i.key === "drawn")!.text).toBe("—");
    expect(v.items.find((i) => i.key === "pending")!.text).toBe("—");
    expect(v.items.find((i) => i.key === "not_found")!.text).toBe("—");
    expect(v.state.text).toBe("—");
    expect(v.pass.text).toBe("마지막 채우기 — 이 수집기 프로세스에서 아직 끝난 채우기가 없다");
  });

  it("a full queue and a tripped breaker are warnings; states it does not know are not guessed", () => {
    const v = trafficGridFill({ ...HB, traffic_grid_not_queued: "1200", traffic_grid_fill_state: "breaker", traffic_grid_fill_resume_at: "2026-09-30T18:23:17Z" })!;
    expect(v.items.find((i) => i.key === "not_queued")!.tone).toBe("warn");
    expect(v.state).toMatchObject({ text: "연달아 오류 — 잠시 쉼 · 다음 10-01 03:23 KST", tone: "warn" });
    expect(trafficGridFill({ ...HB, traffic_grid_fill_state: "something_new", traffic_grid_fill_resume_at: "" })!.state.text).toBe("—");
    expect(trafficGridFill({ ...HB, traffic_grid_fill_state: "idle", traffic_grid_fill_resume_at: "" })!.state.text).toBe("물을 칸 없음");
  });

  it("renders as one row with KST only", () => {
    const html = renderToStaticMarkup(createElement(TrafficGridFill, { collector: HB }));
    expect(htmlUtcLeaks(parseHtml(html))).toEqual([]);
    expect(html).toContain("연안 교통량 격자 위치");
    expect(renderToStaticMarkup(createElement(TrafficGridFill, { collector: {} }))).toBe("");
  });
});

// ---- 운영 화면에 실제로 붙었는가(마운트) -------------------------------------------------------------------------------

const dom = installMiniDom();
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let OpsPage: typeof import("@/app/ops/page").default;
beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  OpsPage = (await import("@/app/ops/page")).default;
});
afterAll(() => dom.restore());
let root: Root | null = null;
afterEach(async () => {
  if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const byTestId = (id: string, from: MiniElement = dom.container): MiniElement | null => {
  if (from.getAttribute?.("data-testid") === id) return from;
  for (const c of from.childNodes) { const f = c instanceof MiniElement ? byTestId(id, c) : null; if (f) return f; }
  return null;
};

describe("ops providers tab", () => {
  it("shows the fill progress row from the collector heartbeat, in KST, and no raw fill *_at chips", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse("2026-09-30T18:56:00Z") });
    const body: Record<string, unknown> = {
      "/api/v1/ops/session": { username: "op" },
      "/api/v1/ops/providers": { providers: [], active: {}, collector: HB, switches: [], budget_days: [], budget_day_zone: "UTC" },
    };
    vi.stubGlobal("fetch", async (url: string) =>
      new Response(JSON.stringify(url in body ? body[url] : { items: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(React.createElement(OpsPage)); });
    for (let i = 0; i < 3; i++) await React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const row = byTestId("ops-traffic-grid-fill");
    expect(row, "fill row").not.toBeNull();
    expect(byTestId("ops-traffic-grid-fill-drawn")!.textContent).toBe("그려지는 칸 3,504 / 3,846");
    expect(byTestId("ops-traffic-grid-fill-pass")!.textContent).toContain("10-01 03:18:17 KST 끝 — 조회 290 → 찾음 268");
    expect(domUtcLeaks(row!)).toEqual([]);
    // 채우기 시각 둘은 줄 안에서 뜻과 함께 보인다 — 일반 heartbeat 시각 칩(traffic_grid_fill_pass …)으로 한 번 더 나오지 않는다
    expect(byTestId("ops-dashboard")!.textContent).not.toContain("traffic_grid_fill_");
    expect(byTestId("ops-dashboard")!.textContent).toContain("traffic_grid 10-01 03:55:40 KST"); // 작업 heartbeat 칩은 그대로
  });
});
