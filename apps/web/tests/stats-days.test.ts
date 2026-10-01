/**
 * QA-308 — 통계의 7일 패널(SIGMET by FIR · by hazard · Alerts)은 응답의 날짜별 집계 여부 days[].aggregated(api StatsRepository.days · REST 계약 STATS_DAYS)를
 * 읽지 않고 최상위 aggregated(7일 응답에는 없다)만 봐서, 지난 7일이 모두 집계됐어도 "집계 전인지 기록이 없는지 … 구분할 수 없습니다"라고 했다.
 */
import { describe, expect, it } from "vitest";
import { daysOf, statsDays, statsEmptyText, statsWeekEmptyText } from "@/lib/stats";

const TODAY = "2026-10-02";
const week = (agg: (i: number) => boolean) => ["09-25", "09-26", "09-27", "09-28", "09-29", "09-30", "10-01"]
  .map((d, i) => ({ day: `2026-${d}`, aggregated: agg(i) })).concat([{ day: TODAY, aggregated: false }]);

describe("statsDays: the past 7 days of a 7-day response, split into aggregated and not yet", () => {
  it("today (never aggregated — not over) is left out; order kept", () => {
    expect(statsDays({ days: week(() => true) }, TODAY)).toEqual({ done: week(() => true).slice(0, 7).map((d) => d.day), pending: [] });
    expect(statsDays({ days: week((i) => i < 5) }, TODAY)).toEqual({ done: ["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"], pending: ["2026-09-30", "2026-10-01"] });
  });
  it("no days, a wrong shape anywhere, or only today → null (unknown — nothing is guessed)", () => {
    expect(statsDays({}, TODAY)).toBeNull();
    expect(statsDays({ aggregated: true }, TODAY)).toBeNull(); // 최상위 aggregated 는 7일 응답의 필드가 아니다
    expect(statsDays({ days: [{ day: "2026-10-01", aggregated: "yes" }] }, TODAY)).toBeNull();
    expect(statsDays({ days: [{ day: "2026-10-01T00:00:00Z", aggregated: true }] }, TODAY)).toBeNull();
    expect(statsDays({ days: [{ day: TODAY, aggregated: false }] }, TODAY)).toBeNull();
  });
  it("daysOf reads only a KST-day response that has loaded", () => {
    const resp = { day_zone: "Asia/Seoul", days: week(() => true) };
    expect(daysOf({ status: "loaded", resp }, TODAY)?.pending).toEqual([]);
    expect(daysOf({ status: "loaded", resp: { ...resp, day_zone: undefined } }, TODAY)).toBeNull();
    expect(daysOf({ status: "loading" }, TODAY)).toBeNull();
  });
});

describe("statsWeekEmptyText: what an empty 7-day panel says", () => {
  it("all past days aggregated → no data (aggregated); none → filled after the next run; unknown → cannot tell", () => {
    expect(statsWeekEmptyText(statsDays({ days: week(() => true) }, TODAY), TODAY)).toBe("최근 7일 자료가 없습니다(집계됨 · 해당 기록 없음).");
    expect(statsWeekEmptyText(statsDays({ days: week(() => false) }, TODAY), TODAY)).toBe(statsEmptyText(false, null, TODAY));
    expect(statsWeekEmptyText(null, TODAY)).toBe(statsEmptyText(undefined, null, TODAY));
    expect(statsWeekEmptyText(null, TODAY)).toContain("구분할 수 없습니다");
  });
  it("mixed: says how many days were aggregated with no data and which KST days are still pending", () => {
    expect(statsWeekEmptyText(statsDays({ days: week((i) => i < 5) }, TODAY), TODAY))
      .toBe("집계된 5일에는 자료가 없습니다 · 집계 전 2일(KST 09-30 · 10-01)은 다음 03:30 KST 집계 뒤 채워집니다(놓친 최근 7일은 3시간마다 따라잡기).");
  });
});
