/**
 * 리뷰 v1(docs/review/REVIEW-v1.md) 웹 UI 갈래 회귀 시험. 각 describe 는 한 발견 사항(R-xx)이다.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다(커밋 메시지·검증 기록 참고).
 */
import type { PublicStatus } from "@/lib/types";
import { readFileSync } from "node:fs";
import { createPropertyExpression, latest } from "@maplibre/maplibre-gl-style-spec";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { aircraftStates, resetData, setData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { panIfOutside } from "@/lib/focus";
import { SidePanelView } from "@/components/SidePanel";
import ReplayPage from "@/app/replay/page";
import Dashboard from "@/app/page";
import { LayerPanel } from "@/components/LayerPanel";
import * as prefs from "@/lib/prefs";
import { addBaseLayers } from "@/lib/maplayers";
import * as sigmetLib from "@/lib/sigmet";
import type { KrRadar, SigmetCollection } from "@/lib/types";
import { StatusBar } from "@/components/StatusBar";
import { KrRadarPanel } from "@/components/KrRadarPanel";
import { MapLegendView } from "@/components/MapLegend";
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
  it("with no frame (failed or not loaded yet) the inspector says the record is unknown, never 'no record' / 'not valid'", () => {
    const frame: ReplayFrame = { at: "2026-09-28T05:00:00Z", aircraft: [{ hex: "abc123", lat: 36, lon: 127 }], sigmets: [], source: "track_point" };
    // 프레임이 있으면 그 프레임에 없는 것 = 기록 없음 · 유효하지 않음(응답이 말해 준 사실)
    expect(replayLib.replayInspectorMiss({ kind: "aircraft", hex: "def456" }, frame, null)).toContain("기록 없음");
    expect(replayLib.replayInspectorMiss({ kind: "sigmet", id: "S9" }, frame, null)).toContain("유효하지 않은");
    // 실패했으면 모른다 — "없음"이라고 말하지 않는다
    const failed = replayLib.replayInspectorMiss({ kind: "aircraft", hex: "abc123" }, null, "요청 영역이 너무 넓음 — 지도를 확대하세요");
    expect(failed).toContain("불러오지 못해");
    expect(failed).not.toContain("기록 없음");
    const sgFailed = replayLib.replayInspectorMiss({ kind: "sigmet", id: "S1" }, null, "서버 오류(HTTP 503) — 기록을 불러오지 못함");
    expect(sgFailed).not.toContain("유효하지 않은");
    // 아직 응답 전
    expect(replayLib.replayInspectorMiss({ kind: "aircraft", hex: "abc123" }, null, null)).toContain("불러오는 중");
  });
});

const UI0 = useUi.getState();
afterEach(() => { resetData(); useUi.setState(UI0, true); });

/** 관심 지역 설정(R-09: 설정을 받기 전에는 관심 지역 목록을 보이지 않는다) — 아래 알림 위치(31.2, 121.5)를 덮는 지역 */
const REGION_STATUS = { server_time: "2026-09-28T01:00:00Z", region: { center: [31.2, 121.5], radius_nm: 300, provider: "adsb_fi", aircraft: 1, lag_s: 1, stale: false, fetched_at: null } } as unknown as PublicStatus;

const alert = (o: Partial<Alert> = {}): Alert => ({
  id: 7, kind: "OBSERVED", hex: "780f47", callsign: "CCA402", sigmet_id: "S1", fir_id: "ZSHA", hazard: "TURB", qualifier: "SEV",
  entered_at: "2026-09-28T01:00:00Z", alt_ft: 27600, evidence: { position: [31.2, 121.5] }, estimated: false, ...o,
});

