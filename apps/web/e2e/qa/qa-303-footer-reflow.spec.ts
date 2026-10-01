import { expect, test } from "@playwright/test";

/**
 * QA-303 · 낮음 — 하단 출처 줄(components/AttributionFooter.tsx)은 묶음마다 inline-block + whitespace-nowrap 이라, 한 묶음('연안 교통량 …' 519 px)이
 * 화면보다 넓으면 줄바꿈되지 않고 잘린다 — 문서 폭 529 px(375 · 320 px 화면, 모든 경로), body overflow hidden 이라 스크롤도 안 된다.
 * '해양수산부 해양격자 4단계' · 'OpenStreetMap contributors' 링크가 화면 밖. 주석("폭이 좁으면 줄바꿈 — 잘리지 않는다") · FR-20 '상시 노출'과 다르다(WCAG 1.4.10).
 */
for (const width of [375, 320]) {
  test(`QA-303 the sources footer wraps inside a ${width} px screen`, async ({ page }) => {
    await page.setViewportSize({ width, height: 812 });
    await page.goto("/about");
    const footer = page.getByTestId("attribution");
    await expect(footer).toBeVisible();
    const r = await page.evaluate(() => {
      const f = document.querySelector('[data-testid="attribution"]')!;
      const cut = Array.from(f.querySelectorAll("a")).filter((a) => a.getBoundingClientRect().right > innerWidth + 0.5).map((a) => a.textContent);
      return { docWidth: document.documentElement.scrollWidth, innerWidth, cut };
    });
    expect(r.cut).toEqual([]);
    expect(r.docWidth).toBeLessThanOrEqual(r.innerWidth);
  });
}
