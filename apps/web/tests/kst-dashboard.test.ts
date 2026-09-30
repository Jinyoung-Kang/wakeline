/**
 * 상황판(지도 · 카드 · 상태 바 · 툴팁)의 시각은 한국 표준시(KST)만(사용자 결정 2026-09-30 "[상황판·재생·통계·공항 화면]을 포함한 필요한(해당되는)
 * 메뉴에 시각을 UTC 지우고, KST 표시" — 계약 v5 §G20 이 §G13 의 "KST 먼저 · UTC 함께" 를 대신한다).
 * - "09-29 08:41:14 KST", 상태 바 · 지도 툴팁 · 선 라벨은 분까지 "08:41 KST", 구간은 끝에 한 번("08:40–08:45 KST"). title 은 연도 · ms 까지의 KST.
 * - 원문 전문(METAR · TAF · SIGMET raw)은 발표된 그대로(data-raw) — 안의 "…Z" 시각을 바꾸지 않는다.
 * - 모르면 "—" 만(시간대 글자도 붙이지 않는다).
 * - 이 파일이 상황판 전체(상태 바 · 레이어 · 칩 · 타임라인 · 오른쪽 패널의 모든 탭)를 그려 원문 밖의 UTC 흔적(tests/helpers/kst-only)이 없는지 본다.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as F from "@/lib/format";
import * as T from "@/lib/time";
import { htmlUtcLeaks, utcLeaks } from "./helpers/kst-only";
import { parseHtml } from "./helpers/html-tree";
import { getData, resetData, setData } from "@/lib/store";
import { detailRows, statusInput } from "@/lib/statusbar";
import { useUi } from "@/lib/ui-store";
import { StatusBar } from "@/components/StatusBar";
import { AlertPanel } from "@/components/AlertPanel";
import { EvidenceCard } from "@/components/EvidenceCard";
import { SigmetCard } from "@/components/SigmetCard";
import { SigmetListView } from "@/components/SigmetList";
import { KrRadarPanel } from "@/components/KrRadarPanel";
import { RadarTimeline } from "@/components/RadarTimeline";
import { MapLegendView } from "@/components/MapLegend";
import { AircraftCard, RouteSection } from "@/components/AircraftCard";
import { parseShipDetail, ShipCardView } from "@/components/ShipCard";
import { ShipTable } from "@/components/ShipTable";
import { SearchResultsView } from "@/components/AircraftSearch";
import { SidePanelView } from "@/components/SidePanel";
import { LayerPanel } from "@/components/LayerPanel";
import { wsInvalidText } from "@/components/WsInvalidBadge";
import { airportTip, shipTrackPointTip, sigmetTip } from "@/lib/tooltip";
import { fmtSavedAt, fmtShipEta, notLiveText, shipTrackFeatures, type ShipRow } from "@/lib/ships";
import { trackFeatureCollection } from "@/lib/track";
import { focusChip, parseDemand } from "@/lib/demand";
import { parseRoute } from "@/lib/route";
import { krTmClock } from "@/lib/kr-radar";
import type { Alert, KrRadar, SigmetProps } from "@/lib/types";
import AboutPage from "@/app/about/page";
import { preloadDashboardParts } from "./helpers/dashboard-parts";

/** UTC 자정 직전 — KST 로는 다음 날 아침(UTC 날짜가 다른 때 — 예전 두 시간대 표시가 날짜를 둘 붙이던 자리) */
const LATE = "2026-09-28T23:41:14.906Z";
/** html 에서 원문(data-raw) 밖의 UTC 흔적 — 글자 · title · aria-label */
const leaks = (html: string) => htmlUtcLeaks(parseHtml(html));


