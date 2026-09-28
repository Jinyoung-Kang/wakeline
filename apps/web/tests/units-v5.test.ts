/**
 * 계약 v5 §A — 단위 표기(항공기 고도 m · 지상속도 km/h · 수직속도 m/s, 선박 대지속력 km/h).
 * 변환은 정의된 상수(1 ft = 0.3048 m, 1 kt = 1 kn = 1.852 km/h)로만 — 계산값이지만 추정이 아니다.
 */
import { describe, expect, it } from "vitest";
import {
  altM, fmtAltDual, fmtAltGndDual, fmtGsDual, fmtSogDual, fmtVrateDual, fpmToMs, ftToM, gsKmh, KMH_PER_KT, ktToKmh, M_PER_FT, sogKmh,
} from "@/lib/format";

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
