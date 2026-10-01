import { expect, test, type Page } from "@playwright/test";
import { blockExternal } from "./qa-helpers";

/**
 * QA-304 · 낮음 — 오른쪽 패널의 내용이 바뀌면 키보드 초점이 <body> 로 떨어진다(WCAG 2.4.3 초점 순서): SIGMET · 공항 · 선박 목록에서 Enter 로 카드를 열 때
 * (누른 목록 단추가 사라짐), 카드의 '닫기'(카드가 사라짐), 알림 근거의 '항공기 카드 · 지도에서 보기', '선박 켜기' 등. 화면 읽기 프로그램은 위치를 잃고
 * 다음 Tab 은 브라우저마다 다르다(Chromium 은 지운 요소 자리에서 이어 감). components/SidePanel.tsx · SigmetList.tsx · SigmetCard.tsx:43 · AircraftCard.tsx:195 — 초점을 옮기지 않는다.
 */
const onBody = (page: Page) => page.evaluate(() => document.activeElement === document.body || document.activeElement === null);

test("QA-304 keyboard: opening a SIGMET card from the list and closing it keeps focus inside the panel", async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
  await page.getByTestId("tab-sigmet").click();
  const item = page.getByTestId("sigmet-list-item").first();
  await expect(item).toBeVisible({ timeout: 30_000 });
  await item.focus();
  await page.keyboard.press("Enter");
  const close = page.getByRole("button", { name: "닫기" }).first();
  await expect(close).toBeVisible();
  expect(await onBody(page), "focus after opening the card from the list").toBe(false);
  await close.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sigmet-list-item").first()).toBeVisible();
  expect(await onBody(page), "focus after closing the card").toBe(false);
});

test("QA-304 keyboard: closing the aircraft card opened from search keeps focus", async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
  await page.getByTestId("layer-aircraft").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(5000);
  await page.keyboard.press("/");
  await page.keyboard.type("KAL");
  await expect(page.getByTestId("aircraft-search-item").first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const close = page.getByTestId("aircraft-card").getByRole("button", { name: "닫기" });
  await expect(close).toBeVisible({ timeout: 10_000 });
  await close.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("aircraft-card")).toHaveCount(0);
  expect(await onBody(page), "focus after closing the aircraft card").toBe(false);
});
