/**
 * 상황판(지도 · 카드 · 상태 바 · 툴팁)도 한국 표준시(KST, UTC+09:00)로(사용자 요청 2026-09-29 "상황판도 KST로 바꿔") — 같은 날 뒤 요청
 * "UTC 와 KST 함께"로 KST 를 먼저, 같은 순간의 UTC 를 함께 보인다(lib/time · 계약 v5 §G13).
 * - "09-29 08:41:14 KST · 09-28 23:41:14 UTC"(UTC 날짜가 다르면 UTC 쪽에도 날짜), 상태 바 · 지도 툴팁 · 선 라벨은 "08:41 KST · 23:41Z".
 *   구간은 쪽마다 끝에 한 번("08:40–08:45 KST · 23:40–23:45Z"). 원본 UTC ISO 는 title 에("원본 UTC …Z").
 * - 원문 전문(METAR · TAF · SIGMET raw)은 발표된 그대로 — 안의 "…Z" 시각을 바꾸지 않는다.
 * - 모르면 "—" 만(시간대 글자도 붙이지 않는다).
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as F from "@/lib/format";
import * as T from "@/lib/time";
import { unpairedKst } from "./helpers/dual-time";
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
import { wsInvalidText } from "@/components/WsInvalidBadge";
import { airportTip, shipTrackPointTip, sigmetTip } from "@/lib/tooltip";
import { aisGapBadge, fmtSavedAt, fmtShipEta, notLiveText, shipTrackFeatures, type ShipRow } from "@/lib/ships";
import { trackFeatureCollection } from "@/lib/track";
import { focusChip, parseDemand } from "@/lib/demand";
import { parseRoute } from "@/lib/route";
import type { Alert, KrRadar, SigmetProps } from "@/lib/types";
import AboutPage from "@/app/about/page";

/** UTC 자정 직전 — KST 로는 다음 날 아침 */
const LATE = "2026-09-28T23:41:14.906Z";

