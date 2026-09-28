/**
 * 리뷰 v1(docs/review/REVIEW-v1.md) 웹 UI 갈래 회귀 시험. 각 describe 는 한 발견 사항(R-xx)이다.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다(커밋 메시지·검증 기록 참고).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { aircraftStates, resetData, setData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { panIfOutside } from "@/lib/focus";
import { SidePanelView } from "@/components/SidePanel";
import ReplayPage from "@/app/replay/page";
import * as replayLib from "@/lib/replay";
import * as opsLib from "@/lib/ops";
import * as pipelineView from "@/components/OpsPipeline";
import type { Alert } from "@/lib/types";
import { subscriptionBbox } from "@/lib/viewport";
import { fmtReplayBbox, REPLAY_MAX_AREA_SQDEG, replayQueryBbox, replayReduce, type ReplayFrame } from "@/lib/replay";

const area = (b: number[]) => (b[2] - b[0]) * (b[3] - b[1]);
/** 서버(Bbox.parse)와 같은 방식: 문자열 네 숫자 → 면적 */
const serverArea = (s: string) => area(s.split(",").map(Number));

describe("R-05 replay request area and stale frame", () => {
  it("a zoomed-out screen (the review's 90,10,170,60 = 4000 sq°) is cut to the server cap around the map centre, keeping the aspect", () => {
    const view = subscriptionBbox(90, 10, 170, 60, Infinity, 127.8); // 수정 전 ReplayMap 이 그대로 보내던 값
    expect(area(view)).toBe(4000);
    const q = replayQueryBbox(view, [127.8, 36.5]);
    expect(q.clamped).toBe(true);
    expect(serverArea(fmtReplayBbox(q.bbox))).toBeLessThanOrEqual(REPLAY_MAX_AREA_SQDEG);
    const [w, s, e, n] = q.bbox;
    expect(w).toBeLessThan(127.8); expect(e).toBeGreaterThan(127.8); expect(s).toBeLessThan(36.5); expect(n).toBeGreaterThan(36.5);
    expect((e - w) / (n - s)).toBeCloseTo(80 / 50, 6);
    // 화면 안에 머문다
    expect(w).toBeGreaterThanOrEqual(90); expect(e).toBeLessThanOrEqual(170); expect(s).toBeGreaterThanOrEqual(10); expect(n).toBeLessThanOrEqual(60);
  });
  it("a small screen is sent unchanged; the formatted bbox never grows past the cap through rounding", () => {
    const small = replayQueryBbox([124, 33, 132, 39], [128, 36]);
    expect(small).toEqual({ bbox: [124, 33, 132, 39], clamped: false });
    expect(fmtReplayBbox([124, 33, 132, 39])).toBe("124.000,33.000,132.000,39.000");
    const world = replayQueryBbox([-180, -85, 180, 85], [0, 0]);
    expect(world.clamped).toBe(true);
    expect(serverArea(fmtReplayBbox(world.bbox))).toBeLessThanOrEqual(REPLAY_MAX_AREA_SQDEG);
    // 가운데가 화면 끝이면 상자를 안쪽으로 민다(범위 밖 좌표를 보내지 않는다)
    const edge = replayQueryBbox([-180, -85, 180, 85], [179.9, 84.9]);
    expect(edge.bbox[2]).toBeLessThanOrEqual(180); expect(edge.bbox[3]).toBeLessThanOrEqual(85);
  });
  it("a failed request clears the previous frame instead of leaving it under the new time label, with a Korean hint", () => {
    const frame: ReplayFrame = { at: "2026-09-28T05:00:00Z", aircraft: [{ hex: "abc123", lat: 36, lon: 127 }], sigmets: [], source: "track_point" };
    const loaded = replayReduce({ frame: null, err: null, latencyMs: null }, { type: "loaded", frame, latencyMs: 40 });
    expect(loaded.frame).toBe(frame);
    const failed = replayReduce(loaded, { type: "failed", error: new ApiError(422, "bbox area 4000 sq° exceeds 2500") });
    expect(failed.frame).toBeNull();
    expect(failed.err).toContain("확대");
    expect(failed.err).not.toContain("exceeds");
    expect(replayReduce(loaded, { type: "failed", error: new TypeError("Failed to fetch") }).err).toContain("연결");
  });
});

const UI0 = useUi.getState();
afterEach(() => { resetData(); useUi.setState(UI0, true); });

const alert = (o: Partial<Alert> = {}): Alert => ({
  id: 7, kind: "OBSERVED", hex: "780f47", callsign: "CCA402", sigmet_id: "S1", fir_id: "ZSHA", hazard: "TURB", qualifier: "SEV",
  entered_at: "2026-09-28T01:00:00Z", alt_ft: 27600, evidence: { position: [31.2, 121.5] }, estimated: false, ...o,
});

