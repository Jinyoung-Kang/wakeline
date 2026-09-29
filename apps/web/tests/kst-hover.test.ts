/**
 * 보인 시각에는 같은 순간의 전체(연도 · ms 까지의 KST)가 툴팁으로 붙는다 — /about · 선박 카드가 "시각에 마우스를 올리면 연도 · ms 까지의 같은 순간"
 * 이라고 말하는 약속(계약 v5 §G20 — 사용자 결정 2026-09-30 "UTC 지우고 KST": 예전의 "원본 UTC" 툴팁을 대신한다). 공항 카드 관측 · 수신, 근거 카드
 * 출처/관측 · 종료, 기상청 패널 수신, 알림 배너, SIGMET 발효 전 배지, 선박 카드 수신 공백 목록, 재생 SIGMET 유효 · 기록 시각. 원문(METAR · SIGMET raw)은
 * 보이는 이름표 "(원문 · 발표 그대로)" 를 달고 data-raw 로 표시한다 — KST 시각 바로 옆의 "…Z" 가 발표 형식이라는 것이 툴팁 없이도 보이게.
 * 규칙(missingHover): 마운트한 카드 안에서 "hh:mm" 이 든 보이는 글자는 title 에 연도 · ms 까지의 KST 가 있는 요소 안에 있거나(원문 · data-raw 밖),
 * title 에 시각을 적은 요소는 KST 만 적는다(UTC 없음 — tests/helpers/kst-only).
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { resetData, setData } from "@/lib/store";
import type { Alert, KrRadar, SigmetProps } from "@/lib/types";
import AboutPage from "@/app/about/page";
import { domUtcLeaks, OTHER_LANE_PENDING } from "./helpers/kst-only";

const dom = installMiniDom();
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
});
afterAll(() => dom.restore());
let root: Root | null = null;
beforeEach(() => resetData());
afterEach(async () => {
  if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
  resetData();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const all = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container, out: MiniElement[] = []): MiniElement[] => {
  if (pred(from)) out.push(from);
  for (const c of from.childNodes) if (c instanceof MiniElement) all(pred, c, out);
  return out;
};
const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
function stub(body: Record<string, unknown>) {
  vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(url in body ? body[url] : { detail: "no such resource" }), { status: url in body ? 200 : 404, headers: { "Content-Type": "application/json" } }));
}
async function mount(el: React.ReactElement) {
  vi.stubGlobal("self", globalThis); // next/link 가 self.requestIdleCallback 을 찾는다
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(el); });
  await settle();
  await settle();
}
const at = (iso: string) => vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(iso) });

/** 연도 · ms 까지의 KST(툴팁의 모양 — lib/time fmtTimeTitle) */
const FULL_KST = /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} KST/;
/** 툴팁 약속을 지키지 않는 시각 — 보이는 hh:mm 글자인데 조상 title 에 연도 · ms 까지의 KST 가 없음(원문 data-raw 밖) + 원문 밖의 UTC 흔적 */
function missingHover(from: MiniElement = dom.container): string[] {
  const out: string[] = domUtcLeaks(from, OTHER_LANE_PENDING).map((x) => `utc: ${x}`); // 다른 레인의 검색 상자 설명 한 줄은 뺀다(helpers/kst-only)
  const walk = (n: MiniElement, covered: boolean) => {
    if (n.hasAttribute("data-raw")) return;
    const c2 = covered || FULL_KST.test(n.getAttribute("title") ?? "");
    for (const c of n.childNodes) {
      if (c instanceof MiniElement) walk(c, c2);
      // 시각 모양의 글자 — 선원 ETA 는 연도가 없는 보고값이라 순간이 아니다(행 title 이 그렇게 말한다)
      else if (!c2 && /\d\d:\d\d(:\d\d)?( KST|\b)/.test(c.textContent) && /\d\d:\d\d(:\d\d)? KST|\d\d-\d\d \d\d:\d\d/.test(c.textContent) && !c.textContent.includes("선원 입력")) out.push(`text: ${c.textContent}`);
    }
  };
  walk(from, false);
  return out;
}