describe("dashboard time formatters (lib/time): KST first, UTC with it", () => {
  it("minute form for radar frames: MM-DD HH:MM KST · HH:MMZ, across the KST and UTC date changes", () => {
    expect(T.fmtDualCompact(LATE, { date: true })).toBe("09-29 08:41 KST · 09-28 23:41Z");
    expect(T.fmtDualCompact("2026-09-28T14:59:00Z", { date: true })).toBe("09-28 23:59 KST · 14:59Z");
    expect(T.fmtDualCompact("2026-09-28T15:00:00Z", { date: true })).toBe("09-29 00:00 KST · 09-28 15:00Z");
    expect(T.fmtDualCompact(Date.parse("2026-09-28T15:00:00Z"), { date: true })).toBe("09-29 00:00 KST · 09-28 15:00Z");
  });
  it("hh:mm spans name each zone once; unknown → —", () => {
    expect(T.fmtDualSpan(LATE, Date.parse("2026-09-28T23:45:00Z"))).toBe("08:41–08:45 KST · 09-28 23:41–23:45Z");
    expect(T.fmtDualSpan(Date.parse("2026-09-29T05:05:00Z"), "2026-09-29T05:10:00Z")).toBe("14:05–14:10 KST · 05:05–05:10Z");
    for (const v of [null, undefined, "", "bad", Number.NaN]) expect(T.fmtDualSpan(v, v)).toBe("—");
  });
  it("ranges name each zone once; an unknown end is — on its side only; an open end can say so", () => {
    expect(T.fmtDualRange("2026-09-28T23:00:00Z", "2026-09-29T03:00:00Z")).toBe("09-29 08:00:00 – 09-29 12:00:00 KST · 09-28 23:00:00 – 09-29 03:00:00 UTC");
    expect(T.fmtDualRange("2026-09-28T23:00:00Z", null)).toBe("09-29 08:00:00 KST · 09-28 23:00:00 UTC – —");
    expect(T.fmtDualRange(null, "2026-09-29T03:00:00Z")).toBe("— – 09-29 12:00:00 KST · 03:00:00 UTC");
    expect(T.fmtDualRange(null, "bad")).toBe("— – —");
    expect(T.fmtDualRange("2026-09-28T23:00:00Z", null, { open: "진행 중" })).toBe("09-29 08:00:00 KST · 09-28 23:00:00 UTC – 진행 중");
  });
  it("range tooltip: the UTC originals once labelled; unknown sides are —; nothing known → no title", () => {
    expect(T.fmtUtcRangeTitle("2026-09-28T23:00:00Z", "2026-09-29T03:00:00Z")).toBe("원본 UTC 2026-09-28T23:00:00.000Z – 2026-09-29T03:00:00.000Z");
    expect(T.fmtUtcRangeTitle("2026-09-28T23:00:00Z", null)).toBe("원본 UTC 2026-09-28T23:00:00.000Z – —");
    expect(T.fmtUtcRangeTitle(null, "bad")).toBeUndefined();
  });
  it("title-only times (the visible text is an age): KST · UTC plus the ISO original; unknown → —", () => {
    expect(T.fmtKstTitle(LATE)).toBe("09-29 08:41:14 KST · 09-28 23:41:14 UTC (원본 2026-09-28T23:41:14.906Z)");
    expect(T.fmtKstTitle(null)).toBe("—");
    expect(T.fmtKstTitle("bad")).toBe("—");
  });
  it("day-aware minute form: no KST date on today's KST day, the KST date otherwise — the KST day decides; the UTC date only when it differs", () => {
    const NOW = Date.parse("2026-09-29T01:00:00Z"); // KST 09-29 10:00
    expect(T.fmtDualDayMinute("2026-09-28T15:30:00Z", NOW)).toBe("00:30 KST · 09-28 15:30Z"); // UTC 로는 전날이지만 KST 로는 같은 날
    expect(T.fmtDualDayMinute("2026-09-28T14:30:00Z", NOW)).toBe("09-28 23:30 KST · 14:30Z"); // KST 로 전날
    expect(T.fmtDualDayMinute("2026-09-28T14:30:00Z", 0)).toBe("09-28 23:30 KST · 14:30Z"); // 지금을 모르면 날짜를 붙인다
    expect(T.fmtDualDayMinute(null, NOW)).toBe("—");
  });
});

const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<");

