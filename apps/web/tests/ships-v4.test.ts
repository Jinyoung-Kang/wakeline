/**
 * 계약 v4 웹 쪽 — §B 선박 출발지·목적지(보고) · §C 선박 표시 규칙·칩·격자 원 · §D AIS 구역(shards) 배지·항적 공백.
 * 항구 코드·이름은 합성(SYNTHETIC) 값이다.
 */
import { createPropertyExpression, latest } from "@maplibre/maplibre-gl-style-spec";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AMBIGUOUS_TEXT, aisBadge, bboxTouchesCoverage, fmtDestPlace, gapAppliesTo, mergeStatusGaps, NO_ORIGIN_TEXT, parseScopeText, normalizeDestination, parseAisStatus,
  parseDestinationInfo, pickDestinationInfo, shipDestinationLines, shipOriginText, SHIPS_OUT_OF_COVERAGE_TEXT, SHIPS_RULE, SHIPS_ZERO_AIS_DOWN_TEXT,
  SHIPS_ZERO_AIS_UNKNOWN_TEXT, SHIPS_ZERO_RANGE_UNKNOWN_TEXT, SHIPS_ZERO_TEXT, shipsChip, shipsGapSuffix, statusOpenGapFor, zeroShipsReason, type AisStatus,
  type ShipsChipInput, type ShipTrack,
} from "@/lib/ships";
import { addShipLayers, SHIP_GRID_RADIUS_EXPR, SHIP_GRID_STYLE } from "@/lib/ship-layers";
import { shipGridTip } from "@/lib/tooltip";
import { attributionText, CREDITS, mapAttributionHtml } from "@/lib/attribution";
import { getData, resetData, setData } from "@/lib/store";
import { WakelineWsClient, type SocketLike } from "@/lib/ws";
import { ShipCard, ShipPanelView } from "@/components/ShipCard";
import { MapChipsView } from "@/components/MapChips";
import { MapLegendView } from "@/components/MapLegend";
import { AttributionFooter } from "@/components/AttributionFooter";
import AboutPage from "@/app/about/page";
import { useUi } from "@/lib/ui-store";

const TS = "2026-09-28T03:00:00Z";
const NOW = Date.parse(TS);

// ---------------------------------------------------------------- §B 목적지 풀이

/** SYNTHETIC 조각(지어낸 UN/LOCODE 모양 코드) */
const place = (text: string, over: Record<string, unknown> = {}) => ({ text, locode: null, name: null, country: null, subdivision: null, ambiguous: false, ...over });
const ALPHA = place("ZZ AAA", { locode: "ZZAAA", name: "Alpha Port", country: "ZZ", subdivision: "01" });
const BRAVO = place("ZZBBB", { locode: "ZZBBB", name: "Bravo Harbour", country: "ZZ" });
const info = (raw: string, kind: string, over: Record<string, unknown> = {}) => parseDestinationInfo({ raw, kind, from: null, to: null, places: [], ...over });

