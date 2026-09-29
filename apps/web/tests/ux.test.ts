import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ageS, ALT_RAMP, CAT_COLORS, catSourceLabel, ceilingLabel, fmtDuration, HAZARD_COLORS, HAZARD_DEFAULT_COLOR, HAZARD_LEGEND,
  hazardColor, isMetarStale, metarAgeS,
} from "@/lib/format";
import { fmtDual, fmtDualClock } from "@/lib/time";
import { ALT_COLOR_EXPR, AIRPORT_FILL_EXPR, coverageTileUrl, frameDisplay, HAZARD_COLOR_EXPR } from "@/lib/maplayers";
import { attributionText, CREDITS, mapAttributionHtml, styleHasBasemapCredit } from "@/lib/attribution";
import { isTypingTarget, moveActive, normalizeQuery, parseSearchResponse } from "@/lib/search";
import { aircraftTip, airportTip, renderTip, sigmetTip } from "@/lib/tooltip";
import { chartSummary, hourlyRows } from "@/lib/chart";
import { radarTimeMs, replayAircraftTip, replayRadarLabel } from "@/lib/replay";
import type { SigmetProps } from "@/lib/types";

const NOW = Date.parse("2026-09-27T09:00:00Z");

describe("timestamps carry the date (GAP-26)", () => {
  it("times carry the date (KST first with UTC — 사용자 요청 2026-09-29); the clock form is time only; unknown is —", () => {
    expect(fmtDual("2026-09-27T08:44:33.912Z")).toBe("09-27 17:44:33 KST · 08:44:33 UTC");
    expect(fmtDual("2026-09-26T23:59:59Z")).toBe("09-27 08:59:59 KST · 09-26 23:59:59 UTC"); // UTC 로는 전날 — UTC 쪽에 그 날짜
    expect(fmtDual(Date.parse("2026-09-27T08:44:33Z"))).toBe("09-27 17:44:33 KST · 08:44:33 UTC");
    expect(fmtDualClock("2026-09-27T08:44:33Z")).toBe("17:44:33 KST · 08:44:33 UTC");
    expect(fmtDual(null)).toBe("—");
    expect(fmtDual("garbage")).toBe("—");
    expect(fmtDual("")).toBe("—");
  });
  it("durations are compact and never negative", () => {
    expect(fmtDuration(42)).toBe("42s");
    expect(fmtDuration(185)).toBe("3m 05s");
    expect(fmtDuration(4320)).toBe("1h 12m");
    expect(fmtDuration(2 * 86400 + 3 * 3600)).toBe("2d 03h");
    expect(fmtDuration(null)).toBe("—");
    expect(ageS("2026-09-27T08:59:00Z", NOW)).toBe(60);
    expect(ageS(null, NOW)).toBeNull();
  });
});

describe("METAR honesty (GAP-14 / GAP-16)", () => {
  it("'실링 없음' only for ceiling_state=none; unknown is —; never '없음' from a null value", () => {
    expect(ceilingLabel("none", null)).toBe("실링 없음");
    expect(ceilingLabel("unknown", null)).toBe("—");
    expect(ceilingLabel("measured", 1200)).toBe("1,200 ft");
    expect(ceilingLabel(undefined, null)).toBe("—"); // 구 응답: 모름
    expect(ceilingLabel(undefined, 800)).toBe("800 ft");
  });
  it("category source: unknown category is '판정 불가', never '계산'", () => {
    expect(catSourceLabel("awc", "VFR")).toContain("AWC");
    expect(catSourceLabel("computed", "IFR")).toContain("계산");
    expect(catSourceLabel(null, null)).toContain("판정 불가");
    expect(catSourceLabel(null, null)).not.toContain("계산으로");
  });
  it("stale after 2 h, computed from obs_time; falls back to server obs_age_s / stale", () => {
    expect(isMetarStale({ obs_time: "2026-09-27T07:00:00Z" }, NOW)).toBe(false); // 정확히 2 h
    expect(isMetarStale({ obs_time: "2026-09-27T06:59:00Z" }, NOW)).toBe(true);
    expect(isMetarStale({ obs_age_s: 7300 }, NOW)).toBe(true);
    expect(isMetarStale({ stale: true }, NOW)).toBe(true);
    expect(isMetarStale({}, NOW)).toBe(false);
    expect(metarAgeS({ obs_time: "2026-09-27T08:30:00Z", obs_age_s: 99999 }, NOW)).toBe(1800); // 실데이터 필드 우선
  });
});

