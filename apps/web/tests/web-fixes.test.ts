/**
 * 웹 리뷰 수정(2026-09-28): 서버 시계(WS-3/DH-1)·지상 고도(DH-3)·시정 단위(DH-7)·발효 전 SIGMET(DH-8)·알림 목록 상태(DH-9)·
 * 트래픽 범위(DH-10)·방위 모름/1분 요약(DH-11)·예측선 시작(DH-12)·예산 한도(DH-14)·예측 고도 표기(DH-15)·기상청 레이더 STALE(REL-19)·
 * 수정 전 히스테리시스 주의. 지도 식은 MapLibre 스타일 명세 구현으로 실제 평가한다(문자열 비교가 아니라 결과).
 */
import { createPropertyExpression, latest, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerClock } from "@/lib/server-clock";
import { fmtAltGnd, fmtBudgetLimit, fmtVisSm, GND_COLOR, isKrRadarStale, KR_RADAR_STALE_S } from "@/lib/format";
import {
  addBaseLayers, AIRCRAFT_COLOR_EXPR, AIRCRAFT_ICON_EXPR, AIRCRAFT_ROTATE_EXPR, predictionFeature, SIGMET_FILL_OPACITY_EXPR, SIGMET_LINE_DASH_EXPR, SIGMET_LINE_WIDTH_EXPR,
} from "@/lib/maplayers";
import { deadReckon } from "@/lib/interpolate";
import { activeSigmetFeatures, isPending } from "@/lib/sigmet";
import { aircraftTip, sigmetTip } from "@/lib/tooltip";
import { alertListState } from "@/lib/alerts";
import { HYSTERESIS_FIX_AT, preFixHysteresis, trafficScopeLabel } from "@/lib/chart";
import { isSummaryRow, replayAircraftTip, replayRecLabel } from "@/lib/replay";
import { resetData, setData } from "@/lib/store";
import { AlertPanel } from "@/components/AlertPanel";
import { StatusBar } from "@/components/StatusBar";
import type { AircraftState, Alert, KrRadar, SigmetCollection, SigmetProps } from "@/lib/types";

const NOW = Date.parse("2026-09-28T01:00:00Z");

/** MapLibre 스타일 식을 명세대로 컴파일해 속성으로 평가한다. spec = "paint_symbol.icon-color" 처럼 명세 위치 */
function evalExpr(expr: unknown, spec: string, properties: Record<string, unknown>, zoom = 8): unknown {
  const [group, prop] = spec.split(".");
  const propSpec = (latest as unknown as Record<string, Record<string, unknown>>)[group][prop];
  const r = createPropertyExpression(expr, `layers[0].${group.split("_")[0]}.${prop}`, propSpec as never);
  if (r.result !== "success") throw new Error(r.value.map((e) => `${e.key}: ${e.message}`).join("; "));
  return r.value.evaluate({ zoom } as never, { type: "Point", properties } as never);
}
const colorHex = (c: unknown) => {
  const x = c as { r: number; g: number; b: number };
  return "#" + [x.r, x.g, x.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
};

describe("map style validity", () => {
  it("every source and layer added by addBaseLayers validates against the MapLibre style spec (an invalid expression would drop the layer at runtime)", () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, Path2D: g.Path2D };
    const ctx = { fillStyle: "", fill: () => {}, beginPath: () => {}, getImageData: () => ({ width: 48, height: 48, data: new Uint8ClampedArray(48 * 48 * 4) }) };
    g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
    g.Path2D = class { constructor(public d: string) {} };
    const style = { version: 8 as const, sources: {} as Record<string, unknown>, layers: [] as unknown[] };
    const images: string[] = [];
    try {
      addBaseLayers({
        addImage: (id: string) => { images.push(id); },
        addSource: (id: string, src: unknown) => { style.sources[id] = src; },
        addLayer: (layer: unknown) => { style.layers.push(layer); },
      } as never);
    } finally { g.document = saved.document; g.Path2D = saved.Path2D; }
    expect(images).toEqual(["plane", "plane-nodir"]);
    expect(validateStyleMin(style as never).map((e) => e.message)).toEqual([]);
  });
});

