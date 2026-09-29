/**
 * 통계(/stats) · 공항(/airports/[icao] · 공항 카드)은 한국 표준시만(계약 v5 §G20 — 사용자 결정 2026-09-30) — 실제 react-dom 으로 마운트(최소 DOM + fetch 대역).
 * - 통계: 서버가 KST 날짜로 센다(응답 day_zone "Asia/Seoul") — 날짜 · 시간대별 막대(KST 시) · 집계 시각(03:30 KST) 모두 KST. KST 날짜라고 밝히지 않은 응답은 그리지 않는다.
 * - 공항: 관측 · 수신 시각은 KST, METAR · TAF 원문은 발표된 그대로(data-raw).
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { hourlyRowsKst } from "@/lib/chart";
import { statsEmptyText } from "@/lib/stats";
import { domUtcLeaks, utcLeaks } from "./helpers/kst-only";

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
afterEach(async () => {
  if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const all = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container, out: MiniElement[] = []): MiniElement[] => {
  if (pred(from)) out.push(from);
  for (const c of from.childNodes) if (c instanceof MiniElement) all(pred, c, out);
  return out;
};
const byTestId = (id: string) => all((e) => e.getAttribute?.("data-testid") === id)[0] ?? null;
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

describe("stats: the server counts KST days (contract v5 §G20) — dates, hours and the aggregation time are KST only", () => {
  it("hourly rows: the 24 KST hours of the KST day in order (00 → 23); the full label names the KST date; no UTC tick line", () => {
    const rows = hourlyRowsKst([{ hour: "00", value: 3 }, { hour: "23", value: 7 }], "2026-09-29");
    expect(rows).toHaveLength(24);
    expect(rows.map((r) => r.label)).toEqual(Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")));
    expect(rows[0]).toEqual({ label: "00", value: 3, full: "09-29 00시 KST" });
    expect(rows[23]).toEqual({ label: "23", value: 7, full: "09-29 23시 KST" });
    expect(rows[1]).toEqual({ label: "01", value: null, full: "09-29 01시 KST" }); // 자료 없음은 null 그대로
    for (const d of [null, "2026-9-29", "2026-02-30"]) expect(hourlyRowsKst([], d)[15].full, String(d)).toBe("15시 KST"); // 날짜를 지어내지 않는다
  });
  it("BarChart draws one tick line per bar (the KST hour); the full KST label is its tooltip", async () => {
    const { BarChart } = await import("@/components/BarChart");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(createElement(BarChart, { id: "h", title: "t", rows: hourlyRowsKst([{ hour: "00", value: 3 }], "2026-09-29") }));
    expect(html).not.toContain("data-tick");
    expect(html).toContain("<title>09-29 00시 KST</title>00</text>");
    expect(utcLeaks(html.replace(/<[^>]+>/g, " "))).toEqual([]);
  });
  it("empty-state text names the aggregation time in KST only", () => {
    expect(statsEmptyText(false, "2026-09-27", "2026-09-28")).toContain("다음 03:30 KST 집계");
    expect(statsEmptyText(undefined, "2026-09-27", "2026-09-28")).toContain("집계는 매일 03:30 KST");
    for (const t of [statsEmptyText(false, "2026-09-27", "2026-09-28"), statsEmptyText(undefined, null, "2026-09-28")]) expect(utcLeaks(t)).toEqual([]);
  });
  const STATS = (trafficDay: string, zone: string | null = "Asia/Seoul") => {
    const z = zone == null ? {} : { day_zone: zone };
    return {
      "/api/v1/stats/sigmet?group=fir": { items: [], days: [], ...z },
      "/api/v1/stats/sigmet?group=hazard": { items: [], days: [], ...z },
      [`/api/v1/stats/traffic?day=${trafficDay}`]: { day: trafficDay, items: [{ day: trafficDay, dim: "00", value: 3 }, { day: trafficDay, dim: "23", value: 7 }], aggregated: true, scope: null, region: null, ...z },
      "/api/v1/stats/alerts": { items: [{ day: "2026-09-27", metric: "alerts_by_kind", dim: "OBSERVED", value: 5 }], days: [], ...z },
    };
  };
  it("the page: yesterday is the KST yesterday; the day picker, chart, table and notes say KST; no UTC anywhere", async () => {
    // 01:00 KST 09-29 = 16:00 UTC 09-28 — UTC 로는 어제가 09-27 이지만 KST 로는 09-28
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-09-28T16:00:00Z") });
    stub(STATS("2026-09-28"));
    const StatsPage = (await import("@/app/stats/page")).default;
    await mount(createElement(StatsPage));
    const t = dom.container.textContent;
    expect(t).toContain("Distinct aircraft by hour (KST)");
    const input = all((e) => e.tagName === "INPUT")[0];
    expect([input.getAttribute("aria-label"), input.getAttribute("max")]).toEqual(["집계 날짜(KST)", "2026-09-28"]);
    expect(byTestId("traffic-hours-note")!.textContent).toBe("KST 날짜 2026-09-28(00:00–24:00 KST) · 눈금 = KST 시");
    const svg = all((e) => e.tagName === "svg")[0];
    const own = (x: MiniElement) => x.childNodes.filter((c) => !(c instanceof MiniElement)).map((c) => c.textContent).join("");
    const ticks = all((e) => e.tagName === "text", svg).map(own).filter((x) => /^\d\d$/.test(x));
    expect(ticks.slice(0, 3)).toEqual(["00", "01", "02"]);
    const srRows = all((e) => e.tagName === "TR").map((r) => all((e) => e.tagName === "TD", r).map((c) => c.textContent)).filter((c) => c.length === 2);
    expect(srRows).toContainEqual(["09-28 23시 KST", "7"]);
    // 알림 표: KST 날짜
    expect(all((e) => e.tagName === "TH").map((h) => h.textContent)).toContain("날짜(KST)");
    expect(all((e) => e.tagName === "TD").map((c) => c.textContent)).toContain("2026-09-27");
    expect(byTestId("hysteresis-caveat")!.textContent).toContain("09-28 00:10:00 KST 이전에 생성된 관측(OBSERVED) 알림");
    expect(byTestId("hysteresis-caveat")!.textContent).toContain("KST 날짜 2026-09-28 까지");
    expect(t).toContain("매일 03:30 KST 에 전날(KST 날짜) 집계");
    expect(domUtcLeaks(dom.container)).toEqual([]);
  });
  it("a response that does not say its days are KST days (older api — UTC days) is not drawn as KST days", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-09-29T01:00:00Z") });
    stub(STATS("2026-09-28", null));
    const StatsPage = (await import("@/app/stats/page")).default;
    await mount(createElement(StatsPage));
    expect(all((e) => e.tagName === "svg")).toHaveLength(0); // 차트 없음
    expect(all((e) => e.tagName === "TD").map((c) => c.textContent)).not.toContain("2026-09-27");
    const notes = all((e) => e.getAttribute("data-testid") === "stats-zone-error").map((e) => e.textContent);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("KST 날짜로 센 응답이 아님");
  });
});

describe("airport weather: observation and reception times in KST only (contract v5 §G20); raw METAR/TAF exactly as issued, marked data-raw", () => {
  const METAR = "METAR RKSI 282330Z 27010KT 9999 FEW030 18/12 Q1012 NOSIG";
  const TAF = "TAF RKSI 282300Z 2900/3006 27010KT 9999 FEW030 TX22/2906Z TN14/2921Z";
  const WX = {
    airport: { icao: "RKSI", name: "Incheon Intl", lat: 37.46, lon: 126.44, elev_ft: 23 },
    latest: { obs_time: "2026-09-28T23:30:00Z", raw: METAR, taf_raw: TAF, provider: "awc", fetched_at: "2026-09-28T23:31:00Z", flight_cat: "VFR", flight_cat_source: "awc", ceiling_state: "none", vis_raw: "6+" },
    history: [{ obs_time: "2026-09-28T23:30:00Z", flight_cat: "VFR", wind_dir: 270, wind_kt: 10, vis_raw: "6+", ceiling_ft: null, temp_c: 18 }, { obs_time: "2026-09-28T14:30:00Z", flight_cat: "VFR" }],
  };
  it("history page: METAR time and the obs column in KST (header says so); raw METAR and TAF unchanged", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-09-28T23:40:00Z") });
    stub({ "/api/v1/airports/RKSI/wx": WX });
    const AirportPage = (await import("@/app/airports/[icao]/page")).default;
    await mount(createElement(AirportPage, { params: Promise.resolve({ icao: "rksi" }) }));
    const t = dom.container.textContent;
    expect(t).toContain("METAR · 09-29 08:30:00 KST");
    expect(all((e) => e.tagName === "TH").map((h) => h.textContent)).toContain("obs (KST)");
    const cells = all((e) => e.tagName === "TD").map((c) => c.textContent);
    expect(cells).toContain("09-29 08:30:00 KST"); // 표 칸: KST(화면 읽기용 " KST" 포함) — UTC 로는 전날 23:30
    expect(cells).toContain("09-28 23:30:00 KST");
    expect(t).not.toMatch(/—°|— kt/); // 바람을 모르는 행은 "—" 만(단위 없이)
    const pres = all((e) => e.tagName === "PRE").map((p) => [p.textContent, p.getAttribute("data-raw")]);
    expect(pres).toEqual([[METAR, "bulletin"], [TAF, "bulletin"]]); // 원문은 글자 그대로(282330Z 등 발표 형식 그대로)
    expect(domUtcLeaks(dom.container)).toEqual([]); // 원문 밖에는 UTC 가 없다
  });
  it("airport card: observation and reception in KST; raw METAR and TAF unchanged", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-09-28T23:40:00Z") });
    stub({ "/api/v1/airports/RKSI/wx": WX });
    const { AirportCard } = await import("@/components/AirportCard");
    await mount(createElement(AirportCard, { icao: "RKSI" }));
    const t = dom.container.textContent;
    expect(t).toContain("관측09-29 08:30:00 KST");
    expect(t).toContain("출처awc · 수신 09-29 08:31:00 KST");
    expect(all((e) => e.tagName === "PRE").map((p) => [p.textContent, p.getAttribute("data-raw")])).toEqual([[METAR, "bulletin"], [TAF, "bulletin"]]);
    expect(t).toContain("METAR (원문 · 발표 그대로)");
    expect(domUtcLeaks(dom.container)).toEqual([]);
  });
});