describe("R-08 alert row: expand stays, selection moves the map", () => {
  it("the alert list stays mounted (hidden) while another panel shows, so its expanded rows and scroll survive a selection", () => {
    setData({ alerts: new Map([[7, alert()]]), alertsVersion: 1, conn: "open" });
    // 수정 전 app/page.tsx 는 panel === "alerts" 일 때만 AlertPanel 을 렌더했다(선택하면 언마운트 → 펼침·스크롤 소실)
    const html = renderToStaticMarkup(createElement(SidePanelView, { panel: "aircraft", hex: "780f47", sigmet: null, airport: null }));
    expect(html).toContain('data-testid="aircraft-card"');
    expect(html).toMatch(/<div[^>]*hidden=""[^>]*><div class="flex h-full flex-col" data-testid="alert-panel"/);
    const alertsTab = renderToStaticMarkup(createElement(SidePanelView, { panel: "alerts", hex: null, sigmet: null, airport: null }));
    expect(alertsTab).not.toMatch(/hidden=""[^>]*><div class="flex h-full flex-col" data-testid="alert-panel"/);
    expect(alertsTab).toContain('data-testid="alert-toggle"');
    expect(alertsTab).not.toContain('aria-expanded="true"'); // 펼치지 않은 행은 근거 영역도 없다
  });
  it("selecting from a list pans to a known position outside the current view, keeping the zoom; inside the view it does not move", () => {
    setData({ viewport: { bbox: [124, 33, 132, 39], zoom: 6 } });
    expect(panIfOutside([127.5, 36.1])).toBe(false);
    expect(useUi.getState().flyTo).toBeNull();
    expect(panIfOutside([121.5, 31.2])).toBe(true);
    expect(useUi.getState().flyTo).toMatchObject({ lon: 121.5, lat: 31.2, zoom: 6 });
    expect(panIfOutside(null)).toBe(false); // 위치 모름 — 움직이지 않는다
  });
  it("the aircraft position comes from the live state first, then the alert's evidence position ([lat, lon])", async () => {
    const { aircraftPos } = await import("@/lib/focus");
    expect(aircraftPos("780f47", alert())).toEqual([121.5, 31.2]);
    aircraftStates.set("780f47", { hex: "780f47", lat: 31.9, lon: 122.4 });
    expect(aircraftPos("780f47", alert())).toEqual([122.4, 31.9]);
    expect(aircraftPos("000000", null)).toBeNull();
  });
});

describe("R-10 replay time can be picked precisely across the 30-day summary window", () => {
  it("the toolbar has a UTC date-time input and ±1 min / ±10 min / ±1 h steps besides the slider", () => {
    const html = renderToStaticMarkup(createElement(ReplayPage));
    expect(html).toMatch(/<input[^>]*type="datetime-local"[^>]*aria-label="재생 시각\(UTC\)"|<input[^>]*aria-label="재생 시각\(UTC\)"[^>]*type="datetime-local"/);
    for (const t of ["−1h", "−10m", "−1m", "+1m", "+10m", "+1h"]) expect(html).toContain(`>${t}</button>`);
    expect(html).toContain('role="group" aria-label="재생 시각 이동"');
  });
  it("the range reaches back 30 days (1-minute summary) and marks the 72 h full-resolution boundary", () => {
    const now = Date.parse("2026-09-28T06:00:00Z");
    const r = replayLib.replayRange(now);
    expect(r.max).toBe(now - 60_000);
    expect(r.min).toBe(now - 30 * 86400_000);
    expect(r.fullResFrom).toBe(now - 72 * 3600_000);
    expect(replayLib.replayZone(now - 3600_000, r)).toBe("full");
    expect(replayLib.replayZone(now - 4 * 86400_000, r)).toBe("summary");
  });
  it("UTC input round-trips and steps are clamped to the range", () => {
    const r = replayLib.replayRange(Date.parse("2026-09-28T06:00:00Z"));
    expect(replayLib.toUtcInput(Date.parse("2026-09-28T03:05:40Z"))).toBe("2026-09-28T03:05");
    expect(replayLib.fromUtcInput("2026-09-28T03:05")).toBe(Date.parse("2026-09-28T03:05:00Z"));
    expect(replayLib.fromUtcInput("")).toBeNull();
    expect(replayLib.fromUtcInput("2026-02-30T03:05")).toBeNull();
    expect(replayLib.stepAt(r.max - 30_000, 3600_000, r)).toBe(r.max);
    expect(replayLib.stepAt(r.min + 1000, -600_000, r)).toBe(r.min);
    expect(replayLib.stepAt(Date.parse("2026-09-28T03:05:00Z"), 60_000, r)).toBe(Date.parse("2026-09-28T03:06:00Z"));
  });
});

