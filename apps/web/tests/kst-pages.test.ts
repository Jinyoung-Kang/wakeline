/**
 * 통계(/stats) · 공항(/airports/[icao] · 공항 카드)도 한국 표준시(사용자 요청 2026-09-29 "상황판도 KST로 바꿔") — 실제 react-dom 으로 마운트(최소 DOM + fetch 대역).
 * - 통계: UTC 날짜로 센 집계는 날짜를 KST 로 옮기지 않고 "(UTC 날짜)" 라고 적는다. 하루 안의 시각(시간대별 막대 · 집계 시각)은 KST(· UTC).
 * - 공항: 관측 · 수신 시각은 KST 먼저 · UTC 함께(사용자 요청 2026-09-29 "UTC 와 KST 함께"), METAR · TAF 원문은 발표된 그대로(안의 "…Z" 는 UTC).
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { hourlyRowsKst } from "@/lib/chart";
import { statsEmptyText } from "@/lib/stats";
import { unpairedKst } from "./helpers/dual-time";

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

describe("stats: UTC-day aggregates keep the UTC date; times of day are KST", () => {
  it("hourly rows: bars stay in time order for the UTC day, labelled with the KST hour; the full label names both", () => {
    const rows = hourlyRowsKst([{ hour: "00", value: 3 }, { hour: "15", value: 7 }], "2026-09-28");
    expect(rows).toHaveLength(24);
    expect(rows.map((r) => r.label)).toEqual(["09", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "00", "01", "02", "03", "04", "05", "06", "07", "08"]);
    expect(rows[0]).toEqual({ label: "09", value: 3, full: "09-28 09시 KST (UTC 00시)" });
    expect(rows[15]).toEqual({ label: "00", value: 7, full: "09-29 00시 KST (UTC 15시)" }); // UTC 15시 = 다음 KST 날의 자정
    expect(rows[1]).toEqual({ label: "10", value: null, full: "09-28 10시 KST (UTC 01시)" }); // 자료 없음은 null 그대로
    // 날짜를 모르면 시각만(날짜를 지어내지 않는다)
    expect(hourlyRowsKst([], null)[15].full).toBe("00시 KST (UTC 15시)");
  });
  it("empty-state text names the aggregation time in KST with UTC", () => {
    expect(statsEmptyText(false, "2026-09-27", "2026-09-28")).toContain("다음 12:30 KST · 03:30 UTC 집계");
    expect(statsEmptyText(undefined, "2026-09-27", "2026-09-28")).toContain("집계는 매일 12:30 KST · 03:30 UTC");
    for (const t of [statsEmptyText(false, "2026-09-27", "2026-09-28"), statsEmptyText(undefined, null, "2026-09-28")]) expect(unpairedKst(t)).toEqual([]);
  });
  it("the page: day picker and table say UTC date; chart bars, caption and the hysteresis note use KST", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-09-29T01:00:00Z") }); // KST 09-29 10:00 → 어제(UTC 날짜) 09-28
    stub({
      "/api/v1/stats/sigmet?group=fir": { items: [], aggregated: true },
      "/api/v1/stats/sigmet?group=hazard": { items: [], aggregated: true },
      "/api/v1/stats/traffic?day=2026-09-28": { items: [{ day: "2026-09-28", hour: "00", dim: "00", value: 3 }, { day: "2026-09-28", hour: "15", dim: "15", value: 7 }], aggregated: true, scope: null, region: null },
      "/api/v1/stats/alerts": { items: [{ day: "2026-09-27", metric: "alerts_by_kind", dim: "OBSERVED", value: 5 }], aggregated: true },
    });
    const StatsPage = (await import("@/app/stats/page")).default;
    await mount(createElement(StatsPage));
    const t = dom.container.textContent;
    expect(t).toContain("Distinct aircraft by hour (KST 시각 · UTC 날짜)");
    const inputs = all((e) => e.tagName === "INPUT").map((e) => e.getAttribute("aria-label"));
    expect(inputs).toEqual(["집계 날짜(UTC 날짜)"]);
    expect(byTestId("traffic-hours-note")!.textContent).toBe("UTC 날짜 2026-09-28 = KST 09-28 09:00 – 09-29 08:59 · 막대 = 한국 표준시 시각(09시 → 다음 날 08시)");
    // 막대 라벨: 첫 칸 09(= UTC 00시), 16번째 칸 00(= UTC 15시 — 다음 KST 날)
    const svg = all((e) => e.tagName === "svg")[0];
    const labels = all((e) => e.tagName === "text", svg).map((x) => x.childNodes.filter((c) => !(c instanceof MiniElement)).map((c) => c.textContent).join("")).filter((x) => /^\d\d$/.test(x));
    expect(labels.slice(0, 2)).toEqual(["09", "10"]);
    expect(labels[15]).toBe("00");
    const srRows = all((e) => e.tagName === "TR").map((r) => all((e) => e.tagName === "TD", r).map((c) => c.textContent)).filter((c) => c.length === 2);
    expect(srRows).toContainEqual(["09-29 00시 KST (UTC 15시)", "7"]);
    // 알림 표: 날짜는 UTC 날짜 그대로 — KST 로 옮기지 않는다
    const heads = all((e) => e.tagName === "TH").map((h) => h.textContent);
    expect(heads).toContain("날짜(UTC 날짜)");
    expect(all((e) => e.tagName === "TD").map((c) => c.textContent)).toContain("2026-09-27");
    expect(byTestId("hysteresis-caveat")!.textContent).toContain("09-28 00:10:00 KST · 09-27 15:10:00 UTC 이전에 생성된 관측(OBSERVED) 알림");
    expect(byTestId("hysteresis-caveat")!.textContent).toContain("UTC 날짜 2026-09-27 까지");
    expect(t).toContain("매일 12:30 KST · 03:30 UTC 에 전날(UTC 날짜) 집계");
    expect(unpairedKst(t)).toEqual([]);
  });
});

describe("airport weather: observation and reception times in KST with UTC; raw METAR/TAF exactly as issued", () => {
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
    expect(t).toContain("METAR · 09-29 08:30:00 KST · 09-28 23:30:00 UTC");
    expect(all((e) => e.tagName === "TH").map((h) => h.textContent)).toContain("obs (KST · UTC)");
    const cells = all((e) => e.tagName === "TD").map((c) => c.textContent);
    expect(cells).toContain("09-29 08:30:00 KST · 09-28 23:30:00 UTC"); // 표 칸: 첫 줄 KST · 둘째 줄 UTC(화면 읽기용 글자 포함)
    expect(cells).toContain("09-28 23:30:00 KST · 14:30:00 UTC"); // 14:30Z = 같은 날 KST 23:30 — UTC 날짜가 같아 UTC 쪽에 날짜 없음
    expect(t).not.toMatch(/—°|— kt/); // 바람을 모르는 행은 "—" 만(단위 없이)
    const pres = all((e) => e.tagName === "PRE").map((p) => p.textContent);
    expect(pres).toEqual([METAR, TAF]); // 원문은 글자 그대로(282330Z 등 UTC 그대로)
    expect(unpairedKst([METAR, TAF].reduce((x, raw) => x.split(raw).join(""), t))).toEqual([]);
  });
  it("airport card: observation and reception in KST; raw METAR and TAF unchanged", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-09-28T23:40:00Z") });
    stub({ "/api/v1/airports/RKSI/wx": WX });
    const { AirportCard } = await import("@/components/AirportCard");
    await mount(createElement(AirportCard, { icao: "RKSI" }));
    const t = dom.container.textContent;
    expect(t).toContain("관측09-29 08:30:00 KST · 09-28 23:30:00 UTC");
    expect(t).toContain("출처awc · 수신 09-29 08:31:00 KST · 09-28 23:31:00 UTC");
    expect(all((e) => e.tagName === "PRE").map((p) => p.textContent)).toEqual([METAR, TAF]);
    expect(t).toContain("METAR (원문 · UTC)");
    expect(unpairedKst([METAR, TAF].reduce((x, raw) => x.split(raw).join(""), t))).toEqual([]);
  });
});
