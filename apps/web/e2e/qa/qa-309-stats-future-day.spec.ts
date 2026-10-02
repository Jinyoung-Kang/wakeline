import { expect, test } from "@playwright/test";

/**
 * QA-309 · 낮음 — 통계의 날짜(집계 날짜(KST))는 max = 어제지만 입력을 검사하지 않는다(app/stats/page.tsx — date input onChange 가 그대로 setDay).
 * 키보드 ↑ 나 직접 입력으로 미래 날짜(예: 한 달 뒤)를 넣으면 그 날짜로 조회하고 "아직 집계되지 않았습니다 — 다음 03:30 KST 집계 뒤 채워집니다"라고 약속한다.
 * 관찰: 2026-10-01 → ↑↑ → 2026-11-01, GET /api/v1/stats/traffic?day=2026-11-01, 같은 문구(pages-steps.json "stats: date + 2 days").
 */
test("QA-309 a future day is not queried and promised as 'filled after the next run'", async ({ page }) => {
  await page.goto("/stats");
  const input = page.getByLabel("집계 날짜(KST)");
  await expect(input).toBeVisible();
  const max = await input.getAttribute("max");
  expect(max).toBeTruthy();
  const future = new Date(Date.parse(`${max}T00:00:00Z`) + 31 * 86_400_000).toISOString().slice(0, 10);
  const asked: string[] = [];
  page.on("request", (r) => { const m = /\/api\/v1\/stats\/traffic\?day=([\d-]+)/.exec(r.url()); if (m) asked.push(m[1]); });
  await input.fill(future);
  await page.waitForTimeout(1500);
  const traffic = page.locator('[data-stats-panel="traffic"]');
  expect(asked, `requested days after typing ${future} (max ${max})`).not.toContain(future);
  await expect(traffic).not.toContainText("집계 뒤 채워집니다");
});