// 탭 내용 · 검색 결과 표 · 범례·정합은 나중에 받는 조각(ADR-026) — 내용을 보려면 미리 받는다(tests/helpers/dashboard-parts)
beforeAll(preloadDashboardParts);
describe("dashboard time formatters (lib/time): KST only", () => {
  it("minute form for radar frames: MM-DD HH:MM KST, across the KST and UTC date changes", () => {
    expect(T.fmtKstMinute(LATE, { date: true })).toBe("09-29 08:41 KST");
    expect(T.fmtKstMinute("2026-09-28T14:59:00Z", { date: true })).toBe("09-28 23:59 KST");
    expect(T.fmtKstMinute("2026-09-28T15:00:00Z", { date: true })).toBe("09-29 00:00 KST");
    expect(T.fmtKstMinute(Date.parse("2026-09-28T15:00:00Z"), { date: true })).toBe("09-29 00:00 KST");
  });
  it("hh:mm spans name the zone once; unknown → —", () => {
    expect(T.fmtKstSpan(LATE, Date.parse("2026-09-28T23:45:00Z"))).toBe("08:41–08:45 KST");
    expect(T.fmtKstSpan(Date.parse("2026-09-29T05:05:00Z"), "2026-09-29T05:10:00Z")).toBe("14:05–14:10 KST");
    for (const v of [null, undefined, "", "bad", Number.NaN]) expect(T.fmtKstSpan(v, v)).toBe("—");
  });
  it("ranges name the zone once; an unknown end is — on its side only; an open end can say so", () => {
    expect(T.fmtKstRange("2026-09-28T23:00:00Z", "2026-09-29T03:00:00Z")).toBe("09-29 08:00:00 – 09-29 12:00:00 KST");
    expect(T.fmtKstRange("2026-09-28T23:00:00Z", null)).toBe("09-29 08:00:00 KST – —");
    expect(T.fmtKstRange(null, "2026-09-29T03:00:00Z")).toBe("— – 09-29 12:00:00 KST");
    expect(T.fmtKstRange(null, "bad")).toBe("— – —");
    expect(T.fmtKstRange("2026-09-28T23:00:00Z", null, { open: "진행 중" })).toBe("09-29 08:00:00 KST – 진행 중");
  });
  it("range tooltip: both KST instants (year · ms); unknown sides are —; nothing known → no title", () => {
    expect(T.fmtRangeTitle("2026-09-28T23:00:00Z", "2026-09-29T03:00:00Z")).toBe("2026-09-29 08:00:00.000 KST – 2026-09-29 12:00:00.000 KST");
    expect(T.fmtRangeTitle("2026-09-28T23:00:00Z", null)).toBe("2026-09-29 08:00:00.000 KST – —");
    expect(T.fmtRangeTitle(null, "bad")).toBeUndefined();
  });
  it("title-only times (the visible text is an age): the full KST instant; unknown → —", () => {
    expect(T.fmtKstTitle(LATE)).toBe("2026-09-29 08:41:14.906 KST");
    expect(T.fmtKstTitle(null)).toBe("—");
    expect(T.fmtKstTitle("bad")).toBe("—");
  });
  it("day-aware minute form: no date on today's KST day, the KST date otherwise", () => {
    const NOW = Date.parse("2026-09-29T01:00:00Z"); // KST 09-29 10:00
    expect(T.fmtKstDayMinute("2026-09-28T15:30:00Z", NOW)).toBe("00:30 KST"); // UTC 로는 전날이지만 KST 로는 같은 날
    expect(T.fmtKstDayMinute("2026-09-28T14:30:00Z", NOW)).toBe("09-28 23:30 KST"); // KST 로 전날
    expect(T.fmtKstDayMinute("2026-09-28T14:30:00Z", 0)).toBe("09-28 23:30 KST"); // 지금을 모르면 날짜를 붙인다
    expect(T.fmtKstDayMinute(null, NOW)).toBe("—");
  });
  it("the KMA tm (issued in KST) reads as its own KST clock", () => {
    expect(krTmClock("202609290840")).toBe("08:40 KST");
    expect(krTmClock("bad")).toBe("—");
  });
});

const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<");

const KR = {
  available: true, latest_tm: "202609290840", georeferenced: true, coordinates: null, legend: [], min_dbz: 10,
  frames: [{ tm: "202609290840", obs_tm: "202609290840", fetched_at: "2026-09-28T23:41:00Z", echo_cells: 5, url: "/x" }],
  attribution: "기상청", meta: { fetched_at: "2026-09-28T23:20:00Z", stale: true },
} as unknown as KrRadar;
const SIG_RAW = "WSKO31 RKSI 282300\nRKRR SIGMET A1 VALID 282300/290300 RKSI-\nRKRR INCHEON FIR EMBD TS OBS AT 2250Z";
const SIG = { id: "S1", fir_id: "RKRR", fir_name: "INCHEON", series_id: "A1", hazard: "TS", valid_from: "2026-09-28T23:00:00Z", valid_to: "2026-09-29T03:00:00Z",
  active: true, expiring_soon: false, raw_text: SIG_RAW, provider: "awc", fetched_at: "2026-09-28T23:05:00Z" } as SigmetProps;
const ALERT = {
  id: 1, kind: "OBSERVED", hex: "a1", callsign: "CS1", sigmet_id: "S1", fir_id: "RKRR", hazard: "TS", entered_at: "2026-09-28T23:00:00Z", eta_s: null, alt_ft: 35000, estimated: false,
  left_at: "2026-09-28T23:30:00Z", close_reason: "EXITED",
  evidence: { valid_from: "2026-09-28T22:00:00Z", valid_to: "2026-09-29T02:00:00Z", judged_at: "2026-09-28T23:00:00Z", seen_at: "2026-09-28T22:59:30Z", provider: "adsb_fi" },
} as unknown as Alert;

