import { expect, test } from "@playwright/test";

// 설명서(/guide) — 데이터 요청이 없는 정적 화면. 목차 이동(넓은 화면 목록 · 좁은 화면 선택 상자), 그림(이미지 또는 자리표시), CSP 위반 · 페이지 오류 없음.
test("guide: contents move to sections on wide and narrow screens; every figure is an image or a placeholder", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto("/guide");
  await expect(page.getByRole("heading", { level: 1, name: "서비스 설명과 사용 방법" })).toBeVisible();
  await expect(page.getByRole("link", { name: "설명서" }).first()).toHaveAttribute("aria-current", "page");
  // 그림: 캡처가 있으면 <img>(불러와져야 한다 — 없는 파일이면 콘솔 404), 없으면 자리표시.
  // 이미지는 loading="lazy"(GuideFigure) — 브라우저는 화면 가까이 온 그림만 받는다. 그래서 그림마다 화면으로 옮긴 뒤 불러와졌는지 본다
  // (통합 2026-09-30: 스크린샷이 들어온 뒤(45219aa) 네 번째 그림부터(1400×900 에서 위 4,575 px)는 스크롤 없이는 요청조차 되지 않아, 옮기지 않던 이 시험이
  // main 빌드에서도 같은 자리에서 실패했다 — 제품이 아니라 시험의 가정이 틀렸다).
  const figures = page.locator("figure[data-guide-shot]");
  expect(await figures.count()).toBeGreaterThan(0);
  for (const f of await figures.all()) {
    const img = f.locator("img");
    if (await img.count()) {
      await f.scrollIntoViewIfNeeded();
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
    } else await expect(f.locator("[data-guide-placeholder]")).toContainText("스크린샷 준비 중");
  }
  await page.evaluate(() => window.scrollTo(0, 0)); // 아래 목차 시험은 맨 위에서 시작한다(그림을 보려고 옮기기 전과 같게)
  // 넓은 화면: 목차 링크 → 그 절, 목차에 지금 절 표시
  const nav = page.getByRole("navigation", { name: "설명서 목차" });
  await nav.getByRole("link", { name: /시각 표기/ }).click();
  await expect(page).toHaveURL(/#time$/);
  await expect(page.locator("#time-h")).toBeInViewport();
  await expect(nav.getByRole("link", { name: /시각 표기/ })).toHaveAttribute("aria-current", "location");
  // 짧은 절(6.1)을 고르면 다음 절(6.2)이 띠에 들어와도 고른 절이 현재 — 사용자가 스크롤하기 전까지
  const current = nav.locator('a[aria-current="location"]');
  await nav.getByRole("link", { name: /^6\.1\s*로그인$/ }).click();
  await expect(page).toHaveURL(/#ops-login$/);
  await expect(current).toHaveAttribute("href", "#ops-login");
  await page.waitForTimeout(300); // 이동이 부른 scroll 이벤트 뒤에도 그대로
  await expect(current).toHaveAttribute("href", "#ops-login");
  // 맨 위로 돌아오면 첫 절 — 앞에서 본 절(마지막 절 포함)이 남지 않는다
  await nav.getByRole("link", { name: /키보드 단축키/ }).click();
  await expect(current).toHaveAttribute("href", "#shortcuts");
  const scroller = page.locator("[data-guide-scroll]");
  await scroller.evaluate((el) => el.scrollTo(0, 0));
  await expect(current).toHaveAttribute("href", "#overview");
  // 사용자가 스크롤하면 고정이 풀리고 그 위치의 절이 현재
  await scroller.evaluate((el) => { const t = document.getElementById("replay")!; el.scrollTo(0, el.scrollTop + t.getBoundingClientRect().top - el.getBoundingClientRect().top - 8); });
  await expect(current).toHaveAttribute("href", "#replay");
  // 좁은 화면: 목록 대신 선택 상자 — 고르면 그 절로 옮기고 제목에 초점
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(nav).toBeHidden();
  const select = page.getByRole("combobox", { name: /설명서 목차/ });
  await select.selectOption("stats");
  await expect(page.locator("#stats-h")).toBeInViewport();
  await expect(page.locator("#stats-h")).toBeFocused();
  await expect(page).toHaveURL(/#stats$/);
  await expect(select).toHaveValue("stats");
  // 좁은 화면도 맨 위로 돌아오면 첫 절
  await page.locator("[data-guide-scroll]").evaluate((el) => el.scrollTo(0, 0));
  await expect(select).toHaveValue("overview");
  expect(errors).toEqual([]);
});
