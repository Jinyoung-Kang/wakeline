/**
 * 상황판 배치 결함(사용자 스크린샷 1427×829 · 2026-09-30) — 서버 렌더 구조로 확인하고 고쳤다. 실제 폭은 e2e/dashboard-layout.spec.ts 가 1440 · 1280 · 1024 에서 잰다.
 * - 알림 배너: 한 줄 truncate 라 "PREDICTED 진입 예상(추정) · AAL2646 · TS MMEX · 수신 02:43:56 K…"(내용 562 px / 379 px)가 잘렸다 →
 *   두 줄(1: 종류 · 호출부호, 2: SIGMET · 받은 시각), 자리 높이는 고정(목록이 밀리지 않게 — R-09), 전체 문장은 title.
 * - 알림 머리: "0 inside · 0 predicted" 가 범위 단추(관심 지역 · 전세계 731) 옆에서 어색하게 줄바꿈 → 수는 단추 아래 자기 줄(줄바꿈 없음).
 * - 검색 상자: 자리 글자 "항공기 호출부호·hex · 선박 선명·MMSI·IMO"(244 px)가 입력 안쪽(190 px)보다 길어 잘리고 "/" 표시와 겹쳤다 →
 *   "/" 표시 자리를 오른쪽 안쪽 여백으로 비우고 자리 글자를 줄였다(전체 설명은 label · title).
 * - 지도의 속 빈 회색 원(줌 6, 라벨 없음): METAR 가 2 h 넘게 오래된 공항(속 빈 회색 고리 — 라벨은 줌 7 부터). 범례가 그 모양과 줌을 말한다.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AlertPanel } from "@/components/AlertPanel";
import { MapLegendView } from "@/components/MapLegend";
import { MapChipsView } from "@/components/MapChips";
import { resetData, setData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import type { Alert, PublicStatus } from "@/lib/types";
import { ancestors, byTestId, classes, findAll, parseHtml, textOf } from "./helpers/html-tree";

beforeEach(() => resetData());
afterEach(() => resetData());

const A = {
  id: 2, kind: "PREDICTED", hex: "71ca03", callsign: "AAL2646", sigmet_id: "MMEX:TS1", fir_id: "MMEX", hazard: "TS", qualifier: "EMBD",
  entered_at: "2026-09-29T17:43:00Z", eta_s: 300, eta_at: "2026-09-29T17:48:00Z", alt_ft: 30000, evidence: { judged_at: "2026-09-29T17:43:00Z" }, estimated: true,
} as unknown as Alert;
const STATUS = { region: { center: [36.5, 127.8], radius_nm: 250 } } as unknown as PublicStatus;
const panel = () => parseHtml(renderToStaticMarkup(createElement(AlertPanel)));

describe("alert banner: the key facts are readable (two lines), the full sentence is in the title", () => {
  it("line 1 = event kind + callsign, line 2 = SIGMET + received time (KST only); nothing is cut with an ellipsis", () => {
    setData({ conn: "open", alertsVersion: 1, lastEvent: { type: "PREDICTED", alert: A, at: Date.parse("2026-09-29T17:43:56Z") } });
    const b = byTestId(panel(), "alert-banner")!;
    const lines = findAll(b, (n) => n.attrs["data-line"] != null);
    expect(lines.map((l) => l.attrs["data-line"])).toEqual(["event", "sigmet"]);
    expect(textOf(lines[0])).toMatch(/PREDICTED\s*진입 예상\(추정\) · AAL2646/);
    expect(textOf(lines[1])).toContain("TS EMBD · MMEX");
    expect(textOf(byTestId(b, "alert-banner-time")!)).toBe("수신 02:43:56 KST");
    expect(textOf(b)).not.toContain("UTC");
    // 줄 전체를 한 번에 자르지 않는다(전에는 banner 자체가 truncate)
    expect(classes(b).has("truncate")).toBe(false);
    expect(b.attrs.title).toBe("PREDICTED 진입 예상(추정) · AAL2646 · SIGMET TS EMBD · MMEX(MMEX:TS1) · 수신 09-30 02:43:56 KST");
  });
  it("the banner slot keeps one fixed height for two lines, with or without an event (the list does not jump — R-09)", () => {
    setData({ conn: "open", alertsVersion: 1 });
    const slot = (root: ReturnType<typeof panel>) => findAll(root, (n) => n.attrs.role === "status" && n.attrs["aria-live"] === "polite")[0];
    const empty = slot(panel());
    setData({ lastEvent: { type: "PREDICTED", alert: A, at: Date.now() } });
    const full = slot(panel());
    const h = (n: typeof empty) => [...classes(n)].find((c) => /^h-\[/.test(c));
    expect(h(empty)).toBe("h-[40px]");
    expect(h(full)).toBe(h(empty));
  });
});

describe("alert header: the counts sit on their own line under the scope buttons (no awkward wrap beside '전세계 731')", () => {
  it("scope buttons in the header row; 'N inside · N predicted' in a separate no-wrap line naming the scope", () => {
    setData({ conn: "open", lastRxAt: Date.now(), alertsVersion: 3, status: STATUS, alerts: new Map([[2, A]]) });
    const root = panel();
    const counts = byTestId(root, "alerts-counts")!;
    const region = byTestId(root, "alerts-scope-region")!;
    // 같은 줄(.row)에 들지 않는다
    const rowOf = (n: typeof counts) => ancestors(n).find((a) => classes(a).has("row"));
    expect(rowOf(region)).toBeTruthy();
    expect(rowOf(counts)).toBeUndefined();
    expect(classes(counts).has("whitespace-nowrap")).toBe(true);
    expect(textOf(counts)).toMatch(/^0 inside · 0 predicted/); // 관심 지역 밖(위치 없음) — 전세계에서만
    expect(textOf(counts)).toContain("관심 지역 · 반경 250 NM");
  });
});

describe("search box: the '/' key hint has its own space and the placeholder is short enough to show", () => {
  const src = readFileSync(new URL("../components/AircraftSearch.tsx", import.meta.url), "utf8");
  const input = /<input[\s\S]*?data-testid="aircraft-search-input"\s*\/>/.exec(src)![0];
  const kbd = /<kbd className="([^"]*)"/.exec(src)![1];
  const spacing = (cls: string, prefix: string) => Number(new RegExp(`(?:^|\\s)${prefix}(\\d+(?:\\.\\d+)?)!?(?:\\s|$)`).exec(cls)?.[1] ?? NaN);
  it("the input reserves right padding at least as wide as the hint's pull-in (no overlap with typed text or placeholder)", () => {
    const cls = /className="([^"]*)"/.exec(input)![1];
    expect(spacing(cls, "pr-")).toBeGreaterThanOrEqual(spacing(kbd, "-ml-"));
    // globals.css 의 input { padding } 은 층(@layer) 밖이라 유틸리티 pr-* 를 이긴다 — 중요도(!)가 있어야 실제로 적용된다(하네스에서 8 px 로 잰 뒤 고침)
    expect(/(?:^|\s)pr-\d+!(?:\s|$)/.test(cls)).toBe(true);
    expect(readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")).toMatch(/^input, select \{[^}]*padding: 4px 8px/m);
  });
  it("the placeholder names both kinds briefly; the full list of keys stays in the label and title", () => {
    const ph = /placeholder="([^"]*)"/.exec(input)![1];
    expect(ph).toBe("항공기 · 선박 검색");
    expect(input).toMatch(/title="[^"]*호출부호[^"]*MMSI[^"]*"/);
    expect(src).toContain("통합 검색 — 항공기(호출부호·hex·등록번호) · 선박(선명·MMSI·IMO·호출부호)");
  });
});

describe("map overlays share one layout: toolbar row, then a left status column and a right legend column (no overlap)", () => {
  // 하네스(1024 · 1280, 선박 켬)에서 레이어 단추 줄이 왼쪽 위 선박 칩("선박 53척 · 2° 격자 …")을 덮었다 — 둘이 따로 absolute 로 같은 자리(top-3)에 있었다.
  it("the chips column lives inside the overlay under the toolbar row (not a separate absolute box at the same top)", async () => {
    const { LayerPanelView } = await import("@/components/LayerPanel");
    useUi.setState({ layers: { ...useUi.getState().layers, ships: true } });
    setData({ conn: "open", lastRxAt: Date.now(), ships: { mode: "grid", version: 1, count: 2, total: 53, ts: null, cell_deg: 2, capped: false, grid: [] } });
    const root = parseHtml(renderToStaticMarkup(createElement(LayerPanelView, { layers: useUi.getState().layers, shipCats: useUi.getState().shipCats, legendOpen: true })));
    const toolbar = byTestId(root, "layer-panel")!;
    const chips = byTestId(root, "map-chips")!;
    const legend = byTestId(root, "map-legend")!;
    const overlay = toolbar.parent!;
    expect(classes(overlay).has("absolute")).toBe(true);
    // 칩 · 범례는 단추 줄 뒤 같은 줄(두 칸)에 — 서로 다른 칸이다
    const below = overlay.children.filter((c) => c.tag !== "#text");
    expect(below.indexOf(toolbar)).toBe(0);
    const cols = below[1];
    expect(ancestors(chips)).toContain(cols);
    expect(ancestors(legend)).toContain(cols);
    const colOf = (n: typeof chips) => ancestors(n).find((a) => a.parent === cols)!;
    expect(colOf(chips)).not.toBe(colOf(legend));
    expect(classes(chips).has("absolute")).toBe(false);
    expect(textOf(chips)).toContain("선박");
    // 두 칸은 남은 높이를 채운다 — items-start 이면 범례 칸의 높이가 정해지지 않아 긴 범례가 지도 아래(타임라인 · 출처 줄)를 덮었다(하네스 1024 px)
    expect(classes(cols).has("items-start")).toBe(false);
    expect(["flex", "min-h-0", "flex-1"].every((c) => classes(cols).has(c))).toBe(true);
    const legendCol = colOf(legend);
    expect(["flex", "flex-col", "min-h-0"].every((c) => classes(legendCol).has(c))).toBe(true);
    expect(["max-h-full", "overflow-y-auto"].every((c) => classes(legend).has(c))).toBe(true);
    useUi.setState({ layers: { ...useUi.getState().layers, ships: false } });
  });
  it("the dashboard page renders the chips only through the overlay (once), and the basemap-failed notice joins the left column", () => {
    const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
    expect(page).not.toMatch(/<MapChips\b/);
    const map = readFileSync(new URL("../components/MapView.tsx", import.meta.url), "utf8");
    expect(map).not.toContain('data-testid="basemap-failed"');
    const html = renderToStaticMarkup(createElement(MapChipsView, { hex: null, shipsOn: false, basemapFailed: true }));
    expect(html).toContain('data-testid="basemap-failed"');
    expect(html).toContain("배경지도를 불러오지 못함");
    expect(renderToStaticMarkup(createElement(MapChipsView, { hex: null, shipsOn: false }))).not.toContain("basemap-failed");
    // LayerPanel 이 그 값을 스토어에서 읽어 넘긴다(MapView 가 스타일 실패 때 정한다)
    expect(readFileSync(new URL("../components/LayerPanel.tsx", import.meta.url), "utf8")).toMatch(/basemapFailed=\{basemapFailed\}/);
    expect(map).toMatch(/useUi\.getState\(\)\.setBasemapFailed\(true\)/);
  });
});

describe("side-panel cards: the label column never shrinks, so a long value does not break a Korean label mid-word", () => {
  // 하네스 1024 px: 항공기 카드의 "관측 시각" 이 긴 시각 값 옆에서 "관측 시 / 각" 으로 쪼개졌다
  it("aircraft, airport, evidence and SIGMET cards keep their label cells at full width (shrink-0)", () => {
    for (const f of ["AircraftCard", "AirportCard", "EvidenceCard", "SigmetCard"]) {
      const src = readFileSync(new URL(`../components/${f}.tsx`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/<span className="text-fg-3">\{k\}<\/span>/);
      expect(src, f).toMatch(/<span className="shrink-0 text-fg-3">\{k\}<\/span>/);
    }
  });
});

describe("map: the hollow grey circles at zoom 6 are airports with a stale METAR — the legend says so with the zooms", () => {
  it("legend row names the shape (속이 빈 회색 고리) and the airport section names both zooms (circle 5.5+, label 7+)", () => {
    const html = renderToStaticMarkup(createElement(MapLegendView, { id: "l", layers: { ...useUi.getState().layers, airports: true }, radarSource: "rainviewer" }));
    const t = textOf(parseHtml(html));
    expect(t).toContain("METAR 오래됨(> 2 h) — 속이 빈 회색 고리");
    expect(t).toContain("줌 5.5+ 원 · 7+ 라벨");
  });
});
