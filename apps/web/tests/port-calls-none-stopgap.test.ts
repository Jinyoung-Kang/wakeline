import { describe, expect, it } from "vitest";
import { portCallStatusText } from "@/lib/portcalls";

/**
 * 해양수산부 PORT-MIS 의 호출부호(clsgn) 조회가 동작하지 않는다(2026-09-29 확인 — docs/review/evidence/public-data-apis-2026-09-29.txt):
 * 입출항 기록이 있는 선박도 'none' 이 온다. 색인 방식으로 바꿀 때까지 'none' 을 "기록 없음"으로 보이지 않는다.
 */
describe("port calls — no definite 'no records' while the lookup cannot filter", () => {
  it("none is not shown as 기록 없음", () => {
    const t = portCallStatusText({ status: "none", call_sign: "V7A3884", window_days: 30 } as never);
    expect(t).not.toContain("기록 없음");
    expect(t).toContain("호출부호 조회");
  });
});