describe("destination_info (contract v4 §B) — shown as the api resolved it, never re-guessed", () => {
  it("validates shape: unknown kind, empty raw or garbage → null; places without text are dropped; bad LOCODE → unresolved", () => {
    expect(info("ZZ AAA>ZZBBB", "maybe")).toBeNull();
    expect(info("   ", "text")).toBeNull();
    expect(parseDestinationInfo("ZZAAA")).toBeNull();
    const i = info("ZZ AAA>ZZBBB", "from_to", { from: ALPHA, to: place("ZZBBB", { locode: "zzbbb", name: "Bravo", ambiguous: true }), places: [ALPHA, { locode: "ZZBBB" }] })!;
    expect(i.from).toMatchObject({ locode: "ZZAAA", name: "Alpha Port", country: "ZZ", subdivision: "01", ambiguous: false });
    expect(i.to).toEqual({ text: "ZZBBB", locode: null, name: null, country: null, subdivision: null, ambiguous: false }); // 코드가 틀리면 풀이·ambiguous 도 버린다
    expect(i.places).toHaveLength(1);
  });
  it("normalisation and picking: only an info whose raw matches the shown destination is used (WS first)", () => {
    expect(normalizeDestination("  zz  aaa>zzbbb@@")).toBe("ZZ AAA>ZZBBB");
    expect(normalizeDestination("  ")).toBeNull();
    const ws = info("ZZ AAA>ZZBBB", "from_to", { from: ALPHA, to: BRAVO });
    const rest = info("zz aaa>zzbbb", "to", { to: BRAVO });
    expect(pickDestinationInfo("ZZ AAA>ZZBBB", ws, rest)).toBe(ws);
    expect(pickDestinationInfo("ZZ AAA>ZZBBB", null, rest)).toBe(rest);
    expect(pickDestinationInfo("OTHER", ws, rest)).toBeNull();
    expect(pickDestinationInfo(null, ws)).toBeNull();
  });
  it("A>B: the reported origin is A, the destination B", () => {
    const i = info("ZZ AAA>ZZBBB", "from_to", { from: ALPHA, to: BRAVO, places: [ALPHA, BRAVO] });
    expect(shipOriginText(i, "ZZ AAA>ZZBBB")).toBe("Alpha Port · ZZ · UN/LOCODE ZZAAA");
    expect(shipDestinationLines(i, "ZZ AAA>ZZBBB")).toEqual({ raw: "ZZ AAA>ZZBBB", lines: ["Bravo Harbour · ZZ · UN/LOCODE ZZBBB"] });
  });
  it(">B and plain text: no origin in AIS; the destination is resolved or left as the raw text", () => {
    const to = info(">ZZBBB", "to", { to: BRAVO, places: [BRAVO] });
    expect(shipOriginText(to, ">ZZBBB")).toBe(NO_ORIGIN_TEXT);
    expect(shipDestinationLines(to, ">ZZBBB").lines).toEqual(["Bravo Harbour · ZZ · UN/LOCODE ZZBBB"]);
    const txt = info("FOR ORDERS", "text", { places: [place("FOR ORDERS")] });
    expect(shipOriginText(txt, "FOR ORDERS")).toBe(NO_ORIGIN_TEXT);
    expect(shipDestinationLines(txt, "FOR ORDERS").lines).toEqual(["UN/LOCODE 풀이 없음 — 원문 그대로"]);
    expect(NO_ORIGIN_TEXT).toBe("— AIS 에는 출발지 항목이 없습니다");
  });
  it("A<>B is a reported round trip (neither is called the origin)", () => {
    const i = info("ZZ AAA<>ZZBBB", "between", { places: [ALPHA, BRAVO] });
    expect(shipOriginText(i, "ZZ AAA<>ZZBBB")).toBe(NO_ORIGIN_TEXT);
    expect(shipDestinationLines(i, "ZZ AAA<>ZZBBB").lines).toEqual([
      "Alpha Port ↔ Bravo Harbour 왕복(보고)", "Alpha Port · ZZ · UN/LOCODE ZZAAA", "Bravo Harbour · ZZ · UN/LOCODE ZZBBB",
    ]);
  });
  it("an ambiguous 5-letter code says it was read as a code and a same-spelled place exists", () => {
    const amb = parseDestinationInfo({ raw: "ZZCCC", kind: "text", to: { ...place("ZZCCC"), locode: "ZZCCC", name: "Charlie", country: "ZZ", ambiguous: true }, places: [] })!;
    expect(fmtDestPlace(amb.to!)).toBe(`Charlie · ZZ · UN/LOCODE ZZCCC · ${AMBIGUOUS_TEXT}`);
    expect(AMBIGUOUS_TEXT).toBe("코드로 읽은 값 · 같은 글자의 지명도 있음");
  });
  it("without destination_info: raw only; origin unknown (—) unless there is no destination at all", () => {
    expect(shipDestinationLines(null, "ZZ AAA>ZZBBB")).toEqual({ raw: "ZZ AAA>ZZBBB", lines: [] });
    expect(shipOriginText(null, "ZZ AAA>ZZBBB")).toBe("—");
    expect(shipOriginText(null, null)).toBe(NO_ORIGIN_TEXT);
    expect(shipDestinationLines(null, null)).toEqual({ raw: null, lines: [] });
  });
});

describe("ship card rows 출발지(보고) / 목적지(보고) (server render)", () => {
  beforeEach(() => resetData());
  afterEach(() => resetData());
  const statik = (destination: string | null) => ({
    mmsi: "431011305", name: "SYNTH", call_sign: null, imo: null, ship_type: 70, dim_a: null, dim_b: null, dim_c: null, dim_d: null, draught_m: null,
    destination, eta_month: 9, eta_day: 30, eta_hour: 6, eta_minute: 0, updated_at: TS, provider: "fixture",
  });
  it("A>B from the WS ship_selected; ETA unchanged", () => {
    setData({ shipSelected: { mmsi: "431011305", received_at: 0, state: null, static: statik("ZZ AAA>ZZBBB"), destination_info: info("ZZ AAA>ZZBBB", "from_to", { from: ALPHA, to: BRAVO }) } });
    const html = renderToStaticMarkup(createElement(ShipCard, { mmsi: "431011305" }));
    expect(html).toContain('data-field="출발지(보고)"');
    expect(html).toContain("Alpha Port · ZZ · UN/LOCODE ZZAAA");
    expect(html).toContain("“ZZ AAA&gt;ZZBBB”");
    expect(html).toContain("Bravo Harbour · ZZ · UN/LOCODE ZZBBB");
    expect(html).toContain("09-30 15:00 KST · 선원 입력 · 연도 없음");
  });
  it("an info for a different destination text is not attached", () => {
    setData({ shipSelected: { mmsi: "431011305", received_at: 0, state: null, static: statik("FOR ORDERS"), destination_info: info("ZZ AAA>ZZBBB", "from_to", { from: ALPHA, to: BRAVO }) } });
    const html = renderToStaticMarkup(createElement(ShipCard, { mmsi: "431011305" }));
    expect(html).toContain("“FOR ORDERS”");
    expect(html).not.toContain("Alpha Port");
    expect(html).not.toContain("Bravo Harbour");
  });
});

// ---------------------------------------------------------------- §C 표시 규칙·칩·격자 원

