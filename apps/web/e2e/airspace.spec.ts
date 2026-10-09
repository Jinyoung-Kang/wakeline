import { expect, test } from "@playwright/test";

/**
 * 공역 레이어(계약 v5 §G47 · ADR-034 · SPEC F1) — 격리 스택(make e2e)은 기동 뒤 합성 공역(가짜 자료 — apps/collector/tests/fixtures/airspace/synthetic.kml,
 * 기준 차수 '합성 시험 공역 1차')을 가져온다. 실제 api 응답으로: 기본 끔(조회 없음) → 켜면 조각을 받아 한 번 조회하고 상태 줄이 기준 차수 · 출처 · '최신 여부 확인 안 함' ·
 * 그린 도형 수를 적는다 → 종류 단추(기본: 금지 · 원전 · 안보 · 제한 · 위험)로 거르고 이 브라우저에 기억한다 → 끄면 상태 줄이 사라지고 더 묻지 않는다.
 */
test("airspace layer: off by default, the synthetic edition with its source, category filter remembered, off again", async ({ page }) => {
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (r) => r.abort());
  let calls = 0;
  page.on("request", (r) => { if (r.url().includes("/api/v1/airspace")) calls++; });
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem("e2e-airspace-init")) {
        localStorage.removeItem("wakeline.layers");
        localStorage.removeItem("wakeline.airspaceTypes");
        sessionStorage.setItem("e2e-airspace-init", "1");
      }
    } catch { /* 저장소 없음 */ }
  });
  await page.goto("/#6/37.0000/132.5000");
  const btn = page.getByTestId("layer-airspace");
  await expect(btn).toBeVisible({ timeout: 20_000 });
  await expect(btn).toHaveText("공역");
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  expect(calls).toBe(0);

  await btn.click();
  const status = page.getByTestId("airspace-status-text");
  await expect(status).toContainText("합성 시험 공역 1차 기준 · 국토교통부 · 최신 여부 확인 안 함", { timeout: 20_000 });
  await expect(status).toContainText("그린 도형 8/20"); // 금지 1 · 원전 2 · 안보 1 · 제한 3 · 위험 1
  await expect(status).toContainText(/가져옴 \d\d-\d\d \d\d:\d\d KST/);
  await expect(page.getByTestId("airspace-status")).not.toContainText("UTC");
  await expect(page.getByTestId("airspace-cat-prohibited")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("airspace-cat-route")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("airspace-cat-other")).toHaveText("시험_새폴더"); // 모르는 종류는 원본 폴더 이름 그대로(짐작하지 않음)

  await page.getByTestId("airspace-cat-route").click();
  await expect(status).toContainText("그린 도형 9/20");
  await page.getByTestId("airspace-cat-danger").click();
  await expect(status).toContainText("그린 도형 8/20");

  await page.reload();
  await expect(page.getByTestId("layer-airspace")).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 }); // 레이어 켬도 기억
  await expect(page.getByTestId("airspace-cat-route")).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  await expect(page.getByTestId("airspace-cat-danger")).toHaveAttribute("aria-pressed", "false");

  await page.getByTestId("layer-airspace").click();
  await expect(page.getByTestId("airspace-status")).toHaveCount(0);
  const before = calls;
  await page.waitForTimeout(500);
  expect(calls).toBe(before);
});