describe("server clock estimate (WS-3)", () => {
  it("keeps the max of recent samples: latency only lowers a sample, so a delayed message never drags the offset down", () => {
    const c = new ServerClock(4);
    expect(c.offsetMs).toBeNull();
    expect(c.observe("2026-09-28T01:00:05Z", NOW)).toBe(true);
    expect(c.offsetMs).toBe(5_000);
    expect(c.observe("2026-09-28T01:00:01Z", NOW)).toBe(false); // 4 s 늦게 도착한 표본
    expect(c.offsetMs).toBe(5_000);
    c.observe("2026-09-28T01:00:05.300Z", NOW);
    expect(c.offsetMs).toBe(5_300);
  });
  it("old samples roll out of the window; garbage is ignored", () => {
    const c = new ServerClock(2);
    c.observe("2026-09-28T01:00:10Z", NOW);
    c.observe("2026-09-28T01:00:02Z", NOW);
    c.observe("2026-09-28T01:00:03Z", NOW);
    expect(c.offsetMs).toBe(3_000);
    expect(c.observe("not a time", NOW)).toBe(false);
    expect(c.observe(12345, NOW)).toBe(false);
    expect(c.offsetMs).toBe(3_000);
  });
  it("a browser wall-clock step (Date.now − performance.now jumps) discards samples from the old clock", () => {
    const c = new ServerClock(8, 2000);
    c.observe("2026-09-28T01:00:00Z", NOW, 1_000); // 오프셋 0
    // 브라우저 시계를 60 s 앞당김: 같은 서버 시각이 60 s 늦은 브라우저 시각에 도착, 단조 시계는 1 s 만 흐름
    c.observe("2026-09-28T01:00:01Z", NOW + 61_000, 2_000);
    expect(c.offsetMs).toBe(-60_000);
  });
});

describe("on-ground altitude (DH-3)", () => {
  it("GND instead of a fabricated 0 ft; a reported non-zero baro altitude is shown as a report", () => {
    expect(fmtAltGnd(0, true)).toBe("GND");
    expect(fmtAltGnd(null, true)).toBe("GND");
    expect(fmtAltGnd(1200, true)).toBe("GND (1,200 ft 보고)");
    expect(fmtAltGnd(0, false)).toBe("0 ft");
    expect(fmtAltGnd(35000, null)).toBe("FL350");
    expect(fmtAltGnd(null, undefined)).toBe("—");
    const t = aircraftTip({ hex: "71bc21" }, { hex: "71bc21", lat: 37.46, lon: 126.44, alt_ft: 0, on_ground: true, seen_at: "2026-09-28T00:59:58Z" }, NOW);
    expect(Object.fromEntries(t.rows).ALT).toBe("GND");
  });
  it("icon colour: on_ground → GND colour (not the 0 ft ramp colour); emergency and selection still win; unknown altitude grey", () => {
    const spec = "paint_symbol.icon-color";
    expect(colorHex(evalExpr(AIRCRAFT_COLOR_EXPR, spec, { on_ground: true, alt_ft: 0 }))).toBe(GND_COLOR);
    expect(colorHex(evalExpr(AIRCRAFT_COLOR_EXPR, spec, { on_ground: false, alt_ft: 0 }))).toBe("#3ec98f");
    expect(colorHex(evalExpr(AIRCRAFT_COLOR_EXPR, spec, { on_ground: true, emergency: true }))).toBe("#e5484d");
    expect(colorHex(evalExpr(AIRCRAFT_COLOR_EXPR, spec, { on_ground: true, selected: true }))).toBe("#ffffff");
    expect(colorHex(evalExpr(AIRCRAFT_COLOR_EXPR, spec, {}))).toBe("#6b737e");
  });
});

