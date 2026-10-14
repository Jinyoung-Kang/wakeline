import { test } from "@playwright/test";
import { assertIsolated, loginOps, saveJson, shot } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/** QA 2026-10-aws 탐색: 로그인한 /ops 를 375 px 로 처음부터 열었을 때 문서 폭(앞선 qa-ops-logs 의 '375 providers' 넘침 768 확인) */
test("probe: /ops at 375 px signed in — document width", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  await emptyExternal(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await loginOps(page);
  const out: Record<string, unknown> = {};
  for (const t of ["providers", "runs", "quality", "settings", "audit", "dlq", "pipeline"]) {
    await page.getByTestId(`ops-tab-${t}`).click();
    await page.waitForTimeout(1500);
    out[t] = await page.evaluate(() => {
      const wide = Array.from(document.querySelectorAll<HTMLElement>("body *")).map((e) => ({ e, r: e.getBoundingClientRect() })).filter((x) => x.r.right > innerWidth + 1 && x.r.width > 0)
        .slice(0, 5).map((x) => `${x.e.tagName.toLowerCase()}.${String(x.e.className).split(" ").slice(0, 2).join(".")} right=${Math.round(x.r.right)}`);
      return { iw: innerWidth, doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, scrollX: scrollX, wide };
    });
    await page.keyboard.press("Tab");
  }
  await shot(page, "aws-probe-ops375.png");
  saveJson("aws-probe-ops375.json", out);
});