const view = (over: Partial<ShipsChipInput> = {}): ShipsChipInput => ({ mode: "points", count: 12, total: 12, cell_deg: null, capped: false, ...over });
/** 운영 권장 두 구역(아메리카 · 아시아·태평양) — 0–45°E 는 구독하지 않는다 */
const TWO_ZONES = [[-90, -180, 90, 0], [-90, 45, 90, 180]];
/** 합성 AIS 상태(status.sources.ais) */
const aisOf = (ais: Record<string, unknown>) => parseAisStatus({ sources: { ais } }, 0);
const AIS_UP = aisOf({ connected: true, state: "receiving", coverage: TWO_ZONES });
const ctx = (over: Partial<Parameters<typeof shipsChip>[1]> = {}) => ({ zoom: 8, bbox: [128, 34, 131, 36] as [number, number, number, number], ais: AIS_UP, ...over });

describe("ships chip wording follows the contract v4 §C rule", () => {
  it("the rule constants are the contract's", () => {
    expect(SHIPS_RULE).toEqual({ lowZoom: 4, highZoom: 7, lowMax: 1500, lowBack: 1200, highMax: 5000 });
  });
  it("points: count in view", () => {
    expect(shipsChip(view({ count: 1234 }), ctx())!.text).toBe("선박 1,234척 · 화면 안 · AIS");
    expect(shipsChip(view({ count: 40 }), ctx({ zoom: 5 }))!.text).toBe("선박 40척 · 화면 안 · AIS"); // 줌 4–6 에서도 개별
  });
  it("zero ships while AIS is connected: the contract sentence; outside the operational coverage says so instead; AIS off says so", () => {
    expect(SHIPS_ZERO_TEXT).toBe("화면 안 선박 0척 — aisstream 은 육상 수신국 기반이라 수신국이 없는 해역은 비어 있습니다");
    expect(shipsChip(view({ count: 0 }), ctx())!.text).toBe(SHIPS_ZERO_TEXT);
    expect(shipsChip(view({ mode: "grid", count: 0, total: 0, cell_deg: 5 }), ctx({ zoom: 2, bbox: [-180, -80, 180, 80] }))!.text).toBe(SHIPS_ZERO_TEXT);
    expect(shipsChip(view({ count: 0 }), ctx({ bbox: [10, 40, 20, 50] }))!.text).toBe(SHIPS_OUT_OF_COVERAGE_TEXT); // 0–45°E
    expect(shipsChip(view({ count: 0 }), ctx({ bbox: [40, 10, 50, 20] }))!.text).toBe(SHIPS_ZERO_TEXT); // 45°E 에 걸침
    expect(shipsChip(view({ count: 0 }), ctx({ ais: aisOf({ state: "disabled", connected: false }) }))!.text).toBe("선박 없음 · AIS 꺼짐(키 없음)");
    expect(shipsChip(view({ count: 0 }), ctx())!.warn).toBe(false);
  });
  it("zero ships while AIS is not connected or its state is unknown: says only that — never blames receiver stations (contract v4 §G C-1)", () => {
    expect(SHIPS_ZERO_AIS_DOWN_TEXT).toBe("화면 안 선박 0척 — AIS 연결 안 됨");
    expect(SHIPS_ZERO_AIS_UNKNOWN_TEXT).toBe("화면 안 선박 0척 — AIS 연결 상태 모름");
    const zero = (ais: AisStatus | null, over: Partial<Parameters<typeof shipsChip>[1]> = {}) => shipsChip(view({ count: 0 }), ctx({ ais, ...over }))!;
    // 끊김(재연결 중·백오프·시작 중·멈춤) — 수집기가 connected:false 를 보고
    for (const state of ["connecting", "backoff", "starting", "stopped"]) {
      const c = zero(aisOf({ connected: false, state, coverage: TWO_ZONES }));
      expect(c.text, state).toBe(SHIPS_ZERO_AIS_DOWN_TEXT);
      expect(c.title, state).not.toContain("수신국");
    }
    // heartbeat 가 오래됨: api 는 connected 를 모름(null)으로, coverage·shards 는 빼고 보낸다
    expect(zero(aisOf({ connected: null, heartbeat_stale: true })).text).toBe(SHIPS_ZERO_AIS_UNKNOWN_TEXT);
    // ais 수집기 상태가 아예 없음
    expect(zero(null).text).toBe(SHIPS_ZERO_AIS_UNKNOWN_TEXT);
    expect(zero(null).title).not.toContain("수신국");
    // 연결은 됐지만 수신 범위를 모름(옛 api) · 화면을 모름 — 수신국 탓인지 말할 수 없다
    expect(zero(aisOf({ connected: true, state: "receiving" })).text).toBe(SHIPS_ZERO_RANGE_UNKNOWN_TEXT);
    expect(zero(AIS_UP, { bbox: null }).text).toBe(SHIPS_ZERO_RANGE_UNKNOWN_TEXT);
  });
  it("zero ships with AIS shards: the receiver sentence only when a connected shard covers the view", () => {
    const sh = (coverage: number[][] | null, connected: boolean | null) => ({ coverage, state: connected ? "receiving" : "backoff", connected, gap_open_since: null });
    // 아메리카 연결 · 아시아 끊김: 합계 connected=false(모든 구역 연결이 아님)
    const asiaDown = aisOf({ connected: false, coverage: TWO_ZONES, shards: [sh([TWO_ZONES[0]], true), sh([TWO_ZONES[1]], false)] });
    const KOREA: [number, number, number, number] = [128, 34, 131, 36];
    const GULF_OF_MEXICO: [number, number, number, number] = [-95, 20, -85, 28];
    expect(zeroShipsReason(asiaDown, KOREA)).toBe("down");
    expect(shipsChip(view({ count: 0 }), ctx({ ais: asiaDown, bbox: KOREA }))!.text).toBe(SHIPS_ZERO_AIS_DOWN_TEXT);
    expect(shipsChip(view({ count: 0 }), ctx({ ais: asiaDown, bbox: GULF_OF_MEXICO }))!.text).toBe(SHIPS_ZERO_TEXT);
    // 계약 v4 §G D-2: 합계 coverage 는 구독한 구역만(아시아는 구독 전·백오프) — 그래도 한국 화면은 '범위 밖' 이 아니라 '연결 안 됨'
    const asiaNeverSubscribed = aisOf({ connected: false, coverage: [TWO_ZONES[0]], shards: [sh([TWO_ZONES[0]], true), sh([TWO_ZONES[1]], false)] });
    expect(zeroShipsReason(asiaNeverSubscribed, KOREA)).toBe("down");
    expect(shipsChip(view({ count: 0 }), ctx({ ais: asiaNeverSubscribed, bbox: KOREA }))!.text).toBe(SHIPS_ZERO_AIS_DOWN_TEXT);
    // 구역 범위를 하나라도 모르면 구역으로 가르지 않는다 — 한 구역이라도 연결이면 연결
    const unknownScope = aisOf({ connected: false, coverage: TWO_ZONES, shards: [sh(null, true), sh([TWO_ZONES[1]], false)] });
    expect(zeroShipsReason(unknownScope, KOREA)).toBe("receivers");
    // 모든 구역 연결 모름
    const allUnknown = aisOf({ connected: null, coverage: TWO_ZONES, shards: [sh([TWO_ZONES[0]], null), sh([TWO_ZONES[1]], null)] });
    expect(shipsChip(view({ count: 0 }), ctx({ ais: allUnknown }))!.text).toBe(SHIPS_ZERO_AIS_UNKNOWN_TEXT);
  });
  it("grid: says it is aggregated and why, by zoom band — never claims '1,500 exceeded' (hysteresis keeps grid down to 1,200)", () => {
    // api(ShipFanout)는 수 기준으로 격자로 바꾼 모든 경우에 capped:true 를 보낸다 — 줌 4–6 격자 포함
    const g = (zoom: number | null, over: Partial<ShipsChipInput> = {}) => shipsChip(view({ mode: "grid", count: 3, total: 1300, cell_deg: 2, capped: true, ...over }), ctx({ zoom }))!;
    expect(g(3).text).toBe("선박 1.3k척 · 2° 격자 3칸으로 묶음 · 줌 4 이상에서 개별 표시");
    expect(g(5).text).toBe("선박 1.3k척 · 2° 격자 3칸으로 묶음 · 줌 4–6 은 1,500척 넘으면 격자 · 1,200척 이하에서 개별");
    expect(g(5).text).not.toContain("초과");
    const capped = g(9, { total: 6200, cell_deg: 0.5 });
    expect(capped.text).toBe("선박 6.2k척 · 0.5° 격자 3칸으로 묶음 · 화면 안 5,000척 초과 · 전송 상한");
    expect(capped.warn).toBe(true);
    expect(g(null).text).toContain("확대하면 개별 표시");
    expect(g(5).title).toContain("1,200척 이하");
  });
  it("warn tone only for the zoom ≥ 7 transfer cap — the zoom 4–6 band grid (capped:true from the api) is normal (contract v4 §G C-1)", () => {
    const g = (zoom: number | null, capped: boolean, total = 1600) => shipsChip(view({ mode: "grid", count: 3, total, cell_deg: 2, capped }), ctx({ zoom }))!;
    for (const z of [4, 5, 6]) {
      expect(g(z, true).warn, `zoom ${z}`).toBe(false);
      expect(g(z, true).text, `zoom ${z}`).not.toContain("전송 상한");
    }
    expect(g(2, true).warn).toBe(false);
    expect(g(null, true).warn).toBe(false); // 줌을 모르면 상한이라고 말하지 않는다
    expect(g(7, true, 5200).warn).toBe(true);
    expect(g(7, false, 5200).warn).toBe(false);
  });
  it("waiting and off", () => {
    expect(shipsChip(view({ mode: "waiting" }), ctx())!.text).toBe("선박 수신 대기");
    expect(shipsChip(view({ mode: "off" }), ctx())).toBeNull();
  });
  it("bbox vs coverage overlap", () => {
    const boxes = [{ s: -90, w: 45, n: 90, e: 180 }];
    expect(bboxTouchesCoverage([100, 0, 110, 10], boxes)).toBe(true);
    expect(bboxTouchesCoverage([0, 0, 44, 10], boxes)).toBe(false);
    expect(bboxTouchesCoverage([-180, -80, 180, 80], boxes)).toBe(true);
  });
});

