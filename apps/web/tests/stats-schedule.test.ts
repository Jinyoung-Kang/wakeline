/**
 * QA-1461: 공개 데모(AWS — ADR-039 덧붙임 2-1)는 03:30 KST 정시 집계가 돌지 않는다 — 통계 화면 머리 · 빈 상태는 '켜진 뒤 따라잡기'로 말하고 03:30 을 약속하지 않는다.
 * 로컬(daily)은 그대로.
 */
import { describe, expect, it } from "vitest";
import { statsDays, statsEmptyText, statsRunHeader, statsRunPhrase, statsSchedule, statsWeekEmptyText } from "@/lib/stats";

const TODAY = "2026-10-14";
const week = (agg: (i: number) => boolean) => Array.from({ length: 8 }, (_, i) => ({ day: `2026-10-${String(6 + i).padStart(2, "0")}`, aggregated: agg(i) }));

describe("stats schedule wording", () => {
  it("the public demo never claims the 03:30 KST run", () => {
    const s = statsSchedule(true);
    expect(s).toBe("catch-up");
    const texts = [
      statsRunHeader(s).text, statsRunHeader(s).title,
      statsEmptyText(false, "2026-10-13", TODAY, undefined, s), statsEmptyText(undefined, "2026-10-13", TODAY, undefined, s),
      statsWeekEmptyText(statsDays({ days: week(() => false) }, TODAY), TODAY, s),
      statsWeekEmptyText(statsDays({ days: week((i) => i < 5) }, TODAY), TODAY, s),
    ];
    for (const t of [...texts, statsRunPhrase(s)]) expect(t).not.toContain("03:30");
    expect(statsEmptyText(false, "2026-10-13", TODAY, undefined, s)).toContain("따라잡기 집계 뒤 채워집니다");
  });
  it("local keeps the daily 03:30 KST wording", () => {
    const s = statsSchedule(false);
    expect(statsRunHeader(s).text).toBe("매일 03:30 KST 에 전날(KST 날짜) 집계");
    expect(statsRunPhrase(s)).toBe("매일 03:30 KST 에 전날을 셉니다"); // 설명서 번호 설명의 {stats-run}(QA-1461)
    expect(statsEmptyText(false, "2026-10-13", TODAY, undefined, s)).toBe(statsEmptyText(false, "2026-10-13", TODAY));
    expect(statsEmptyText(false, "2026-10-13", TODAY)).toContain("다음 03:30 KST 집계 뒤 채워집니다");
  });
});
