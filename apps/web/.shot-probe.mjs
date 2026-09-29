// 임시: /guide 를 넓은 · 좁은 폭에서 통째로 찍는다(스크롤 영역이 다 들어가는 높이) — CSS 이동 전후 비교용
import { chromium } from "@playwright/test";
const [,, out] = process.argv;
const b = await chromium.launch();
for (const [w, name] of [[1440, "wide"], [390, "narrow"]]) {
  const page = await b.newPage({ viewport: { width: w, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("http://127.0.0.1:18932/guide");
  await page.locator("[data-guide-scroll]").waitFor();
  const h = await page.locator("[data-guide-scroll]").evaluate((el) => el.scrollHeight);
  await page.setViewportSize({ width: w, height: h + 200 });
  await page.waitForTimeout(500);
  await page.evaluate(() => document.fonts?.ready);
  await page.screenshot({ path: `${out}-${name}.png` });
  console.log(name, h);
  await page.close();
}
await b.close();