const METAR = "METAR RKSI 282330Z 27010KT 9999 FEW030 18/12 Q1012 NOSIG";
const TAF = "TAF RKSI 282300Z 2900/3006 27010KT 9999 FEW030 TX22/2906Z TN14/2921Z";
const WX = {
  airport: { icao: "RKSI", name: "Incheon Intl", lat: 37.46, lon: 126.44, elev_ft: 23 },
  latest: { obs_time: "2026-09-28T23:30:00Z", raw: METAR, taf_raw: TAF, provider: "awc", fetched_at: "2026-09-28T23:31:00Z", flight_cat: "VFR", flight_cat_source: "awc", ceiling_state: "none", vis_raw: "6+" },
  history: [{ obs_time: "2026-09-28T23:30:00Z", flight_cat: "VFR", wind_dir: 270, wind_kt: 10, vis_raw: "6+", ceiling_ft: null, temp_c: 18 }],
};

describe("airport: every time is KST with the full KST instant on hover; the raw METAR is labelled on both views", () => {
  it("airport card: observation and reception rows have the full KST instant on hover", async () => {
    at("2026-09-28T23:40:00Z");
    stub({ "/api/v1/airports/RKSI/wx": WX });
    const { AirportCard } = await import("@/components/AirportCard");
    await mount(createElement(AirportCard, { icao: "RKSI" }));
    expect(dom.container.textContent).toContain("관측09-29 08:30:00 KST");
    expect(domUtcLeaks(dom.container)).toEqual([]);
    const titles = all((e) => e.getAttribute("title") != null).map((e) => e.getAttribute("title"));
    expect(titles).toContain("2026-09-29 08:30:00.000 KST");
    expect(titles).toContain("2026-09-29 08:31:00.000 KST");
  });
  it("airport page: the raw METAR has a visible '(원문 · 발표 그대로)' label like the TAF next to it", async () => {
    at("2026-09-28T23:40:00Z");
    stub({ "/api/v1/airports/RKSI/wx": WX });
    const AirportPage = (await import("@/app/airports/[icao]/page")).default;
    await mount(createElement(AirportPage, { params: Promise.resolve({ icao: "rksi" }) }));
    const labels = all((e) => /\blabel\b/.test(e.getAttribute("class") ?? "")).map((e) => e.textContent);
    expect(labels).toContain("METAR (원문 · 발표 그대로)");
    expect(labels).toContain("TAF (원문 · 발표 그대로)");
    expect(all((e) => e.tagName === "PRE").map((p) => p.textContent)).toEqual([METAR, TAF]); // 원문은 글자 그대로
    expect(domUtcLeaks(dom.container)).toEqual([]);
  });
});