describe("unknown heading is not drawn as north (DH-11)", () => {
  it("track_deg missing → direction-less symbol with no rotation; known → plane rotated to the track", () => {
    const img = "layout_symbol.icon-image", rot = "layout_symbol.icon-rotate";
    expect(String(evalExpr(AIRCRAFT_ICON_EXPR, img, { track_deg: 250 }))).toBe("plane");
    expect(evalExpr(AIRCRAFT_ROTATE_EXPR, rot, { track_deg: 250 })).toBe(250);
    expect(String(evalExpr(AIRCRAFT_ICON_EXPR, img, {}))).toBe("plane-nodir");
    expect(String(evalExpr(AIRCRAFT_ICON_EXPR, img, { track_deg: null }))).toBe("plane-nodir");
    expect(evalExpr(AIRCRAFT_ROTATE_EXPR, rot, {})).toBe(0);
    // 0° 는 "북쪽"이라는 실제 값 — 모름과 구분된다
    expect(String(evalExpr(AIRCRAFT_ICON_EXPR, img, { track_deg: 0 }))).toBe("plane");
    const tip = aircraftTip({ hex: "a" }, { hex: "a", lat: 1, lon: 1, seen_at: "2026-09-28T00:59:58Z" }, NOW);
    expect(tip.flags.map((f) => f.text)).toContain("방위 모름 · 방향 없는 기호");
  });
  it("replay rows from the 1-minute summary are labelled as averages, not recorded positions", () => {
    const row = { hex: "71c081", lat: 36, lon: 127, alt_ft: 31000, gs_kt: 450, track_deg: null, on_ground: null, ts: "2026-09-20T08:43:00Z", provider: "1m_summary" };
    expect(isSummaryRow(row)).toBe(true);
    const t = replayAircraftTip(row, "2026-09-20T08:44:00Z");
    expect(t.flags[0].text).toContain("1분 평균");
    expect(t.flags.map((f) => f.text)).not.toContain("기록 위치 · 보간 없음");
    expect(Object.fromEntries(t.rows)).toMatchObject({ REC: "09-20 08:43:00Z – 08:44:00Z 평균", SRC: "1분 요약", TRK: "—" });
    const raw = { ...row, provider: "adsb_fi", ts: "2026-09-27T08:43:30Z" };
    expect(replayAircraftTip(raw, "2026-09-27T08:44:00Z").flags[0].text).toBe("기록 위치 · 보간 없음");
    expect(replayRecLabel(raw, "2026-09-27T08:44:00Z")).toBe("09-27 08:43:30Z (재생 시각 −30s)");
  });
});

describe("SIGMET not yet in force (DH-8)", () => {
  const f = (id: string, from: string, to: string) => ({
    type: "Feature" as const, id, geometry: { type: "MultiPolygon" as const, coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] },
    properties: { id, valid_from: from, valid_to: to, active: true, hazard: "TS", fir_id: "UTAA", series_id: "3", raw_text: "", provider: "awc", fetched_at: "", expiring_soon: false } as SigmetProps,
  });
  const fc = { type: "FeatureCollection", features: [f("now", "2026-09-28T00:00:00Z", "2026-09-28T04:00:00Z"), f("later", "2026-09-28T01:20:00Z", "2026-09-28T05:00:00Z")] } as SigmetCollection;

  it("future valid_from is carried as pending (kept on the map, drawn distinctly); unparseable → not claimed pending", () => {
    const out = activeSigmetFeatures(fc, NOW);
    expect(out.map((x) => [x.properties.id, x.properties.pending])).toEqual([["now", false], ["later", true]]);
    expect(isPending({ valid_from: "?" }, NOW)).toBe(false);
    expect(activeSigmetFeatures(fc, Date.parse("2026-09-28T01:20:00Z")).every((x) => !x.properties.pending)).toBe(true);
  });
  it("pending polygons: faint fill, fine dotted outline, never the thick 'aircraft inside' outline", () => {
    const fill = "paint_fill.fill-opacity", dash = "paint_line.line-dasharray", width = "paint_line.line-width";
    expect(evalExpr(SIGMET_FILL_OPACITY_EXPR, fill, { pending: true, inside: true })).toBe(0.04);
    expect(evalExpr(SIGMET_FILL_OPACITY_EXPR, fill, { inside: true })).toBe(0.28);
    expect(evalExpr(SIGMET_FILL_OPACITY_EXPR, fill, {})).toBe(0.15);
    expect(evalExpr(SIGMET_LINE_DASH_EXPR, dash, { pending: true, expiring_soon: true })).toEqual([0.6, 2.4]);
    expect(evalExpr(SIGMET_LINE_DASH_EXPR, dash, { expiring_soon: true })).toEqual([2, 2]);
    expect(evalExpr(SIGMET_LINE_WIDTH_EXPR, width, { pending: true, inside: true })).toBe(1.2);
    expect(evalExpr(SIGMET_LINE_WIDTH_EXPR, width, { inside: true })).toBe(3);
  });
  it("tooltip says '발효 전' with the start time and how long until then", () => {
    const t = sigmetTip({ ...fc.features[1].properties, inside: true }, NOW);
    expect(t.flags.map((x) => x.text)).toEqual(["발효 전 · 09-28 01:20:00Z부터 · 판정 전"]);
    expect(Object.fromEntries(t.rows)).toMatchObject({ STARTS: "20m 00s 뒤", LEFT: "4h 00m" });
    expect(sigmetTip(fc.features[0].properties, NOW).flags.map((x) => x.text)).not.toContain(expect.stringContaining("발효 전"));
  });
});

