import { expect, test } from "@playwright/test";
import { krMissingStreak } from "./rest-inject";

/**
 * 기상청 내려받기 '파일 없음' 연속(계약 v5 §G22) — 격리된 fixture 스택의 /api/v1/radar/kr 응답에 missing 만 덧붙여(fixture 수집기는 기상청을 부르지 않는다)
 * 빌드된 앱이 상태 바 KMA 칩 · 상세 표에 까닭을 적는지 본다(통합 리뷰 2026-09-30 — 전에는 Vitest 만 보았다). 나머지 응답 · WS 는 스택 그대로.
 * 시각은 KST 만(UTC 글자 없음) · 값은 응답 그대로(확인한 tm 수 · 목록 종류 · 파일 종류 PUB).
 */
test("KMA 'file not exist' streak from /radar/kr: the KMA chip says 파일 없음 and 상세 has the 기상청 내려받기 파일 row (KST only)", async ({ page }) => {
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (r) => r.abort()); // 외부 타일 — 결과가 네트워크에 달리지 않게
  let injected = 0;
  await page.route(/\/api\/v1\/radar\/kr$/, async (route) => {
    const res = await route.fetch();
    const body = res.ok() ? await res.json() : { available: false, georeferenced: false, coordinates: null, legend: null, frames: [] };
    injected++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...body, missing: krMissingStreak(Date.now()) }) });
  });
  await page.goto("/");
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 20_000 });
  const chip = page.getByTestId("kr-status");
  await expect(chip).toBeVisible({ timeout: 20_000 });
  expect(injected).toBeGreaterThan(0);
  const word = page.getByTestId("kr-status-missing");
  await expect(word).toHaveText("파일 없음"); // 1분 전 확인 — 확인 멈춤이 아니다
  await expect(chip).toHaveAttribute("data-health", /warn|bad/);
  await expect(chip).not.toHaveAttribute("data-overflow", "true"); // 주의 칩은 상세로 옮기지 않는다
  const title = (await word.getAttribute("title")) ?? "";
  expect(title).toContain("기상청 내려받기 파일(PUB) 없음");
  expect(title).toContain("확인한 tm 12개 모두 없음");
  expect(title).toContain("목록에는 EXT");
  // 오늘(KST)이 아니면 날짜가 붙는다(lib/time — CI 가 KST 자정을 넘겨 돈 2026-10-03: "마지막 확인 10-02 23:59:35 KST")
  expect(title).toMatch(/마지막 확인 (\d\d-\d\d )?\d\d:\d\d:\d\d KST/);
  expect(title).not.toContain("UTC");
  await page.getByTestId("statusbar-details-toggle").click();
  const row = page.getByTestId("statusbar-details").locator('[data-row="kma-missing"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("기상청 내려받기 파일");
  await expect(row).toContainText("없음");
  await expect(page.getByTestId("statusbar-details")).not.toContainText("UTC");
});