describe("R-08 alert row: expand stays, selection moves the map", () => {
  it("the alert list stays mounted (hidden) while another panel shows, so its expanded rows and scroll survive a selection", () => {
    setData({ alerts: new Map([[7, alert()]]), alertsVersion: 1, conn: "open", status: REGION_STATUS });
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
  it("the on-screen check uses the visible map bounds, not the WS subscription band: zoom 3 over the Pacific does not count France as on screen", () => {
    // 줌 3, 화면 약 49E ~ 153W(MapLibre 는 펼친 경도 49 ~ 207 을 준다) — 구독은 날짜변경선 규칙으로 위도 띠 전체(lib/viewport)
    const sub = subscriptionBbox(49, 5, 207, 62, 3, 128);
    expect(sub).toEqual([-180, 5, 180, 62]);
    setData({ viewport: { bbox: sub, zoom: 3 }, mapBounds: [49, 5, 207, 62] });
    // 수정 전: 구독 띠 [-180, 5, 180, 62] 와 비교해 프랑스(LFRR)도 "화면 안" → 옮기지 않았다
    expect(panIfOutside([-2, 47])).toBe(true);
    expect(useUi.getState().flyTo).toMatchObject({ lon: -2, lat: 47, zoom: 3 });
    useUi.setState({ flyTo: null });
    expect(panIfOutside([140, 35])).toBe(false); // 도쿄 — 보인다
    expect(panIfOutside([-160, 21])).toBe(false); // 호놀룰루 — 날짜변경선 너머지만 보인다(펼친 경도 200)
    expect(useUi.getState().flyTo).toBeNull();
    // 한 바퀴 넘게 보이는 화면(줌 0–1)이면 경도는 어디든 보인다
    setData({ mapBounds: [-300, -80, 300, 80] });
    expect(panIfOutside([-2, 47])).toBe(false);
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
  it("the toolbar has a KST date-time input and ±1 min / ±10 min / ±1 h steps besides the slider", () => {
    const html = renderToStaticMarkup(createElement(ReplayPage));
    expect(html).toMatch(/<input[^>]*type="datetime-local"[^>]*aria-label="재생 시각\(KST\)"|<input[^>]*aria-label="재생 시각\(KST\)"[^>]*type="datetime-local"/);
    for (const t of ["−1h", "−10m", "−1m", "+1m", "+10m", "+1h"]) expect(html).toContain(`>${t}</button>`);
    expect(html).toContain('role="group" aria-label="재생 시각 이동"');
  });
  it("the KST basis is visible next to the date-time input (browsers render it in their own locale format)", () => {
    const html = renderToStaticMarkup(createElement(ReplayPage));
    expect(html).toMatch(/>KST<\/span><input type="datetime-local"/);
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
  it("KST input round-trips and steps are clamped to the range (midnight cases: tests/kst-replay.test.ts)", () => {
    const r = replayLib.replayRange(Date.parse("2026-09-28T06:00:00Z"));
    expect(replayLib.toKstInput(Date.parse("2026-09-28T03:05:40Z"))).toBe("2026-09-28T12:05");
    expect(replayLib.fromKstInput("2026-09-28T12:05")).toBe(Date.parse("2026-09-28T03:05:00Z"));
    expect(replayLib.fromKstInput("")).toBeNull();
    expect(replayLib.fromKstInput("2026-02-30T03:05")).toBeNull();
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
    expect(html).toContain("09-28 10:00:00 KST"); // 운영 화면은 한국 표준시
  });
  it("permanent losses (rejected rows, apply errors, listener errors) are loss rows too", () => {
    const rows = opsLib.pipelineRows({ ...resp, api: { ...resp.api, track_rows_failed: 2, ship_rows_failed: 0, stream_apply_errors: 1, listener_errors: 0 } });
    const by = (k: string) => rows.find((r) => r.group === "api" && r.key === k)!;
    expect(by("track_rows_failed")).toMatchObject({ value: 2, tone: "bad" });
    expect(by("ship_rows_failed")).toMatchObject({ value: 0, tone: "ok" });
    expect(by("stream_apply_errors")).toMatchObject({ value: 1, tone: "bad" });
    expect(by("listener_errors")).toMatchObject({ value: 0, tone: "ok" });
    // 예전 api(필드 없음)면 모름
    expect(opsLib.pipelineRows(resp).find((r) => r.key === "track_rows_failed")!.text).toBe("—");
  });
  it("R-14 stream budget trims (collector: aircraft stream, ais: ships stream) are shown as counts, not losses (shared field contract); unknown is —", () => {
    const trims = { ...resp, collector: { ...resp.collector, stream_budget_trims: 2 }, ais: { ...resp.ais, stream_budget_trims: 0 } };
    const rows = opsLib.pipelineRows(trims);
    const by = (g: string) => rows.find((r) => r.group === g && r.key === "stream_budget_trims");
    // 예산 트림은 보존 창을 줄일 뿐 손실이 아니다 — 읽기 전에 잘린 것만 api stream_trim_loss_events 가 센다(tests/ops-pipeline-window.test.ts)
    expect(by("collector")).toMatchObject({ value: 2, tone: "muted", text: "2" });
    expect(by("ais")).toMatchObject({ value: 0, tone: "muted", text: "0" });
    expect(by("collector")!.label).toMatch(/트림/);
    expect(opsLib.pipelineLossCount(trims)).toBe(4); // 수정 전 5 — 트림을 손실로 셌다
    // 필드가 없거나(예전 api·heartbeat 오래됨 → null) 형식이 틀리면 모름 — 0 으로 보이지 않는다
    const unknown = opsLib.pipelineRows({ ...resp, collector: { ...resp.collector, stream_budget_trims: null }, ais: { stream_budget_trims: "3" } });
    expect(unknown.filter((r) => r.key === "stream_budget_trims").map((r) => [r.group, r.text, r.tone])).toEqual([["collector", "—", "muted"], ["ais", "—", "muted"]]);
    const html = renderToStaticMarkup(createElement(pipelineView.OpsPipeline, { data: trims }));
    expect(html).toMatch(/data-key="stream_budget_trims" data-tone="muted"/);
    expect(html).not.toMatch(/data-key="stream_budget_trims" data-tone="bad"/);
  });
  it("a trimmed range whose start is unknown (from=null) is still shown, with the start marked unknown", () => {
    const unknownStart = { ...resp, api: { ...resp.api, last_stream_trim_loss: { stream: "wakeline:ships", from: null, to: "2026-09-28T01:02:00Z" } } };
    expect(opsLib.lastTrimLoss(unknownStart)).toEqual({ stream: "wakeline:ships", from: null, to: "2026-09-28T01:02:00Z" });
    const html = renderToStaticMarkup(createElement(pipelineView.OpsPipeline, { data: unknownStart }));
    expect(html).toContain("wakeline:ships");
    expect(html).toContain("시작 모름");
    expect(html).toContain("09-28 10:02:00 KST");
    expect(opsLib.lastTrimLoss({ api: { last_stream_trim_loss: { stream: "wakeline:ships", from: 5, to: "x" } } })).toBeNull();
  });
  it("a trim start that cannot be read is \"—\" in the text and the tooltip (never the word undefined)", () => {
    const badStart = { ...resp, api: { ...resp.api, last_stream_trim_loss: { stream: "wakeline:ships", from: "garbage", to: "2026-09-28T01:02:00Z" } } };
    const html = renderToStaticMarkup(createElement(pipelineView.OpsPipeline, { data: badStart }));
    expect(html).not.toContain("undefined");
    expect(html).toContain('title="— – 원본 UTC 2026-09-28T01:02:00.000Z"');
    expect(html).toContain("wakeline:ships · — – 09-28 10:02:00 KST");
  });
});

describe("R-35 settings: the version is taken when editing starts, so a refresh cannot defeat If-Match", () => {
  it("an edit keeps the version it started from; a newer server version is a visible conflict, not a silent overwrite", () => {
    const v3 = { key: "region_radius_nm", value: 250, version: 3 };
    const e1 = opsLib.editSetting(undefined, v3, "300");
    expect(e1).toEqual({ value: "300", version: 3 });
    // 15 s 새로고침이 다른 운영자의 변경(v4)을 가져온 뒤에도 계속 입력
    const v4 = { ...v3, value: 200, version: 4 };
    const e2 = opsLib.editSetting(e1, v4, "310");
    expect(e2.version).toBe(3);
    expect(opsLib.settingIfMatch(e2)).toBe("3"); // 수정 전: 새로고침된 s.version(4)을 보내 서버 잠금을 통과했다
    expect(opsLib.settingConflict(e2, v4)).toBe(true);
    expect(opsLib.settingConflict(e1, v3)).toBe(false);
    expect(opsLib.settingConflict(undefined, v4)).toBe(false);
    // 운영자가 "덮어쓰기"를 고르면 그때 본 서버 version 으로 옮긴다
    expect(opsLib.rebaseSetting(e2, v4)).toEqual({ value: "310", version: 4 });
  });
});

describe("R-39 narrow screens (390 px phone, 768 px tablet)", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  it("below 900 px the side panel stacks under the map at full width instead of a fixed 380 px column", () => {
    const html = renderToStaticMarkup(createElement(Dashboard));
    expect(html).toMatch(/class="[^"]*flex-col[^"]*min-\[900px\]:flex-row/);
    expect(html).toMatch(/<aside[^>]*class="[^"]*w-full[^"]*min-\[900px\]:w-\[380px\]/);
  });
  it("the layer buttons wrap inside the map (bounded on the left) instead of running off screen", () => {
    const html = renderToStaticMarkup(createElement(LayerPanel));
    expect(html).toMatch(/class="[^"]*left-12[^"]*"/);
    expect(html).toMatch(/class="[^"]*flex-wrap[^"]*"[^>]*data-testid="layer-panel"/);
  });
  it("buttons never break inside a Korean word; the legend starts closed on narrow screens", () => {
    expect(css).toMatch(/\.btn \{[^}]*white-space: nowrap;[^}]*word-break: keep-all;/);
    expect(prefs.legendDefaultOpen(390)).toBe(false);
    expect(prefs.legendDefaultOpen(768)).toBe(false);
  });
});

/** addBaseLayers 가 만든 레이어 정의(지도 없이) */
type LayerDef = { id: string; layout?: Record<string, unknown>; paint?: Record<string, unknown> };
function baseLayers(): Record<string, LayerDef> {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, Path2D: g.Path2D };
  const ctx = { fillStyle: "", fill: () => {}, beginPath: () => {}, getImageData: () => ({ width: 48, height: 48, data: new Uint8ClampedArray(48 * 48 * 4) }) };
  g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
  g.Path2D = class { constructor(public d: string) {} };
  const out: Record<string, LayerDef> = {};
  try {
    addBaseLayers({ addImage: () => {}, addSource: () => {}, addLayer: (l: LayerDef) => { out[l.id] = l; } } as never);
  } finally { g.document = saved.document; g.Path2D = saved.Path2D; }
  return out;
}
function evalLayout(expr: unknown, prop: string, properties: Record<string, unknown>): unknown {
  const spec = (latest as unknown as Record<string, Record<string, unknown>>).layout_symbol[prop];
  const r = createPropertyExpression(expr, `layers[0].layout.${prop}`, spec as never);
  if (r.result !== "success") throw new Error(r.value.map((e) => e.message).join("; "));
  return r.value.evaluate({ zoom: 8 } as never, { type: "Point", properties } as never);
}

describe("R-40 keyboard paths to SIGMETs, airports and replay items; airport category not by colour alone", () => {
  it("airport labels (zoom >= 7) carry the flight category as text; stale or unknown METAR shows the code only", () => {
    const tf = baseLayers()["airport-label"].layout!["text-field"];
    const txt = (p: Record<string, unknown>) => String(evalLayout(tf, "text-field", p));
    expect(txt({ icao: "RKSI", flight_cat: "IFR" })).toBe("RKSI IFR");
    expect(txt({ icao: "RKSS", flight_cat: "LIFR" })).toBe("RKSS LIFR");
    expect(txt({ icao: "RKPC", flight_cat: "IFR", stale: true })).toBe("RKPC");
    expect(txt({ icao: "RKPK", flight_cat: null })).toBe("RKPK");
  });
  const fc: SigmetCollection = {
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "MultiPolygon", coordinates: [[[[120, 30], [124, 30], [124, 34], [120, 34], [120, 30]]]] },
        properties: { id: "S1", fir_id: "ZSHA", fir_name: "SHANGHAI", series_id: "A1", hazard: "TURB", qualifier: "SEV", valid_from: "2026-09-28T00:00:00Z", valid_to: "2026-09-28T04:00:00Z", active: true, expiring_soon: false, raw_text: "", provider: "awc", fetched_at: "2026-09-28T00:00:00Z" } },
      { type: "Feature", geometry: { type: "MultiPolygon", coordinates: [[[[170, 50], [-170, 50], [-170, 55], [170, 55], [170, 50]]]] },
        properties: { id: "S2", fir_id: "PAZA", series_id: "B2", hazard: "ICE", valid_from: "2026-09-28T00:00:00Z", valid_to: "2026-09-28T04:00:00Z", active: true, expiring_soon: false, raw_text: "", provider: "awc", fetched_at: "2026-09-28T00:00:00Z" } },
      { type: "Feature", geometry: { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
        properties: { id: "S3", fir_id: "EGTT", series_id: "C3", hazard: "TS", valid_from: "2026-09-27T00:00:00Z", valid_to: "2026-09-27T04:00:00Z", active: false, expiring_soon: false, raw_text: "", provider: "awc", fetched_at: "2026-09-28T00:00:00Z" } },
    ],
  };
  it("the SIGMET list has the active warnings, aircraft-inside counts from the live alert list (— when unknown) and a pan target", () => {
    const now = Date.parse("2026-09-28T01:00:00Z");
    const items = sigmetLib.sigmetListItems(fc, [alert({ sigmet_id: "S2", hex: "a1" }), alert({ id: 8, sigmet_id: "S2", hex: "a2" }), alert({ id: 9, kind: "PREDICTED", sigmet_id: "S1", hex: "a3" })], now);
    expect(items.map((i) => i.id)).toEqual(["S2", "S1"]); // 만료(S3) 제외 · 안 항공기 많은 순
    expect(items[0]).toMatchObject({ inside: 2, predicted: 0 });
    expect(items[1]).toMatchObject({ inside: 0, predicted: 1 });
    expect(items[1].center).toEqual([122, 32]);
    expect(items[0].center![0]).toBeCloseTo(180, 6); // 날짜변경선을 넘는 폴리곤의 가운데
    const unknown = sigmetLib.sigmetListItems(fc, null, now);
    expect(unknown[0].inside).toBeNull();
  });
  it("the sigmet and airport tabs list their items as buttons when nothing is selected (no map click needed)", async () => {
    const { SigmetListView } = await import("@/components/SigmetList");
    const now = Date.parse("2026-09-28T01:00:00Z");
    const sl = renderToStaticMarkup(createElement(SigmetListView, { items: sigmetLib.sigmetListItems(fc, [], now) }));
    expect(sl).toMatch(/<button[^>]*data-testid="sigmet-list-item"[^>]*>.*TURB SEV/);
    expect(sl).toContain("ZSHA");
    const { AirportListView } = await import("@/components/AirportList");
    const al = renderToStaticMarkup(createElement(AirportListView, {
      state: "done", now,
      features: [
        { type: "Feature", geometry: { type: "Point", coordinates: [126.45, 37.46] }, properties: { icao: "RKSI", name: "Incheon", flight_cat: "IFR", obs_time: "2026-09-28T00:30:00Z" } },
        { type: "Feature", geometry: { type: "Point", coordinates: [126.79, 37.56] }, properties: { icao: "RKSS", name: "Gimpo", flight_cat: "VFR", obs_time: "2026-09-27T20:00:00Z" } },
      ],
    }));
    expect(al).toMatch(/data-testid="airport-list-item"[^>]*>.*RKSI.*IFR/);
    expect(al).toMatch(/RKSS.*METAR 오래됨/); // 2 h 넘은 METAR 는 카테고리를 현재처럼 보이지 않는다
    expect(SidePanelView).toBeTypeOf("function");
    const tab = renderToStaticMarkup(createElement(SidePanelView, { panel: "sigmet", hex: null, sigmet: null, airport: null }));
    expect(tab).toContain('data-testid="sigmet-list"');
  });
  it("replay: the frame's SIGMETs and aircraft are listed as buttons that open the inspector", async () => {
    const { ReplayListView } = await import("@/components/ReplayList");
    const frame: ReplayFrame = {
      at: "2026-09-28T05:00:00Z", source: "track_point",
      aircraft: [{ hex: "abc123", lat: 36, lon: 127, callsign: "KAL123" }, { hex: "def456", lat: 35, lon: 128 }],
      sigmets: [{ id: "S1", hazard: "TS", fir_id: "RKRR", valid_from: "2026-09-28T04:00:00Z", valid_to: "2026-09-28T08:00:00Z", raw_text: "", geometry: null }],
    };
    const html = renderToStaticMarkup(createElement(ReplayListView, { frame, q: "", onPick: () => {} }));
    expect(html).toMatch(/data-testid="replay-list-sigmet"[^>]*>.*TS.*RKRR/);
    expect(html).toMatch(/data-testid="replay-list-aircraft"[^>]*>.*KAL123/);
    expect(html).toMatch(/data-testid="replay-list-aircraft"[^>]*>.*def456/);
    expect(renderToStaticMarkup(createElement(ReplayListView, { frame, q: "kal", onPick: () => {} }))).not.toContain("def456");
  });
});

describe("R-30 structure for assistive technology", () => {
  it("each route has its own document title (template on the root layout)", async () => {
    const root = (await import("@/app/layout")).metadata as { title: { default: string; template: string } };
    expect(root.title.template).toContain("%s");
    const titles = await Promise.all(["replay", "stats", "ops"].map(async (r) => (await import(`@/app/${r}/layout.tsx`)).metadata.title as string));
    const about = (await import("@/app/about/page")).metadata?.title as string | undefined;
    const airport = (await import("@/app/airports/[icao]/layout")).metadata.title as string;
    const all = [root.title.default, ...titles, about, airport];
    expect(all.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });
  it("pages without a visible heading get a screen-reader h1; the shell starts with skip links and a focusable main", async () => {
    expect(renderToStaticMarkup(createElement(Dashboard))).toMatch(/<h1 class="sr-only">[^<]+<\/h1>/);
    expect(renderToStaticMarkup(createElement(ReplayPage))).toMatch(/<h1 class="sr-only">[^<]+<\/h1>/);
    const { Shell } = await import("@/components/Shell");
    const html = renderToStaticMarkup(createElement(Shell, null, createElement("p", null, "x")));
    expect(html.indexOf('href="#main"')).toBeGreaterThan(-1);
    expect(html.indexOf('href="#main"')).toBeLessThan(html.indexOf("<header"));
    expect(html).toMatch(/<main[^>]*id="main"[^>]*tabindex="-1"|<main[^>]*tabindex="-1"[^>]*id="main"/i);
    expect(renderToStaticMarkup(createElement(Dashboard))).toMatch(/<aside[^>]*id="side-panel"/);
  });
  it("on-map credit links are out of the Tab order (the same links are in the footer)", async () => {
    const { mapAttributionHtml } = await import("@/lib/attribution");
    const html = mapAttributionHtml();
    const anchors = html.match(/<a /g)!.length;
    expect(anchors).toBeGreaterThan(5);
    expect(html.match(/<a [^>]*tabindex="-1"/g)?.length ?? 0).toBe(anchors);
  });
  it("alert rows are read with pauses between fields", () => {
    setData({ alerts: new Map([[7, alert()]]), alertsVersion: 1, conn: "open", status: REGION_STATUS });
    const html = renderToStaticMarkup(createElement(SidePanelView, { panel: "alerts", hex: null, sigmet: null, airport: null }));
    const row = html.slice(html.indexOf('data-testid="alert-toggle"'), html.indexOf("</button>", html.indexOf('data-testid="alert-toggle"')));
    expect(row.match(/<span class="sr-only">, <\/span>/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});

describe("R-31 legend and status bar on common laptop screens", () => {
  it("the legend starts closed below 1600 px (1280x720 and 1440x900 lost 23-27 % of the map to it)", () => {
    expect(prefs.legendDefaultOpen(1280)).toBe(false);
    expect(prefs.legendDefaultOpen(1440)).toBe(false);
    expect(prefs.legendDefaultOpen(1600)).toBe(true);
  });
  it("an opened legend stops above the on-map credit line instead of covering it", () => {
    const html = renderToStaticMarkup(createElement(LayerPanel));
    expect(html).toMatch(/class="pointer-events-none absolute[^"]*bottom-16/);
    expect(html).not.toMatch(/class="pointer-events-none absolute[^"]*bottom-3[ "]/);
  });
  it("the KMA STALE badge sits at the front of the status bar, not past the scroll edge", () => {
    const kr: KrRadar = {
      available: true, latest_tm: "202609280130", georeferenced: true, coordinates: null, legend: null, frames: [{ tm: "202609280130", obs_tm: "202609280130", fetched_at: "x", echo_cells: 1, url: "/u" }],
      attribution: "기상청", meta: { fetched_at: "2026-09-27T16:33:40Z", stale: true },
    };
    setData({ conn: "open", lastRxAt: Date.now(), radarKr: kr });
    const html = renderToStaticMarkup(createElement(StatusBar));
    expect(html.indexOf('data-testid="kr-radar-stale"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="kr-radar-stale"')).toBeLessThan(html.indexOf('data-testid="aircraft-count"'));
  });
});

describe("R-32 / R-45 statistics readable: labels, units, honest empty states, date-only days", () => {
  it("day values: 'YYYY-MM-DD' as is; a UTC-midnight timestamp is read as that date; anything else is unknown (—), never shifted", async () => {
    const stats = await import("@/lib/stats");
    expect(stats.statsDay("2026-09-27")).toBe("2026-09-27");
    expect(stats.statsDay("2026-09-27T00:00:00.000Z")).toBe("2026-09-27"); // 옛 응답(UTC JVM)
    expect(stats.statsDay("2026-09-26T15:00:00.000Z")).toBeNull(); // KST JVM 이 만든 자정 — 날짜를 단정하지 않는다
    expect(stats.statsDay(null)).toBeNull();
    expect(stats.statsDay("2026-02-30")).toBeNull();
  });
  it("alert stats become one row per day and kind with Korean labels and units instead of raw metric keys", async () => {
    const stats = await import("@/lib/stats");
    const rows = stats.alertStatsRows([
      { day: "2026-09-27", metric: "alerts_by_kind", dim: "OBSERVED", value: 19546 },
      { day: "2026-09-27", metric: "alert_dwell_avg_s", dim: "OBSERVED", value: 784.55 },
      { day: "2026-09-27", metric: "alerts_by_kind", dim: "PREDICTED", value: 120 },
      { day: "2026-09-28", metric: "alerts_by_kind", dim: "OBSERVED", value: 10 },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ day: "2026-09-27", kind: "관측(경보 안)", count: "19,546건", dwell: "13m 05s", preFix: true });
    expect(rows[1]).toMatchObject({ kind: "예측(추정)", count: "120건", dwell: "—", preFix: false });
    expect(rows[2]).toMatchObject({ day: "2026-09-28", dwell: "—", preFix: false });
    const { AlertStatsTable } = await import("@/components/AlertStatsTable");
    const html = renderToStaticMarkup(createElement(AlertStatsTable, { rows }));
    expect(html).not.toMatch(/alert_dwell_avg_s|alerts_by_kind/);
    expect(html).toContain("평균 체류");
    expect(html).toContain("날짜(UTC 날짜)"); // 집계 날짜는 UTC 날짜 그대로(KST 날짜로 옮기지 않는다)
  });
  it("rows whose day cannot be read stay separate ('—' each) instead of one row where one day's value overwrites another's", async () => {
    const stats = await import("@/lib/stats");
    const rows = stats.alertStatsRows([
      { day: "2026-09-25T15:00:00.000Z", metric: "alerts_by_kind", dim: "OBSERVED", value: 100 }, // KST JVM 자정 — 날짜를 모른다(R-45)
      { day: "2026-09-25T15:00:00.000Z", metric: "alert_dwell_avg_s", dim: "OBSERVED", value: 600 }, // 같은 원문 날짜 = 같은 날의 다른 지표
      { day: "2026-09-26T15:00:00.000Z", metric: "alerts_by_kind", dim: "OBSERVED", value: 5 },
      { day: null, metric: "alerts_by_kind", dim: "OBSERVED", value: 7 },
      { day: undefined, metric: "alerts_by_kind", dim: "OBSERVED", value: 9 },
    ]);
    // 수정 전: 모두 "—|OBSERVED" 한 행으로 묶여 마지막 값(9건)만 남았다
    expect(rows.map((r) => [r.day, r.count, r.dwell])).toEqual([["—", "100건", "10m 00s"], ["—", "5건", "—"], ["—", "7건", "—"], ["—", "9건", "—"]]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length); // 표의 React key 가 겹치지 않는다
  });
  it("empty states say whether the day was not aggregated yet, never aggregated, or aggregated with no data", async () => {
    const stats = await import("@/lib/stats");
    const today = "2026-09-28";
    expect(stats.statsEmptyText(false, "2026-09-27", today)).toContain("다음 12:30 KST");
    expect(stats.statsEmptyText(false, "2020-01-01", today)).not.toContain("다음 12:30");
    expect(stats.statsEmptyText(false, "2020-01-01", today)).toContain("집계되지 않은 날짜");
    expect(stats.statsEmptyText(true, "2026-09-20", today)).toContain("자료가 없습니다");
    expect(stats.statsEmptyText(undefined, "2026-09-20", today)).toContain("구분할 수 없");
    expect(stats.aggregatedFlag({ aggregated: false })).toBe(false);
    expect(stats.aggregatedFlag({ aggregated: "no" })).toBeUndefined();
    expect(stats.yesterdayUtc(Date.parse("2026-09-28T01:00:00Z"))).toBe("2026-09-27");
  });
  it("traffic: a fill is promised only while the raw tracks (72 h) are still kept at the next aggregation attempt", async () => {
    const stats = await import("@/lib/stats");
    // api: track-retention-hours 72 · MaintenanceJobs.families 는 그날 끝 > now − 72 h 일 때만 교통량을 다시 센다 · 따라잡기 3 h 마다
    const src = (iso: string) => ({ name: "원본 항적", retentionH: 72, nowMs: Date.parse(iso) });
    const today = "2026-09-28";
    // 5일 전(09-23): 그날 끝(09-24 00Z) + 72 h = 09-27 00Z < 지금 → 원본이 없다. 수정 전: "다음 03:30 UTC(지금은 12:30 KST) 집계 뒤 채워집니다"
    const gone = stats.statsEmptyText(false, "2026-09-23", today, src("2026-09-28T01:00:00Z"));
    expect(gone).not.toContain("다음 12:30");
    expect(gone).not.toMatch(/채워집니다/);
    expect(gone).toContain("채워지지 않습니다");
    expect(gone).toContain("72 h");
    // 3일 전(09-25): 원본은 09-29 00Z 까지 — 01Z 에는 약속, 22Z 에는 다음 따라잡기(≤ 3 h) 전에 지워질 수 있어 약속하지 않는다
    expect(stats.statsEmptyText(false, "2026-09-25", today, src("2026-09-28T01:00:00Z"))).toContain("다음 12:30 KST");
    const soon = stats.statsEmptyText(false, "2026-09-25", today, src("2026-09-28T22:00:00Z"));
    expect(soon).not.toMatch(/채워집니다/);
    expect(soon).toContain("채워지지 않을 수 있습니다");
    // 어제는 그대로 약속한다 · 원본 보존을 모르는(넘기지 않은) 계열은 기존 규칙(따라잡기 7일)
    expect(stats.statsEmptyText(false, "2026-09-27", today, src("2026-09-28T23:59:00Z"))).toContain("다음 12:30 KST");
    expect(stats.statsEmptyText(false, "2026-09-23", today)).toContain("다음 12:30 KST");
    // 교통량 차트가 이 원본 보존 규칙으로 빈 상태를 말한다
    expect(stats.TRAFFIC_SOURCE).toEqual({ name: "원본 항적", retentionH: 72 });
    expect(readFileSync(new URL("../app/stats/page.tsx", import.meta.url), "utf8")).toMatch(/statsEmptyText\(agg\.traffic, day, today, \{ \.\.\.TRAFFIC_SOURCE, nowMs: /);
  });
  it("bar labels are not cut to four characters: long labels are rotated and the full text is in a tooltip", async () => {
    const { BarChart } = await import("@/components/BarChart");
    const html = renderToStaticMarkup(createElement(BarChart, { id: "c", title: "t", rows: [{ label: "TURB", value: 3 }, { label: "SBAOYMMMWAAF", value: 1 }] }));
    expect(html).not.toContain("SBAO…");
    expect(html).toMatch(/<title>SBAOYMMMWAAF<\/title>/);
    expect(html).toMatch(/transform="rotate\(-45/);
  });
});

describe("R-47 replay: a request made while one is in flight is sent when it finishes (latest wins)", () => {
  type Req = { at: number; bbox: string };
  function harness() {
    const calls: Req[] = [];
    const pending: { resolve: (f: ReplayFrame) => void; reject: (e: unknown) => void }[] = [];
    const events: { type: string; at?: string }[] = [];
    const loader = new replayLib.ReplayLoader(
      (r) => { calls.push(r); return new Promise<ReplayFrame>((resolve, reject) => pending.push({ resolve, reject })); },
      (e) => events.push(e.type === "loaded" ? { type: e.type, at: e.frame.at } : { type: e.type }),
    );
    const frame = (at: number): ReplayFrame => ({ at: new Date(at).toISOString(), aircraft: [], sigmets: [], source: "track_point" });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    return { calls, pending, events, loader, frame, tick };
  }
  it("the last (at, bbox) asked during a slow request is fetched afterwards; intermediate ones are skipped", async () => {
    const h = harness();
    h.loader.request({ at: 1000, bbox: "a" });
    h.loader.request({ at: 2000, bbox: "a" }); // 수정 전: inflight 이면 return — 이 요청과
    h.loader.request({ at: 3000, bbox: "b" }); // 이 요청이 사라지고 라벨만 3000 으로 남았다
    expect(h.calls).toEqual([{ at: 1000, bbox: "a" }]);
    h.pending[0].resolve(h.frame(1000));
    await h.tick();
    expect(h.calls).toEqual([{ at: 1000, bbox: "a" }, { at: 3000, bbox: "b" }]);
    h.pending[1].resolve(h.frame(3000));
    await h.tick();
    expect(h.events.at(-1)).toEqual({ type: "loaded", at: new Date(3000).toISOString() });
  });
  it("a failure that is already superseded does not clear the map; a same request is not sent twice", async () => {
    const h = harness();
    h.loader.request({ at: 1000, bbox: "a" });
    h.loader.request({ at: 2000, bbox: "a" });
    h.pending[0].reject(new ApiError(500, "x"));
    await h.tick();
    expect(h.events.some((e) => e.type === "failed")).toBe(false);
    h.pending[1].resolve(h.frame(2000));
    await h.tick();
    h.loader.request({ at: 2000, bbox: "a" });
    h.loader.request({ at: 5000, bbox: "a" });
    h.loader.request({ at: 2000, bbox: "a" }); // 대기 요청이 방금 보낸 것과 같아지면 다시 보내지 않는다
    h.pending[2].resolve(h.frame(2000));
    await h.tick();
    expect(h.calls.length).toBe(3);
    h.loader.dispose();
  });
  it("a failure is reported when the request queued behind it asks for the same (at, bbox) again (T1 → T2 → T1, T1 fails)", async () => {
    const h = harness();
    h.loader.request({ at: 1000, bbox: "a" }); // T1 보내는 중(느림)
    h.loader.request({ at: 2000, bbox: "a" }); // +1m → T2 대기
    h.loader.request({ at: 1000, bbox: "a" }); // −1m → 다시 T1 대기(보내는 중인 것과 같다)
    h.pending[0].reject(new ApiError(500, "x"));
    await h.tick();
    // 수정 전: 대기 요청이 있어 실패를 알리지 않았고, finally 가 같은 요청이라 대기 요청도 버렸다 — events=[] · calls=1 → "불러오는 중"이 끝나지 않았다
    expect(h.events).toEqual([{ type: "failed" }]);
    expect(h.calls).toEqual([{ at: 1000, bbox: "a" }]); // 같은 요청을 곧바로 다시 보내지는 않는다
    h.loader.dispose();
  });
});

describe("R-56 ops forms: client validation, Korean status messages, distinct success/failure", () => {
  it("the login form requires both fields and an 8+ character password before sending, with Korean inline messages", async () => {
    const { OpsLogin } = await import("@/components/OpsLogin");
    const html = renderToStaticMarkup(createElement(OpsLogin, { onLogin: () => {}, notice: null }));
    expect(html).toMatch(/<input[^>]*id="ops-user"[^>]*required=""/);
    expect(html).toMatch(/<input[^>]*id="ops-pass"[^>]*minLength="8"[^>]*required=""|<input[^>]*id="ops-pass"[^>]*required=""[^>]*minLength="8"/i);
    expect(opsLib.validateLogin("", "")).toEqual({ field: "user", text: "아이디를 입력하세요." });
    expect(opsLib.validateLogin("op", "short7!")).toEqual({ field: "pass", text: "비밀번호는 8자 이상입니다." });
    expect(opsLib.validateLogin("op", "long-enough")).toBeNull();
  });
  it("login errors are mapped per status (429 with the wait from Retry-After, network), never the raw English detail", () => {
    expect(opsLib.loginErrorText(new ApiError(401, "bad credentials"))).toContain("올바르지 않습니다");
    expect(opsLib.loginErrorText(new ApiError(400, "invalid request"))).toContain("8자 이상");
    expect(opsLib.loginErrorText(new ApiError(429, "too many login attempts", 42))).toContain("42초");
    expect(opsLib.loginErrorText(new ApiError(429, "too many login attempts"))).toContain("잠시 뒤");
    expect(opsLib.loginErrorText(new ApiError(503, "unavailable"))).toContain("일시적으로");
    expect(opsLib.loginErrorText(new TypeError("Failed to fetch"))).toContain("연결할 수 없습니다");
    for (const e of [new ApiError(400, "invalid request"), new ApiError(429, "too many login attempts")]) expect(opsLib.loginErrorText(e)).not.toMatch(/invalid request|too many/);
  });
  it("ApiError carries Retry-After seconds from the response", async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = g.document;
    g.document = { cookie: "" };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ detail: "too many login attempts" }), { status: 429, headers: { "Retry-After": "42", "Content-Type": "application/json" } }));
    try {
      const { apiSend } = await import("@/lib/api");
      const e = await apiSend("POST", "/api/v1/ops/session", {}).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).retryAfterS).toBe(42);
    } finally { vi.unstubAllGlobals(); g.document = saved; }
  });
  it("settings inputs follow the server rules per key (number range, checkbox, pattern) and are checked before PUT", () => {
    expect(opsLib.settingSpec("region_radius_nm")).toMatchObject({ kind: "int", min: 50, max: 500 });
    expect(opsLib.settingSpec("global_enabled")).toMatchObject({ kind: "bool" });
    expect(opsLib.parseSetting("region_radius_nm", "300")).toEqual({ ok: true, value: 300 });
    expect(opsLib.parseSetting("region_radius_nm", "abc")).toMatchObject({ ok: false });
    expect(opsLib.parseSetting("region_radius_nm", "600")).toMatchObject({ ok: false, error: expect.stringContaining("50–500") });
    expect(opsLib.parseSetting("global_enabled", "true")).toEqual({ ok: true, value: true });
    expect(opsLib.parseSetting("aircraft_providers", "adsb_lol,opensky")).toEqual({ ok: true, value: "adsb_lol,opensky" });
    expect(opsLib.parseSetting("aircraft_providers", "adsb_lol,foo")).toMatchObject({ ok: false });
    expect(opsLib.parseSetting("region_center", "37.5,127")).toEqual({ ok: true, value: "37.5,127" });
    expect(opsLib.parseSetting("region_center", "99,127")).toMatchObject({ ok: false });
    expect(opsLib.parseSetting("ais_bboxes", "")).toEqual({ ok: true, value: "" }); // 빈 값 = .env 사용(서버 규칙)
    expect(opsLib.parseSetting("ais_bboxes", "123")).toEqual({ ok: true, value: "123" }); // 수정 전: 숫자처럼 보이면 숫자로 보냈다
  });
  it("an unwatched airport page says so in Korean instead of 'airport not watched: ZZZZ'", async () => {
    const { airportErrorText } = await import("@/lib/format");
    expect(airportErrorText(new ApiError(404, "airport not watched: ZZZZ"), "ZZZZ")).toBe("감시 공항 목록에 없는 코드입니다: ZZZZ — 감시 공항만 기상 이력을 보관합니다.");
    expect(airportErrorText(new TypeError("Failed to fetch"), "RKSI")).toContain("연결할 수 없습니다");
  });
});

describe("R-57 KMA radar legend numbers meet WCAG AA contrast", () => {
  // GET /api/v1/radar/kr legend(리뷰에서 확인한 값) — 45/50/55 dBZ 칸이 검은 글자로 3.52 / 3.00 / 3.48 : 1 이었다
  const legend: [number, number[]][] = [[10, [0, 200, 255]], [20, [0, 180, 0]], [30, [255, 255, 0]], [40, [255, 128, 0]], [45, [200, 0, 60]], [50, [160, 0, 160]], [55, [120, 60, 220]]];
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const hex = (h: string) => (h.length === 4 ? [1, 2, 3].map((i) => parseInt(h[i] + h[i], 16)) : [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  const cells = (html: string) => [...html.matchAll(/style="background:rgb\((\d+),(\d+),(\d+)\);color:(#[0-9a-f]{6}|#[0-9a-f]{3})"[^>]*>(\d+)</gi)]
    .map((m) => ({ bg: [Number(m[1]), Number(m[2]), Number(m[3])], fg: hex(m[4]), lo: Number(m[5]) }));
  const kr: KrRadar = {
    available: true, latest_tm: "202609280130", georeferenced: true, coordinates: null, legend, min_dbz: "10",
    frames: [{ tm: "202609280130", obs_tm: "202609280130", fetched_at: "2026-09-28T01:31:00Z", echo_cells: 1, url: "/u" }],
    attribution: "기상청", meta: { fetched_at: "2026-09-28T01:31:00Z", stale: false },
  };
  it("the legend panel and the map legend pick black or white per cell so every number reaches 4.5:1", () => {
    setData({ radarKr: kr });
    const panel = cells(renderToStaticMarkup(createElement(KrRadarPanel, { onClose: () => {} })));
    const layers = { radar: true, sigmet: false, aircraft: false, ships: false, airports: false, tracks: false, prediction: false };
    const mapLegend = cells(renderToStaticMarkup(createElement(MapLegendView, { id: "l", layers, radarSource: "kma" })));
    for (const list of [panel, mapLegend]) {
      expect(list.map((c) => c.lo)).toEqual([10, 20, 30, 40, 45, 50, 55]);
      for (const c of list) expect(ratio(c.bg, c.fg), `${c.lo} dBZ`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("R-59 SIGMET card names the aircraft inside", () => {
  it("each hex shows the callsign and altitude from the live alert (or the live aircraft state); unknown stays —; hex is lowercase", async () => {
    setData({ alerts: new Map([[7, alert({ sigmet_id: "S1", hex: "780f47", callsign: "CCA402", alt_ft: 27600 })], [8, alert({ id: 8, sigmet_id: "S9", hex: "7823a9", callsign: "OTHER" })]]) });
    aircraftStates.set("7823a9", { hex: "7823a9", lat: 31, lon: 121, callsign: "CES501", alt_ft: 31000 });
    const { InsideAircraftList } = await import("@/components/SigmetCard");
    const html = renderToStaticMarkup(createElement(InsideAircraftList, { sigmetId: "S1", hexes: ["780f47", "7823a9", "abcdef"] }));
    expect(html).toMatch(/data-hex="780f47"[^>]*>.*CCA402.*FL276/);
    expect(html).toMatch(/data-hex="7823a9"[^>]*>.*CES501.*FL310/); // 이 SIGMET 알림은 없고 실시간 상태만 있음
    expect(html).not.toContain("OTHER"); // 다른 SIGMET 의 알림 콜사인을 붙이지 않는다
    expect(html).toMatch(/data-hex="abcdef"[^>]*>.*—/);
    expect(html).toMatch(/class="[^"]*normal-case![^"]*"[^>]*data-hex="780f47"/);
    expect(html).toMatch(/aria-label="CCA402[^"]*780f47/);
  });
});
