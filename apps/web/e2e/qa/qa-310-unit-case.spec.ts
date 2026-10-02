import { expect, test } from "@playwright/test";
import { blockExternal } from "./qa-helpers";

/**
 * QA-310 · 낮음 — 단위 글자가 대문자로 바뀐다: .badge · .label 의 text-transform: uppercase(app/globals.css:33 · :40)가 예측 ETA 배지
 * (components/AlertPanel.tsx EtaBadge — "추정 ETA 9m 55s" → "9M 55S")와 공항 METAR 줄(app/airports/[icao]/page.tsx:42 — "15m 38s 전" → "15M 38S 전")의
 * 분 · 초 단위를 바꾼다. 브라우저 접근성 트리 이름도 "추정 ETA 9M 41S" 라 화면 읽기 프로그램도 그렇게 읽는다. 같은 화면에서 m 은 미터(고도 "9,449 m")다.
 */
test("QA-310 predicted ETA keeps lower-case minute/second units (m, s)", async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
  const eta = page.getByTestId("alert-eta").first();
  await expect(eta).toBeVisible({ timeout: 30_000 });
  // 보이는 글자(innerText — CSS text-transform 이 적용된 글자). textContent 는 "9m 55s" 그대로라 보이는 대로 본다
  await expect.poll(() => eta.innerText(), { timeout: 5000 }).toMatch(/ETA ((\d+m )?\d+s|—)$/);
});

test("QA-310 airport METAR age keeps lower-case units", async ({ page }) => {
  await page.goto("/airports/RKSI");
  const line = page.locator("main").getByText(/METAR · .* 전/).first();
  await expect(line).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => line.innerText(), { timeout: 5000 }).toMatch(/\d+(m|s|h)( \d+(m|s))? 전/);
});