describe("dashboard cards: every time has the full KST instant on hover (no UTC anywhere)", () => {
  it("evidence card: source/observation and end rows", async () => {
    at("2026-09-28T23:40:00Z");
    const a = {
      id: 1, kind: "OBSERVED", hex: "a1", callsign: "CS1", sigmet_id: "S1", fir_id: "RKRR", hazard: "TS", entered_at: "2026-09-28T23:00:00Z", eta_s: null, alt_ft: 35000, estimated: false,
      left_at: "2026-09-28T23:30:00Z", close_reason: "EXITED",
      evidence: { valid_from: "2026-09-28T22:00:00Z", valid_to: "2026-09-29T02:00:00Z", judged_at: "2026-09-28T23:00:00Z", seen_at: "2026-09-28T22:59:30Z", provider: "adsb_fi" },
    } as unknown as Alert;
    const { EvidenceCard } = await import("@/components/EvidenceCard");
    await mount(createElement(EvidenceCard, { a }));
    expect(dom.container.textContent).toContain("출처 / 관측adsb_fi · 09-29 07:59:30 KST");
    expect(missingHover()).toEqual([]);
  });
  it("KMA radar panel: reception time and the STALE badge", async () => {
    at("2026-09-28T23:59:00Z");
    const kr = {
      available: true, latest_tm: "202609290840", georeferenced: true, coordinates: null, legend: [], min_dbz: 10,
      frames: [{ tm: "202609290840", obs_tm: "202609290840", fetched_at: "2026-09-28T23:41:00Z", echo_cells: 5, url: "/x" }],
      attribution: "기상청", meta: { fetched_at: "2026-09-28T23:41:00Z", stale: true },
    } as unknown as KrRadar;
    setData({ radarKr: kr });
    const { KrRadarPanel } = await import("@/components/KrRadarPanel");
    await mount(createElement(KrRadarPanel, { onClose: () => {} }));
    expect(dom.container.textContent).toContain("수신09-29 08:41:00 KST");
    expect(dom.container.textContent).toContain("202609290840 (08:40 KST)"); // 기상청 tm 원문 옆에 같은 순간
    expect(all((e) => e.getAttribute("data-testid") === "kr-panel-stale")).toHaveLength(1);
    expect(missingHover()).toEqual([]);
  });
  it("alert banner: the received time", async () => {
    at("2026-09-28T23:02:10Z");
    const a = { id: 3, kind: "OBSERVED", hex: "a3", callsign: "CS3", sigmet_id: "S3", fir_id: "RKRR", hazard: "TS", entered_at: "2026-09-28T23:00:00Z", eta_s: null, alt_ft: 35000, evidence: {}, estimated: false } as unknown as Alert;
    setData({ conn: "open", alertsVersion: 1, lastEvent: { type: "ENTERED", alert: a, at: Date.parse("2026-09-28T23:02:03Z") } });
    const { AlertPanel } = await import("@/components/AlertPanel");
    await mount(createElement(AlertPanel));
    expect(all((e) => e.getAttribute("data-testid") === "alert-banner-time")[0].textContent).toBe("수신 08:02:03 KST");
    expect(missingHover()).toEqual([]);
  });
  it("SIGMET card: the 'not yet valid' badge names the start as the full KST instant", async () => {
    at("2026-09-28T22:00:00Z"); // 발효 1 h 전
    const p = { id: "S1", fir_id: "RKRR", fir_name: "INCHEON", series_id: "A1", hazard: "TS", valid_from: "2026-09-28T23:00:00Z", valid_to: "2026-09-29T03:00:00Z",
      active: true, expiring_soon: false, raw_text: "RKRR SIGMET A1 VALID 282300/290300 RKSI-", provider: "awc", fetched_at: "2026-09-28T21:55:00Z" } as SigmetProps;
    setData({ sigmets: { type: "FeatureCollection", features: [{ type: "Feature", properties: p, geometry: null }] } as never });
    const { SigmetCard } = await import("@/components/SigmetCard");
    await mount(createElement(SigmetCard, { id: "S1" }));
    expect(all((e) => e.getAttribute("data-testid") === "sigmet-pending")).toHaveLength(1);
    expect(missingHover()).toEqual([]);
  });
  it("ship card: the reception-gap list (the footer promises the full KST instant on hover)", async () => {
    const NOW = Date.parse("2026-09-29T01:00:00Z");
    at("2026-09-29T01:00:00Z");
    const { parseShipDetail, ShipCardView } = await import("@/components/ShipCard");
    const detail = parseShipDetail("431011305", {
      state: null, static: { name: "SYN BRAVO", ship_type: 70, eta_month: 9, eta_day: 30, eta_hour: 20, eta_minute: 5 },
      first_recorded_at: "2026-09-20T01:02:03Z", last_position_at: "2026-09-28T23:00:00Z", last_seen_at: "2026-09-28T23:05:00Z", meta: {},
    });
    setData({ shipTrack: { mmsi: "431011305", loaded: true, error: null, gapsTruncated: false, segments: 2, fromMs: null, hours: 6,
      gaps: [{ started_at: "2026-09-28T22:00:00Z", ended_at: "2026-09-28T22:05:00Z", reason: "keepalive" }, { started_at: "2026-09-28T23:10:00Z", ended_at: null, reason: null }] } });
    await mount(createElement(ShipCardView, { mmsi: "431011305", detail, error: null, now: NOW }));
    const gaps = all((e) => e.getAttribute("data-testid") === "ship-gaps")[0];
    expect(all((e) => e.tagName === "LI", gaps).map((li) => li.getAttribute("title"))).toEqual([
      "2026-09-29 07:00:00.000 KST – 2026-09-29 07:05:00.000 KST", "2026-09-29 08:10:00.000 KST – —",
    ]);
    expect(missingHover()).toEqual([]);
  });
});

