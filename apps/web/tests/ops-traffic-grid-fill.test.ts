/**
 * 운영 화면 — 연안 교통량 격자 위치 채우기 진행(ADR-023 2026-10-01 개정). 운영 질문 '채우기가 수렴하는가'를 DB · 컨테이너 로그 없이 본다:
 * 수집기 heartbeat 의 traffic_grid_* 필드(그려지는 칸 / 스냅샷 · 아는 칸 · 대기 · 대기열이 가득 차 못 넣음 · 부정 캐시 · 오늘 조회 · 상태와
 * 다음 때 · 마지막 채우기 한 번)를 그대로 보인다. 전에는 providers 탭이 heartbeat 의 *_at 시각만 보여 채우기 진행이 화면 어디에도 없었다.
 * 모르는 값은 "—", 시각은 KST 만(계약 v5 §G20). heartbeat 가 오래됐거나(서버 시각 기준 120 s 초과 — api TrafficGridReader 와 같은 규칙)
 * 수집기가 꺼짐(키 없음 · fixture)을 알리면 남은 수를 지금 값처럼 보이지 않는다(검토 지적: 멈춘 수집기의 '조회 중'과 수가 그대로 남았다).
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

/** /ops/providers 응답의 generated_at(서버 시각) — heartbeat(18:55:40Z) 20 s 뒤 */
const NOW = Date.parse("2026-09-30T18:56:00Z");

const texts = (v: NonNullable<ReturnType<typeof trafficGridFill>>) => [v.state, ...v.items, v.pass].flatMap((i) => [i.text, i.title]);