describe("ships chip / list / legend / tooltip (server render)", () => {
  beforeEach(() => resetData());
  afterEach(() => resetData());
  it("map chip uses the last subscribed viewport for the rule and the zero-ship reason", () => {
    setData({ ships: { mode: "grid", version: 2, count: 3, total: 1600, ts: null, cell_deg: 2, capped: true, grid: [] }, viewport: { bbox: [120, 30, 135, 40], zoom: 5 }, ais: AIS_UP });
    const chip = () => renderToStaticMarkup(createElement(MapChipsView, { hex: null, shipsOn: true }));
    expect(chip()).toContain("줌 4–6 은 1,500척 넘으면 격자 · 1,200척 이하에서 개별");
    expect(chip()).toContain('class="badge normal-case! " data-testid="ships-chip"'); // 줌 5 격자는 경고 색이 아니다
    setData({ ships: { mode: "points", version: 3, count: 0, total: 0, ts: null, cell_deg: null, capped: false, grid: [] } });
    expect(chip()).toContain(SHIPS_ZERO_TEXT);
    setData({ ais: aisOf({ connected: false, state: "backoff", coverage: TWO_ZONES }) });
    expect(chip()).toContain(SHIPS_ZERO_AIS_DOWN_TEXT);
    expect(chip()).not.toContain("수신국");
    setData({ ais: null });
    expect(chip()).toContain(SHIPS_ZERO_AIS_UNKNOWN_TEXT);
    // 레이어를 켰는데 서버에 아직 알리기 전(off) — 수신 대기
    setData({ ships: { mode: "off", version: 4, count: 0, total: 0, ts: null, cell_deg: null, capped: false, grid: [] } });
    expect(chip()).toContain("선박 수신 대기");
  });
  it("ship list: zero ships in view gives the same reason; grid explains the rule", () => {
    setData({ ships: { mode: "points", version: 1, count: 0, total: 0, ts: null, cell_deg: null, capped: false, grid: [] }, viewport: { bbox: [120, 30, 135, 40], zoom: 8 }, ais: AIS_UP });
    const list = () => renderToStaticMarkup(createElement(ShipPanelView, { selected: null, shipsOn: true }));
    expect(list()).toContain(SHIPS_ZERO_TEXT);
    setData({ ais: aisOf({ connected: false, state: "connecting", coverage: TWO_ZONES }) });
    expect(list()).toContain(SHIPS_ZERO_AIS_DOWN_TEXT);
    expect(list()).not.toContain("수신국");
    setData({ ais: null });
    expect(list()).toContain(SHIPS_ZERO_AIS_UNKNOWN_TEXT);
    setData({ ships: { mode: "grid", version: 2, count: 3, total: 40, ts: null, cell_deg: 5, capped: false, grid: [] } });
    const html = renderToStaticMarkup(createElement(ShipPanelView, { selected: null, shipsOn: true }));
    expect(html).toContain("줌 4–6 은 1,500척 이하");
    expect(html).not.toContain("줌 7 이상으로 확대하면");
  });
  it("legend and grid tooltip describe the new rule", () => {
    const legend = renderToStaticMarkup(createElement(MapLegendView, { id: "lg", layers: { ...useUi.getState().layers, ships: true }, radarSource: "rainviewer" }));
    expect(legend).toContain("격자(줌 4 미만 · 화면 안 선박이 많을 때)");
    expect(legend).not.toContain("줌 7 미만");
    expect(shipGridTip({ count: 3, cat: "cargo" }, 2).flags[0].text).toBe("클릭하면 줌 7 이상으로 확대 — 화면 안 5,000척 이하면 개별 선박");
  });
});

