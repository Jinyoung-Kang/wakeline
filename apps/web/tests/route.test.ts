/**
 * 항공기 출발지·도착지(계약 v4 §A) — 검증·대권 경로 거리(계산값)·카드 문구.
 * 공항·항공사 값은 모두 합성(SYNTHETIC)이다 — 실제 노선 자료를 저장소에 넣지 않는다(adsbdb 약관).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  distanceToPathKm, EARTH_RADIUS_KM, fmtAirline, fmtAirportCodes, fmtAirportPlace, fmtRouteKm, parseRoute, parseRouteAirport, ROUTE_ATTRIBUTION,
  ROUTE_CAVEAT, ROUTE_STATUS_TEXT, routeCallsignMismatch, routeDistanceKm, type RouteInfo,
} from "@/lib/route";
import { resetData, setData } from "@/lib/store";
import { AircraftCard, RouteSection } from "@/components/AircraftCard";

/** SYNTHETIC 공항(지어낸 코드·이름·좌표) */
const AP = (over: Record<string, unknown> = {}) => ({
  icao: "ZZAA", iata: "ZAA", name: "Synthetic Alpha Field", city: "Alphaville", country: "Testland", country_iso: "ZZ", lat: 0, lon: 0, ...over,
});
const FOUND = {
  status: "found", callsign: "TST123", source: "adsbdb", fetched_at: "2026-09-28T03:00:00Z",
  airline: { name: "Synthetic Air", icao: "TST", iata: "TS" },
  origin: AP(), destination: AP({ icao: "ZZBB", iata: "ZBB", name: "Synthetic Bravo Intl", city: "Bravo City", lat: 0, lon: 10 }), midpoint: null,
};
const deg = (d: number) => (d * Math.PI / 180) * EARTH_RADIUS_KM;

describe("route validation (server values are not trusted)", () => {
  it("a found route keeps airline, origin, destination and optional midpoint", () => {
    const r = parseRoute({ ...FOUND, midpoint: AP({ icao: "ZZMM", iata: null, name: "Mid", city: null, country: null, country_iso: null, lat: 1, lon: 5 }) })!;
    expect(r.status).toBe("found");
    expect(r.callsign).toBe("TST123");
    expect(r.airline).toEqual({ name: "Synthetic Air", icao: "TST", iata: "TS" });
    expect(r.origin?.icao).toBe("ZZAA");
    expect(r.midpoint).toMatchObject({ icao: "ZZMM", iata: null, city: null, country: null, country_iso: null });
    expect(r.source).toBe("adsbdb");
  });
  it("unknown status or a non-object is not shown at all (null) — never guessed", () => {
    expect(parseRoute({ ...FOUND, status: "maybe" })).toBeNull();
    expect(parseRoute(null)).toBeNull();
    expect(parseRoute("found")).toBeNull();
    expect(parseRoute(undefined)).toBeNull();
  });
  it("airports failing the contract shapes are null; optional fields with a wrong shape become null", () => {
    expect(parseRouteAirport(AP({ icao: "ZZA" }))).toBeNull();
    expect(parseRouteAirport(AP({ icao: "zzaa" }))).toBeNull();
    expect(parseRouteAirport(AP({ lat: 91 }))).toBeNull();
    expect(parseRouteAirport(AP({ lon: "10" }))).toBeNull();
    expect(parseRouteAirport(AP({ name: "   " }))).toBeNull();
    const a = parseRouteAirport(AP({ iata: "ZA", country_iso: "ZZZ", city: "x".repeat(200), name: "Line\nbreak\u0007 Field" }))!;
    expect(a.iata).toBeNull();
    expect(a.country_iso).toBeNull();
    expect(a.city).toHaveLength(80);
    expect(a.name).toBe("Linebreak Field"); // 제어문자 제거
  });
  it("found without any valid airport becomes not_found (same rule as the collector)", () => {
    const r = parseRoute({ ...FOUND, origin: AP({ icao: "bad" }), destination: null })!;
    expect(r.status).toBe("not_found");
    expect(r.origin).toBeNull();
    expect(r.airline).toBeNull();
  });
  it("strings drop Unicode format characters too (bidi overrides, zero-width) and are cut by code points, like the api", () => {
    // U+202E(오른쪽→왼쪽 덮어쓰기)로 이웃 글자를 뒤집어 보이게 하는 이름
    const a = parseRouteAirport(AP({ name: "A\u202Eevil\u202C Field", city: "Zero\u200Bwidth\u2066City\u2069", country: "\uFEFFTestland" }))!;
    expect(a.name).toBe("Aevil Field");
    expect(a.city).toBe("ZerowidthCity");
    expect(a.country).toBe("Testland");
    expect(/[\p{Cc}\p{Cf}]/u.test(a.name + a.city + a.country)).toBe(false);
    const r = parseRoute({ ...FOUND, airline: { name: "Synth\u202EAir", icao: "TST", iata: "TS" } })!;
    expect(r.airline?.name).toBe("SynthAir");
    // 코드포인트 기준 절단: 아스트랄 문자(서러게이트 쌍)를 반으로 자르지 않는다
    const city = parseRouteAirport(AP({ city: "\u{1F6EB}".repeat(100) }))!.city!;
    expect(Array.from(city)).toHaveLength(80);
    expect(city).toBe("\u{1F6EB}".repeat(80));
    expect(parseRouteAirport(AP({ name: "\u202E\u200B" }))).toBeNull(); // 서식 문자뿐이면 이름 없음
  });
  it("non-found statuses carry no airports even if the payload has some; bad callsign / fetched_at are null", () => {
    const r = parseRoute({ ...FOUND, status: "pending", callsign: "tst 1", fetched_at: "yesterday" })!;
    expect(r).toMatchObject({ status: "pending", callsign: null, fetched_at: null, origin: null, destination: null });
  });
});

