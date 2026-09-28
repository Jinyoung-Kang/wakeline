/**
 * 리뷰 v1(docs/review/REVIEW-v1.md) 웹 UI 갈래 회귀 시험. 각 describe 는 한 발견 사항(R-xx)이다.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다(커밋 메시지·검증 기록 참고).
 */
import { readFileSync } from "node:fs";
import { createPropertyExpression, latest } from "@maplibre/maplibre-gl-style-spec";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
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
import type { SigmetCollection } from "@/lib/types";
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
  it("the UTC basis is visible next to the date-time input (browsers render it in their own locale format)", () => {
    const html = renderToStaticMarkup(createElement(ReplayPage));
    expect(html).toMatch(/>UTC<\/span><input type="datetime-local"/);
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
    setData({ alerts: new Map([[7, alert()]]), alertsVersion: 1, conn: "open" });
    const html = renderToStaticMarkup(createElement(SidePanelView, { panel: "alerts", hex: null, sigmet: null, airport: null }));
    const row = html.slice(html.indexOf('data-testid="alert-toggle"'), html.indexOf("</button>", html.indexOf('data-testid="alert-toggle"')));
    expect(row.match(/<span class="sr-only">, <\/span>/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});
