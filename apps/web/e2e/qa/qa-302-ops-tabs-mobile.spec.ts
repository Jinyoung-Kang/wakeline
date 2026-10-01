import { expect, test } from "@playwright/test";
import { mockOpsApi } from "./qa-helpers";

/**
 * QA-302 · 보통 — 375 px(휴대폰) 이하에서 운영 화면의 탭 줄(app/ops/page.tsx — role=group "운영 탭", flex · 줄바꿈 없음 · 가로 스크롤 없음)이
 * 화면 밖으로 넘쳐 audit · dlq · pipeline(320 px 에서는 settings 도) 단추가 화면 밖 — dlq · pipeline 에는 닿을 수 없다. 본문은 overflow hidden 이라 페이지도 옆으로 밀리지 않는다(WCAG 1.4.10).
 * 운영 API 는 계약 모양 값으로 대신 준다(자격 증명 없이 결정적으로).
 */
for (const width of [375, 320]) {
  test(`QA-302 every ops tab button is reachable at ${width} px`, async ({ page }) => {
    await mockOpsApi(page, {});
    await page.setViewportSize({ width, height: 812 });
    await page.goto("/ops");
    await expect(page.getByTestId("ops-dashboard")).toBeVisible({ timeout: 20_000 });
    const unreachable = await page.locator('[role="group"][aria-label="운영 탭"] button').evaluateAll((bs) => bs.filter((b) => {
      const r = b.getBoundingClientRect();
      if (r.right <= innerWidth + 0.5) return false;
      // 가로로 스크롤되는 조상 안이면 닿을 수 있다
      for (let p = b.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (/(auto|scroll)/.test(ox) && p.scrollWidth > p.clientWidth) return false;
      }
      return true;
    }).map((b) => `${(b as HTMLElement).dataset.testid} (right ${Math.round(b.getBoundingClientRect().right)} > ${innerWidth})`));
    expect(unreachable).toEqual([]);
  });
}
