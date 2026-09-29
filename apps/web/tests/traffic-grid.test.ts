/**
 * 연안 교통량(ADR-023) — 한국해양교통안전공단 5분 집계 격자별 선박 척수를 해양격자 4단계 칸(0.025°)에 칠한다(개별 선박 위치가 아니다).
 * 응답 검증(틀린 칸은 버린다 · ok 가 아니면 칸 없음) · 칸 → 정사각형 · 색 구간(범례와 지도가 같은 표 · MapLibre 스타일 규격) · 툴팁(격자 번호 · 척수 ·
 * 밀집도 % · 기준 KST · UTC) · 상태 줄(모든 상태의 이유를 글로) · ETag 조회(304 · 같은 ETag 면 다시 그리지 않음) · 레이어 토글 기억 · 범례 · 출처.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import {
  addTrafficGridLayers, parseTrafficGrid, TRAFFIC_BINS, TRAFFIC_CELL_DEG, TRAFFIC_LAYER_LABEL, TRAFFIC_LAYERS, TRAFFIC_LEGEND_NOTE, TRAFFIC_POLL_MS,
  TRAFFIC_SOURCE, TRAFFIC_URL, TRAFFIC_VISIBLE_MIN_GAP_MS, TRAFFIC_ZERO_COLOR, trafficColor, trafficColorExpr, trafficDrawable, TrafficGridPoller,
  trafficGridFeatures, trafficGridTip, trafficStaleAt, trafficStatusLine, trafficTimeText, type TrafficGrid, type TrafficPollState,
} from "@/lib/traffic-grid";
import { loadLayers, saveLayers } from "@/lib/prefs";
import { attributionText, CREDITS } from "@/lib/attribution";
import { resetData, setData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { MapLegendView } from "@/components/MapLegend";
import { LayerPanelView } from "@/components/LayerPanel";
import AboutPage from "@/app/about/page";

const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<");

function body(over: Record<string, unknown> = {}) {
  return {
    available: true, status: "ok", disabled_reason: null,
    reg_dt_kst: "2026-09-29T18:05:05+09:00", reg_dt_utc: "2026-09-29T09:05:05Z", fetched_at: "2026-09-29T09:06:01.250Z",
    age_s: 70, stale_after_s: 900, total: 3, total_count: 3, partial: false, rejected: 0, resolved: 2, unresolved: 1, pending: 1, not_found: 0,
    off_grid: 0, failed: 0, invalid_cells: 0, cell_deg: 0.025,
    cells: [["GR4_F2K41_C3", 37.45, 126.6, 12, 34.0], ["GR4_F2K41_D3", 37.425, 126.6, 102, 100.0]],
    source: { provider: "한국해양교통안전공단 MTIS 실시간 해양교통정보", grid: "해양수산부 해양격자 4단계", note: "5분 집계 — 격자별 선박 척수(개별 위치 아님)" },
    time_zone: "x", meta: { stale: false },
    ...over,
  };
}
const grid = (over: Record<string, unknown> = {}) => parseTrafficGrid(body(over)) as TrafficGrid;
const NOW_UNKNOWN = { reg_dt_kst: null, reg_dt_utc: null, fetched_at: null, age_s: null, total: null, total_count: null, partial: null, rejected: null,
  resolved: null, unresolved: null, pending: null, not_found: null, off_grid: null, failed: null, invalid_cells: null, cells: [] };
const REG_MS = Date.parse("2026-09-29T09:05:05Z");

describe("parseTrafficGrid: only verified shapes reach the map", () => {
  it("keeps valid cells of an ok snapshot", () => {
    const g = grid();
    expect(g.available).toBe(true);
    expect(g.cells).toEqual([["GR4_F2K41_C3", 37.45, 126.6, 12, 34], ["GR4_F2K41_D3", 37.425, 126.6, 102, 100]]);
    expect(g.dropped).toBe(0);
  });
  it("drops cells that are malformed or off the 0.025° lattice and counts them — never repairs them", () => {
    const g = grid({ cells: [["GR4_OK", 37.45, 126.6, 1, 0], ["GR4 BAD", 37.45, 126.6, 1, 0], ["GR4_OFF", 37.4512, 126.6, 1, 0], ["GR4_NEG", 37.45, 126.6, -1, 0],
      ["GR4_PCT", 37.45, 126.6, 1, 101], ["GR4_SHORT", 37.45, 126.6, 1], "x", ["GR4_TOP", 90, 126.6, 1, 0]] });
    expect(g.cells.map((c) => c[0])).toEqual(["GR4_OK"]);
    expect(g.dropped).toBe(7);
  });
  it("a non-ok status never draws cells even if some came along; the disabled reason is kept only for disabled", () => {
    expect(grid({ status: "stale", available: false }).cells).toEqual([]);
    expect(grid({ status: "ok", available: false }).available).toBe(false); // 서로 맞지 않으면 쓰지 않는다
    expect(grid({ status: "disabled", available: false, disabled_reason: "no_key", ...NOW_UNKNOWN }).disabled_reason).toBe("no_key");
    expect(grid({ status: "no_data", available: false, disabled_reason: "no_key", ...NOW_UNKNOWN }).disabled_reason).toBeNull();
    expect(grid({ status: "disabled", available: false, disabled_reason: "made_up", ...NOW_UNKNOWN }).disabled_reason).toBeNull();
  });
  it("rejects bodies that are not the contract", () => {
    for (const bad of [null, 1, "x", [], {}, { status: "fresh", available: true }, { status: "ok" }]) expect(parseTrafficGrid(bad)).toBeNull();
  });
});

describe("cells → map squares, colour scale shared by map and legend", () => {
  it("each cell is one closed 0.025° square with grid_no, count and density", () => {
    const fc = trafficGridFeatures(grid().cells);
    expect(fc.features).toHaveLength(2);
    const f = fc.features[0];
    expect(f.properties).toEqual({ g: "GR4_F2K41_C3", v: 12, d: 34 });
    const ring = f.geometry.coordinates[0];
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    expect(ring[2][0] - ring[0][0]).toBeCloseTo(TRAFFIC_CELL_DEG, 12);
    expect(ring[2][1] - ring[0][1]).toBeCloseTo(TRAFFIC_CELL_DEG, 12);
  });
  it("bins are ordered, start at 1 and the expression matches trafficColor for every count", () => {
    expect(TRAFFIC_BINS.map((b) => b.min)).toEqual([1, 2, 4, 8, 16, 32]);
    expect(TRAFFIC_BINS.map((b) => b.label)).toEqual(["1", "2–3", "4–7", "8–15", "16–31", "32+"]);
    const expr = trafficColorExpr();
    const evalStep = (v: number) => { let c = expr[2] as string; for (let i = 3; i < expr.length; i += 2) if (v >= (expr[i] as number)) c = expr[i + 1] as string; return c; };
    for (const v of [0, 1, 2, 3, 4, 7, 8, 15, 16, 31, 32, 102, 1000]) expect(evalStep(v)).toBe(trafficColor(v));
    expect(trafficColor(0)).toBe(TRAFFIC_ZERO_COLOR);
  });
  it("ramp gets monotonically lighter (one hue, sequential — more ships = brighter on the dark map)", () => {
    const lum = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
    const ls = TRAFFIC_BINS.map((b) => lum(b.color));
    for (let i = 1; i < ls.length; i++) expect(ls[i]).toBeGreaterThan(ls[i - 1]);
  });
  it("one GeoJSON source and two hidden layers that validate against the MapLibre style spec, inserted under the given slot", () => {
    const style = { version: 8 as const, sources: {} as Record<string, unknown>, layers: [] as { id: string; layout: { visibility: string } }[] };
    const before: (string | undefined)[] = [];
    const host = {
      addSource: (id: string, s: unknown) => { style.sources[id] = s; },
      addLayer: (l: { id: string; layout: { visibility: string } }, b?: string) => { style.layers.push(l); before.push(b); },
      getSource: (id: string) => style.sources[id],
      getLayer: () => undefined,
    };
    addTrafficGridLayers(host, "radar-slot");
    addTrafficGridLayers(host, "radar-slot"); // 두 번 불러도 한 번만
    expect(Object.keys(style.sources)).toEqual([TRAFFIC_SOURCE]);
    expect(style.layers.map((l) => l.id)).toEqual([...TRAFFIC_LAYERS]);
    expect(style.layers.every((l) => l.layout.visibility === "none")).toBe(true);
    expect(before).toEqual(["radar-slot", "radar-slot"]);
    expect(validateStyleMin(style as never).map((e) => e.message)).toEqual([]);
  });
});

describe("tooltip and time text: KST with UTC alongside, unknown is — without a unit", () => {
  it("time text", () => {
    expect(trafficTimeText("2026-09-29T09:05:05Z")).toBe("09-29 18:05:05 KST · 09-29 09:05:05 UTC");
    expect(trafficTimeText("2026-09-29T15:30:00Z")).toBe("09-30 00:30:00 KST · 09-29 15:30:00 UTC"); // KST 로는 다음 날
    for (const v of [null, undefined, "", "bad"]) expect(trafficTimeText(v)).toBe("—");
  });
  it("cell tooltip: grid number, ship count, density %, reference time (KST · UTC), and that it is not a ship position", () => {
    const tip = trafficGridTip({ g: "GR4_F2K41_C3", v: 12, d: 34 }, grid())!;
    expect(tip.title).toBe("연안 교통량 격자");
    expect(tip.subtitle).toBe("GR4_F2K41_C3");
    expect(tip.rows).toEqual([
      ["척수", "12척"], ["밀집도", "34 %"], ["기준", "09-29 18:05:05 KST · 09-29 09:05:05 UTC"], ["격자", "0.025° 칸(약 2.2×2.8 km)"],
    ]);
    expect(tip.flags.map((f) => f.text)).toEqual(["5분 집계 · 개별 선박 위치 아님"]);
    expect(trafficGridTip({ g: "GR4_A", v: 3, d: 12.25 }, grid())!.rows[1][1]).toBe("12.3 %");
    const unknown = trafficGridTip({ g: "GR4_A" }, null)!;
    expect(unknown.rows.slice(0, 3).map((r) => r[1])).toEqual(["—", "—", "—"]);
    expect(trafficGridTip({}, grid())).toBeNull();
  });
});

describe("status line: every state says why the map shows what it shows", () => {
  it("loading · fetch error before any value", () => {
    expect(trafficStatusLine(null, null)).toEqual({ text: "불러오는 중…", tone: "muted", detail: null });
    expect(trafficStatusLine(null, "HTTP 429").text).toBe("조회 실패 — HTTP 429");
  });
  it("ok: reference time, cells shown / total, geometry still being resolved", () => {
    const l = trafficStatusLine(grid({ total: 5099, resolved: 4812, unresolved: 287, pending: 287 }), null);
    expect(l.text).toBe("기준 09-29 18:05:05 KST · 09-29 09:05:05 UTC · 격자 2 / 5,099칸 표시 · 위치 확인 중 287칸");
    expect(l.tone).toBe("muted");
    // 모르는 수는 "—" 만(단위를 붙이지 않는다)
    const unknownTotal = trafficStatusLine(grid({ total: undefined, pending: 0 }), null).text;
    expect(unknownTotal).toContain("격자 2 / — 표시");
    expect(unknownTotal).not.toMatch(/—칸|— 칸/);
    const done = trafficStatusLine(grid({ pending: 0, not_found: 1 }), null);
    expect(done.tone).toBe("ok");
    expect(done.detail).toBe("해양격자에 없음 1칸");
  });
  it("cells whose position lookup kept failing are their own count — not '위치 확인 중'", () => {
    const g = grid({ unresolved: 2, total: 4, pending: 0, not_found: 1, failed: 1 });
    expect(g.failed).toBe(1);
    const l = trafficStatusLine(g, null);
    expect(l.text).not.toContain("위치 확인 중");
    expect(l.detail).toBe("해양격자에 없음 1칸 · 위치 조회 실패 1칸");
    expect(l.tone).toBe("warn");
    expect(trafficStatusLine(grid({ pending: 0, failed: undefined }), null).detail).toBeNull(); // 모르면 쓰지 않는다
  });
  it("an ok answer that has aged past stale_after_s on this clock reads '자료 멈춤' (the api cannot say so when polls fail)", () => {
    const stale = trafficStatusLine(grid({ pending: 0 }), "HTTP 503", REG_MS + 901_000);
    expect(stale.text).toBe("자료 멈춤 — 마지막 기준 09-29 18:05:05 KST · 09-29 09:05:05 UTC · 15분 넘게 새 자료 없음 · 표시 안 함 · 조회 실패(HTTP 503) — 마지막 값");
    expect(stale.tone).toBe("warn");
    expect(trafficStatusLine(grid({ pending: 0 }), null, REG_MS + 899_000).text).toMatch(/^기준 /);
    expect(trafficStatusLine(grid({ pending: 0 }), null, 0).text).toMatch(/^기준 /); // 시각을 아직 모른다(첫 렌더) — api 판정 그대로
  });
  it("partial page, quarantined and dropped cells are spelled out", () => {
    const l = trafficStatusLine(grid({ partial: true, total: 5099, total_count: 6200, pending: 0, off_grid: 2, invalid_cells: 1,
      cells: [["GR4_A", 37.45, 126.6, 1, 0], ["bad id", 37.45, 126.6, 1, 0]] }), null);
    expect(l.tone).toBe("warn");
    expect(l.detail).toBe("일부만 수신(5,099 / 공급자 6,200칸) · 격자 검사 실패(격리) 2칸 · 형식 오류로 뺀 칸 2");
  });
  it("stale · disabled (each reason) · no data · invalid · a failed refresh keeps the last value and says so", () => {
    expect(trafficStatusLine(grid({ status: "stale", available: false, age_s: 1000 }), null).text)
      .toBe("자료 멈춤 — 마지막 기준 09-29 18:05:05 KST · 09-29 09:05:05 UTC · 15분 넘게 새 자료 없음 · 표시 안 함");
    const dis = (r: string) => trafficStatusLine(grid({ status: "disabled", available: false, disabled_reason: r, ...NOW_UNKNOWN }), null).text;
    expect(dis("no_key")).toBe("꺼짐 — 공공데이터포털 서비스 키 없음(수집기 설정)");
    expect(dis("fixture")).toBe("꺼짐 — fixture 모드 — 외부 호출 없음");
    expect(dis("operator_off")).toBe("꺼짐 — 운영자가 수집을 끔");
    expect(trafficStatusLine(grid({ status: "no_data", available: false, ...NOW_UNKNOWN }), null).text).toBe("자료 없음 — 수집기가 아직 싣지 않았거나 20분 넘게 멈춤");
    const invalid = trafficStatusLine(grid({ status: "invalid", available: false, ...NOW_UNKNOWN }), null);
    expect(invalid.tone).toBe("bad");
    expect(invalid.text).toBe("받은 자료 검증 실패(형식 또는 미래 시각) — 표시 안 함"); // api 는 형식 오류와 미래 regDt 를 invalid 로 낸다
    const failed = trafficStatusLine(grid({ pending: 0 }), "HTTP 503");
    expect(failed.text).toContain("조회 실패(HTTP 503) — 마지막 값");
    expect(failed.tone).toBe("warn");
  });
});

describe("drawable: only a verified ok snapshot that is still fresh on this clock", () => {
  it("ok and fresh draws; aged past stale_after_s, unknown regDt or a non-ok status does not", () => {
    expect(trafficDrawable(grid(), REG_MS + 70_000)).toBe(true);
    expect(trafficDrawable(grid(), REG_MS + 900_000)).toBe(true);
    expect(trafficDrawable(grid(), REG_MS + 900_001)).toBe(false);
    expect(trafficDrawable(grid({ reg_dt_utc: null }), REG_MS)).toBe(false); // 기준 시각을 모르면 '지금'이라고 그리지 않는다
    expect(trafficDrawable(grid({ status: "stale", available: false }), REG_MS)).toBe(false);
    expect(trafficDrawable(null, REG_MS)).toBe(false);
    expect(trafficStaleAt(grid())).toBe(REG_MS + 900_000);
    expect(trafficStaleAt(grid({ reg_dt_utc: "bad" }))).toBeNull();
  });
});

describe("TrafficGridPoller: ETag, no redraw when unchanged, hidden tab, errors keep the last value", () => {
  type Call = { url: string; headers: Record<string, string> };
  let calls: Call[];
  let answers: (() => Response)[];
  const res = (status: number, json?: unknown, etag?: string) => () =>
    new Response(json === undefined ? null : JSON.stringify(json), { status, headers: etag ? { ETag: etag } : {} });
  const fetcher = async (url: string, init: RequestInit) => { calls.push({ url, headers: init.headers as Record<string, string> }); return answers.shift()!(); };
  let states: TrafficPollState[];
  beforeEach(() => { calls = []; answers = []; states = []; });

  it("first 200 publishes version 1; 304 and a repeated ETag keep the version (the map is not redrawn); new content bumps it", async () => {
    const p = new TrafficGridPoller((s) => states.push(s), undefined, fetcher, () => false, () => 1000);
    answers.push(res(200, body(), '"ta"'), res(304), res(200, body(), '"ta"'), res(200, body({ total: 4 }), '"tb"'));
    await p.poll();
    expect(calls[0].url).toBe(TRAFFIC_URL);
    expect(calls[0].headers["If-None-Match"]).toBeUndefined();
    expect(states.at(-1)!.version).toBe(1);
    expect(states.at(-1)!.data!.cells).toHaveLength(2);
    await p.poll();
    expect(calls[1].headers["If-None-Match"]).toBe('"ta"');
    expect(states.at(-1)!.version).toBe(1);
    await p.poll();
    expect(states.at(-1)!.version).toBe(1);
    await p.poll();
    expect(states.at(-1)!.version).toBe(2);
    expect(states.at(-1)!.data!.total).toBe(4);
  });

  it("HTTP errors, network errors and malformed bodies keep the last value and report the error", async () => {
    const p = new TrafficGridPoller((s) => states.push(s), undefined, fetcher, () => false, () => 1000);
    answers.push(res(200, body(), '"ta"'), res(503), () => { throw new Error("offline"); }, res(200, { nope: 1 }, '"tc"'));
    await p.poll();
    await p.poll();
    expect(states.at(-1)!.error).toBe("HTTP 503");
    expect(states.at(-1)!.data!.total).toBe(3);
    await p.poll().catch(() => {});
    expect(states.at(-1)!.error).toBe("offline");
    await p.poll();
    expect(states.at(-1)!.error).toBe("응답 형식 오류");
    expect(states.at(-1)!.version).toBe(1);
  });

  it("polls right away when the tab becomes visible again (unless it just checked) and stops listening when stopped", async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000_000;
      let hidden = false;
      let onVisible: (() => void) | null = null;
      const watch = (cb: () => void) => { onVisible = cb; return () => { onVisible = null; }; };
      answers.push(res(200, body(), '"ta"'), res(304), res(304));
      const p = new TrafficGridPoller((s) => states.push(s), undefined, fetcher, () => hidden, () => now, TRAFFIC_POLL_MS, watch);
      p.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(1);
      hidden = true;
      now += TRAFFIC_POLL_MS * 5; // 숨긴 동안에는 부르지 않는다
      await vi.advanceTimersByTimeAsync(TRAFFIC_POLL_MS * 5);
      expect(calls).toHaveLength(1);
      hidden = false;
      onVisible!();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(2); // 다시 보이면 곧바로(다음 90 s 를 기다리지 않는다)
      now += TRAFFIC_VISIBLE_MIN_GAP_MS - 1;
      onVisible!(); // 방금 확인했다 — 탭을 빨리 오가도 몰아서 부르지 않는다
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(2);
      p.stop();
      expect(onVisible).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls every TRAFFIC_POLL_MS only while the tab is visible, never two at once, and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      let hidden = false;
      const slow: (() => void)[] = [];
      const f = (url: string, init: RequestInit) => { calls.push({ url, headers: init.headers as Record<string, string> }); return new Promise<Response>((r) => slow.push(() => r(res(200, body(), '"ta"')()))); };
      const p = new TrafficGridPoller((s) => states.push(s), undefined, f, () => hidden, () => 1000);
      p.start();
      expect(calls).toHaveLength(1);
      await p.poll(); // 앞 호출이 끝나지 않았다 — 겹쳐 부르지 않는다
      expect(calls).toHaveLength(1);
      slow.shift()!();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(TRAFFIC_POLL_MS);
      expect(calls).toHaveLength(2);
      slow.shift()!();
      await vi.advanceTimersByTimeAsync(0);
      hidden = true;
      await vi.advanceTimersByTimeAsync(TRAFFIC_POLL_MS * 3);
      expect(calls).toHaveLength(2);
      p.stop();
      hidden = false;
      await vi.advanceTimersByTimeAsync(TRAFFIC_POLL_MS * 3);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("layer toggle, legend, sources", () => {
  const initial = useUi.getState();
  beforeEach(() => { resetData(); useUi.setState(initial, true); });
  afterEach(() => { resetData(); useUi.setState(initial, true); });

  it("is off by default and remembered like the other layers", () => {
    expect(useUi.getState().layers.traffic).toBe(false);
    const m = new Map<string, string>();
    const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    saveLayers({ ...useUi.getState().layers, traffic: true }, kv);
    expect(loadLayers(kv)?.traffic).toBe(true);
    m.set("wakeline.layers", JSON.stringify({ traffic: "yes" }));
    expect(loadLayers(kv)).toBeNull();
  });

  it("the layer panel shows the toggle (not pressed by default) and, when on, the status line", () => {
    const layers = useUi.getState().layers;
    const off = renderToStaticMarkup(createElement(LayerPanelView, { layers, shipCats: [], legendOpen: false }));
    expect(off).toContain(`data-testid="layer-traffic"`);
    expect(off).toMatch(/aria-pressed="false"[^>]*data-testid="layer-traffic"/);
    expect(text(off)).toContain(TRAFFIC_LAYER_LABEL);
    expect(off).not.toContain("traffic-status");
    setData({ trafficGrid: { data: grid({ pending: 0 }), etag: '"ta"', error: null, version: 1, checkedAt: 1 } });
    const on = text(renderToStaticMarkup(createElement(LayerPanelView, { layers: { ...layers, traffic: true }, shipCats: [], legendOpen: false })));
    expect(on).toContain("기준 09-29 18:05:05 KST · 09-29 09:05:05 UTC · 격자 2 / 3칸 표시");
  });

  it("the legend shows the scale and says it is a 5-minute count per cell, not ship positions — only when the layer is on", () => {
    const layers = useUi.getState().layers;
    const on = text(renderToStaticMarkup(createElement(MapLegendView, { id: "l", layers: { ...layers, traffic: true }, radarSource: "rainviewer" })));
    expect(on).toContain(TRAFFIC_LEGEND_NOTE);
    expect(TRAFFIC_LEGEND_NOTE).toBe("격자 약 2.2×2.8 km · 5분 집계 · 선박 척수 — 개별 선박 위치 아님");
    for (const b of TRAFFIC_BINS) expect(on).toContain(b.label);
    expect(on).toContain("0척");
    expect(on).toContain("기준 시각(KST · UTC)");
    const off = text(renderToStaticMarkup(createElement(MapLegendView, { id: "l", layers, radarSource: "rainviewer" })));
    expect(off).not.toContain(TRAFFIC_LEGEND_NOTE);
  });

  it("both providers are in the SOURCES footer and on /about", () => {
    const roles = CREDITS.filter((c) => c.role === "연안 교통량").map((c) => c.label);
    expect(roles).toEqual(["한국해양교통안전공단 MTIS 실시간 해양교통정보", "해양수산부 해양격자 4단계"]);
    expect(attributionText()).toContain("연안 교통량: 한국해양교통안전공단 MTIS 실시간 해양교통정보 (공공데이터포털) · 해양수산부 해양격자 4단계 (공공데이터포털)");
    const about = text(renderToStaticMarkup(createElement(AboutPage)));
    expect(about).toContain("연안 교통량(격자)");
    expect(about).toContain("개별 선박 위치가 아닙니다");
    expect(about).toContain("KST 와 UTC 를 함께");
  });
});