describe("dashboard components show KST only (title = the full KST instant)", () => {
  beforeEach(() => resetData());
  afterEach(() => { resetData(); useUi.getState().setRadarSource("rainviewer"); });

  it("status bar (KST 만 — 사용자 결정 2026-09-30): region fetch time HH:MM:SS KST in the details; KMA latest tm HH:MM KST; KMA STALE title in KST", () => {
    const kr = {
      available: true, latest_tm: "202609290840", georeferenced: true, coordinates: null, legend: null,
      frames: [{ tm: "202609290840", obs_tm: "202609290840", fetched_at: "2026-09-28T23:41:00Z", echo_cells: 5, url: "/x" }],
      attribution: "기상청", meta: { fetched_at: "2026-09-28T23:20:00Z", stale: true },
    } as KrRadar;
    setData({ conn: "open", lastRxAt: Date.now(), radarKr: kr, feeds: { region: { provider: "adsb_fi", fetched_at: "2026-09-28T23:41:14Z", lag_s: 2, stale: false, received_at: Date.now() }, global: null } });
    const html = renderToStaticMarkup(createElement(StatusBar));
    // 오늘(KST 09-29)이 아닌 순간은 날짜와 함께 — 시계를 서버 시각으로 고정하지 않으므로 오늘이면 날짜가 없을 수 있다
    const rows = () => { const now = Date.now(); return detailRows(statusInput(getData(), now, now)); };
    expect(rows().find((r) => r.key === "region")!.source).toMatch(/^adsb_fi · 수집 (09-29 )?08:41:14 KST$/);
    expect(html).toMatch(/data-testid="kr-radar-stale" title="[^"]*최신 tm 첫 수집 (09-29 )?08:20:00 KST/);
    expect(rows().find((r) => r.key === "kma")!.value).toMatch(/^1f · 최신 tm (09-29 )?08:40 KST · /); // 기상청 tm 은 원래 KST
    expect(text(html)).not.toContain("UTC");
    expect(leaks(html)).toEqual([]);
    // 최신 tm 을 모르면 "—" 만 — "undefined:undefinedK" 가 아니다
    setData({ radarKr: { ...kr, latest_tm: null, meta: { fetched_at: null, stale: false } } });
    expect(rows().find((r) => r.key === "kma")!.value).toMatch(/^1f · 최신 tm — · /);
  });

  it("alert banner: received time in KST only (사용자 결정 2026-09-30)", () => {
    const a = { id: 3, kind: "OBSERVED", hex: "a3", callsign: "CS3", sigmet_id: "S3", fir_id: "RKRR", hazard: "TS", entered_at: "2026-09-28T23:00:00Z", eta_s: null, alt_ft: 35000, evidence: {}, estimated: false } as unknown as Alert;
    setData({ conn: "open", alertsVersion: 1, lastEvent: { type: "ENTERED", alert: a, at: Date.parse("2026-09-28T23:02:03Z") } });
    const html = renderToStaticMarkup(createElement(AlertPanel));
    expect(text(html)).toContain("수신 08:02:03 KST");
    expect(leaks(html)).toEqual([]);
  });

  it("evidence card: validity range, judged time, observation and end in KST", () => {
    const html = renderToStaticMarkup(createElement(EvidenceCard, { a: ALERT }));
    const t = text(html);
    expect(t).toContain("유효시간09-29 07:00:00 – 09-29 11:00:00 KST");
    expect(html).toContain('title="2026-09-29 07:00:00.000 KST – 2026-09-29 11:00:00.000 KST"');
    expect(t).toContain("판정 시각09-29 08:00:00 KST");
    expect(t).toContain("출처 / 관측adsb_fi · 09-29 07:59:30 KST");
    expect(t).toMatch(/종료09-29 08:30:00 KST · /);
    expect(leaks(html)).toEqual([]);
  });

  it("SIGMET card and list: validity in KST, the raw bulletin exactly as issued (data-raw)", () => {
    setData({ sigmets: { type: "FeatureCollection", features: [{ type: "Feature", properties: SIG, geometry: null }] } as never });
    const html = renderToStaticMarkup(createElement(SigmetCard, { id: "S1" }));
    expect(text(html)).toContain("유효09-29 08:00:00 – 09-29 12:00:00 KST");
    expect(text(html)).toContain("출처awc · 09-29 08:05:00 KST");
    expect(text(html.replace(/\n/g, "⏎"))).toContain(SIG_RAW.replace(/\n/g, "⏎")); // 원문은 발표된 그대로(…2250Z 포함)
    expect(html).toMatch(/<pre[^>]*data-raw="bulletin"[^>]*>WSKO31/);
    expect(text(html)).toContain("Raw (원문 · 발표 그대로)");
    expect(leaks(html)).toEqual([]); // 원문(data-raw) 밖에는 UTC 가 없다
    const list = renderToStaticMarkup(createElement(SigmetListView, { items: [{ id: "S1", hazard: "TS", qualifier: null, fir_id: "RKRR", fir_name: "INCHEON", valid_to: SIG.valid_to, pending: false, inside: 0, predicted: 0, center: null }] }));
    expect(list).toContain("유효 09-29 12:00:00 KST 까지");
    expect(leaks(list)).toEqual([]);
  });

  it("KMA radar panel and radar timeline: reception and frame times in KST", () => {
    setData({ radarKr: { ...KR, meta: { fetched_at: "2026-09-28T23:41:00Z", stale: false } }, radar: { host: "h", generated: 0, past: [{ time: Date.parse("2026-09-28T23:40:00Z") / 1000, path: "/p" }], fetched_at: "2026-09-28T23:41:00Z" } });
    const panel = renderToStaticMarkup(createElement(KrRadarPanel, { onClose: () => {} }));
    expect(text(panel)).toContain("수신09-29 08:41:00 KST");
    expect(text(panel)).toContain("202609290840 (08:40 KST)"); // 기상청 tm 원문 옆에 같은 순간
    expect(leaks(panel)).toEqual([]);
    const tl = renderToStaticMarkup(createElement(RadarTimeline));
    expect(/data-testid="radar-frame-time"[^>]*>([^<]*)</.exec(tl)![1]).toBe("09-29 08:40 KST"); // RainViewer 프레임(epoch) → KST
    expect(tl).toMatch(/title="2026-09-29 08:40:00.000 KST"[^>]*data-testid="radar-frame-time"|data-testid="radar-frame-time"[^>]*title="2026-09-29 08:40:00.000 KST"/);
    expect(leaks(tl)).toEqual([]);
  });

  it("map legend: the ship track point and traffic tooltips say KST", () => {
    const html = renderToStaticMarkup(createElement(MapLegendView, { id: "l", layers: { ...useUi.getState().layers, ships: true, tracks: true, traffic: true }, radarSource: "rainviewer" }));
    expect(text(html)).toContain("항적 점 — 마우스를 올리면 시각(KST)·속력·침로·항해 상태");
    expect(leaks(html)).toEqual([]);
  });

  it("aircraft card and route section: observation, reception and route lookup times in KST (title = full KST instant)", () => {
    setData({ selected: { hex: "71c081", received_at: 0, prediction: null, state: { hex: "71c081", lat: 36, lon: 127, seen_at: "2026-09-28T23:41:14Z", fetched_at: "2026-09-28T23:41:15Z", provider: "adsb_fi" } } as never });
    const card = renderToStaticMarkup(createElement(AircraftCard, { hex: "71c081" }));
    expect(text(card)).toContain("관측 시각09-29 08:41:14 KST");
    expect(text(card)).toContain("수신 시각09-29 08:41:15 KST");
    expect(card).toContain('title="2026-09-29 08:41:14.000 KST"');
    expect(leaks(card)).toEqual([]);
    const route = parseRoute({ status: "found", callsign: "KAL081", source: "adsbdb", fetched_at: "2026-09-28T23:00:00Z", airline: null,
      origin: { icao: "RKSI", name: "Incheon", lat: 37.46, lon: 126.44 }, destination: { icao: "KJFK", name: "John F Kennedy", lat: 40.64, lon: -73.78 } });
    const r = renderToStaticMarkup(createElement(RouteSection, { route, pos: null, callsign: "KAL081" }));
    expect(text(r)).toContain("조회 시각09-29 08:00:00 KST");
    expect(r).toContain('title="2026-09-29 08:00:00.000 KST"');
    expect(leaks(r)).toEqual([]);
  });

  it("ship card: times, the reception gaps and the crew ETA in KST; the hover hint says KST", () => {
    const NOW = Date.parse("2026-09-29T01:00:00Z");
    const detail = parseShipDetail("431011305", {
      state: null, static: { name: "SYN BRAVO", ship_type: 70, eta_month: 9, eta_day: 30, eta_hour: 20, eta_minute: 5 },
      first_recorded_at: "2026-09-20T01:02:03Z", last_position_at: "2026-09-28T23:00:00Z", last_seen_at: "2026-09-28T23:05:00Z", meta: {},
    });
    setData({ shipTrack: { mmsi: "431011305", loaded: true, error: null, gapsTruncated: false, segments: 2, fromMs: null, hours: 6,
      gaps: [{ started_at: "2026-09-28T22:00:00Z", ended_at: "2026-09-28T22:05:00Z", reason: "keepalive" }, { started_at: "2026-09-28T23:10:00Z", ended_at: null, reason: null }] } });
    const html = renderToStaticMarkup(createElement(ShipCardView, { mmsi: "431011305", detail, error: null, now: NOW }));
    const t = text(html);
    expect(t).toContain("처음 기록09-20 10:02:03 KST");
    expect(t).toContain("마지막 저장 위치09-29 08:00:00 KST (2h 00m 전)");
    expect(t).toContain("마지막 수신09-29 08:05:00 KST (1h 55m 전)");
    expect(t).toContain("실시간 아님 · 마지막 수신 08:05 KST · 마지막 저장 08:00 KST");
    expect(t).toContain("수신 공백 09-29 07:00:00 – 09-29 07:05:00 KST · 300 s · keepalive");
    expect(t).toContain("수신 공백 09-29 08:10:00 KST – 진행 중");
    expect(t).toContain("ETA10-01 05:05 KST · 선원 입력 · 연도 없음");
    expect(t).toContain("항적 점에 마우스를 올리면 시각(KST)·속력·침로·항해 상태");
    expect(html).toContain('title="2026-09-20 10:02:03.000 KST"');
    expect(leaks(html)).toEqual([]);
  });

  it("ship table: not-live rows in KST (the KST day decides whether the date is shown); tooltips carry the full KST instant", () => {
    const NOW = Date.parse("2026-09-29T01:00:00Z"); // KST 09-29 10:00
    const rows: ShipRow[] = [
      { mmsi: "300000001", name: "ALPHA", category: "cargo", sog_kn: 3, nav_status: 0, live: true, seen_at: "2026-09-29T00:59:00Z", last_position_at: null, last_seen_at: null },
      { mmsi: "300000002", name: "BRAVO", category: "cargo", sog_kn: null, nav_status: null, live: false, seen_at: null, last_position_at: "2026-09-28T15:30:00Z", last_seen_at: "2026-09-28T14:30:00Z" },
    ] as ShipRow[];
    const html = renderToStaticMarkup(createElement(ShipTable, { rows, now: NOW, sort: null, onSort: () => {}, onPick: () => {}, testId: "ship-list" }));
    const r2 = text(/data-mmsi="300000002".*?<\/tr>/.exec(html)![0]);
    expect(r2).toContain("마지막 수신 09-28 23:30 KST"); // KST 로 전날
    expect(r2).toContain("저장 00:30 KST"); // UTC 로는 전날이지만 KST 로는 오늘
    expect(html).toContain('title="2026-09-29 09:59:00.000 KST"');
    expect(html).toMatch(/title="마지막 수신 2026-09-28 23:30:00.000 KST · 마지막 저장 위치 2026-09-29 00:30:00.000 KST — /);
    expect(leaks(html)).toEqual([]);
  });

  it("search results: the aircraft 'db' badge, the not-live ship rows and the search box's help line name KST only", () => {
    const NOW = Date.parse("2026-09-29T01:00:00Z");
    const results = renderToStaticMarkup(createElement(SearchResultsView, {
      uid: "u", now: NOW, active: -1, shipSort: { key: "sog", dir: "desc" }, onShipSort: () => {}, onChooseAircraft: () => {}, onChooseShip: () => {}, onHover: () => {},
      aircraft: { hits: [{ hex: "71c081", callsign: "KAL081", registration: null, type_code: null, alt_ft: null, on_ground: null, lat: null, lon: null, live: false, last_seen: "2026-09-28T23:41:14Z" }], state: "done", msg: "1건" },
      ships: { hits: [{ mmsi: "300000002", name: "BRAVO", call_sign: null, imo: null, ship_type: null, category: "cargo", live: false, lat: null, lon: null, sog_kn: null, seen_at: null, last_position_at: "2026-09-28T15:30:00Z", last_seen_at: "2026-09-28T14:30:00Z" }], state: "done", msg: "1건", note: null, error: null },
    } as never));
    expect(results).toContain('title="마지막 수신 2026-09-29 08:41:14.000 KST"');
    const t = text(results);
    expect(t).toContain("마지막 수신·저장 시각은 KST ·"); // 검색 상자의 설명 줄은 KST 만(사용자 결정 2026-09-30 — 대시보드 UX 레인 3c2ec90)
    expect(utcLeaks(t)).toEqual([]);
    expect(leaks(results)).toEqual([]); // 글자 · title · aria-label 어디에도 UTC 가 없다
  });

  it("WS format-error detail: the browser-clock time in KST", () => {
    const t = wsInvalidText({ elements: 1, messages: 0, errors: 0, last: "aircraft: bad lat", at: Date.parse("2026-09-28T23:41:14Z") });
    expect(t).toContain("마지막: aircraft: bad lat · 08:41:14 KST(브라우저 시계)");
    expect(utcLeaks(t)).toEqual([]);
  });

  it("the whole dashboard (status bar · layer panel · chips · radar timeline · every side-panel tab) has no UTC outside raw bulletins", () => {
    useUi.setState({ layers: { ...useUi.getState().layers, ships: true, tracks: true, traffic: true } });
    setData({
      conn: "open", lastRxAt: Date.now(), radarKr: KR, alertsVersion: 1, alerts: [ALERT] as never,
      lastEvent: { type: "ENTERED", alert: ALERT, at: Date.parse("2026-09-28T23:02:03Z") },
      feeds: { region: { provider: "adsb_fi", fetched_at: "2026-09-28T23:41:14Z", lag_s: 2, stale: false, received_at: Date.now() }, global: null },
      radar: { host: "h", generated: 0, past: [{ time: Date.parse("2026-09-28T23:40:00Z") / 1000, path: "/p" }], fetched_at: "2026-09-28T23:41:00Z" },
      sigmets: { type: "FeatureCollection", features: [{ type: "Feature", properties: SIG, geometry: null }] } as never,
      selected: { hex: "71c081", received_at: 0, prediction: null, state: { hex: "71c081", lat: 36, lon: 127, seen_at: "2026-09-28T23:41:14Z", fetched_at: "2026-09-28T23:41:15Z", provider: "adsb_fi" } } as never,
    });
    // 지도 칩(MapChipsView)은 LayerPanel 이 레이어 단추 줄 아래 칸에 그린다(대시보드 UX 레인 0dce5e2)
    const parts = [StatusBar, LayerPanel, RadarTimeline].map((c) => renderToStaticMarkup(createElement(c)));
    for (const panel of ["alerts", "aircraft", "ship", "sigmet", "airport"] as const) {
      parts.push(renderToStaticMarkup(createElement(SidePanelView, { panel, hex: "71c081", sigmet: panel === "sigmet" ? "S1" : null, airport: null })));
    }
    parts.push(renderToStaticMarkup(createElement(SidePanelView, { panel: "sigmet", hex: null, sigmet: null, airport: null }))); // SIGMET 목록
    for (const html of parts) expect(leaks(html)).toEqual([]);
    expect(parts.join("")).toContain("KST"); // 시각이 실제로 그려졌다(빈 화면을 통과시키지 않는다)
    expect(parts.join("")).not.toContain('data-testid="lazy-loading"'); // 탭 내용이 '불러오는 중' 자리가 아니라 실제 카드 · 목록이다(ADR-026)
  });
});