describe("traffic grid fill line (lib)", () => {
  it("shows the collector's own numbers and times in KST", () => {
    const v = trafficGridFill(HB, NOW)!;
    expect(v.state.text).toBe("이 시의 채우기 몫을 다 씀 · 다음 10-01 04:00 KST");
    expect(v.state.tone).toBe("muted"); // 계획한 속도 제한 — 오류색이 아니다
    expect(Object.fromEntries(v.items.map((i) => [i.key, i.text]))).toEqual({
      drawn: "3,504 / 3,846", known: "7,571", pending: "4,812", not_queued: "0", not_found: "15", off_grid: "2", failed: "0", calls: "4,350",
    });
    expect(v.pass.text).toBe("마지막 채우기 10-01 03:18:17 KST 끝 — 조회 290 → 찾음 268 · 해양격자에 없음 15 · 격자 밖 2 · 오류 5");
    for (const t of texts(v)) expect(utcLeaks(t)).toEqual([]);
  });

  it("does not draw without the fill fields (no key · fixture · an older collector) and never fills unknowns with 0", () => {
    expect(trafficGridFill(undefined, NOW)).toBeNull();
    expect(trafficGridFill({ traffic_grid_state: "no_key", traffic_grid_at: "2026-09-30T18:55:40Z" }, NOW)).toBeNull();
    const v = trafficGridFill({
      traffic_grid_at: "2026-09-30T18:55:40Z", traffic_grid_state: "active",
      traffic_grid_cells_known: "12", traffic_grid_resolved: "", traffic_grid_pending: "x", traffic_grid_fill_state: "",
    }, NOW)!;
    expect(v.items.find((i) => i.key === "drawn")!.text).toBe("—");
    expect(v.items.find((i) => i.key === "pending")!.text).toBe("—");
    expect(v.items.find((i) => i.key === "not_found")!.text).toBe("—");
    expect(v.state.text).toBe("—");
    expect(v.pass.text).toBe("마지막 채우기 — 이 수집기 프로세스에서 아직 끝난 채우기가 없다");
  });

  it("a full queue and a tripped breaker are warnings; states it does not know are not guessed", () => {
    const v = trafficGridFill({ ...HB, traffic_grid_not_queued: "1200", traffic_grid_fill_state: "breaker", traffic_grid_fill_resume_at: "2026-09-30T18:23:17Z" }, NOW)!;
    expect(v.items.find((i) => i.key === "not_queued")).toMatchObject({ label: "대기열이 가득 차 못 넣은 칸(마지막 스냅샷)", text: "1,200", tone: "warn" });
    // 누계가 아니라 마지막으로 읽은 스냅샷의 서로 다른 칸 수다(검토 지적: 예전 수는 거절 횟수를 칸이라 불렀다)
    expect(v.items.find((i) => i.key === "not_queued")!.title).toContain("누계가 아니다");
    expect(v.state).toMatchObject({ text: "연달아 오류 — 잠시 쉼 · 다음 10-01 03:23 KST", tone: "warn" });
    expect(trafficGridFill({ ...HB, traffic_grid_fill_state: "something_new", traffic_grid_fill_resume_at: "" }, NOW)!.state.text).toBe("—");
    expect(trafficGridFill({ ...HB, traffic_grid_fill_state: "idle", traffic_grid_fill_resume_at: "" }, NOW)!.state.text).toBe("물을 칸 없음");
  });

  it("shows bbox tile progress from the collector's own fields (ADR-023 2026-10-01 bbox amendment) and nothing when a collector has no tiles", () => {
    const tiles = {
      ...HB,
      traffic_grid_tiles_done: "147", traffic_grid_tiles_queued: "12",
      traffic_grid_fill_pass_tiles: "151", traffic_grid_fill_pass_tile_cells: "29980", traffic_grid_fill_pass_tile_new: "17083",
      traffic_grid_fill_pass_tile_stored: "17090",
      traffic_grid_fill_pass_tile_splits: "1", traffic_grid_fill_pass_tile_errors: "0",
    };
    const v = trafficGridFill(tiles, NOW)!;
    expect(v.items.find((i) => i.key === "tiles")).toMatchObject({ label: "bbox 타일", text: "끝 147 · 대기 12", tone: "muted" });
    expect(v.items.find((i) => i.key === "tiles")!.title).toContain("32 km");
    expect(v.pass.text).toBe(
      "마지막 채우기 10-01 03:18:17 KST 끝 — 조회 290 → 찾음 268 · 해양격자에 없음 15 · 격자 밖 2 · 오류 5 · 타일 151 → 칸 29,980(새 17,083 · DB 저장 요청 17,090) · 나눔 1 · 오류 0",
    );
    // 타일 공급자가 없는 수집기(빈 값) · 예전 수집기(필드 없음)는 타일 항목 · 절을 싣지 않는다 — 0 으로 채우지 않는다
    for (const hb of [HB, { ...HB, traffic_grid_tiles_done: "", traffic_grid_tiles_queued: "", traffic_grid_fill_pass_tiles: "" }]) {
      const w = trafficGridFill(hb, NOW)!;
      expect(w.items.find((i) => i.key === "tiles")).toBeUndefined();
      expect(w.pass.text).not.toContain("타일");
    }
    expect(trafficGridFill({ ...tiles, traffic_grid_tiles_queued: "x" }, NOW)!.items.find((i) => i.key === "tiles")!.text).toBe("끝 147 · 대기 —");
    expect(trafficGridFill({ ...tiles, traffic_grid_fill_state: "waiting_tiles", traffic_grid_fill_resume_at: "" }, NOW)!.state).toMatchObject({
      text: "타일 진행 기록 읽기를 기다림", tone: "muted",
    });
    for (const t of texts(v)) expect(utcLeaks(t)).toEqual([]);
  });

  it("a stale heartbeat (a stopped or crashed collector) shows its last time, not the dead process's state and numbers", () => {
    // 120 s 는 api(TrafficGridReader.HEARTBEAT_MAX_AGE_S)와 같은 선이다 — 딱 120 s 는 아직 지금 값
    expect(trafficGridFill(HB, Date.parse("2026-09-30T18:57:40Z"))!.items).toHaveLength(8);
    const v = trafficGridFill(HB, Date.parse("2026-09-30T18:57:41Z"))!;
    expect(v.state).toMatchObject({ text: "heartbeat 오래됨 — 마지막 10-01 03:55:40 KST", tone: "warn" });
    expect(v.items).toEqual([]);
    const all = texts(v).join(" ");
    for (const leftover of ["7,571", "4,812", "3,504", "조회 중", "이 시의 채우기 몫", "찾음 268"]) expect(all).not.toContain(leftover);
    for (const t of texts(v)) expect(utcLeaks(t)).toEqual([]);
    // heartbeat 시각이 없거나 틀려도 지금 값으로 보이지 않는다
    const noAt = Object.fromEntries(Object.entries(HB).filter(([k]) => k !== "traffic_grid_at"));
    expect(trafficGridFill(noAt, NOW)!.items).toEqual([]);
    expect(trafficGridFill({ ...HB, traffic_grid_at: "yesterday" }, NOW)!.state.text).toBe("heartbeat 시각을 알 수 없음 — 수를 보이지 않는다");
    // 서버 시각보다 120 s 넘게 앞선 heartbeat 도 판정하지 않는다(시계가 어긋났다)
    expect(trafficGridFill({ ...HB, traffic_grid_at: "2026-09-30T19:05:00Z" }, NOW)!.state.text)
      .toBe("heartbeat 시각이 서버 시각보다 앞섬 — 10-01 04:05:00 KST");
  });

  it("without the server time it does not judge freshness with the browser clock — it shows no numbers", () => {
    const v = trafficGridFill(HB, 0)!;
    expect(v.items).toEqual([]);
    expect(v.state.text).toBe("서버 시각을 몰라 heartbeat 가 지금 값인지 판정하지 못함 — 마지막 10-01 03:55:40 KST");
  });

  it("a fresh heartbeat that says the layer is off (no key · fixture) hides the numbers an earlier process left", () => {
    for (const [state, text] of [["no_key", "꺼짐 — 공공데이터포털 키 없음"], ["fixture", "꺼짐 — fixture 모드"]] as const) {
      // _disabled() 는 traffic_grid_state 만 쓴다(HSET — 지우지 않는다): 예전 active 프로세스의 수가 해시에 남아 있다
      const v = trafficGridFill({ ...HB, traffic_grid_state: state }, NOW)!;
      expect(v.state).toMatchObject({ text, tone: "muted" });
      expect(v.items).toEqual([]);
      expect(texts(v).join(" ")).not.toContain("7,571");
    }
    // 운영자가 교통 호출(komsa_traffic)을 꺼도 채우기 필드는 이 프로세스가 지금 쓴 값이다 — 그대로 보인다
    expect(trafficGridFill({ ...HB, traffic_grid_state: "operator_off" }, NOW)!.items).toHaveLength(8);
    expect(trafficGridFill({ ...HB, traffic_grid_state: "" }, NOW)!.items).toEqual([]); // 모르는 상태는 짐작하지 않는다
  });

  it("renders as one row with KST only", () => {
    const html = renderToStaticMarkup(createElement(TrafficGridFill, { collector: HB, nowMs: NOW }));
    expect(htmlUtcLeaks(parseHtml(html))).toEqual([]);
    expect(html).toContain("연안 교통량 격자 위치");
    expect(renderToStaticMarkup(createElement(TrafficGridFill, { collector: {}, nowMs: NOW }))).toBe("");
    const stale = renderToStaticMarkup(createElement(TrafficGridFill, { collector: HB, nowMs: NOW + 10 * 60_000 }));
    expect(htmlUtcLeaks(parseHtml(stale))).toEqual([]);
    expect(stale).toContain("heartbeat 오래됨");
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
      "/api/v1/ops/providers": {
        providers: [], active: {}, collector: HB, switches: [], budget_days: [], budget_day_zone: "UTC", generated_at: "2026-09-30T18:56:00Z",
      },
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

  it("judges the heartbeat age by the response's server time — a collector that stopped 10 minutes ago shows no numbers", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse("2026-09-30T18:56:00Z") });
    const body: Record<string, unknown> = {
      "/api/v1/ops/session": { username: "op" },
      "/api/v1/ops/providers": {
        providers: [], active: {}, collector: HB, switches: [], budget_days: [], budget_day_zone: "UTC", generated_at: "2026-09-30T19:05:40Z",
      },
    };
    vi.stubGlobal("fetch", async (url: string) =>
      new Response(JSON.stringify(url in body ? body[url] : { items: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(React.createElement(OpsPage)); });
    for (let i = 0; i < 3; i++) await React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(byTestId("ops-traffic-grid-fill-state")!.textContent).toBe("heartbeat 오래됨 — 마지막 10-01 03:55:40 KST");
    expect(byTestId("ops-traffic-grid-fill-known")).toBeNull();
    expect(byTestId("ops-traffic-grid-fill")!.textContent).not.toContain("7,571");
  });
});