describe("10-min prediction line starts at 'now' like the engine (DH-12)", () => {
  const T = Date.parse("2026-09-27T12:00:00Z");
  const os: AircraftState = { hex: "o1", lat: 50, lon: 8, alt_ft: 36000, gs_kt: 480, track_deg: 270, seen_at: new Date(T - 150_000).toISOString(), provider: "opensky" };

  it("first point = observed position advanced by the age (150 s), last point = +10 min from there", () => {
    const g = predictionFeature(os, T)!.geometry.coordinates;
    const [lat0, lon0] = deadReckon(50, 8, 270, 480, 150);
    expect(g[0][0]).toBeCloseTo(lon0, 9);
    expect(g[0][1]).toBeCloseTo(lat0, 9);
    const [lat10, lon10] = deadReckon(lat0, lon0, 270, 480, 600);
    expect(g[10][0]).toBeCloseTo(lon10, 9);
    expect(g[10][1]).toBeCloseTo(lat10, 9);
    // 예전 방식(관측 위치에서 시작)이면 끝점이 2.5분 모자란다 — 약 20 NM
    expect(g[0][0]).toBeLessThan(8 - 0.2);
  });
  it("no line when the observation time is unknown, the state is past the stale limit, or it would cross ±180°", () => {
    expect(predictionFeature({ ...os, seen_at: null }, T)).toBeNull();
    expect(predictionFeature({ ...os, seen_at: new Date(T - 301_000).toISOString() }, T)).toBeNull();
    expect(predictionFeature({ ...os, provider: "adsb_fi", seen_at: new Date(T - 61_000).toISOString() }, T)).toBeNull();
    expect(predictionFeature({ ...os, lon: -179.9, seen_at: new Date(T).toISOString() }, T)).toBeNull();
    expect(predictionFeature({ ...os, lon: -179.9, track_deg: 90, seen_at: new Date(T).toISOString() }, T)).not.toBeNull();
  });
});

describe("small honesty fixes", () => {
  it("visibility carries its unit; '6+' is a lower bound (DH-7)", () => {
    expect(fmtVisSm("6+")).toBe("6 SM 이상");
    expect(fmtVisSm("10")).toBe("10 SM");
    expect(fmtVisSm(1.5)).toBe("1.5 SM");
    expect(fmtVisSm("1/2")).toBe("1/2 SM");
    expect(fmtVisSm("1 1/2")).toBe("1 1/2 SM");
    expect(fmtVisSm("M1/4")).toBe("M1/4"); // 모르는 형식은 원문 그대로, 단위를 지어 붙이지 않는다
    expect(fmtVisSm(null)).toBe("—");
  });
  it("unknown budget limit is — , 0 is unlimited ∞ (DH-14)", () => {
    expect(fmtBudgetLimit(undefined)).toBe("—");
    expect(fmtBudgetLimit(null)).toBe("—");
    expect(fmtBudgetLimit("")).toBe("—");
    expect(fmtBudgetLimit("abc")).toBe("—");
    expect(fmtBudgetLimit("0")).toBe("∞");
    expect(fmtBudgetLimit("2880")).toBe("2880");
  });
  it("traffic scope comes from the server; missing scope is '범위 미확인' (DH-10)", () => {
    expect(trafficScopeLabel("region", { center: [36.5, 127.8], radius_nm: 250 })).toEqual({ known: true, text: "관심 지역 · 중심 36.50, 127.80 · 반경 250 NM 원의 외접 bbox" });
    expect(trafficScopeLabel(null, null)).toEqual({ known: false, text: "범위 미확인(전세계 표본 포함 가능)" });
    expect(trafficScopeLabel("region", { center: [36.5], radius_nm: 250 }).known).toBe(false);
  });
  it("OBSERVED alert stats on/before the hysteresis fix day carry the caveat", () => {
    expect(HYSTERESIS_FIX_AT).toBe("2026-09-27T15:10:00Z");
    expect(preFixHysteresis({ day: "2026-09-27T00:00:00.000Z", metric: "alerts_by_kind", dim: "OBSERVED" })).toBe(true);
    expect(preFixHysteresis({ day: "2026-09-26T00:00:00.000Z", metric: "alert_dwell_avg_s", dim: "OBSERVED" })).toBe(true);
    expect(preFixHysteresis({ day: "2026-09-28T00:00:00.000Z", metric: "alerts_by_kind", dim: "OBSERVED" })).toBe(false);
    expect(preFixHysteresis({ day: "2026-09-27T00:00:00.000Z", metric: "alerts_by_kind", dim: "PREDICTED" })).toBe(false);
  });
  it("KMA radar STALE from the server flag or from the collection age via the server clock (REL-19)", () => {
    expect(isKrRadarStale({ meta: { stale: true, fetched_at: new Date(NOW).toISOString() } }, NOW)).toBe(true);
    expect(isKrRadarStale({ meta: { stale: false, fetched_at: new Date(NOW - 206_000).toISOString() } }, NOW)).toBe(false);
    expect(isKrRadarStale({ meta: { stale: false, fetched_at: new Date(NOW - (KR_RADAR_STALE_S + 1) * 1000).toISOString() } }, NOW)).toBe(true);
    expect(isKrRadarStale(null, NOW)).toBe(false);
  });
  it("alert list state: waiting before the first alerts message, disconnected keeps the last list (DH-9)", () => {
    expect(alertListState("connecting", null)).toBe("waiting");
    expect(alertListState("open", null)).toBe("waiting");
    expect(alertListState("open", 12)).toBe("live");
    expect(alertListState("closed", 12)).toBe("disconnected");
    expect(alertListState("connecting", 12)).toBe("disconnected");
    expect(alertListState("paused", 12)).toBe("paused");
  });
});

