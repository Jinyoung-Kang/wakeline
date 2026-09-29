/**
 * 상황판(지도 · 카드 · 상태 바 · 툴팁)도 한국 표준시(KST, UTC+09:00)로(사용자 요청 2026-09-29 "상황판도 KST로 바꿔").
 * - 머리글이 없는 자리는 " KST" 를 붙이고, 구간은 끝에 한 번("08:40–08:45 KST"). 원본 UTC ISO 는 title 에("원본 UTC …Z").
 * - 원문 전문(METAR · TAF · SIGMET raw)은 발표된 그대로 — 안의 "…Z" 시각을 바꾸지 않는다.
 * - 모르면 "—" 만(시간대 글자도 붙이지 않는다).
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { describe, expect, it } from "vitest";
import * as F from "@/lib/format";

/** UTC 자정 직전 — KST 로는 다음 날 아침 */
const LATE = "2026-09-28T23:41:14.906Z";

describe("dashboard KST formatters (lib/format)", () => {
  it("minute form for radar frames: MM-DD HH:MM KST, across the KST date change", () => {
    expect(F.fmtMinuteKst(LATE)).toBe("09-29 08:41 KST");
    expect(F.fmtMinuteKst("2026-09-28T14:59:00Z")).toBe("09-28 23:59 KST");
    expect(F.fmtMinuteKst("2026-09-28T15:00:00Z")).toBe("09-29 00:00 KST");
    expect(F.fmtMinuteKst(Date.parse("2026-09-28T15:00:00Z"))).toBe("09-29 00:00 KST");
  });
  it("HH:MM without the zone (for spans that name KST once at the end); unknown → null", () => {
    expect(F.hmKst(LATE)).toBe("08:41");
    expect(F.hmKst(Date.parse("2026-09-28T15:05:00Z"))).toBe("00:05");
    for (const v of [null, undefined, "", "bad", Number.NaN]) expect(F.hmKst(v)).toBeNull();
  });
  it("ranges name KST once; an unknown end is — on its side only; an open end can say so", () => {
    expect(F.fmtRangeKst("2026-09-28T23:00:00Z", "2026-09-29T03:00:00Z")).toBe("09-29 08:00:00 – 09-29 12:00:00 KST");
    expect(F.fmtRangeKst("2026-09-28T23:00:00Z", null)).toBe("09-29 08:00:00 KST – —");
    expect(F.fmtRangeKst(null, "2026-09-29T03:00:00Z")).toBe("— – 09-29 12:00:00 KST");
    expect(F.fmtRangeKst(null, "bad")).toBe("— – —");
    expect(F.fmtRangeKst("2026-09-28T23:00:00Z", null, "진행 중")).toBe("09-29 08:00:00 KST – 진행 중");
  });
  it("title-only times (the visible text is an age): KST plus the UTC original; unknown → —", () => {
    expect(F.fmtKstTitle(LATE)).toBe("09-29 08:41:14 KST · 원본 UTC 2026-09-28T23:41:14.906Z");
    expect(F.fmtKstTitle(null)).toBe("—");
    expect(F.fmtKstTitle("bad")).toBe("—");
  });
  it("day-aware minute form: HH:MM KST on the same KST day as now, MM-DD HH:MM KST otherwise — the KST day, not the UTC day", () => {
    const NOW = Date.parse("2026-09-29T01:00:00Z"); // KST 09-29 10:00
    expect(F.fmtDayMinuteKst("2026-09-28T15:30:00Z", NOW)).toBe("00:30 KST"); // UTC 로는 전날(09-28)이지만 KST 로는 같은 날
    expect(F.fmtDayMinuteKst("2026-09-28T14:30:00Z", NOW)).toBe("09-28 23:30 KST"); // KST 로 전날
    expect(F.fmtDayMinuteKst("2026-09-28T14:30:00Z", 0)).toBe("09-28 23:30 KST"); // 지금을 모르면 날짜를 붙인다
    expect(F.fmtDayMinuteKst(null, NOW)).toBe("—");
  });
});