describe("map tooltips and text helpers: KST only", () => {
  const NOW = Date.parse("2026-09-28T23:41:14Z");
  it("SIGMET tooltip: validity range and the 'not yet valid' flag in KST", () => {
    const p = { id: "S1", fir_id: "RKRR", series_id: "A1", hazard: "TS", valid_from: "2026-09-29T00:00:00Z", valid_to: "2026-09-29T04:00:00Z", active: false, expiring_soon: false, raw_text: "", provider: "awc", fetched_at: "" } as SigmetProps;
    const tip = sigmetTip(p, NOW);
    expect(Object.fromEntries(tip.rows).VALID).toBe("09-29 09:00 – 09-29 13:00 KST");
    expect(tip.flags.map((f) => f.text)).toContain("발효 전 · 09-29 09:00 KST부터 · 판정 전");
  });
  it("airport tooltip: the METAR observation time in KST", () => {
    const tip = airportTip({ icao: "RKSI", obs_time: "2026-09-28T23:30:00Z" }, NOW);
    expect(Object.fromEntries(tip.rows).METAR).toBe("09-29 08:30 KST · 11m 14s 전");
  });
  it("ship track point tooltip: TIME in KST (date and seconds)", () => {
    const tip = shipTrackPointTip({ ts: "2026-09-28T23:41:14Z", sog: 1, src: "rest" }, "X");
    expect(Object.fromEntries(tip.rows)).toMatchObject({ TIME: "09-29 08:41:14 KST" });
  });
  it("not-live text and saved times use the KST day", () => {
    const now = Date.parse("2026-09-29T01:00:00Z");
    expect(fmtSavedAt("2026-09-28T15:30:00Z", now)).toBe("00:30 KST");
    expect(fmtSavedAt("2026-09-28T14:30:00Z", now)).toBe("09-28 23:30 KST");
    expect(fmtSavedAt(null, now)).toBe("—");
    expect(notLiveText({ lastSeenAt: null, lastPositionAt: "2026-09-29T00:59:00Z" }, now)).toBe("실시간 아님 · 마지막 수신 — · 마지막 저장 09:59 KST");
  });
  it("crew ETA (month-day-hour-minute entered on the UTC clock, no year) → KST; the day that depends on the unknown year is not guessed; no UTC shown", () => {
    expect(fmtShipEta({ eta_month: 9, eta_day: 30, eta_hour: 6, eta_minute: 5 })).toBe("09-30 15:05 KST · 선원 입력 · 연도 없음");
    expect(fmtShipEta({ eta_month: 9, eta_day: 30, eta_hour: 15, eta_minute: 0 })).toBe("10-01 00:00 KST · 선원 입력 · 연도 없음");
    expect(fmtShipEta({ eta_month: 12, eta_day: 31, eta_hour: 23, eta_minute: 59 })).toBe("01-01 08:59 KST · 선원 입력 · 연도 없음");
    expect(fmtShipEta({ eta_month: 2, eta_day: 29, eta_hour: 16, eta_minute: 0 })).toBe("03-01 01:00 KST · 선원 입력 · 연도 없음");
    // 2월 28일 입력 15시 이후: 윤년이면 02-29, 아니면 03-01 — 연도가 없어 둘 다 적는다(고르지 않는다)
    expect(fmtShipEta({ eta_month: 2, eta_day: 28, eta_hour: 20, eta_minute: 0 })).toBe("02-29 또는 03-01 05:00 KST(연도 없어 윤년 모름) · 선원 입력 · 연도 없음");
    // 달력에 없는 날(04-31)은 시각을 지어내지 않고 그렇다고만
    expect(fmtShipEta({ eta_month: 4, eta_day: 31, eta_hour: 20, eta_minute: 0 })).toBe("— (선원 입력 날짜 04-31 이 달력에 없음 — KST 로 바꿀 수 없음, 연도 없음)");
    expect(fmtShipEta({ eta_month: 9, eta_day: null, eta_hour: 6, eta_minute: 5 })).toBe("—");
  });
  it("track gap labels on the map (aircraft and ship) name KST", () => {
    const a = trackFeatureCollection([
      { ts: Date.parse("2026-09-28T23:40:00Z"), lat: 36, lon: 127, alt_ft: 1000, provider: "adsb_fi" },
      { ts: Date.parse("2026-09-28T23:45:00Z"), lat: 36.1, lon: 127.1, alt_ft: 1000, provider: "adsb_fi" },
    ] as never);
    expect(a.features[0].properties).toMatchObject({ kind: "gap", label: "수신 없음 08:40–08:45 KST" });
    const s = shipTrackFeatures({ segs: [{ pts: [[129, 35]], startMs: Date.parse("2026-09-28T23:00:00Z"), endMs: Date.parse("2026-09-28T23:10:00Z") }, { pts: [[129.1, 35]], startMs: Date.parse("2026-09-28T23:40:00Z"), endMs: null }], gaps: [] } as never);
    expect(s.features.find((f) => f.properties?.kind === "gap")?.properties?.label).toBe("기록 없음 08:10–08:40 KST");
  });
  it("focus-tracking chip: the start time in its tooltip is the full KST instant", () => {
    const d = parseDemand({ focus: { hex: "71c081", state: "active", interval_s: 5, since: "2026-09-28T23:40:00Z" } }, 0);
    expect(focusChip(d, "71c081", NOW)!.title).toContain("시작 2026-09-29 08:40:00.000 KST.");
  });
});

