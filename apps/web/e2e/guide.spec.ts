import { expect, test } from "@playwright/test";

// 설명서(/guide) — 데이터 요청이 없는 정적 화면. 목차 이동(넓은 화면 목록 · 좁은 화면 선택 상자), 그림(이미지 또는 자리표시), CSP 위반 · 페이지 오류 없음.
test("guide: contents move to sections on wide and narrow screens; every figure is an image or a placeholder", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto("/guide");
  await expect(page.getByRole("heading", { level: 1, name: "서비스 설명과 사용 방법" })).toBeVisible();
  await expect(page.getByRole("link", { name: "설명서" }).first()).toHaveAttribute("aria-current", "page");
  // 그림: 캡처가 있으면 <img>(불러와져야 한다 — 없는 파일이면 콘솔 404), 없으면 자리표시
  const figures = page.locator("figure[data-guide-shot]");
  expect(await figures.count()).toBeGreaterThan(0);
  for (const f of await figures.all()) {
    const img = f.locator("img");
    if (await img.count()) await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
    else await expect(f.locator("[data-guide-placeholder]")).toContainText("스크린샷 준비 중");
  }
  // 넓은 화면: 목차 링크 → 그 절, 목차에 지금 절 표시
  const nav = page.getByRole("navigation", { name: "설명서 목차" });
  await nav.getByRole("link", { name: /시각 표기/ }).click();
  await expect(page).toHaveURL(/#time$/);
  await expect(page.locator("#time-h")).toBeInViewport();
  await expect(nav.getByRole("link", { name: /시각 표기/ })).toHaveAttribute("aria-current", "location");
  // 좁은 화면: 목록 대신 선택 상자 — 고르면 그 절로 옮기고 제목에 초점
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nav).toBeHidden();
  const select = page.getByRole("combobox", { name: /설명서 목차/ });
  await select.selectOption("stats");
  await expect(page.locator("#stats-h")).toBeInViewport();
  await expect(page.locator("#stats-h")).toBeFocused();
  await expect(page).toHaveURL(/#stats$/);
  expect(errors).toEqual([]);
});
