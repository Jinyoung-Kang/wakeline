import { expect, test } from "@playwright/test";

/**
 * QA-308 · 낮음 — 통계의 7일 패널(SIGMET by FIR · by hazard · Alerts by kind)은 api 응답의 날짜별 집계 여부 days[].aggregated(계약 — tools/rest_contract_check.py
 * STATS_DAYS, api HistoryController:82 · :108)를 읽지 않고 최상위 aggregated(이 응답에는 없다)만 본다(app/stats/page.tsx:41 flagOf → lib/stats.ts:35).
 * 그래서 지난 7일이 모두 집계됨(true)이어도 "집계 전인지 기록이 없는지 이 응답으로는 구분할 수 없습니다"라고 한다 — 머리말 "빈 칸은 집계 전·자료 없음을 구분해 표시"와 다르다.
 * (e2e/stats-states.spec.ts 의 가짜 응답은 api 가 주지 않는 최상위 aggregated 를 넣어 이 길을 덮는다.) 응답은 실제 api 와 같은 모양으로 준다.
 */
test("QA-308 a 7-day panel whose past days are all aggregated does not say it cannot tell", async ({ page }) => {
  const kstDay = (offset: number) => new Date(Date.now() + 9 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);
  const days = [-7, -6, -5, -4, -3, -2, -1].map((o) => ({ day: kstDay(o), aggregated: true })).concat([{ day: kstDay(0), aggregated: false }]);
  const meta = { provider: "db", fetched_at: new Date().toISOString(), lag_s: 0, stale: false, generated_at: new Date().toISOString(), request_id: "qa308" };
  await page.route(/\/api\/v1\/stats\/sigmet\?group=fir$/, (r) => r.fulfill({ json: { group: "fir", items: [], days, day_zone: "Asia/Seoul", meta } }));
  await page.goto("/stats");
  const fir = page.locator('[data-stats-panel="fir"]');
  await expect(fir).toHaveAttribute("data-state", "empty", { timeout: 15_000 });
  await expect(fir).not.toContainText("구분할 수 없습니다");
});