describe("grid circle style (contract v4 §C)", () => {
  function gridLayers() {
    const g = globalThis as Record<string, unknown>;
    const saved = { document: g.document, Path2D: g.Path2D };
    const noop = () => {};
    const c2d = { fillStyle: "", strokeStyle: "", lineWidth: 0, fill: noop, stroke: noop, setLineDash: noop, save: noop, restore: noop, translate: noop, scale: noop,
      getImageData: () => ({ width: 48, height: 48, data: new Uint8ClampedArray(48 * 48 * 4) }) };
    g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => c2d }) };
    g.Path2D = class { constructor(public d: string) {} };
    const layers: { id: string; paint?: Record<string, unknown>; layout?: Record<string, unknown> }[] = [];
    const befores: (string | undefined)[] = [];
    try {
      addShipLayers({
        addImage: noop, addSource: noop,
        addLayer: (l: (typeof layers)[number], before?: string) => { layers.push(l); befores.push(before); },
        getLayer: (id: string) => (id === "aircraft-symbol" ? {} : undefined),
      } as never);
    } finally { g.document = saved.document; g.Path2D = saved.Path2D; }
    return { layers, befores };
  }
  it("dominant-category colour, white 1.5 px stroke, opacity 0.85, haloed count label — still below the aircraft", () => {
    const { layers, befores } = gridLayers();
    const circle = layers.find((l) => l.id === "ship-grid-circle")!;
    const label = layers.find((l) => l.id === "ship-grid-label")!;
    expect(circle.paint).toMatchObject({ "circle-opacity": 0.85, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 });
    expect(label.paint!["text-halo-width"]).toBeGreaterThanOrEqual(1.5);
    expect(label.paint!["text-halo-color"]).toBe(SHIP_GRID_STYLE.labelHalo);
    expect(befores.every((b) => b === "aircraft-symbol")).toBe(true);
  });
  it("minimum radius 8 px, growing with the count", () => {
    const spec = (latest as unknown as Record<string, Record<string, unknown>>).paint_circle["circle-radius"];
    const r = createPropertyExpression(SHIP_GRID_RADIUS_EXPR, "layers[0].paint.circle-radius", spec as never);
    if (r.result !== "success") throw new Error("expr");
    const at = (count: number) => r.value.evaluate({ zoom: 3 } as never, { type: "Point", properties: { count } } as never) as number;
    expect(at(1)).toBe(8);
    expect(SHIP_GRID_STYLE.minRadius).toBe(8);
    expect(at(2)).toBeGreaterThan(8);
    expect(at(10_000)).toBeGreaterThan(at(100));
  });
});

