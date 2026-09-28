/**
 * 계약 v5 §A — 단위 표기(항공기 고도 m · 지상속도 km/h · 수직속도 m/s, 선박 대지속력 km/h).
 * 변환은 정의된 상수(1 ft = 0.3048 m, 1 kt = 1 kn = 1.852 km/h)로만 — 계산값이지만 추정이 아니다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  altM, fmtAltDual, fmtAltGndDual, fmtGsDual, fmtSogDual, fmtVrateDual, fpmToMs, ftToM, gsKmh, KMH_PER_KT, ktToKmh, M_PER_FT, sogKmh,
} from "@/lib/format";
import { aircraftTip, shipTip } from "@/lib/tooltip";
import { fmtCourse } from "@/lib/ships";
import { replayAircraftRows, replayAircraftTip } from "@/lib/replay";
import { aircraftStates, resetData, setData } from "@/lib/store";
import { AircraftCard } from "@/components/AircraftCard";
import { AlertPanel } from "@/components/AlertPanel";
import { EvidenceCard } from "@/components/EvidenceCard";
import { InsideAircraftList } from "@/components/SigmetCard";
import { ShipCard } from "@/components/ShipCard";
import { AltStack, SogStack } from "@/components/UnitStack";
import type { Alert, PublicStatus } from "@/lib/types";

describe("unit conversions (contract v5 §A1) — defined constants only", () => {
  it("constants are the exact definitions", () => {
    expect(M_PER_FT).toBe(0.3048);
    expect(KMH_PER_KT).toBe(1.852);
    expect(ftToM(1)).toBe(0.3048);
    expect(ftToM(10000)).toBeCloseTo(3048, 9);
    expect(ktToKmh(1)).toBe(1.852);
    expect(ktToKmh(100)).toBeCloseTo(185.2, 9);
    expect(fpmToMs(60)).toBeCloseTo(0.3048, 12);
    expect(fpmToMs(1000)).toBeCloseTo(5.08, 12);
  });
  it("boundaries: 0, negative, null / undefined / non-finite", () => {
    expect(ftToM(0)).toBe(0);
    expect(ftToM(-1000)).toBeCloseTo(-304.8, 9);
    expect(ktToKmh(0)).toBe(0);
    expect(fpmToMs(-600)).toBeCloseTo(-3.048, 12);
    for (const f of [ftToM, ktToKmh, fpmToMs]) {
      expect(f(null)).toBeNull();
      expect(f(undefined)).toBeNull();
      expect(f(Number.NaN)).toBeNull();
      expect(f(Number.POSITIVE_INFINITY)).toBeNull();
    }
  });
});

describe("dual-unit strings (contract v5 §A1)", () => {
  it("altitude: FL above 18,000 ft, ft below, metres rounded to an integer with en-US separators", () => {
    expect(fmtAltDual(34000)).toBe("FL340 · 10,363 m");
    expect(fmtAltDual(12000)).toBe("12,000 ft · 3,658 m");
    expect(fmtAltDual(17999)).toBe("17,999 ft · 5,486 m"); // FL 전환 직전
    expect(fmtAltDual(18000)).toBe("FL180 · 5,486 m"); // FL 전환
    expect(fmtAltDual(0)).toBe("0 ft · 0 m");
    expect(fmtAltDual(-500)).toBe("-500 ft · -152 m");
    expect(fmtAltDual(-1)).toBe("-1 ft · 0 m"); // -0.3 m → 0(음의 0 표기 없음)
    expect(fmtAltDual(null)).toBe("—");
    expect(fmtAltDual(undefined)).toBe("—");
    expect(altM(34000)).toBe("10,363 m");
    expect(altM(null)).toBe("—");
  });
  it("altitude on the ground: GND, or the reported baro altitude in both units", () => {
    expect(fmtAltGndDual(0, true)).toBe("GND");
    expect(fmtAltGndDual(null, true)).toBe("GND");
    expect(fmtAltGndDual(1200, true)).toBe("GND (1,200 ft · 366 m 보고)");
    expect(fmtAltGndDual(0, false)).toBe("0 ft · 0 m");
    expect(fmtAltGndDual(35000, null)).toBe("FL350 · 10,668 m");
    expect(fmtAltGndDual(null, undefined)).toBe("—");
  });
  it("ground speed: integer kt and km/h", () => {
    expect(fmtGsDual(460)).toBe("460 kt · 852 km/h");
    expect(fmtGsDual(0)).toBe("0 kt · 0 km/h");
    expect(fmtGsDual(459.6)).toBe("460 kt · 851 km/h"); // km/h 는 보고값에서 바로 계산(반올림한 kt 에서가 아니다)
    expect(fmtGsDual(1200)).toBe("1,200 kt · 2,222 km/h");
    expect(fmtGsDual(null)).toBe("—");
    expect(gsKmh(460)).toBe("852 km/h");
    expect(gsKmh(null)).toBe("—");
  });
  it("vertical speed: signed ft/min and m/s (1 decimal); 0 has no sign", () => {
    expect(fmtVrateDual(1216)).toBe("+1,216 ft/min · +6.2 m/s");
    expect(fmtVrateDual(-1216)).toBe("-1,216 ft/min · -6.2 m/s");
    expect(fmtVrateDual(0)).toBe("0 ft/min · 0.0 m/s");
    expect(fmtVrateDual(64)).toBe("+64 ft/min · +0.3 m/s");
    expect(fmtVrateDual(5)).toBe("+5 ft/min · 0.0 m/s"); // 0.0254 m/s → 0.0 은 부호 없음
    expect(fmtVrateDual(0.4)).toBe("0 ft/min · 0.0 m/s");
    expect(fmtVrateDual(null)).toBe("—");
  });
  it("ship speed over ground: 1 decimal in both units", () => {
    expect(fmtSogDual(12.3)).toBe("12.3 kn · 22.8 km/h");
    expect(fmtSogDual(0)).toBe("0.0 kn · 0.0 km/h");
    expect(fmtSogDual(102.2)).toBe("102.2 kn · 189.3 km/h"); // 102.3 = 값 없음(수집·검증에서 null)
    expect(fmtSogDual(null)).toBe("—");
    expect(sogKmh(12.3)).toBe("22.8 km/h");
    expect(sogKmh(undefined)).toBe("—");
  });
});

// ---------------------------------------------------------------- §A2 각 표시 위치(서버 렌더 · 순수 함수)

const T0 = Date.parse("2026-09-28T03:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
const OBS = { hex: "71c081", callsign: "KAL081", lat: 36.5, lon: 127.8, alt_ft: 34000, gs_kt: 460, vrate_fpm: 1216, track_deg: 90, seen_at: iso(T0 - 5_000), provider: "adsb_fi" };
const alertOf = (over: Partial<Alert> = {}): Alert => ({
  id: 1, kind: "OBSERVED", hex: "71c081", callsign: "KAL081", sigmet_id: "S1", fir_id: "RKRR", hazard: "TS", entered_at: iso(T0 - 60_000),
  alt_ft: 35000, evidence: { position: [36.5, 127.8], judged_at: iso(T0 - 60_000), gs_kt: 460, track_deg: 90 }, estimated: false, ...over,
} as Alert);

describe("dual units at every display site (contract v5 §A2)", () => {
  beforeEach(() => resetData());
  afterEach(() => resetData());

  it("aircraft card: altitude, ground speed and vertical speed in both units; GND rule kept", () => {
    setData({ selected: { hex: "71c081", state: OBS, prediction: null, received_at: 0 } });
    const t = text(renderToStaticMarkup(createElement(AircraftCard, { hex: "71c081" })));
    expect(t).toContain("고도FL340 · 10,363 m");
    expect(t).toContain("지상속도460 kt · 852 km/h");
    expect(t).toContain("수직속도+1,216 ft/min · +6.2 m/s");
    setData({ selected: { hex: "71c081", state: { ...OBS, alt_ft: 1200, on_ground: true, vrate_fpm: null, gs_kt: null }, prediction: null, received_at: 0 } });
    const g = text(renderToStaticMarkup(createElement(AircraftCard, { hex: "71c081" })));
    expect(g).toContain("고도GND (1,200 ft · 366 m 보고)");
    expect(g).toContain("지상속도—");
    expect(g).toContain("수직속도—");
  });

  it("map tooltip: observed altitude and speed in both units; an altitude taken from the extrapolated render is labelled as an estimate", () => {
    const t = aircraftTip({ hex: "71c081", estimated: true }, OBS, T0);
    expect(Object.fromEntries(t.rows)).toMatchObject({ ALT: "FL340 · 10,363 m", GS: "460 kt · 852 km/h", VS: "+1,216 ft/min · +6.2 m/s" });
    // 원본 상태가 없어 지도 렌더(dead reckoning — 수직속도로 외삽했을 수 있음)의 고도를 쓸 때는 추정이라고 적는다
    const r = aircraftTip({ hex: "71c081", alt_ft: 35200, estimated: true }, null, T0);
    expect(Object.fromEntries(r.rows).ALT).toBe("FL352 · 10,729 m (추정)");
    expect(Object.fromEntries(aircraftTip({ hex: "71c081", alt_ft: 35200, estimated: false }, null, T0).rows).ALT).toBe("FL352 · 10,729 m");
    expect(Object.fromEntries(aircraftTip({ hex: "71c081", alt_ft: null, estimated: true }, null, T0).rows).ALT).toBe("—");
  });

  it("alert list: the narrow altitude column puts metres on a small grey second line; predicted altitude stays marked as an estimate", () => {
    const pred = alertOf({ id: 2, kind: "PREDICTED", hex: "71c082", callsign: "KAL082", alt_ft: 35000, eta_s: 120, eta_at: iso(T0 + 120_000), estimated: true });
    setData({ conn: "open", alertsVersion: 1, status: { server_time: iso(T0), region: { center: [36.5, 127.8], radius_nm: 300 } } as unknown as PublicStatus, alerts: new Map([[1, alertOf()], [2, pred]]) });
    const html = renderToStaticMarkup(createElement(AlertPanel));
    expect(html).toMatch(/title="관측 고도"[^>]*>.*?FL350.*?<span class="[^"]*text-fg-3[^"]*"[^>]*>10,668 m<\/span>/);
    expect(html).toMatch(/data-testid="alert-alt-est"[^>]*>.*?FL350.*?<span class="[^"]*est-val[^"]*"[^>]*>10,668 m<\/span>/);
  });

  it("evidence card: aircraft / predicted altitude and the judged ground speed in both units", () => {
    const obs = text(renderToStaticMarkup(createElement(EvidenceCard, { a: alertOf() })));
    expect(obs).toContain("항공기 고도FL350 · 10,668 m");
    const pred = text(renderToStaticMarkup(createElement(EvidenceCard, { a: alertOf({ kind: "PREDICTED", estimated: true, eta_s: 60 }) })));
    expect(pred).toContain("진입 시 고도(추정)FL350 · 10,668 m");
    expect(pred).toContain("판정 입력460 kt · 852 km/h · 90°");
  });

  it("SIGMET card aircraft list: altitude with metres under it (alert → live state → —)", async () => {
    setData({ alerts: new Map([[1, alertOf({ sigmet_id: "S1", hex: "780f47", callsign: "CCA402", alt_ft: 27600 })]]) });
    aircraftStates.set("7823a9", { hex: "7823a9", lat: 31, lon: 121, callsign: "CES501", alt_ft: 1200, on_ground: true });
    const html = renderToStaticMarkup(createElement(InsideAircraftList, { sigmetId: "S1", hexes: ["780f47", "7823a9", "abcdef"] }));
    expect(html).toMatch(/data-hex="780f47"[^>]*>.*?FL276.*?8,412 m/);
    expect(html).toMatch(/aria-label="CCA402, 780f47, 고도 FL276 · 8,412 m, 관측 알림"/);
    expect(html).toMatch(/data-hex="7823a9"[^>]*>.*?>GND<\/span><span class="[^"]*text-fg-3[^"]*">1,200 ft · 366 m 보고<\/span>/);
    expect(html).toContain('aria-label="CES501, 7823a9, 고도 GND (1,200 ft · 366 m 보고), 실시간"');
  });

  it("narrow-column stacks: primary unit then a small grey metric line; unknown is a single —", () => {
    const alt = renderToStaticMarkup(createElement(AltStack, { ft: 34000 }));
    expect(alt).toMatch(/>FL340<\/span><span class="[^"]*text-\[10px\][^"]*text-fg-3[^"]*">10,363 m<\/span>/);
    expect(text(renderToStaticMarkup(createElement(AltStack, { ft: null })))).toBe("—");
    expect(text(renderToStaticMarkup(createElement(AltStack, { ft: 0, onGround: true })))).toBe("GND");
    expect(text(renderToStaticMarkup(createElement(AltStack, { ft: 1200, onGround: true })))).toBe("GND1,200 ft · 366 m 보고");
    expect(text(renderToStaticMarkup(createElement(SogStack, { kn: 12.3 })))).toBe("12.3 kn22.8 km/h");
    expect(text(renderToStaticMarkup(createElement(SogStack, { kn: null })))).toBe("—");
  });

  it("replay inspector rows and tooltip: altitude and ground speed in both units (1-minute summary rows keep their label)", () => {
    const rec = { hex: "71c081", ts: iso(T0 - 5_000), lat: 36, lon: 127, alt_ft: 34000, gs_kt: 460, track_deg: 90, on_ground: false, provider: "adsb_fi" };
    const rows = Object.fromEntries(replayAircraftRows(rec, iso(T0)));
    expect(rows).toMatchObject({ 고도: "FL340 · 10,363 m", 지상속도: "460 kt · 852 km/h", 방위: "90°" });
    const sum = Object.fromEntries(replayAircraftRows({ ...rec, provider: "1m_summary", track_deg: null }, iso(T0)));
    expect(sum).toMatchObject({ "고도(1분 평균)": "FL340 · 10,363 m", "지상속도(1분 평균)": "460 kt · 852 km/h" });
    const tip = Object.fromEntries(replayAircraftTip(rec, iso(T0)).rows);
    expect(tip).toMatchObject({ ALT: "FL340 · 10,363 m", GS: "460 kt · 852 km/h" });
  });

  it("ship speed: card, tooltip (course/heading on their own line or row)", () => {
    const st = { mmsi: "431011305", lat: 35, lon: 129, sog_kn: 12.3, cog_deg: 123.4, heading_deg: 120, ship_type: 70, name: "ALPHA", seen_at: iso(T0 - 60_000), position_source: null, nav_status: 0 };
    setData({ shipSelected: { mmsi: "431011305", received_at: 0, static: null, state: { ...st, rot: null, provider: "fixture", msg_type: "PositionReport", class: "A" } } });
    const html = renderToStaticMarkup(createElement(ShipCard, { mmsi: "431011305" }));
    expect(text(html)).toContain("속력/침로/선수방위12.3 kn · 22.8 km/h침로 123.4° · 선수방위 120°");
    const tip = Object.fromEntries(shipTip(st, T0).rows);
    expect(tip).toMatchObject({ SOG: "12.3 kn · 22.8 km/h", "COG/HDG": "123.4° / 120°" });
    expect(Object.fromEntries(shipTip({ ...st, sog_kn: null, cog_deg: null }, T0).rows)).toMatchObject({ SOG: "—", "COG/HDG": "— / 120°" });
    expect(fmtCourse({ cog_deg: null, heading_deg: 33 })).toBe("— / 33°");
  });
});
