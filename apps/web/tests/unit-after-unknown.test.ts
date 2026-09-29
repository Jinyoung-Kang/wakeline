import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { aisBadge } from "@/lib/ships";
import { fmtTempPair, fmtWind } from "@/lib/format";
import { resetData } from "@/lib/store";
import { StatusBar } from "@/components/StatusBar";

/**
 * 모르는 값 뒤에 단위를 붙이지 않는다("— ms" · "— frames" 는 잰 값처럼 읽힌다) — /ops · /logs 에서 고친 규칙(계약 v5 §G10)을
 * 상황판 상태 바 · AIS 배지에도. 단위(또는 이름)를 앞에 두고 값이 "—" 이다.
 */
const UNIT_AFTER_DASH = /—\s*(ms|polys|frames|active|msg\/s)\b/;

describe("no unit after an unknown value", () => {
  afterEach(() => resetData());
  it("status bar before any status arrives", () => {
    resetData();
    const html = renderToStaticMarkup(createElement(StatusBar)).replace(/<[^>]+>/g, " ");
    expect(html).not.toMatch(UNIT_AFTER_DASH);
  });
  it("AIS badge without a message rate", () => {
    const b = aisBadge({ connected: true, state: "connected", lag_s: 3, msgs_per_s: null, received_at: 1_000 } as never, 1_000, true);
    expect(b?.text ?? "").not.toMatch(UNIT_AFTER_DASH);
    expect(b?.text).toContain("msg/s —");
  });
  it("airport wind and temperature: a known part keeps its unit, an unknown part is — alone (was \"—° — kt\" · \"— / — °C\")", () => {
    expect(fmtWind(270, 10)).toBe("270° 10 kt");
    expect(fmtWind(0, 0)).toBe("0° 0 kt");
    expect(fmtWind(null, 10)).toBe("— 10 kt");
    expect(fmtWind(270, null)).toBe("270° —");
    expect(fmtWind(null, undefined)).toBe("—");
    expect(fmtTempPair(18, 12)).toBe("18 °C / 12 °C");
    expect(fmtTempPair(18, null)).toBe("18 °C / —");
    expect(fmtTempPair(null, -3)).toBe("— / -3 °C");
    expect(fmtTempPair(undefined, null)).toBe("—");
  });
});