describe("distance to the great-circle route (computed)", () => {
  it("on the route is 0; 1° off the middle of an equatorial leg is 1° of arc", () => {
    const path = [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }];
    expect(distanceToPathKm(path, { lat: 0, lon: 5 })).toBeCloseTo(0, 6);
    expect(distanceToPathKm(path, { lat: 1, lon: 5 })).toBeCloseTo(deg(1), 3);
    expect(distanceToPathKm(path, { lat: -2, lon: 3 })).toBeCloseTo(deg(2), 3);
  });
  it("beyond either end the distance is to the nearer airport, not to the infinite great circle", () => {
    const path = [{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }];
    expect(distanceToPathKm(path, { lat: 0, lon: 12 })).toBeCloseTo(deg(2), 3);
    expect(distanceToPathKm(path, { lat: 0, lon: -3 })).toBeCloseTo(deg(3), 3);
    // 정반대 쪽(대권 위지만 호 밖)
    expect(distanceToPathKm(path, { lat: 0, lon: 185 - 360 })).toBeCloseTo(deg(175), 1);
  });
  it("a route across the antimeridian uses the short arc", () => {
    const path = [{ lat: 0, lon: 170 }, { lat: 0, lon: -170 }];
    expect(distanceToPathKm(path, { lat: 1, lon: 180 })).toBeCloseTo(deg(1), 3);
    expect(distanceToPathKm(path, { lat: 1, lon: -180 })).toBeCloseTo(deg(1), 3);
  });
  it("the midpoint makes two legs; the nearest leg wins", () => {
    const r = parseRoute({ ...FOUND, midpoint: AP({ icao: "ZZMM", lat: 10, lon: 5 }) })!;
    // 출발(0,0) → 경유(10,5) → 도착(0,10): (0,5) 는 두 다리에서 모두 떨어져 있다
    const viaMid = routeDistanceKm(r, { lat: 0, lon: 5 })!;
    const direct = routeDistanceKm({ ...r, midpoint: null }, { lat: 0, lon: 5 })!;
    expect(direct).toBeCloseTo(0, 6);
    expect(viaMid).toBeGreaterThan(100);
    expect(routeDistanceKm(r, { lat: 10, lon: 5 })).toBeCloseTo(0, 6);
  });
  it("same origin and destination (or antipodes) measure to the airports; unknown inputs give null", () => {
    expect(distanceToPathKm([{ lat: 10, lon: 10 }, { lat: 10, lon: 10 }], { lat: 11, lon: 10 })).toBeCloseTo(deg(1), 3);
    expect(distanceToPathKm([{ lat: 0, lon: 0 }, { lat: 0, lon: 180 }], { lat: 0, lon: 1 })).toBeCloseTo(deg(1), 3);
    expect(distanceToPathKm([{ lat: 0, lon: 0 }], { lat: 0, lon: 1 })).toBeNull();
    expect(distanceToPathKm([{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }], null)).toBeNull();
    expect(distanceToPathKm([{ lat: 0, lon: 0 }, { lat: 0, lon: 10 }], { lat: NaN, lon: 0 })).toBeNull();
    const r = parseRoute(FOUND)!;
    expect(routeDistanceKm({ ...r, destination: null }, { lat: 0, lon: 5 })).toBeNull();
    expect(routeDistanceKm({ ...r, status: "pending" }, { lat: 0, lon: 5 })).toBeNull();
    expect(routeDistanceKm(null, { lat: 0, lon: 5 })).toBeNull();
  });
});

describe("route display helpers", () => {
  it("airport codes/place, airline and km formatting show — for unknown parts", () => {
    const a = parseRouteAirport(AP({ iata: null, city: null }))!;
    expect(fmtAirportCodes(a)).toBe("ZZAA · IATA —");
    expect(fmtAirportPlace(a)).toBe("Synthetic Alpha Field · — · Testland (ZZ)");
    expect(fmtAirline(null)).toBe("—");
    expect(fmtAirline({ name: null, icao: "TST", iata: null })).toBe("TST");
    expect(fmtRouteKm(null)).toBe("—");
    expect(fmtRouteKm(3.456)).toBe("3.5 km");
    expect(fmtRouteKm(1234.4)).toBe("1,234 km");
  });
  it("callsign mismatch only when both are known and differ (trim, upper case)", () => {
    const r = parseRoute(FOUND);
    expect(routeCallsignMismatch(r, " tst123 ")).toBe(false);
    expect(routeCallsignMismatch(r, "TST124")).toBe(true);
    expect(routeCallsignMismatch(r, null)).toBe(false);
    expect(routeCallsignMismatch({ ...r!, callsign: null }, "TST124")).toBe(false);
  });
});

