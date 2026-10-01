import { expect, test } from "@playwright/test";

/**
 * QA-313 · 낮음 — 문서는 lang="ko" 인데 영어 제목 · 문구에 lang 표시가 없다(WCAG 3.1.2 부분의 언어): h1 "Statistics"(app/stats/page.tsx:52),
 * "Data sources · licenses"(app/about/page.tsx), "Airport weather · …"(app/airports/[icao]/page.tsx:35), 운영 로그인 "Operator sign-in" · "Sign in" 등.
 * 한국어 음성은 이 글자를 한국어 규칙으로 읽는다. 화면 전체에서 lang^=en 요소 0개(a11y-extra.json).
 */
for (const [route, text] of [["/stats", "Statistics"], ["/about", "Data sources"], ["/airports/RKSI", "Airport weather"]] as const) {
  test(`QA-313 ${route}: the English heading "${text}" declares its language`, async ({ page }) => {
    await page.goto(route);
    const h1 = page.locator("h1").first();
    await expect(h1).toContainText(text, { ignoreCase: true });
    const lang = await h1.evaluate((e) => e.closest("[lang]")?.getAttribute("lang") ?? "");
    expect(lang).toMatch(/^en/);
  });
}