describe("dashboard components show KST first with UTC (the ISO original stays in the tooltip)", () => {
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
    // 최신 tm 을 모르면 "—" 만 — "undefined:undefinedK" 가 아니다
    setData({ radarKr: { ...kr, latest_tm: null, meta: { fetched_at: null, stale: false } } });
    expect(rows().find((r) => r.key === "kma")!.value).toMatch(/^1f · 최신 tm — · /);
  });

  it("alert banner: received time in KST only (사용자 결정 2026-09-30)", () => {
    const a = { id: 3, kind: "OBSERVED", hex: "a3", callsign: "CS3", sigmet_id: "S3", fir_id: "RKRR", hazard: "TS", entered_at: "2026-09-28T23:00:00Z", eta_s: null, alt_ft: 35000, evidence: {}, estimated: false } as unknown as Alert;
    setData({ conn: "open", alertsVersion: 1, lastEvent: { type: "ENTERED", alert: a, at: Date.parse("2026-09-28T23:02:03Z") } });
    const h = renderToStaticMarkup(createElement(AlertPanel));
    const banner = /data-testid="alert-banner".*?<\/div><\/div><\/div>/.exec(h)![0];
    expect(text(banner)).toContain("수신 08:02:03 KST");
    expect(banner).not.toContain("UTC");
  });

  it("evidence card: validity range, judged time, observation and end in KST", () => {
    const a = {
      id: 1, kind: "OBSERVED", hex: "a1", callsign: "CS1", sigmet_id: "S1", fir_id: "RKRR", hazard: "TS", entered_at: "2026-09-28T23:00:00Z", eta_s: null, alt_ft: 35000, estimated: false,
      left_at: "2026-09-28T23:30:00Z", close_reason: "EXITED",
      evidence: { valid_from: "2026-09-28T22:00:00Z", valid_to: "2026-09-29T02:00:00Z", judged_at: "2026-09-28T23:00:00Z", seen_at: "2026-09-28T22:59:30Z", provider: "adsb_fi" },
    } as unknown as Alert;
    const t = text(renderToStaticMarkup(createElement(EvidenceCard, { a })));
    expect(t).toContain("유효시간09-29 07:00:00 – 09-29 11:00:00 KST · 09-28 22:00:00 – 09-29 02:00:00 UTC");
    expect(renderToStaticMarkup(createElement(EvidenceCard, { a }))).toContain('title="원본 UTC 2026-09-28T22:00:00.000Z – 2026-09-29T02:00:00.000Z"');
    expect(t).toContain("판정 시각09-29 08:00:00 KST · 09-28 23:00:00 UTC");
    expect(t).toContain("출처 / 관측adsb_fi · 09-29 07:59:30 KST · 09-28 22:59:30 UTC");
    expect(t).toMatch(/종료09-29 08:30:00 KST · 09-28 23:30:00 UTC · /);
    expect(unpairedKst(t)).toEqual([]);
  });

  it("SIGMET card and list: validity in KST, the raw bulletin exactly as issued", () => {
    const RAW = "WSKO31 RKSI 282300\nRKRR SIGMET A1 VALID 282300/290300 RKSI-\nRKRR INCHEON FIR EMBD TS OBS AT 2250Z";
    const p = { id: "S1", fir_id: "RKRR", fir_name: "INCHEON", series_id: "A1", hazard: "TS", valid_from: "2026-09-28T23:00:00Z", valid_to: "2026-09-29T03:00:00Z",
      active: true, expiring_soon: false, raw_text: RAW, provider: "awc", fetched_at: "2026-09-28T23:05:00Z" } as SigmetProps;
    setData({ sigmets: { type: "FeatureCollection", features: [{ type: "Feature", properties: p, geometry: null }] } as never });
    const html = renderToStaticMarkup(createElement(SigmetCard, { id: "S1" }));
    expect(text(html)).toContain("유효09-29 08:00:00 – 09-29 12:00:00 KST · 09-28 23:00:00 – 09-29 03:00:00 UTC");
    expect(text(html)).toContain("출처awc · 09-29 08:05:00 KST · 09-28 23:05:00 UTC");
    expect(text(html.replace(/\n/g, "⏎"))).toContain(RAW.replace(/\n/g, "⏎")); // 원문은 발표된 그대로(…2250Z 포함)
    expect(unpairedKst(text(html).split(RAW).join(""))).toEqual([]);
    const list = renderToStaticMarkup(createElement(SigmetListView, { items: [{ id: "S1", hazard: "TS", qualifier: null, fir_id: "RKRR", fir_name: "INCHEON", valid_to: p.valid_to, pending: false, inside: 0, predicted: 0, center: null }] }));
    expect(list).toContain("유효 09-29 12:00:00 KST · 03:00:00 UTC 까지");
  });

  it("KMA radar panel and radar timeline: reception and frame times in KST (the KMA-unavailable note: tests/mapview-lifecycle.test.ts)", () => {
    const kr = {
      available: true, latest_tm: "202609290840", georeferenced: true, coordinates: null, legend: [], frames: [{ tm: "202609290840", obs_tm: "202609290840", fetched_at: "2026-09-28T23:41:00Z", echo_cells: 5, url: "/x" }],
      attribution: "기상청", meta: { fetched_at: "2026-09-28T23:41:00Z", stale: false },
    } as unknown as KrRadar;
    setData({ radarKr: kr, radar: { host: "h", generated: 0, past: [{ time: Date.parse("2026-09-28T23:40:00Z") / 1000, path: "/p" }], fetched_at: "2026-09-28T23:41:00Z" } });
    expect(text(renderToStaticMarkup(createElement(KrRadarPanel, { onClose: () => {} })))).toContain("수신09-29 08:41:00 KST · 09-28 23:41:00 UTC");
    const tl = renderToStaticMarkup(createElement(RadarTimeline));
    expect(/data-testid="radar-frame-time">([^<]*)</.exec(tl)![1]).toBe("09-29 08:40 KST · 09-28 23:40Z"); // RainViewer 프레임(UTC epoch) → KST · UTC
  });

  it("map legend: the ship track point tooltip says KST · UTC", () => {
    const html = renderToStaticMarkup(createElement(MapLegendView, { id: "l", layers: { ...useUi.getState().layers, ships: true, tracks: true }, radarSource: "rainviewer" }));
    expect(text(html)).toContain("항적 점 — 마우스를 올리면 시각(KST · UTC)·속력·침로·항해 상태");
    expect(text(html)).not.toContain("시각(UTC)");
  });

  it("aircraft card and route section: observation, reception and route lookup times in KST (title = original UTC)", () => {
    setData({ selected: { hex: "71c081", received_at: 0, prediction: null, state: { hex: "71c081", lat: 36, lon: 127, seen_at: "2026-09-28T23:41:14Z", fetched_at: "2026-09-28T23:41:15Z", provider: "adsb_fi" } } as never });
    const card = renderToStaticMarkup(createElement(AircraftCard, { hex: "71c081" }));
    expect(text(card)).toContain("관측 시각09-29 08:41:14 KST · 09-28 23:41:14 UTC");
    expect(text(card)).toContain("수신 시각09-29 08:41:15 KST · 09-28 23:41:15 UTC");
    expect(card).toContain('title="원본 UTC 2026-09-28T23:41:14.000Z"');
    expect(unpairedKst(text(card))).toEqual([]);
    const route = parseRoute({ status: "found", callsign: "KAL081", source: "adsbdb", fetched_at: "2026-09-28T23:00:00Z", airline: null,
      origin: { icao: "RKSI", name: "Incheon", lat: 37.46, lon: 126.44 }, destination: { icao: "KJFK", name: "John F Kennedy", lat: 40.64, lon: -73.78 } });
    const r = renderToStaticMarkup(createElement(RouteSection, { route, pos: null, callsign: "KAL081" }));
    expect(text(r)).toContain("조회 시각09-29 08:00:00 KST · 09-28 23:00:00 UTC");
    expect(r).toContain('title="원본 UTC 2026-09-28T23:00:00.000Z"');
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
    expect(t).toContain("처음 기록09-20 10:02:03 KST · 01:02:03 UTC");
    expect(t).toContain("마지막 저장 위치09-29 08:00:00 KST · 09-28 23:00:00 UTC (2h 00m 전)");
    expect(t).toContain("마지막 수신09-29 08:05:00 KST · 09-28 23:05:00 UTC (1h 55m 전)");
    expect(t).toContain("실시간 아님 · 마지막 수신 08:05 KST · 09-28 23:05Z · 마지막 저장 08:00 KST · 09-28 23:00Z");
    expect(t).toContain("수신 공백 09-29 07:00:00 – 09-29 07:05:00 KST · 09-28 22:00:00 – 09-28 22:05:00 UTC · 300 s · keepalive");
    expect(t).toContain("수신 공백 09-29 08:10:00 KST · 09-28 23:10:00 UTC – 진행 중");
    expect(t).toContain("ETA10-01 05:05 KST · 선원 입력 09-30 20:05 UTC · 연도 없음");
    expect(t).toContain("항적 점에 마우스를 올리면 시각(KST · UTC)·속력·침로·항해 상태");
    expect(html).toContain('title="원본 UTC 2026-09-20T01:02:03.000Z"');
    // 선원 ETA 는 자기 형식(KST · 선원 입력 UTC) — 그 밖의 KST 시각은 모두 UTC 짝이 있다
    expect(unpairedKst(t.replace("10-01 05:05 KST · 선원 입력 09-30 20:05 UTC", ""))).toEqual([]);
  });

  it("ship table and search results: not-live rows in KST (the KST day decides whether the date is shown); tooltips carry KST and UTC", () => {
    const NOW = Date.parse("2026-09-29T01:00:00Z"); // KST 09-29 10:00
    const rows: ShipRow[] = [
      { mmsi: "300000001", name: "ALPHA", category: "cargo", sog_kn: 3, nav_status: 0, live: true, seen_at: "2026-09-29T00:59:00Z", last_position_at: null, last_seen_at: null },
      { mmsi: "300000002", name: "BRAVO", category: "cargo", sog_kn: null, nav_status: null, live: false, seen_at: null, last_position_at: "2026-09-28T15:30:00Z", last_seen_at: "2026-09-28T14:30:00Z" },
    ] as ShipRow[];
    const html = renderToStaticMarkup(createElement(ShipTable, { rows, now: NOW, sort: null, onSort: () => {}, onPick: () => {}, testId: "ship-list" }));
    const r2 = text(/data-mmsi="300000002".*?<\/tr>/.exec(html)![0]);
    expect(r2).toContain("마지막 수신 09-28 23:30 KST · 14:30Z"); // KST 로 전날(UTC 도 같은 날짜)
    expect(r2).toContain("저장 00:30 KST · 09-28 15:30Z"); // UTC 로는 전날이지만 KST 로는 오늘 — UTC 쪽에 날짜
    expect(html).toContain('title="09-29 09:59:00 KST · 00:59:00 UTC (원본 2026-09-29T00:59:00.000Z)"');
    expect(html).toMatch(/title="마지막 수신 09-28 23:30:00 KST · 14:30:00 UTC \(원본 2026-09-28T14:30:00.000Z\) · 마지막 저장 위치 09-29 00:30:00 KST · 09-28 15:30:00 UTC \(원본 2026-09-28T15:30:00.000Z\) — /);
    expect(unpairedKst(text(html))).toEqual([]);
    const results = renderToStaticMarkup(createElement(SearchResultsView, {
      uid: "u", now: NOW, active: -1, shipSort: { key: "sog", dir: "desc" }, onShipSort: () => {}, onChooseAircraft: () => {}, onChooseShip: () => {}, onHover: () => {},
      aircraft: { hits: [{ hex: "71c081", callsign: "KAL081", registration: null, type_code: null, alt_ft: null, on_ground: null, lat: null, lon: null, live: false, last_seen: "2026-09-28T23:41:14Z" }], state: "done", msg: "1건" },
      ships: { hits: [{ mmsi: "300000002", name: "BRAVO", call_sign: null, imo: null, ship_type: null, category: "cargo", live: false, lat: null, lon: null, sog_kn: null, seen_at: null, last_position_at: "2026-09-28T15:30:00Z", last_seen_at: "2026-09-28T14:30:00Z" }], state: "done", msg: "1건", note: null, error: null },
    } as never));
    expect(results).toContain('title="마지막 수신 09-29 08:41:14 KST · 09-28 23:41:14 UTC (원본 2026-09-28T23:41:14.000Z)"');
    expect(text(results)).toContain("마지막 수신·저장 시각은 KST ·"); // 검색 상자의 설명 줄은 KST 만(사용자 결정 2026-09-30 — 이 레인의 파일)
    expect(unpairedKst(text(results))).toEqual([]);
  });

  it("WS format-error detail: the browser-clock time in KST · UTC", () => {
    const t = wsInvalidText({ elements: 1, messages: 0, errors: 0, last: "aircraft: bad lat", at: Date.parse("2026-09-28T23:41:14Z") });
    expect(t).toContain("마지막: aircraft: bad lat · 08:41:14 KST · 09-28 23:41:14 UTC(브라우저 시계)");
    expect(unpairedKst(t)).toEqual([]);
  });
});