// ---------------------------------------------------------------- §D AIS 구역(shards)

const AMERICAS = [[-90, -180, 90, 0]];
const ASIA = [[-90, 45, 90, 180]];
const status = (shards: unknown, over: Record<string, unknown> = {}) =>
  parseAisStatus({ sources: { ais: { connected: true, msgs_per_s: 60, lag_s: 2, coverage: [...AMERICAS, ...ASIA], shards, ...over } } }, NOW)!;
const shard = (coverage: unknown, over: Record<string, unknown> = {}) => ({ coverage, state: "receiving", connected: true, gap_open_since: null, ...over });

describe("AIS shards (contract v4 §D)", () => {
  it("parses status.sources.ais.shards; malformed lists are ignored as a whole (so 'n/m' is never wrong)", () => {
    const s = status([shard(AMERICAS), shard(ASIA, { gap_open_since: "2026-09-28T02:50:00Z", state: "backoff", connected: false })]);
    expect(s.shards).toHaveLength(2);
    expect(s.shards![1]).toMatchObject({ state: "backoff", connected: false, gap_open_since: "2026-09-28T02:50:00Z", coverage: [{ s: -90, w: 45, n: 90, e: 180 }] });
    expect(status([shard(AMERICAS), shard(ASIA), shard(ASIA), shard(ASIA)]).shards).toBeNull();
    expect(status([shard(AMERICAS), "x"]).shards).toBeNull();
    expect(status([]).shards).toBeNull();
    expect(status(undefined).shards).toBeNull();
    expect(status([shard("bad", { state: "weird" })]).shards![0]).toMatchObject({ coverage: null, state: null });
  });
  // 상태 바의 공백 모델(구역 n/m · 구역별 시작 · 다른 구역의 연결 · 끝난 공백의 구역 모름)은 lib/statusbar aisGapInfo — tests/statusbar-ais-gap.test.ts
  it("ships chip suffix: 'AIS 공백 1/2 구역(그 구역 위치 멈춤)' when only some shards are in a gap", () => {
    const s = status([shard(AMERICAS, { gap_open_since: "2026-09-28T02:50:00Z", connected: false }), shard(ASIA)], { gap_open_since: "2026-09-28T02:50:00Z", connected: false });
    expect(shipsGapSuffix(s)).toBe(" · AIS 공백 1/2 구역(그 구역 위치 멈춤)");
  });
  it("a shard in a gap and the other down (backoff): the connection badge says AIS 끊김", () => {
    // 아메리카는 공백 중, 아시아는 끊겼지만 아직 공백 기록 전(backoff)
    const s = status([shard(AMERICAS, { gap_open_since: "2026-09-28T02:50:00Z", connected: false }), shard(ASIA, { connected: false, state: "backoff" })],
      { gap_open_since: "2026-09-28T02:50:00Z", connected: false });
    expect(aisBadge(s, NOW, true)!.text).toBe("AIS 끊김");
  });
  it("all shards in a gap, or a single connection: the plain ships chip suffix", () => {
    const all = status([shard(AMERICAS, { gap_open_since: "2026-09-28T02:40:00Z" }), shard(ASIA, { gap_open_since: "2026-09-28T02:50:00Z" })], { gap_open_since: "2026-09-28T02:40:00Z" });
    expect(shipsGapSuffix(all)).toBe(" · AIS 공백 중(위치 멈춤)");
    expect(shipsGapSuffix(status(null))).toBe("");
  });
  it("connection badge: one of two shards down is 'AIS 일부 끊김 1/2 구역' (warn), not 'AIS 끊김'; all down stays 'AIS 끊김'", () => {
    const part = status([shard(AMERICAS, { connected: false, state: "backoff" }), shard(ASIA)], { connected: false });
    const b = aisBadge(part, NOW, true)!;
    expect(b.text).toBe("AIS 일부 끊김 1/2 구역 · 60.0 msg/s · lag 2s");
    expect(b.tone).toBe("warn");
    expect(b.title).toContain("재연결 중");
    const down = status([shard(AMERICAS, { connected: false }), shard(ASIA, { connected: false })], { connected: false, state: "backoff" });
    expect(aisBadge(down, NOW, true)!.text).toBe("AIS 끊김");
    expect(aisBadge(status([shard(AMERICAS), shard(ASIA)]), NOW, true)!.text).toBe("AIS · 60.0 msg/s · lag 2s");
  });
});