describe("aircraft card route section (server render)", () => {
  beforeEach(() => resetData());
  afterEach(() => resetData());
  const section = (route: RouteInfo | null, pos: { lat: number; lon: number } | null = { lat: 1, lon: 5 }, callsign: string | null = "TST123") =>
    renderToStaticMarkup(createElement(RouteSection, { route, pos, callsign }));

  it("found: airports (ICAO·IATA·name·city·country), airline, computed distance, caveat and attribution", () => {
    const html = section(parseRoute(FOUND));
    expect(html).toContain("노선(콜사인 기준 등록 노선)");
    expect(html).toContain('data-status="found"');
    expect(html).toContain("ZZAA · ZAA");
    expect(html).toContain("Synthetic Alpha Field · Alphaville · Testland (ZZ)");
    expect(html).toContain("ZZBB · ZBB");
    expect(html).toContain("Synthetic Air · TST · TS");
    expect(html).toContain(`${Math.round(deg(1))} km · 계산값`);
    expect(html).toContain("구면 지구");
    expect(html).toContain(ROUTE_CAVEAT);
    expect(html.replace(/<[^>]+>/g, "")).toContain(`출처 ${ROUTE_ATTRIBUTION}`.replace(/&/g, "&amp;"));
    expect(html).toContain('href="https://www.adsbdb.com"');
    expect(html).not.toContain('data-field="경유"'); // 경유가 없으면 줄도 없다
    expect(html).not.toContain("route-callsign-mismatch");
  });
  it("found with a midpoint lists it; unknown position leaves the distance as —", () => {
    const html = section(parseRoute({ ...FOUND, midpoint: AP({ icao: "ZZMM", name: "Synthetic Mid", lat: 1, lon: 5 }) }), null);
    expect(html).toContain('data-field="경유"');
    expect(html).toContain("Synthetic Mid");
    expect(/data-field="경로와의 거리"[^>]*>.*?<span class="text-right"[^>]*>—<\/span>/.test(html)).toBe(true);
  });
  it("every other status has its contract wording and no route values", () => {
    for (const status of ["pending", "not_found", "no_callsign", "unavailable", "disabled"] as const) {
      const html = section(parseRoute({ status, callsign: status === "no_callsign" ? null : "TST123", source: "adsbdb" }));
      expect(html, status).toContain(ROUTE_STATUS_TEXT[status]);
      expect(html, status).toContain(`data-status="${status}"`);
      // 노선 값(거리 계산값 · 공항 행)이 없다 — 조회 중 툴팁의 "보통 경로 계산값" 은 노선 값이 아니다
      expect(html, status).not.toContain("km · 계산값");
      expect(html, status).not.toContain('data-testid="route-row"');
    }
    expect(ROUTE_STATUS_TEXT).toEqual({
      pending: "노선 조회 중", not_found: "이 콜사인의 등록 노선 없음", no_callsign: "콜사인 없음 — 노선을 찾을 수 없음", unavailable: "노선 조회 실패",
      disabled: "노선 조회 꺼짐(운영 설정)",
    });
    expect(section(null)).toContain('data-status="unknown"');
  });
  it("disabled (fixture mode or the operator turned adsbdb off) is an operational setting, not a failure", () => {
    const r = parseRoute({ status: "disabled", callsign: "TST123", source: "adsbdb", origin: AP() })!;
    expect(r).toMatchObject({ status: "disabled", callsign: "TST123", origin: null, destination: null });
    const html = section(r);
    expect(html).toContain("노선 조회 꺼짐(운영 설정)");
    expect(html).toContain('data-status="disabled"');
    expect(html).not.toContain("text-warn");
    expect(html).not.toContain("노선 조회 실패");
  });
  it("a different current callsign is pointed out", () => {
    expect(section(parseRoute(FOUND), { lat: 0, lon: 5 }, "TST999")).toContain("지금 콜사인 TST999 과 다름");
  });
  it("the card uses the WS selected route", () => {
    setData({
      selected: {
        hex: "abc123", received_at: 0, prediction: null, route: parseRoute(FOUND),
        state: { hex: "abc123", lat: 0, lon: 5, callsign: "TST123", seen_at: "2026-09-28T03:00:00Z" },
      },
    });
    const html = renderToStaticMarkup(createElement(AircraftCard, { hex: "abc123" }));
    expect(html).toContain("Synthetic Bravo Intl");
    expect(html).toContain("0.0 km · 계산값");
  });
});