describe("map tooltips and text helpers: compact KST · UTC", () => {
  const NOW = Date.parse("2026-09-28T23:41:14Z");
  it("SIGMET tooltip: validity range and the 'not yet valid' flag in KST", () => {
    const p = { id: "S1", fir_id: "RKRR", series_id: "A1", hazard: "TS", valid_from: "2026-09-29T00:00:00Z", valid_to: "2026-09-29T04:00:00Z", active: false, expiring_soon: false, raw_text: "", provider: "awc", fetched_at: "" } as SigmetProps;
    const tip = sigmetTip(p, NOW);
    expect(Object.fromEntries(tip.rows).VALID).toBe("09-29 09:00 – 09-29 13:00 KST · 00:00 – 04:00 UTC");
    expect(tip.flags.map((f) => f.text)).toContain("발효 전 · 09-29 09:00 KST · 00:00Z부터 · 판정 전");
  });
  it("airport tooltip: the METAR observation time in KST", () => {
    const tip = airportTip({ icao: "RKSI", obs_time: "2026-09-28T23:30:00Z" }, NOW);
    expect(Object.fromEntries(tip.rows).METAR).toBe("09-29 08:30 KST · 09-28 23:30Z · 11m 14s 전");
  });
  it("ship track point tooltip: TIME in KST", () => {
    const tip = shipTrackPointTip({ ts: "2026-09-28T23:41:14Z", sog: 1, src: "rest" }, "X");
    expect(Object.fromEntries(tip.rows)).toMatchObject({ TIME: "09-29 08:41:14 KST · 09-28 23:41:14Z" });
    expect(tip.rows.map(([k]) => k)).not.toContain("TIME UTC");
  });
  it("AIS gap badge: open and closed gaps as HH:MM KST · HH:MMZ; the tooltip keeps the original UTC", () => {
    const base = { connected: false, msgs_per_s: 0, lag_s: null, gap_open_since: null, last_gap: null } as never as Parameters<typeof aisGapBadge>[0] & object;
    const open = aisGapBadge({ ...base, gap_open_since: "2026-09-28T23:40:00Z" }, NOW)!;
    expect(open.text).toBe("AIS 공백 08:40 KST · 09-28 23:40Z 부터 · 진행 중");
    expect(open.title).toContain("AIS 수신이 09-29 08:40:00 KST · 09-28 23:40:00 UTC 부터 끊겨 있음(원본 UTC 2026-09-28T23:40:00.000Z)");
    const closed = aisGapBadge({ ...base, last_gap: { started_at: "2026-09-28T23:20:00Z", ended_at: "2026-09-28T23:25:00Z", reason: "keepalive" } }, NOW)!;
    expect(closed.text).toBe("AIS 공백 08:20–08:25 KST · 09-28 23:20–23:25Z");
    expect(closed.title).toContain("AIS 수신 공백 09-29 08:20:00 – 09-29 08:25:00 KST · 09-28 23:20:00 – 09-28 23:25:00 UTC (keepalive)");
  });
  it("not-live text and saved times use the KST day", () => {
    const now = Date.parse("2026-09-29T01:00:00Z");
    expect(fmtSavedAt("2026-09-28T15:30:00Z", now)).toBe("00:30 KST · 09-28 15:30Z");
    expect(fmtSavedAt("2026-09-28T14:30:00Z", now)).toBe("09-28 23:30 KST · 14:30Z");
    expect(fmtSavedAt(null, now)).toBe("—");
    expect(notLiveText({ lastSeenAt: null, lastPositionAt: "2026-09-29T00:59:00Z" }, now)).toBe("실시간 아님 · 마지막 수신 — · 마지막 저장 09:59 KST · 00:59Z");
  });
  it("crew ETA (UTC month-day-hour-minute, no year) → KST; the day that depends on the unknown year is not guessed", () => {
    expect(fmtShipEta({ eta_month: 9, eta_day: 30, eta_hour: 6, eta_minute: 5 })).toBe("09-30 15:05 KST · 선원 입력 09-30 06:05 UTC · 연도 없음");
    expect(fmtShipEta({ eta_month: 9, eta_day: 30, eta_hour: 15, eta_minute: 0 })).toBe("10-01 00:00 KST · 선원 입력 09-30 15:00 UTC · 연도 없음");
    expect(fmtShipEta({ eta_month: 12, eta_day: 31, eta_hour: 23, eta_minute: 59 })).toBe("01-01 08:59 KST · 선원 입력 12-31 23:59 UTC · 연도 없음");
    expect(fmtShipEta({ eta_month: 2, eta_day: 29, eta_hour: 16, eta_minute: 0 })).toBe("03-01 01:00 KST · 선원 입력 02-29 16:00 UTC · 연도 없음");
    // 2월 28일 15시 이후: 윤년이면 02-29, 아니면 03-01 — 연도가 없어 둘 다 적는다(고르지 않는다)
    expect(fmtShipEta({ eta_month: 2, eta_day: 28, eta_hour: 20, eta_minute: 0 })).toBe("02-29 또는 03-01 05:00 KST(연도 없어 윤년 모름) · 선원 입력 02-28 20:00 UTC · 연도 없음");
    // 달력에 없는 날(04-31)은 바꾸지 않고 입력값 그대로
    expect(fmtShipEta({ eta_month: 4, eta_day: 31, eta_hour: 20, eta_minute: 0 })).toBe("04-31 20:00 UTC · 선원 입력값(달력에 없는 날 — KST 로 바꾸지 않음), 연도 없음");
    expect(fmtShipEta({ eta_month: 9, eta_day: null, eta_hour: 6, eta_minute: 5 })).toBe("—");
  });
  it("track gap labels on the map (aircraft and ship) name KST and UTC", () => {
    const a = trackFeatureCollection([
      { ts: Date.parse("2026-09-28T23:40:00Z"), lat: 36, lon: 127, alt_ft: 1000, provider: "adsb_fi" },
      { ts: Date.parse("2026-09-28T23:45:00Z"), lat: 36.1, lon: 127.1, alt_ft: 1000, provider: "adsb_fi" },
    ] as never);
    expect(a.features[0].properties).toMatchObject({ kind: "gap", label: "수신 없음 08:40–08:45 KST · 09-28 23:40–23:45Z" });
    const s = shipTrackFeatures({ segs: [{ pts: [[129, 35]], startMs: Date.parse("2026-09-28T23:00:00Z"), endMs: Date.parse("2026-09-28T23:10:00Z") }, { pts: [[129.1, 35]], startMs: Date.parse("2026-09-28T23:40:00Z"), endMs: null }], gaps: [] } as never);
    expect(s.features.find((f) => f.properties?.kind === "gap")?.properties?.label).toBe("기록 없음 08:10–08:40 KST · 09-28 23:10–23:40Z");
  });
  it("focus-tracking chip: the start time in its tooltip is KST · UTC", () => {
    const d = parseDemand({ focus: { hex: "71c081", state: "active", interval_s: 5, since: "2026-09-28T23:40:00Z" } }, 0);
    expect(focusChip(d, "71c081", NOW)!.title).toContain("시작 09-29 08:40:00 KST · 09-28 23:40:00 UTC (원본 2026-09-28T23:40:00.000Z).");
  });
});

