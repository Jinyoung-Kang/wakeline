import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { aisBadge } from "@/lib/ships";
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
});