describe("map encodings match the legend (GAP-13)", () => {
  it("hazard colour expression is built from the shared table; TC and IFR differ", () => {
    const expr = HAZARD_COLOR_EXPR as unknown as unknown[];
    for (const [k, c] of Object.entries(HAZARD_COLORS)) {
      const i = expr.indexOf(k);
      expect(i).toBeGreaterThan(1);
      expect(expr[i + 1]).toBe(c);
    }
    expect(expr[expr.length - 1]).toBe(HAZARD_DEFAULT_COLOR);
    expect(HAZARD_COLORS.TC).not.toBe(HAZARD_COLORS.IFR);
    expect(hazardColor("XYZ")).toBe(HAZARD_DEFAULT_COLOR);
    for (const h of HAZARD_LEGEND) expect(h.color).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("altitude ramp is shared and unknown altitude is not painted as 0 ft", () => {
    const json = JSON.stringify(ALT_COLOR_EXPR);
    expect(json).toContain(JSON.stringify(ALT_RAMP.flat()).slice(1, -1));
    expect(json).toContain('"typeof"');
    expect(json).not.toContain('"coalesce"');
  });
  it("airport fill: stale METAR overrides the category colour", () => {
    const e = AIRPORT_FILL_EXPR as unknown as unknown[];
    expect(e[0]).toBe("case");
    expect(JSON.stringify(e[1])).toContain("stale");
    for (const c of Object.values(CAT_COLORS)) expect(JSON.stringify(e)).toContain(c);
  });
});

describe("radar frame visibility (PERF-12)", () => {
  it("only the current frame is shown when not playing", () => {
    expect([...frameDisplay(13, null, true, false)]).toEqual([[12, "current"]]);
    expect([...frameDisplay(13, 4, true, false)]).toEqual([[4, "current"]]);
  });
  it("radar off or no frames → nothing is used", () => {
    expect(frameDisplay(13, 4, false, true).size).toBe(0);
    expect(frameDisplay(0, null, true, true).size).toBe(0);
  });
  it("while playing: previous (fade-out) + current + 2 preloaded, wrapping", () => {
    const d = frameDisplay(13, 12, true, true);
    expect(d.get(12)).toBe("current");
    expect(d.get(11)).toBe("preload");
    expect(d.get(0)).toBe("preload");
    expect(d.get(1)).toBe("preload");
    expect(d.size).toBe(4);
    expect([...frameDisplay(1, 0, true, true)]).toEqual([[0, "current"]]);
  });
  it("coverage tile template follows the documented RainViewer path", () => {
    expect(coverageTileUrl("https://tilecache.rainviewer.com")).toBe("https://tilecache.rainviewer.com/v2/coverage/0/512/{z}/{x}/{y}/0/0_0.png");
  });
});

describe("attribution (GAP-11)", () => {
  const required = ["adsb.lol", "ODbL", "adsb.fi", "OpenSky Network", "AviationWeather.gov", "RainViewer", "기상청 API허브", "OpenFreeMap", "OpenMapTiles", "OpenStreetMap"];
  it("the footer text and the on-map credit name every source", () => {
    const text = attributionText();
    const html = mapAttributionHtml();
    for (const r of required) { expect(text).toContain(r); expect(html).toContain(r); }
    for (const c of CREDITS) expect(c.href).toMatch(/^https:\/\//);
  });
  it("basemap credits are not duplicated when the style already carries them", () => {
    const html = mapAttributionHtml({ includeMap: false, extra: "Replay <x>" });
    expect(html).not.toContain("OpenMapTiles");
    expect(html).toContain("OpenSky Network");
    expect(html).toContain("Replay &lt;x&gt;");
    expect(styleHasBasemapCredit(['<a href="https://openfreemap.org">OpenFreeMap</a> © OpenMapTiles Data from OpenStreetMap', undefined])).toBe(true);
    expect(styleHasBasemapCredit([undefined, "RainViewer"])).toBe(false);
  });
});

describe("aircraft search (GAP-12)", () => {
  it("normalizes queries like the server (2..10 chars, alnum/-)", () => {
    expect(normalizeQuery(" kal 081 ")).toBe("KAL081");
    expect(normalizeQuery("k")).toBeNull();
    expect(normalizeQuery("abcdefghijk")).toBeNull();
    expect(normalizeQuery("KAL%27")).toBeNull();
    expect(normalizeQuery("HL-8081")).toBe("HL-8081");
  });
  it("parses live and DB rows, de-duplicates by hex, keeps unknowns null", () => {
    const hits = parseSearchResponse({ items: [
      { hex: "71C081", callsign: "KAL081 ", lat: 36.9, lon: 126.9, alt_ft: 34000, on_ground: false, seen_at: "2026-09-27T08:59:50Z", provider: "adsb_fi" },
      { hex: "71c081", registration: "HL8081", last_seen: "2026-09-26T10:00:00Z" },
      { hex: "71d002", registration: "HL8002", type_code: "B738", last_seen: "2026-09-26T10:00:00Z" },
      { hex: "zzz", callsign: "BAD" },
      null,
    ] });
    expect(hits.map((h) => h.hex)).toEqual(["71c081", "71d002"]);
    expect(hits[0]).toMatchObject({ callsign: "KAL081", live: true, lat: 36.9, lon: 126.9, alt_ft: 34000, registration: null, on_ground: false });
    expect(hits[1]).toMatchObject({ callsign: null, live: false, lat: null, lon: null, alt_ft: null, on_ground: null, registration: "HL8002", last_seen: "2026-09-26T10:00:00Z" });
    expect(parseSearchResponse({})).toEqual([]);
    expect(parseSearchResponse({ items: Array.from({ length: 30 }, (_, i) => ({ hex: (0x100000 + i).toString(16) })) })).toHaveLength(20);
  });
  it("keyboard movement wraps; typing targets are not hijacked by '/'", () => {
    expect(moveActive(-1, 1, 3)).toBe(0);
    expect(moveActive(-1, -1, 3)).toBe(2);
    expect(moveActive(2, 1, 3)).toBe(0);
    expect(moveActive(0, -1, 3)).toBe(2);
    expect(moveActive(0, 1, 0)).toBe(-1);
    expect(isTypingTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("hover tooltips (GAP-26)", () => {
  it("aircraft: observed values, age from seen_at, unknowns as —", () => {
    const t = aircraftTip({ hex: "71c081", callsign: "KAL081", stale: false, estimated: true }, { hex: "71c081", callsign: "KAL081", lat: 1, lon: 1, alt_ft: 34000, gs_kt: 460, seen_at: "2026-09-27T08:59:48Z", provider: "adsb_fi" }, NOW);
    expect(t.title).toBe("KAL081");
    expect(Object.fromEntries(t.rows)).toMatchObject({ ALT: "FL340 · 10,363 m", GS: "460 kt · 852 km/h", TRK: "—", AGE: "12s", SRC: "adsb_fi" });
    expect(t.flags.map((f) => f.text)).toContain("위치 추정(dead reckoning)");
    const u = aircraftTip({ hex: "abc123", stale: true }, { hex: "abc123", lat: 1, lon: 1, seen_at: "2026-09-27T08:57:00Z" }, NOW);
    expect(u.title).toBe("—");
    expect(Object.fromEntries(u.rows)).toMatchObject({ ALT: "—", GS: "—", AGE: "3m 00s", SRC: "—" });
    expect(u.flags[0].text).toContain("수신 지연");
    const n = aircraftTip({ hex: "abc123" }, null, NOW);
    expect(n.flags.map((f) => f.text)).toContain("수신 경과 모름");
  });
  it("SIGMET: band with assumption labels, expiring / expired flags", () => {
    const p = { id: "S", fir_id: "RKRR", series_id: "FX1", hazard: "TS", qualifier: "EMBD", base_ft: 0, top_ft: null, base_source: "assumed_surface", top_source: "unknown",
      valid_from: "2026-09-27T08:00:00Z", valid_to: "2026-09-27T09:20:00Z", active: true, expiring_soon: true, raw_text: "", provider: "awc", fetched_at: "" } as SigmetProps;
    const t = sigmetTip(p, NOW);
    expect(t.title).toBe("TS EMBD");
    expect(Object.fromEntries(t.rows).BAND).toBe("하한 미발표(SFC 가정) – 상한 미발표(무제한 가정)");
    expect(Object.fromEntries(t.rows).LEFT).toBe("20m 00s");
    expect(t.flags.map((f) => f.text)).toContain("30분 내 만료");
    expect(sigmetTip({ ...p, valid_to: "2026-09-27T08:59:00Z" }, NOW).flags[0].text).toBe("만료됨");
  });
  it("airport: category, METAR age, stale, ceiling state", () => {
    const t = airportTip({ icao: "RKSI", flight_cat: "VFR", flight_cat_source: "awc", obs_time: "2026-09-27T06:00:00Z", ceiling_state: "none" }, NOW);
    expect(Object.fromEntries(t.rows)).toMatchObject({ CAT: "VFR · AWC 제공", METAR: "09-27 15:00 KST · 06:00Z · 3h 00m 전", CEIL: "실링 없음" });
    expect(t.flags.map((f) => f.text)).toContain("오래됨 · 2시간 초과");
    const none = airportTip({ icao: "RKXX" }, NOW);
    expect(Object.fromEntries(none.rows)).toMatchObject({ CAT: "—", METAR: "—", CEIL: "—" });
    expect(none.flags[0].text).toBe("METAR 없음");
  });
  it("renders with text nodes only (no HTML interpretation)", () => {
    type El = { className: string; textContent: string; children: El[]; appendChild: (c: El) => void; append: (...c: El[]) => void; innerHTML?: string };
    const mk = (): El => { const e: El = { className: "", textContent: "", children: [], appendChild: (c) => { e.children.push(c); }, append: (...c) => { e.children.push(...c); } }; return e; };
    const doc = { createElement: () => mk() } as unknown as Document;
    const el = renderTip({ title: "<img src=x onerror=alert(1)>", rows: [["K", "<b>v</b>"]], flags: [{ text: "<i>", tone: "warn" }] }, doc) as unknown as El;
    const all: El[] = [];
    const walk = (e: El) => { all.push(e); e.children.forEach(walk); };
    walk(el);
    expect(all.some((e) => e.textContent === "<img src=x onerror=alert(1)>")).toBe(true);
    expect(all.every((e) => e.innerHTML === undefined)).toBe(true);
  });
});

describe("charts and replay (GAP-17 / GAP-19 / GAP-25)", () => {
  it("missing hours are null (no data), not 0", () => {
    const rows = hourlyRows([{ hour: "03", value: 12 }, { dim: "4", value: "7" }, { dim: "xx", value: 1 }]);
    expect(rows).toHaveLength(24);
    expect(rows[3]).toEqual({ label: "03", value: 12 });
    expect(rows[4]).toEqual({ label: "04", value: 7 });
    expect(rows[0].value).toBeNull();
    expect(chartSummary(rows)).toBe("24개 항목 · 최댓값 03 12 · 자료 없음 22개");
    expect(chartSummary([{ label: "a", value: null }])).toContain("모두 자료 없음");
  });
  it("replay radar label uses the returned frame, or says there is none", () => {
    expect(radarTimeMs(1790506200)).toBe(1790506200_000);
    expect(radarTimeMs("2026-09-27T08:40:00Z")).toBe(Date.parse("2026-09-27T08:40:00Z"));
    expect(replayRadarLabel({ at: "2026-09-27T08:44:00Z", radar: { host: "h", path: "/p", time: "2026-09-27T08:40:00Z" } })).toBe("레이더 09-27 17:40:00 KST (재생 시각 −4분)");
    expect(replayRadarLabel({ at: "2026-09-27T08:44:00Z", radar: null })).toContain("레이더 이력 없음");
  });
  it("replay aircraft without a recorded callsign shows the hex as the title, not in the callsign slot", () => {
    const t = replayAircraftTip({ hex: "71c081", lat: 1, lon: 1, alt_ft: null, ts: "2026-09-27T08:43:30Z", provider: "adsb_fi" }, "2026-09-27T08:44:00Z");
    expect(t.title).toBe("71c081");
    expect(t.subtitle).toBeUndefined();
    expect(Object.fromEntries(t.rows)).toMatchObject({ ALT: "—", GS: "—", REC: "09-27 17:43:30 KST (재생 시각 −30s)" });
  });
});

describe("WCAG AA contrast of theme text colours (GAP-25)", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const token = (name: string) => { const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css); if (!m) throw new Error(name); return m[1]; };
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  it.each(["fg", "fg-2", "fg-3", "accent", "ok", "warn", "bad", "est"])("%s ≥ 4.5:1 on every panel background", (fg) => {
    for (const bg of ["bg", "bg-1", "bg-2"]) expect(ratio(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
  });
});