describe("about page states the time basis", () => {
  it("screens show KST first with UTC, raw bulletins stay UTC, stats days are UTC dates, the ISO original is in the tooltip", () => {
    const t = text(renderToStaticMarkup(createElement(AboutPage)));
    expect(t).toContain("화면의 시각은 한국 표준시(KST, UTC+9)를 먼저, 같은 순간의 UTC 를 함께");
    expect(t).toContain("09-29 14:02:54 KST · 05:02:54 UTC");
    expect(t).toContain("METAR · TAF · SIGMET 원문은 발표된 그대로(UTC");
    expect(t).toContain("통계의 날짜는 UTC 날짜");
  });
});

describe("only lib/time builds clock strings (one shared formatter)", () => {
  /**
   * 화면 글자를 따로 만들던 모양: "…Z`" 템플릿 · getUTC* 로 hh:mm · toISOString() 을 월-일/시각 자리로 자르기 ·
   * isoKst(…) 를 잘라 쓰기(리뷰 2026-09-29 — lib/chart 가 그렇게 시간대별 라벨을 만들었다) · "${…} KST" / "${…}시 KST" / "${…} UTC" 템플릿.
   */
  const PATTERNS = [/\}Z`/, /p2\([^)]*getUTC/, /toISOString\(\)\.slice\((5|11)\b/, /toISOString\(\)\.replace\("T"/, /\bisoKst\(/, /\}(시)? (KST|UTC)\b/];
  /**
   * 일부러 lib/time 밖에서 만드는 곳(계약 v5 §G13 "바꾸지 않는 것") — 파일마다 줄 수까지 고정해, 같은 파일에 새로 생겨도 걸린다.
   * - 복사 · 내려받기 형식(ISO +09:00): lib/log-line(머리 줄) · lib/logs(텍스트 · 파일 이름)
   * - 오류 화면 시각 칸(KST ISO 와 원본 UTC ISO 를 나란히 — 오류 경계 청크는 lib/kst · lib/log-line 만 싣는다, PERF §8)
   * - 재생 datetime-local 입력 값(보이는 글자가 아니라 입력 값 "YYYY-MM-DDTHH:MM")
   * - 선박 ETA(선원 입력 월 · 일 · 시 · 분, 연도 없음 — 순간이 아니라 lib/time 에 넣을 수 없다)
   */
  const ALLOWED: Record<string, number> = {
    [join("lib", "log-line.ts")]: 1,
    [join("lib", "logs.ts")]: 2,
    [join("components", "logs", "ErrorScreen.tsx")]: 1,
    [join("lib", "replay.ts")]: 1,
    [join("lib", "ships.ts")]: 5,
  };
  const root = new URL("..", import.meta.url).pathname;
  const walk = (d: string): string[] => readdirSync(join(root, d)).flatMap((n) => {
    const rel = join(d, n);
    return statSync(join(root, rel)).isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(n) ? [rel] : [];
  });
  it("app/ · components/ · lib/ (lib/time.ts · lib/kst.ts are the formatters themselves; the listed exceptions have exactly their known lines)", () => {
    const hits: string[] = [];
    const allowedSeen: Record<string, number> = {};
    for (const f of ["app", "components", "lib"].flatMap(walk)) {
      if (f === join("lib", "time.ts") || f === join("lib", "kst.ts")) continue;
      const own: string[] = [];
      readFileSync(join(root, f), "utf8").split("\n").forEach((line, i) => { if (PATTERNS.some((p) => p.test(line))) own.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`); });
      if (f in ALLOWED) allowedSeen[f] = own.length;
      else hits.push(...own);
    }
    expect(hits).toEqual([]);
    expect(allowedSeen).toEqual(ALLOWED);
  });
  it("the patterns see the forms the review found (isoKst slicing, \"${…}시 KST\" labels)", () => {
    for (const line of ["const kst = Number.isFinite(dayMs) ? isoKst(dayMs + h * 3600_000) : null;", "full: `${date}${kstH}시 KST (UTC ${r.label}시)`", "return `${p2(mo)}-${p2(d)} ${p2(hk)}:${p2(mi)} KST`;"]) {
      expect(PATTERNS.some((p) => p.test(line)), line).toBe(true);
    }
    expect(PATTERNS.some((p) => p.test("expect(t).toContain(\"12:30 KST · 03:30 UTC\")"))).toBe(false);
  });
  it("lib/format has no clock formatters (they live in lib/time); the ISO original is there for tooltips / the log detail", () => {
    for (const k of ["fmtTime", "fmtClock", "fmtTimeKst", "fmtTimeKstLabel", "fmtClockKst", "fmtMinuteKst", "hmKst", "fmtRangeKst", "fmtDayMinuteKst", "fmtIso"]) expect(k in F, k).toBe(false);
    expect(T.fmtIso("2026-09-28T23:41:14Z")).toBe("2026-09-28T23:41:14.000Z");
  });
});