describe("live ship track: a shard's gap only breaks lines of ships inside that shard (contract v4 §D)", () => {
  const ASIA_SHIP = { lat: 35, lon: 129 };
  const AMERICA_SHIP = { lat: 30, lon: -120 };
  const START = "2026-09-28T02:50:00Z";
  const END = "2026-09-28T02:55:00Z";
  const openAmericas = (over: Record<string, unknown> = {}) =>
    status([shard(AMERICAS, { gap_open_since: START, connected: false }), shard(ASIA)], { gap_open_since: START, ...over }) as AisStatus;
  const closed = (startIso = START) => status([shard(AMERICAS), shard(ASIA)], { gap_open_since: null, last_gap: { started_at: startIso, ended_at: END, reason: null } }) as AisStatus;
  const since = NOW - 6 * 3600_000;

  it("the open gap of the shard that covers the ship; none for a ship in another shard; unknown position or scope → aggregate", () => {
    expect(statusOpenGapFor(openAmericas(), AMERICA_SHIP)).toEqual({ openSince: START, scoped: true });
    expect(statusOpenGapFor(openAmericas(), ASIA_SHIP)).toEqual({ openSince: null, scoped: true });
    expect(statusOpenGapFor(openAmericas(), null)).toEqual({ openSince: START, scoped: false });
    const noScope = status([shard(null, { gap_open_since: START }), shard(ASIA)], { gap_open_since: START });
    expect(statusOpenGapFor(noScope, ASIA_SHIP)).toEqual({ openSince: START, scoped: false });
  });
  it("status.server_time is the observation time of the shard states", () => {
    const st = parseAisStatus({ server_time: "2026-09-28T02:52:00Z", sources: { ais: { connected: true, shards: [shard(AMERICAS), shard(ASIA)] } } }, NOW)!;
    expect(st.server_ms).toBe(Date.parse("2026-09-28T02:52:00Z"));
    expect(parseAisStatus({ server_time: "later", sources: { ais: { connected: true } } }, NOW)!.server_ms).toBeNull();
    expect(status(null).server_ms).toBeNull();
  });
  const scopedClosed = (scope: string | undefined) =>
    status([shard(AMERICAS), shard(ASIA)], { gap_open_since: null, last_gap: { started_at: START, ended_at: END, reason: null, ...(scope ? { scope } : {}) } }) as AisStatus;
  it("the closed gap's scope (from the status) decides — a ship outside that shard never gets it, even after a reconnect", () => {
    const tr: ShipTrack = { segs: [], gaps: [] };
    expect(mergeStatusGaps(tr, openAmericas(), since, ASIA_SHIP)).toBe(false); // 아메리카 자리표시는 아시아 선박에 없다
    expect(mergeStatusGaps(tr, scopedClosed("-90,-180,90,0"), since, ASIA_SHIP)).toBe(false);
    expect(tr.gaps).toEqual([]);
    // 재연결·숨긴 탭으로 열린 상태를 못 봤어도, 자기 구역의 끝난 공백은 받는다(선을 모르는 구간을 실선으로 잇지 않는다)
    const own: ShipTrack = { segs: [], gaps: [] };
    expect(mergeStatusGaps(own, scopedClosed("-90,45,90,180"), since, ASIA_SHIP)).toBe(true);
    expect(own.gaps).toHaveLength(1);
    expect(own.gaps[0]).toMatchObject({ started_at: START, ended_at: END });
    // 다른 구역의 짧은 공백도 이 선박에는 넣지 않는다(관측 시각으로 추정하지 않는다)
    const other: ShipTrack = { segs: [], gaps: [] };
    expect(mergeStatusGaps(other, scopedClosed("-90,45,90,180"), since, AMERICA_SHIP)).toBe(false);
  });
  it("a gap without scope (legacy · fixture · whole-process restart) applies to every ship", () => {
    for (const ship of [ASIA_SHIP, AMERICA_SHIP]) {
      const tr: ShipTrack = { segs: [], gaps: [] };
      expect(mergeStatusGaps(tr, closed(), since, ship)).toBe(true);
      expect(tr.gaps).toEqual([{ started_at: START, ended_at: END, reason: null }]);
    }
  });
  it("REST track gaps with scope are filtered to the selected ship's shard", () => {
    const tr: ShipTrack = {
      segs: [],
      gaps: [
        { started_at: "2026-09-28T01:00:00Z", ended_at: "2026-09-28T01:05:00Z", reason: null, scope: parseScopeText("-90,-180,90,0")! },
        { started_at: "2026-09-28T01:10:00Z", ended_at: "2026-09-28T01:12:00Z", reason: null, scope: parseScopeText("-90,45,90,180")! },
        { started_at: "2026-09-28T01:20:00Z", ended_at: "2026-09-28T01:21:00Z", reason: null },
      ],
    };
    expect(mergeStatusGaps(tr, status([shard(AMERICAS), shard(ASIA)]), since, ASIA_SHIP)).toBe(true);
    expect(tr.gaps.map((g) => g.started_at)).toEqual(["2026-09-28T01:10:00Z", "2026-09-28T01:20:00Z"]);
  });
  it("scope text parsing: valid one-shard strings only; anything else is 'no scope' (applies to all)", () => {
    expect(parseScopeText("-90,45,90,180;10,10,20,20")).toEqual([{ s: -90, w: 45, n: 90, e: 180 }, { s: 10, w: 10, n: 20, e: 20 }]);
    for (const bad of ["a|b", "1,2,3", "1e1,0,1,1", "", 7, null, "91,0,1,1"]) expect(parseScopeText(bad)).toBeNull();
    expect(gapAppliesTo({ started_at: START, ended_at: END, reason: null }, ASIA_SHIP)).toBe(true);
    expect(gapAppliesTo({ started_at: START, ended_at: END, reason: null, scope: parseScopeText("-90,-180,90,0")! }, null)).toBe(true); // 위치 모름
  });
  it("a ship in the Americas: placeholder, then the closed gap replaces it (start within 1 s)", () => {
    const tr: ShipTrack = { segs: [], gaps: [] };
    expect(mergeStatusGaps(tr, openAmericas(), since, AMERICA_SHIP)).toBe(true);
    expect(tr.gaps).toEqual([{ started_at: START, ended_at: null, reason: null }]);
    expect(mergeStatusGaps(tr, closed("2026-09-28T02:50:00.400Z"), since, AMERICA_SHIP)).toBe(true);
    expect(tr.gaps).toEqual([{ started_at: "2026-09-28T02:50:00.400Z", ended_at: "2026-09-28T02:55:00Z", reason: null }]);
    expect(mergeStatusGaps(tr, closed("2026-09-28T02:50:00.400Z"), since, AMERICA_SHIP)).toBe(false); // 다음 상태(같은 last_gap)
  });
  it("without a position the aggregate is used, as before", () => {
    const tr: ShipTrack = { segs: [], gaps: [] };
    mergeStatusGaps(tr, openAmericas(), since);
    expect(tr.gaps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- WS 배관

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close(code?: number) { this.readyState = 3; this.onclose?.({ code: code ?? 1005 }); }
  open() { this.readyState = 1; this.onopen?.({}); }
  recv(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}

describe("WS client plumbing for v4 fields", () => {
  beforeEach(() => { resetData(); vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); resetData(); });
  function welcomed() {
    let sock: FakeSocket | null = null;
    const client = new WakelineWsClient({ postMessage() {} }, { url: "ws://test/ws/v1", isHidden: () => false, createSocket: () => (sock = new FakeSocket()) });
    client.connect();
    sock!.open();
    sock!.recv({ type: "welcome", server_time: TS });
    return { client, ws: sock! };
  }
  it("subscribe records the viewport; selected carries a validated route; ship_selected a validated destination_info", () => {
    const { client, ws } = welcomed();
    client.subscribe([120, 30, 135, 40], 5);
    expect(getData().viewport).toEqual({ bbox: [120, 30, 135, 40], zoom: 5 });
    client.select("abc123");
    ws.recv({ type: "selected", hex: "abc123", state: { hex: "abc123", lat: 1, lon: 2 }, route: { status: "pending", callsign: "TST123", source: "adsbdb" } });
    expect(getData().selected?.route).toMatchObject({ status: "pending", callsign: "TST123" });
    ws.recv({ type: "selected", hex: "abc123", state: null, route: { status: "bogus" } });
    expect(getData().selected?.route).toBeNull();
    client.selectShip("431011305");
    ws.recv({ type: "ship_selected", mmsi: "431011305", state: null, static: null, destination_info: { raw: ">ZZBBB", kind: "to", to: BRAVO, places: [BRAVO] } });
    expect(getData().shipSelected?.destination_info?.to?.name).toBe("Bravo Harbour");
    ws.recv({ type: "ship_selected", mmsi: "431011305", state: null, static: null });
    expect(getData().shipSelected?.destination_info).toBeNull();
  });
});

// ---------------------------------------------------------------- §F 출처

describe("attribution: route data and port codes (contract v4 §F)", () => {
  it("footer, map credit and /about carry adsbdb and UN/LOCODE", () => {
    expect(attributionText()).toContain("노선: adsbdb.com (flight route data © David Taylor · Jim Mason)");
    expect(attributionText()).toContain("항구 코드: UN/LOCODE (UNECE, datasets/un-locode ODC-PDDL)");
    expect(mapAttributionHtml()).toContain("adsbdb.com</a>");
    expect(CREDITS.every((c) => c.href.startsWith("https://"))).toBe(true);
    const footer = renderToStaticMarkup(createElement(AttributionFooter));
    expect(footer).toContain("adsbdb.com");
    expect(footer).toContain("UN/LOCODE");
    const about = renderToStaticMarkup(createElement(AboutPage));
    expect(about).toContain("노선 adsbdb.com(flight route data © David Taylor · Jim Mason)");
    expect(about).toContain("항구 코드 UN/LOCODE(UNECE, datasets/un-locode ODC-PDDL)");
    expect(about).toContain("flight route data © David Taylor, Edinburgh &amp; Jim Mason, Glasgow");
    expect(about).not.toContain("줌 7 미만에서는 격자");
  });
});
