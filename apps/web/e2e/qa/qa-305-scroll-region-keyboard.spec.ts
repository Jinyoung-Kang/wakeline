import { expect, test } from "@playwright/test";
import { runAxe } from "./qa-helpers";

/**
 * QA-305 · 낮음 — 내용을 담은 스크롤 상자(overflow-y-auto)에 키보드 초점이 없다(axe scrollable-region-focusable · serious · WCAG 2.1.1):
 * /about 본문(app/about/page.tsx — div.h-full.overflow-y-auto), /airports/RKSI(모바일), 지도 범례(#map-legend), 항공기 카드 본문, 운영 quality · audit · pipeline 탭 본문,
 * 설명서의 범례 표(모바일). 본문(body)은 overflow hidden 이라 페이지가 스크롤되지 않고, '본문으로 건너뛰기'(#main, tabindex=-1) 뒤 PageDown 으로 읽을 수 없다.
 * (Chromium 은 초점 없는 스크롤 상자 자체를 Tab 정지점으로 만들어 그 뒤에는 스크롤된다 — 그렇지 않은 브라우저(Safari)는 키보드로 읽을 길이 없다.)
 */
test("QA-305 /about: after '본문으로 건너뛰기' the page scrolls with PageDown", async ({ page }) => {
  await page.goto("/about");
  const sc = page.locator("main .overflow-y-auto").first();
  await expect(sc).toBeVisible();
  expect(await sc.evaluate((e) => e.scrollHeight > e.clientHeight), "content is taller than the box (900 px)").toBe(true);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "본문으로 건너뛰기" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(400);
  expect(await sc.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
});

test("QA-305 /about: axe scrollable-region-focusable has no violations", async ({ page }) => {
  await page.goto("/about");
  await page.waitForTimeout(1000);
  const v = (await runAxe(page)).filter((x) => x.id === "scrollable-region-focusable");
  expect(v.flatMap((x) => x.nodes.map((n) => n.target.join(" ")))).toEqual([]);
});