describe("tooltips that name a time name it in KST only", () => {
  it("status bar: the KMA STALE badge", async () => {
    at("2026-09-28T23:59:00Z");
    const kr = {
      available: true, latest_tm: "202609290840", georeferenced: true, coordinates: null, legend: null,
      frames: [{ tm: "202609290840", obs_tm: "202609290840", fetched_at: "2026-09-28T23:41:00Z", echo_cells: 5, url: "/x" }],
      attribution: "기상청", meta: { fetched_at: "2026-09-28T23:20:00Z", stale: true },
    } as KrRadar;
    setData({ conn: "open", lastRxAt: Date.now(), radarKr: kr, feeds: { region: { provider: "adsb_fi", fetched_at: "2026-09-28T23:58:14Z", lag_s: 2, stale: false, received_at: Date.now() }, global: null } });
    const { StatusBar } = await import("@/components/StatusBar");
    await mount(createElement(StatusBar));
    expect(all((e) => e.getAttribute("data-testid") === "kr-radar-stale")).toHaveLength(1);
    expect(missingHover().filter((x) => x.startsWith("title: "))).toEqual([]);
  });
  it("search results: the 'db' badge of an aircraft that is not live, and the not-live ship rows", async () => {
    const NOW = Date.parse("2026-09-29T01:00:00Z");
    at("2026-09-29T01:00:00Z");
    const { SearchResultsView } = await import("@/components/AircraftSearch");
    await mount(createElement(SearchResultsView, {
      uid: "u", now: NOW, active: -1, shipSort: { key: "sog", dir: "desc" }, onShipSort: () => {}, onChooseAircraft: () => {}, onChooseShip: () => {}, onHover: () => {},
      aircraft: { hits: [{ hex: "71c081", callsign: "KAL081", registration: null, type_code: null, alt_ft: null, on_ground: null, lat: null, lon: null, live: false, last_seen: "2026-09-28T23:41:14Z" }], state: "done", msg: "1건" },
      ships: { hits: [{ mmsi: "300000002", name: "BRAVO", call_sign: null, imo: null, ship_type: null, category: "cargo", live: false, lat: null, lon: null, sog_kn: null, seen_at: null, last_position_at: "2026-09-28T15:30:00Z", last_seen_at: "2026-09-28T14:30:00Z" }], state: "done", msg: "1건", note: null, error: null },
    } as never));
    expect(all((e) => e.getAttribute("title") === "마지막 수신 2026-09-29 08:41:14.000 KST")).toHaveLength(1);
    expect(missingHover()).toEqual([]);
  });
  it("focus-tracking chip: the start time", async () => {
    const { focusChip, parseDemand } = await import("@/lib/demand");
    const d = parseDemand({ focus: { hex: "71c081", state: "active", interval_s: 5, since: "2026-09-28T23:40:00Z" } }, 0);
    expect(focusChip(d, "71c081", Date.parse("2026-09-28T23:45:00Z"))!.title).toContain("시작 2026-09-29 08:40:00.000 KST.");
  });
});

describe("time labels on the radar timeline and the replay toolbar", () => {
  it("radar timeline: a RainViewer frame (epoch) shows KST with the full KST instant on hover", async () => {
    at("2026-09-28T23:45:00Z");
    setData({ radar: { host: "h", generated: 0, past: [{ time: Date.parse("2026-09-28T23:40:00Z") / 1000, path: "/p" }], fetched_at: "2026-09-28T23:41:00Z" } });
    const { RadarTimeline } = await import("@/components/RadarTimeline");
    await mount(createElement(RadarTimeline));
    const label = all((e) => e.getAttribute("data-testid") === "radar-frame-time")[0];
    expect(label.textContent).toBe("09-29 08:40 KST");
    expect(label.getAttribute("title")).toBe("2026-09-29 08:40:00.000 KST");
    expect(missingHover()).toEqual([]);
  });
  it("replay radar frame: the tooltip gives the frame's full KST instant (no UTC original — contract v5 §G20)", async () => {
    const { replayRadarTitle } = await import("@/lib/replay");
    expect(replayRadarTitle({ at: "2026-09-28T15:10:00Z", radar: { host: "h", path: "/p", time: Date.parse("2026-09-28T15:00:00Z") / 1000 } })).toBe("2026-09-29 00:00:00.000 KST");
    expect(replayRadarTitle({ at: "2026-09-28T15:10:00Z", radar: null })).toBeUndefined();
    expect(replayRadarTitle(null)).toBeUndefined();
  });
});

