/**
 * lib/endpoints/* 와 lib/search 의 검색 요청(web-review §3.1): 함수마다 경로(서버 계약 그대로) · 경로 조각과 검색어 인코딩 · { signal } 그대로 넘기기 · 본문 파싱(모양이 틀린 본문은
 * 파서의 답 — 빈 목록 · null)을 본다. 전송은 lib/api apiGet 이라 vi.mock("@/lib/api") 로 가로챈다(컴포넌트 시험과 같은 자리).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rec = vi.hoisted(() => ({
  calls: [] as { path: string; init: unknown }[], sends: [] as { method: string; path: string; body: unknown; headers: unknown }[], body: undefined as unknown, error: null as unknown,
}));
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  apiGet: (path: string, init?: unknown) => { rec.calls.push({ path, init }); return rec.error ? Promise.reject(rec.error) : Promise.resolve(rec.body); },
  apiSend: (method: string, path: string, body?: unknown, headers?: unknown) => {
    rec.sends.push({ method, path, body, headers });
    return rec.error ? Promise.reject(rec.error) : Promise.resolve(rec.body);
  },
}));

import { aircraftDetail } from "@/lib/endpoints/aircraft";
import { searchAircraft, searchShips } from "@/lib/search";
import { aircraftTrack, shipTrack } from "@/lib/endpoints/tracks";
import { shipDetail } from "@/lib/endpoints/ship-detail";
import { airportWx, sigmetInside, watchedAirports } from "@/lib/endpoints/weather";
import { alertStats, sigmetStats, trafficStats } from "@/lib/endpoints/stats";
import { replayFrame } from "@/lib/endpoints/replay";
import {
  createResolution, opsSession, opsTab, opsTabPath, revokeResolution, runsDrill, saveSetting, setProviderEnabled, signIn, signOutRequest,
} from "@/lib/endpoints/ops";
import { aisGaps, logGroups, logItem, logsPage } from "@/lib/endpoints/logs";
import { DEFAULT_LOG_FILTER, logGroupsUrl, logsUrl } from "@/lib/logs";

beforeEach(() => { rec.calls.length = 0; rec.sends.length = 0; rec.body = undefined; rec.error = null; });
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

describe("stats endpoints", () => {
  it("the four panel paths (the day is encoded); signal passed through; the body is returned as is", async () => {
    const ctl = new AbortController();
    rec.body = { items: [], day_zone: "Asia/Seoul" };
    expect(await sigmetStats("fir", { signal: ctl.signal })).toEqual({ items: [], day_zone: "Asia/Seoul" });
    await sigmetStats("hazard");
    await alertStats();
    await trafficStats("2026-09-27");
    await trafficStats("x&y=1");
    expect(paths()).toEqual(["/api/v1/stats/sigmet?group=fir", "/api/v1/stats/sigmet?group=hazard", "/api/v1/stats/alerts",
      "/api/v1/stats/traffic?day=2026-09-27", "/api/v1/stats/traffic?day=x%26y%3D1"]);
    expect((rec.calls[0].init as { signal: AbortSignal }).signal).toBe(ctl.signal);
  });
});

describe("replay endpoint", () => {
  it("replayApiPath (UTC instant, encoded bbox) with the loader's signal", async () => {
    const ctl = new AbortController();
    rec.body = { at: "2026-09-28T15:10:00Z", aircraft: [], sigmets: [], source: "track_point" };
    await replayFrame({ at: Date.parse("2026-09-28T15:10:00Z"), bbox: "124,33,132,39" }, { signal: ctl.signal });
    expect(paths()).toEqual(["/api/v1/replay?at=2026-09-28T15%3A10%3A00.000Z&bbox=124%2C33%2C132%2C39"]);
    expect((rec.calls[0].init as { signal: AbortSignal }).signal).toBe(ctl.signal);
  });
});

describe("ops endpoints", () => {
  it("session: GET with the caller's signal; sign-in POST with the credentials; sign-out DELETE", async () => {
    const ctl = new AbortController();
    rec.body = { username: "op" };
    expect(await opsSession({ signal: ctl.signal })).toEqual({ username: "op" });
    await signIn("op", "secret-pw");
    await signOutRequest();
    expect(paths()).toEqual(["/api/v1/ops/session"]);
    expect((rec.calls[0].init as { signal: AbortSignal }).signal).toBe(ctl.signal);
    expect(rec.sends.map((x) => [x.method, x.path, x.body])).toEqual([["POST", "/api/v1/ops/session", { username: "op", password: "secret-pw" }], ["DELETE", "/api/v1/ops/session", undefined]]);
  });
  it("tab paths: runs carries the resolved mode, the others are fixed", async () => {
    rec.body = {};
    for (const t of ["providers", "runs", "quality", "settings", "audit", "dlq", "pipeline"] as const) await opsTab(t, "show");
    expect(paths()).toEqual(["/api/v1/ops/providers", "/api/v1/ops/runs?limit=50&resolved=show", "/api/v1/ops/quality", "/api/v1/ops/settings",
      "/api/v1/ops/audit", "/api/v1/ops/dlq", "/api/v1/ops/pipeline"]);
    expect(opsTabPath("runs", "hide")).toBe("/api/v1/ops/runs?limit=50&resolved=hide");
  });
  it("runs drill: lib/ops-runs runsDrillPath", async () => {
    rec.body = { items: [] };
    await runsDrill({ job: "kma radar", provider: "kma", status: "error" }, "2026-09-28T00:00:00Z", 50);
    expect(paths()).toEqual(["/api/v1/ops/runs?job=kma+radar&provider=kma&status=error&since=2026-09-28T00%3A00%3A00Z&limit=50&cursor=50"]);
  });
  it("writes: provider switch and setting paths are encoded; the setting save sends If-Match", async () => {
    rec.body = { provider: "a/b", disabled: true, version: 2, updated_at: "2026-09-28T01:00:05Z", mirrored: true };
    await setProviderEnabled("a/b", false);
    await setProviderEnabled("adsbdb", true);
    await saveSetting("x/y", 2, "3");
    expect(rec.sends.map((x) => [x.method, x.path, x.body, x.headers])).toEqual([
      ["POST", "/api/v1/ops/providers/a%2Fb/disable", undefined, undefined],
      ["POST", "/api/v1/ops/providers/adsbdb/enable", undefined, undefined],
      ["PUT", "/api/v1/ops/settings/x%2Fy", { value: 2 }, { "If-Match": "3" }],
    ]);
  });
  it("resolutions: POST body from the draft and note, 201 parsed (null when the shape is wrong); DELETE by id", async () => {
    rec.body = { id: 7, kind: "log_group", key: "fp1", upto: "2026-09-28T01:00:00.123456Z", resolved_at: "2026-09-28T01:01:00Z", resolved_by: "op", note: null };
    const r = await createResolution({ kind: "log_group", key: "fp1", upto: "2026-09-28T01:00:00.123456Z" }, "  fixed ");
    expect(r).toMatchObject({ id: 7, key: "fp1", resolved_by: "op" });
    rec.body = { id: "x" };
    expect(await createResolution({ kind: "provider_error", key: "kma", upto: null }, "")).toBeNull();
    rec.body = undefined;
    await revokeResolution(7);
    expect(rec.sends.map((x) => [x.method, x.path, x.body])).toEqual([
      ["POST", "/api/v1/ops/resolutions", { kind: "log_group", key: "fp1", upto: "2026-09-28T01:00:00.123456Z", note: "fixed" }],
      ["POST", "/api/v1/ops/resolutions", { kind: "provider_error", key: "kma" }],
      ["DELETE", "/api/v1/ops/resolutions/7", undefined],
    ]);
  });
});

describe("logs endpoints", () => {
  const AT = Date.parse("2026-09-28T02:00:00Z");
  const entry = { id: "1727480000000-0", ts: "2026-09-28T01:59:00Z", service: "api", level: "ERROR", message: "boom" };
  it("page and groups use lib/logs logsUrl · logGroupsUrl and parse; signal passed through", async () => {
    const ctl = new AbortController();
    rec.body = { items: [entry, { id: "bad" }], next_cursor: null };
    const p = await logsPage(DEFAULT_LOG_FILTER, AT, { limit: 200 }, { signal: ctl.signal });
    expect(p.items.map((e) => e.id)).toEqual(["1727480000000-0"]);
    rec.body = { groups: [] };
    expect((await logGroups(DEFAULT_LOG_FILTER, AT)).groups).toEqual([]);
    expect(paths()).toEqual([logsUrl(DEFAULT_LOG_FILTER, AT, { limit: 200 }), logGroupsUrl(DEFAULT_LOG_FILTER, AT)]);
    expect((rec.calls[0].init as { signal: AbortSignal }).signal).toBe(ctl.signal);
  });
  it("one item: the id is encoded, {item} is unwrapped, a bare entry is read as is, a body of the wrong shape is null", async () => {
    rec.body = { item: entry };
    expect((await logItem("1727480000000-0", "client"))?.message).toBe("boom");
    rec.body = entry;
    expect((await logItem("1727480000000-0", null))?.id).toBe("1727480000000-0");
    rec.body = { item: { id: "nope" } };
    expect(await logItem("a/b", null)).toBeNull();
    expect(paths()).toEqual(["/api/v1/ops/logs/1727480000000-0?stream=client", "/api/v1/ops/logs/1727480000000-0", "/api/v1/ops/logs/a%2Fb"]);
  });
  it("AIS gaps: from as a query value; rows through aisGapRows", async () => {
    rec.body = { to: "2026-09-28T02:00:00Z", items: [] };
    const r = await aisGaps("2026-09-28T01:00:00.000Z");
    expect(paths()).toEqual(["/api/v1/ais/gaps?from=2026-09-28T01%3A00%3A00.000Z"]);
    expect(r).toMatchObject({ rows: [], to: "2026-09-28T02:00:00Z" });
  });
});
