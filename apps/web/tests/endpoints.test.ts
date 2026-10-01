/**
 * lib/endpoints/* 와 lib/search 의 검색 요청(web-review §3.1): 함수마다 경로(서버 계약 그대로) · 경로 조각과 검색어 인코딩 · { signal } 그대로 넘기기 · 본문 파싱(모양이 틀린 본문은
 * 파서의 답 — 빈 목록 · null)을 본다. 전송은 lib/api apiGet 이라 vi.mock("@/lib/api") 로 가로챈다(컴포넌트 시험과 같은 자리).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rec = vi.hoisted(() => ({ calls: [] as { path: string; init: unknown }[], body: undefined as unknown, error: null as unknown }));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  apiGet: (path: string, init?: unknown) => { rec.calls.push({ path, init }); return rec.error ? Promise.reject(rec.error) : Promise.resolve(rec.body); },
}));

import { aircraftDetail } from "@/lib/endpoints/aircraft";
import { searchAircraft, searchShips } from "@/lib/search";
import { aircraftTrack, shipTrack } from "@/lib/endpoints/tracks";
import { shipDetail } from "@/lib/endpoints/ship-detail";
import { airportWx, sigmetInside, watchedAirports } from "@/lib/endpoints/weather";

beforeEach(() => { rec.calls.length = 0; rec.body = undefined; rec.error = null; });
const paths = () => rec.calls.map((c) => c.path);

describe("aircraft endpoints", () => {
  it("detail, track and search paths; path segment and query are encoded", async () => {
    rec.body = { hex: "71be19", state: null, static: null };
    expect(await aircraftDetail("71be19")).toEqual({ hex: "71be19", state: null, static: null });
    rec.body = { points: [] };
    await aircraftTrack("a/b?c");
    rec.body = { items: [] };
    await searchAircraft("KAL 1");
    expect(paths()).toEqual(["/api/v1/aircraft/71be19", "/api/v1/aircraft/a%2Fb%3Fc/track", "/api/v1/aircraft/search?q=KAL%201"]);
  });
  it("passes the caller's signal through and sends no init without one", async () => {
    const ctl = new AbortController();
    rec.body = { items: [] };
    await searchAircraft("KAL1", { signal: ctl.signal });
    await aircraftDetail("71be19");
    expect((rec.calls[0].init as { signal: AbortSignal }).signal).toBe(ctl.signal);
    expect(rec.calls[1].init).toBeUndefined();
  });
  it("parses: search hits through parseSearchResponse, track points through trackFromRest", async () => {
    rec.body = { items: [{ hex: "71BE19", callsign: "KAL1 ", lat: 37, lon: 127 }, { hex: "zz" }] };
    const hits = await searchAircraft("KAL1");
    expect(hits.map((h) => [h.hex, h.callsign, h.live])).toEqual([["71be19", "KAL1", true]]);
    rec.body = { points: [{ ts: "2026-09-28T01:00:00Z", lon: 127, lat: 37, alt_ft: 1000 }, { ts: null, lon: 1, lat: 2 }] };
    expect(await aircraftTrack("71be19")).toEqual([{ ts: Date.parse("2026-09-28T01:00:00Z"), lon: 127, lat: 37, alt_ft: 1000, provider: null }]);
  });
  it("a body of the wrong shape: search gives no hits, a track without points is empty, a null track body rejects", async () => {
    rec.body = { items: "nope" };
    expect(await searchAircraft("KAL1")).toEqual([]);
    rec.body = {};
    expect(await aircraftTrack("71be19")).toEqual([]);
    rec.body = null;
    await expect(aircraftTrack("71be19")).rejects.toThrow(TypeError);
  });
  it("a transport failure is the caller's to handle", async () => {
    rec.error = new Error("down");
    await expect(aircraftDetail("71be19")).rejects.toThrow("down");
  });
});

describe("ship endpoints", () => {
  it("track path carries the window as ISO instants; the MMSI is encoded", async () => {
    rec.body = {};
    const from = Date.parse("2026-09-28T00:00:00Z"), to = Date.parse("2026-09-28T06:00:00Z");
    expect(await shipTrack("440123456", from, to)).toEqual({ segs: [], gaps: [] });
    await shipTrack("4/0", from, to);
    expect(paths()).toEqual([
      "/api/v1/ships/440123456/track?from=2026-09-28T00%3A00%3A00.000Z&to=2026-09-28T06%3A00%3A00.000Z",
      "/api/v1/ships/4%2F0/track?from=2026-09-28T00%3A00%3A00.000Z&to=2026-09-28T06%3A00%3A00.000Z",
    ]);
  });
  it("search: encoded query with the screen's limit, parsed hits and the db_unavailable flag; signal passed through", async () => {
    const ctl = new AbortController();
    rec.body = { items: [{ mmsi: "440123456", name: "SYN A", live: false }, { mmsi: "12" }], meta: { db_unavailable: true } };
    const r = await searchShips("SYN A", { signal: ctl.signal });
    expect(paths()).toEqual(["/api/v1/ships/search?q=SYN%20A&limit=10"]);
    expect((rec.calls[0].init as { signal: AbortSignal }).signal).toBe(ctl.signal);
    expect(r.dbUnavailable).toBe(true);
    expect(r.hits.map((h) => [h.mmsi, h.name, h.live])).toEqual([["440123456", "SYN A", false]]);
    rec.body = "garbage";
    expect(await searchShips("SYN")).toEqual({ hits: [], dbUnavailable: false });
  });
  it("detail (lazy-only module): encoded path, parsed through parseShipDetail — unknown values stay null", async () => {
    rec.body = { state: null, static: null, first_recorded_at: "yesterday", meta: { db_unavailable: true } };
    const d = await shipDetail("440/123");
    expect(paths()).toEqual(["/api/v1/ships/440%2F123"]);
    expect(d).toMatchObject({ mmsi: "440/123", state: null, static: null, first_recorded_at: null, db_unavailable: true });
  });
});

describe("weather endpoints (lazy-only module)", () => {
  it("airport wx: encoded path; a readable body is parsed, a body of the wrong shape is null", async () => {
    rec.body = { airport: { icao: "RKSI", lat: "x" }, latest: null, history: [{ obs_time: "2026-09-28T01:00:00Z" }, { nope: 1 }] };
    const wx = await airportWx("RK/SI");
    expect(paths()).toEqual(["/api/v1/airports/RK%2FSI/wx"]);
    expect(wx).toMatchObject({ airport: { icao: "RKSI", lat: null }, latest: null, history: [{ obs_time: "2026-09-28T01:00:00Z" }] });
    rec.body = { airport: { icao: "RKSI" }, latest: null };
    expect(await airportWx("RKSI")).toBeNull();
  });
  it("watched airports: points whose ICAO is text; a features value that is not a list is an empty list", async () => {
    const ctl = new AbortController();
    rec.body = { type: "FeatureCollection", features: [{ properties: { icao: "RKSI" } }, { properties: { icao: 7 } }, { properties: null }] };
    expect((await watchedAirports({ signal: ctl.signal })).map((f) => f.properties.icao)).toEqual(["RKSI"]);
    expect(paths()).toEqual(["/api/v1/airports?watched=true"]);
    expect((rec.calls[0].init as { signal: AbortSignal }).signal).toBe(ctl.signal);
    rec.body = { features: null };
    expect(await watchedAirports()).toEqual([]);
  });
  it("SIGMET inside: encoded id; the hex list, or null (unknown) when the body has no list", async () => {
    rec.body = { aircraft_inside: ["71be19"] };
    expect(await sigmetInside("RKRR 1#2")).toEqual(["71be19"]);
    expect(paths()).toEqual(["/api/v1/sigmets/RKRR%201%232"]);
    rec.body = { aircraft_inside: "71be19" };
    expect(await sigmetInside("x")).toBeNull();
  });
});