describe("about page states the time basis", () => {
  it("screens show KST only; raw bulletins stay as issued (their …Z is 9 h behind KST); stats days are KST days; budget windows in KST; no UTC", () => {
    const t = text(renderToStaticMarkup(createElement(AboutPage)));
    expect(t).toContain("화면의 시각은 모두 한국 표준시(KST)입니다");
    expect(t).toContain("“09-29 14:02:54 KST”");
    expect(t).toContain("METAR · TAF · SIGMET 원문은 발표된 그대로 두고 바꾸지 않습니다");
    expect(t).toContain("통계의 날짜와 운영 화면의 격리 수 날짜는 KST 날짜");
    expect(t).toContain("매일 09:00 KST 에 새로 시작하는 창");
    expect(utcLeaks(t)).toEqual([]);
  });
});

describe("only lib/time builds clock strings (one shared formatter) and no screen text names UTC", () => {
  /**
   * 화면 글자를 따로 만들던 모양: "…Z`" 템플릿 · getUTC* 로 hh:mm · toISOString() 을 월-일/시각 자리로 자르기 ·
   * isoKst(…) 를 잘라 쓰기(리뷰 2026-09-29 — lib/chart 가 그렇게 시간대별 라벨을 만들었다) · "${…} KST" / "${…}시 KST" / "${…} UTC" 템플릿.
   */
  const PATTERNS = [/\}Z`/, /p2\([^)]*getUTC/, /toISOString\(\)\.slice\((5|11)\b/, /toISOString\(\)\.replace\("T"/, /\bisoKst\(/, /\}(시)? (KST|UTC)\b/];
  /**
   * 일부러 lib/time 밖에서 만드는 곳 — 파일마다 줄 수까지 고정해, 같은 파일에 새로 생겨도 걸린다.
   * - 복사 · 내려받기 형식(ISO +09:00): lib/log-line(머리 줄) · lib/logs(텍스트 · 파일 이름)
   * - 오류 화면 시각 칸(KST ISO — 오류 경계 청크는 lib/kst · lib/log-line 만 싣는다, PERF §8)
   * - 선박 ETA(선원 입력 월 · 일 · 시 · 분, 연도 없음 — 순간이 아니라 lib/time 에 넣을 수 없다 — "MM-DD HH:MM KST" 네 줄)
   */
  const ALLOWED: Record<string, number> = {
    [join("lib", "log-line.ts")]: 1,
    [join("lib", "logs.ts")]: 2,
    [join("components", "logs", "ErrorScreen.tsx")]: 1,
    [join("lib", "ships.ts")]: 4,
  };
  /** 한국어 화면 글이 UTC 를 말하는 줄(주석 밖) — 계약 v5 §G20: 화면은 KST 만 */
  const KOREAN_UTC = /[\uAC00-\uD7A3][^"'`\n]*\bUTC\b|\bUTC\b[^"'`\n]*[\uAC00-\uD7A3]/;
  const code = (line: string) => (/^\s*(\*|\/\/|\/\*|\{\/\*)/.test(line) ? "" : line.replace(/\s\/\/ .*$/, "").replace(/\{\/\*.*?\*\/\}/g, ""));
  const root = new URL("..", import.meta.url).pathname;
  const walk = (d: string): string[] => readdirSync(join(root, d)).flatMap((n) => {
    const rel = join(d, n);
    return statSync(join(root, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(n) ? [rel] : [];
  });
  const files = ["app", "components", "lib"].flatMap(walk);
  it("app/ · components/ · lib/ (lib/time.ts · lib/kst.ts are the formatters themselves; the listed exceptions have exactly their known lines)", () => {
    const hits: string[] = [];
    const allowedSeen: Record<string, number> = {};
    for (const f of files) {
      if (f === join("lib", "time.ts") || f === join("lib", "kst.ts")) continue;
      const own: string[] = [];
      readFileSync(join(root, f), "utf8").split("\n").forEach((line, i) => { if (PATTERNS.some((p) => p.test(line))) own.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`); });
      if (f in ALLOWED) allowedSeen[f] = own.length;
      else hits.push(...own);
    }
    expect(hits).toEqual([]);
    expect(allowedSeen).toEqual(ALLOWED);
  });
  it("no Korean screen text outside comments says UTC (no exemptions)", () => {
    const hits: string[] = [];
    for (const f of files) {
      const own = readFileSync(join(root, f), "utf8").split("\n").map(code).filter((l) => KOREAN_UTC.test(l));
      hits.push(...own.map((l) => `${f}: ${l.trim().slice(0, 140)}`));
    }
    expect(hits).toEqual([]);
    expect(KOREAN_UTC.test("title=\"한국 표준시(UTC+9) — 둘째 줄\"")).toBe(true);
    expect(KOREAN_UTC.test("prov.budget_day_zone === \"UTC\"")).toBe(false); // 값 비교는 화면 글이 아니다
  });
  it("the patterns see the forms the review found (isoKst slicing, \"${…}시 KST\" labels)", () => {
    for (const line of ["const kst = Number.isFinite(dayMs) ? isoKst(dayMs + h * 3600_000) : null;", "full: `${date}${kstH}시 KST (UTC ${r.label}시)`", "return `${p2(mo)}-${p2(d)} ${p2(hk)}:${p2(mi)} KST`;"]) {
      expect(PATTERNS.some((p) => p.test(line)), line).toBe(true);
    }
    expect(PATTERNS.some((p) => p.test("expect(t).toContain(\"12:30 KST\")"))).toBe(false);
  });
  it("lib/format has no clock formatters (they live in lib/time); lib/time has no UTC display helper any more", () => {
    for (const k of ["fmtTime", "fmtClock", "fmtTimeKst", "fmtTimeKstLabel", "fmtClockKst", "fmtMinuteKst", "hmKst", "fmtRangeKst", "fmtDayMinuteKst", "fmtIso"]) expect(k in F, k).toBe(false);
    for (const k of ["fmtIso", "fmtUtcTitle", "fmtUtcRangeTitle", "fmtUtcDayDual", "utcDayHours", "dualCell", "fmtDualCompact", "fmtDualRange", "fmtDualClock",
      "fmtDual", "dualPair", "dualParts", "dualRangePair", "fmtDualDayMinute", "fmtDualSpan"]) expect(k in T, k).toBe(false);
    expect(T.fmtIsoKst("2026-09-28T23:41:14Z")).toBe("2026-09-29T08:41:14.000+09:00");
  });
  /**
   * 합친 뒤(2026-09-30 · integ): 대시보드 UX 레인의 파일(AircraftCard · AircraftSearch · AlertPanel · lib/statusbar)이 쓰던 KST 전용 별칭을 KstTime · fmtKst ·
   * fmtTimeTitle · timeParts · fmtKstRange 로 옮기고 별칭과 components/DualTime.tsx 를 지웠다 — 면제 목록 없이 어느 파일도 그 이름을 쓰지 않는다.
   */
  it("no file uses the removed dual-time names (DualTime · dualPair · fmtDual · dualParts · dualRangePair · fmtDualDayMinute · fmtDualSpan · fmtDualClock)", () => {
    const users = files.filter((f) => /\b(DualTime|dualPair|fmtDual|dualParts|dualRangePair|fmtDualDayMinute|fmtDualSpan|fmtDualClock)\b/.test(readFileSync(join(root, f), "utf8").split("\n").map(code).join("\n")));
    expect(users).toEqual([]);
  });
});
