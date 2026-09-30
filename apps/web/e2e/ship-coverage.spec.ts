import { expect, test, type Page } from "@playwright/test";
import { shipCoverageBody } from "./rest-inject";

/**
 * 관측 수신 범위 레이어(계약 v5 §G27 · ADR-027) — /api/v1/ships/coverage 를 이 시험이 대신 답한다(route — 스택의 수신 상태와 무관하게 결정적).
 * 빌드된 앱에서: 기본 끔(조회 없음) → 단추(선박 옆)를 켜면 조각을 받아 한 번 조회하고 상태 줄이 칸 수 · 이 화면의 칸 수 · 창(KST 만)과 '창의 일부만 셈'의
 * 까닭을 적는다 → 범례 절이 '구독 범위가 아니다'를 말한다 → 끄면 상태 줄이 사라지고 더 묻지 않는다. 외부 타일은 막는다(결과가 네트워크에 달리지 않게).
 */
async function coverageCalls(page: Page, now: number): Promise<{ count: number }> {
  const calls = { count: 0 };
  await page.route(/\/api\/v1\/ships\/coverage$/, async (route) => {
    calls.count++;
    await route.fulfill({ status: 200, contentType: "application/json", headers: { ETag: '"oe2e"', "Cache-Control": "public, max-age=60" },
      body: JSON.stringify(shipCoverageBody(now)) });
  });
  return calls;
}

test("observed reception layer: off by default, one routed fetch when turned on, KST-only status with the partial-window reason, legend, off again", async ({ page }) => {
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (r) => r.abort());
  const now = Date.now();
  const calls = await coverageCalls(page, now);
  await page.addInitScript(() => { try { localStorage.removeItem("wakeline.layers"); localStorage.setItem("wakeline.legend", "1"); } catch { /* 저장소 없음 */ } });
  await page.goto("/#6/36.5000/127.8000");
  const btn = page.getByTestId("layer-reception");
  await expect(btn).toBeVisible({ timeout: 20_000 });
  await expect(btn).toHaveText("관측 수신 범위(최근 24 h)");
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  expect(calls.count).toBe(0); // 기본 끔 — 조회하지 않는다

  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
  const status = page.getByTestId("reception-status-text");
  await expect(status).toContainText("칸 3개(0.5°)", { timeout: 20_000 });
  await expect(status).toContainText(/이 화면 [12]개/); // 한반도 칸(인천 앞바다 · 부산 앞바다) — 대서양 칸은 화면 밖
  await expect(status).toContainText(/창 \d\d-\d\d \d\d:\d\d – \d\d-\d\d \d\d:\d\d KST/);
  const detail = page.getByTestId("reception-status-detail");
  await expect(detail).toContainText("창의 일부만 셈");
  await expect(detail).toContainText("api 시작 뒤 · 기동 전 기록 읽는 중 0/25시간");
  await expect(page.getByTestId("reception-status")).not.toContainText("UTC");
  expect(calls.count).toBe(1);

  const legend = page.getByTestId("legend-reception");
  await expect(legend).toBeVisible();
  await expect(page.getByTestId("legend-reception-note")).toContainText("구독 범위(점선)가 아니다");

  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("reception-status")).toHaveCount(0);
  await expect(legend).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(calls.count).toBe(1);
});