describe("R-12 ops: an expired session goes back to sign-in, sign-out always leaves", () => {
  it("a 401/404 from an ops call is an expiry only when the session probe also fails with 401/404", async () => {
    const gone = () => Promise.reject(new ApiError(404, "no such resource"));
    const alive = () => Promise.resolve({ username: "op" });
    const down = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await opsLib.classifyOpsError(new ApiError(404, "no such resource"), gone)).toBe("expired");
    expect(await opsLib.classifyOpsError(new ApiError(401, "unauthorized"), gone)).toBe("expired");
    // 세션은 살아 있음 → 그 엔드포인트만 문제(예: 아직 없는 경로) — 로그아웃시키지 않는다
    expect(await opsLib.classifyOpsError(new ApiError(404, "no such resource"), alive)).toBe("error");
    // 확인할 수 없음(네트워크) → 로그아웃시키지 않는다
    expect(await opsLib.classifyOpsError(new ApiError(404, "no such resource"), down)).toBe("error");
    expect(await opsLib.classifyOpsError(new ApiError(500, "boom"), gone)).toBe("error");
  });
  it("sign-out returns to the login screen even when the server call fails (no unhandled rejection)", async () => {
    let left = 0;
    const expired = await opsLib.signOut(() => Promise.reject(new ApiError(404, "no such resource")), () => { left++; });
    expect(left).toBe(1);
    expect(expired).toEqual({ ok: true, note: null }); // 이미 만료 — 서버에 남은 세션 없음
    const net = await opsLib.signOut(() => Promise.reject(new TypeError("Failed to fetch")), () => { left++; });
    expect(left).toBe(2);
    expect(net.ok).toBe(false);
    expect(net.note).toContain("서버 세션");
    expect(await opsLib.signOut(() => Promise.resolve(undefined), () => { left++; })).toEqual({ ok: true, note: null });
    expect(left).toBe(3);
  });
});

describe("R-18 ops pipeline tab: loss counters are visible, unknown is —", () => {
  const resp = {
    collector: { publish_dropped: 3, db_dropped: 0, db_pending: 12, heartbeat_age_s: 4.2 },
    ais: { dropped_total: null, quarantined_total: 7 },
    api: {
      track_queue_dropped: 0, ship_queue_dropped: 2, receipts_force_released: 0, dlq: 1, stream_trim_loss_events: 1,
      last_stream_trim_loss: { stream: "wakeline:aircraft", from: "2026-09-28T01:00:00Z", to: "2026-09-28T01:02:00Z" },
    },
    generated_at: "2026-09-28T01:05:00Z",
  };
  it("rows: non-zero loss counters are 'bad', zero is 'ok', null / malformed is '—' (never 0)", () => {
    const rows = opsLib.pipelineRows(resp);
    const by = (g: string, k: string) => rows.find((r) => r.group === g && r.key === k)!;
    expect(by("collector", "publish_dropped")).toMatchObject({ value: 3, tone: "bad", text: "3" });
    expect(by("collector", "db_dropped")).toMatchObject({ value: 0, tone: "ok", text: "0" });
    expect(by("ais", "dropped_total")).toMatchObject({ value: null, text: "—" });
    expect(by("api", "ship_queue_dropped").tone).toBe("bad");
    expect(by("api", "dlq").tone).toBe("bad");
    expect(by("api", "stream_trim_loss_events").tone).toBe("bad");
    expect(by("collector", "db_pending").tone).toBe("muted"); // 대기열은 손실이 아니다
    expect(by("collector", "heartbeat_age_s").text).toBe("4s");
    const bad = opsLib.pipelineRows({ collector: { publish_dropped: -1, db_dropped: "5" }, api: {} });
    expect(bad.find((r) => r.key === "publish_dropped")!.text).toBe("—");
    expect(bad.find((r) => r.key === "db_dropped")!.text).toBe("—");
    expect(bad.find((r) => r.key === "dlq")!.text).toBe("—");
    expect(opsLib.pipelineLossCount(resp)).toBe(4);
    expect(opsLib.pipelineLossCount(null)).toBeNull();
  });
  it("the tab renders every counter, highlights losses and names the last trimmed range", () => {
    const html = renderToStaticMarkup(createElement(pipelineView.OpsPipeline, { data: resp }));
    expect(html).toContain('data-testid="ops-pipeline"');
    expect(html).toMatch(/data-key="publish_dropped" data-tone="bad"/);
    expect(html).toMatch(/data-key="dropped_total" data-tone="muted"[^>]*>.*?—/);
    expect(html).toContain("wakeline:aircraft");
    expect(html).toContain("09-28 01:00:00Z");
  });
});