describe("replay inspector: record times and SIGMET validity in KST only (title = the full KST instant); the raw SIGMET is labelled and kept as issued", () => {
  const sg = { id: "S", hazard: "TS", qualifier: null, fir_id: "RKRR", fir_name: "INCHEON", valid_from: "2026-09-28T14:00:00Z", valid_to: "2026-09-28T18:00:00Z",
    raw_text: "RKRR SIGMET 1 VALID 281400/281800 RKSI-", geometry: null };
  it("SIGMET at that time: validity in KST, raw text under 'Raw (원문 · 발표 그대로)' exactly as issued", async () => {
    const { ReplaySigmetDetail } = await import("@/components/ReplayInspector");
    await mount(createElement(ReplaySigmetDetail, { sg } as never));
    expect(dom.container.textContent).toContain("유효09-28 23:00:00 – 09-29 03:00:00 KST");
    const labels = all((e) => /\blabel\b/.test(e.getAttribute("class") ?? "")).map((e) => e.textContent);
    expect(labels).toContain("Raw (원문 · 발표 그대로)");
    expect(all((e) => e.tagName === "PRE").map((p) => [p.textContent, p.getAttribute("data-raw")])).toEqual([[sg.raw_text, "bulletin"]]);
    expect(all((e) => e.getAttribute("title") === "2026-09-28 23:00:00.000 KST – 2026-09-29 03:00:00.000 KST")).toHaveLength(1);
    expect(domUtcLeaks(dom.container)).toEqual([]);
  });
  it("aircraft record: the record time (full resolution) and the record span (1-minute summary)", async () => {
    const { ReplayAircraftDetail } = await import("@/components/ReplayInspector");
    await mount(createElement(ReplayAircraftDetail, { ac: { hex: "71c081", lat: 36, lon: 127, ts: "2026-09-28T15:09:30Z", provider: "adsb_fi" }, at: "2026-09-28T15:10:00Z" } as never));
    expect(dom.container.textContent).toContain("기록 시각09-29 00:09:30 KST");
    expect(all((e) => e.getAttribute("title") === "2026-09-29 00:09:30.000 KST")).toHaveLength(1);
    expect(domUtcLeaks(dom.container)).toEqual([]);
    await React.act(async () => { root!.render(createElement(ReplayAircraftDetail, { ac: { hex: "71c081", lat: 36, lon: 127, ts: "2026-09-28T14:59:00Z", provider: "1m_summary" }, at: "2026-09-28T15:10:00Z" } as never)); });
    expect(dom.container.textContent).toContain("기록 구간09-28 23:59:00 – 09-29 00:00:00 KST 평균");
    expect(dom.container.textContent).toContain("1분 평균"); // 요약 행 표시는 그대로
    expect(domUtcLeaks(dom.container)).toEqual([]);
  });
});

describe("the hover promise is stated only where it holds", () => {
  it("/about: KST only on every screen; the full KST instant on hover; the KMA tm is issued in KST", () => {
    const t = renderToStaticMarkup(createElement(AboutPage)).replace(/<[^>]+>/g, "");
    expect(t).toContain("화면의 시각은 모두 한국 표준시(KST)입니다");
    expect(t).toContain("시각에 마우스를 올리면 연도 · ms 까지의 같은 순간(KST)이 보입니다");
    expect(t).toContain("기상청 레이더 tm 은 기상청이 준 KST 그대로입니다");
    expect(t).not.toContain("원본 UTC");
  });
  it("ship card footer: KST, the full KST instant on hover", async () => {
    const { parseShipDetail, ShipCardView } = await import("@/components/ShipCard");
    const html = renderToStaticMarkup(createElement(ShipCardView, { mmsi: "431011305", detail: parseShipDetail("431011305", { state: null, static: null, meta: {} }), error: null, now: 0 }));
    expect(html).toContain("시각은 KST — 이 카드의 시각에 마우스를 올리면 연도 · ms 까지의 같은 순간(KST).");
  });
});