describe("rendered panels (server-side render, no DOM)", () => {
  const pred: Alert = {
    id: 7, kind: "PREDICTED", hex: "71c081", callsign: "KAL081", sigmet_id: "S", fir_id: "RKRR", hazard: "TS", entered_at: "2026-09-28T00:59:00Z",
    eta_s: 240, eta_at: "2026-09-28T01:04:00Z", alt_ft: 35000, evidence: { judged_at: "2026-09-28T01:00:00Z" }, estimated: true,
  };
  beforeEach(() => resetData());
  afterEach(() => resetData());

  it("before the first alerts message the panel says it is waiting, never 'no aircraft' (DH-9)", () => {
    setData({ conn: "open", alertsVersion: null });
    const html = renderToStaticMarkup(createElement(AlertPanel));
    expect(html).toContain("알림 목록 수신 대기");
    expect(html).not.toContain("항공기가 없습니다");
    setData({ conn: "open", alertsVersion: 3 });
    expect(renderToStaticMarkup(createElement(AlertPanel))).toContain("항공기가 없습니다");
  });
  it("after a disconnect the last list is marked stale and the ETA stops (DH-9); predicted altitude is marked 추정 (DH-15)", () => {
    setData({ conn: "open", alertsVersion: 3, alerts: new Map([[7, pred]]) });
    const live = renderToStaticMarkup(createElement(AlertPanel));
    expect(live).toContain('data-testid="alert-alt-est"');
    expect(live).toMatch(/class="mono est-val[^"]*"[^>]*title="진입 시 고도 — 추정/);
    expect(live).not.toContain('data-testid="alerts-stale"');
    setData({ conn: "closed" });
    const off = renderToStaticMarkup(createElement(AlertPanel));
    expect(off).toContain("연결 끊김 — 마지막으로 받은 목록 · 갱신 안 됨");
    expect(off).toContain("추정 ETA —");
  });
  it("status bar shows the KMA STALE badge from the server flag (REL-19)", () => {
    const kr: KrRadar = {
      available: true, latest_tm: "202609280130", georeferenced: true, coordinates: null, legend: null, frames: [{ tm: "202609280130", obs_tm: "202609280130", fetched_at: "x", echo_cells: 1, url: "/u" }],
      attribution: "기상청", meta: { fetched_at: "2026-09-27T16:33:40Z", stale: true },
    };
    setData({ conn: "open", lastRxAt: Date.now(), radarKr: kr });
    expect(renderToStaticMarkup(createElement(StatusBar))).toContain('data-testid="kr-radar-stale"');
    setData({ radarKr: { ...kr, meta: { ...kr.meta, stale: false, fetched_at: new Date().toISOString() } } });
    expect(renderToStaticMarkup(createElement(StatusBar))).not.toContain("KMA STALE");
  });
});
