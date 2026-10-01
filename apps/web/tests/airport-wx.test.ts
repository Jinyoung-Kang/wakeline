/**
 * GET /api/v1/airports/{icao}/wx 본문 검사(web-review B10 · PLAN W10 — 공항 카드 · 공항 기상 이력 화면). 전에는 캐스트만 해서
 * airport 가 없거나 위경도가 수가 아닌 본문이 카드 · 화면을 그리다 던졌다. 읽을 수 없는 본문은 그리지 않고 그렇다고 말한다(지어내지 않는다).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { parseWx } from "@/lib/airport-wx";

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** api WeatherController#airportWx 의 모양(값은 합성) */
const BODY = {
  airport: { icao: "RKSI", name: "Incheon Intl", country: "KR", elev_ft: 23, lat: 37.4602, lon: 126.4407 },
  latest: { obs_time: "2026-09-29T00:00:00Z", raw: "METAR RKSI 290000Z 27008KT 9999 FEW030 18/12 Q1015", temp_c: 18, dewp_c: 12, wind_dir: 270, wind_kt: 8, vis_raw: "6+",
    ceiling_ft: null, ceiling_state: "none", flight_cat: "VFR", flight_cat_source: "metar", obs_age_s: 600, stale: false, provider: "awc", fetched_at: "2026-09-29T00:05:00Z" },
  history: [{ obs_time: "2026-09-29T00:00:00Z", flight_cat: "VFR", wind_dir: 270, wind_kt: 8, vis_sm: 6, vis_raw: "6+", ceiling_ft: null, temp_c: 18 }],
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("parseWx", () => {
  it("accepts the api's body; no METAR yet is latest null", () => {
    expect(parseWx(BODY)).toEqual(BODY);
    expect(parseWx({ ...BODY, latest: null, history: [] })!.latest).toBeNull();
  });
  it("refuses what the screens cannot read: no airport/icao, a METAR without time or text, history not a list", () => {
    for (const bad of [null, [], "x", {}, { ...BODY, airport: null }, { ...BODY, airport: { name: "x" } }, { ...BODY, latest: { raw: "METAR" } },
      { ...BODY, latest: "METAR" }, { ...BODY, history: null }]) expect(parseWx(bad)).toBeNull();
  });
  it("drops history rows without a time; unreadable coordinates become unknown (null)", () => {
    const w = parseWx({ ...BODY, airport: { ...BODY.airport, lat: "37.46", lon: null }, history: [BODY.history[0], { flight_cat: "IFR" }, null] })!;
    expect(w.history).toEqual(BODY.history);
    expect(w.airport.lat).toBeNull();
    expect(w.airport.lon).toBeNull();
  });
});

describe("airport card and history page with an unreadable body", () => {
  it("the card says the answer could not be read instead of falling over", async () => {
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("fetch", async () => json({ latest: null, history: [] }));
    const { AirportCard } = await import("@/components/AirportCard");
    await m.render(m.React.createElement(AirportCard, { icao: "RKSI" }));
    await m.settle();
    expect(m.byTestId("airport-card")!.textContent).toContain("응답 형식이 맞지 않음");
  });
  it("the history page says so too (a non-numeric latitude used to throw in toFixed)", async () => {
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("fetch", async () => json({ ...BODY, airport: { ...BODY.airport, lat: "37.46" }, history: "none" }));
    const AirportPage = (await import("@/app/airports/[icao]/page")).default;
    await m.render(m.React.createElement(m.React.Suspense, { fallback: null }, m.React.createElement(AirportPage, { params: Promise.resolve({ icao: "rksi" }) })));
    await m.settle();
    await m.settle();
    const alert = m.find((e) => e.getAttribute("role") === "alert");
    expect(alert?.textContent).toContain("응답 형식이 맞지 않");
  });
  it("the history page shows unknown coordinates as — when only they are unreadable", async () => {
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("fetch", async () => json({ ...BODY, airport: { ...BODY.airport, lat: "37.46" } }));
    const AirportPage = (await import("@/app/airports/[icao]/page")).default;
    await m.render(m.React.createElement(m.React.Suspense, { fallback: null }, m.React.createElement(AirportPage, { params: Promise.resolve({ icao: "rksi" }) })));
    await m.settle();
    await m.settle();
    expect(dom.container.textContent).toContain("Incheon Intl (—, 126.441)");
  });
});
