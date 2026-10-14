import { expect, test } from "@playwright/test";
import { assertIsolated, saveJson } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA-1501 재현(QA 2026-10-aws · 성능 — findings/performance.md §9): 새 화면 /guide 의 모바일 LCP 2,910 ms [2,842–2,955](Lighthouse 12.8.2 · 3번 모두 2.5 s 초과).
 * LCP 요소는 서버가 그린 첫 문단(section#overview > p.g-p)이고 단계는 TTFB 463 · Render Delay 2,446 ms. 보고서의 요청 목록을 보면 첫 화면 밖의 스크린샷 두 장
 * (dashboard 138 KB · world 159 KB — 모바일 412×823 에서 위 1,653 · 2,677 px)이 loading="lazy" 인데도 브라우저의 lazy 거리(화면 아래 1,250–2,500 px) 안이라
 * 첫 그리기(관측 LCP 232 ms) 전 176 ms 에 요청된다 — 시뮬레이션은 LCP 전에 시작한 요청을 모두 LCP 경로에 넣으므로 그 297 KB 를 느린 4G 로 다시 센다.
 * 기대: 첫 화면 밖 그림은 늦게 받는다 — 모바일 화면을 열고 스크롤하지 않는 동안 첫 화면 밖 그림을 요청하지 않는다. 대조: 그림 쪽으로 스크롤하면 그 그림을 받는다.
 * 실행: cd apps/web && QA_BASE_URL=http://localhost:8701 QA_EVIDENCE_DIR=… npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1501
 */
const MOBILE = { viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true };

test("QA-1501 /guide on a phone does not fetch off-screen screenshots while the first screen loads", async ({ browser, baseURL }) => {
  assertIsolated(baseURL);
  const ctx = await browser.newContext({ ...MOBILE, baseURL, locale: "ko-KR", timezoneId: "UTC" });
  const page = await ctx.newPage();
  await emptyExternal(page);
  const t0 = Date.now();
  const images: { t: number; file: string }[] = [];
  page.on("request", (r) => { if (r.resourceType() === "image" && new URL(r.url()).pathname.startsWith("/guide/")) images.push({ t: Date.now() - t0, file: new URL(r.url()).pathname }); });
  await page.goto("/guide", { waitUntil: "load" });
  await page.waitForTimeout(2500);
  const m = await page.evaluate(async () => {
    // LCP 항목은 getEntriesByType 로 나오지 않는다 — buffered 관찰자로 받는다
    const lcp = await new Promise<(PerformanceEntry & { element?: Element | null }) | undefined>((res) => {
      new PerformanceObserver((l) => res(l.getEntries().at(-1) as PerformanceEntry & { element?: Element | null })).observe({ type: "largest-contentful-paint", buffered: true });
      setTimeout(() => res(undefined), 1000);
    });
    const vh = innerHeight;
    const figs = Array.from(document.querySelectorAll<HTMLElement>("figure[data-guide-shot]")).map((f) => ({ id: f.dataset.guideShot, top: Math.round(f.getBoundingClientRect().top) }));
    return { vh, lcpMs: lcp ? Math.round(lcp.startTime) : null, lcpEl: lcp?.element ? `${lcp.element.tagName}.${lcp.element.className}` : null, offscreen: figs.filter((f) => f.top >= vh).map((f) => f.id) };
  });
  const beforeScroll = [...images];
  // 대조: 첫 그림으로 스크롤하면 그 그림을 받아 그린다
  const first = page.locator("figure[data-guide-shot]").first();
  await first.scrollIntoViewIfNeeded();
  const img = first.locator("img").first();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
  saveJson("qa-1501-guide-offscreen-images.json", { ...m, beforeScroll, afterScroll: images });
  console.log(`QA-1501 vh=${m.vh} lcp=${m.lcpMs}ms ${m.lcpEl} offscreenFigures=${m.offscreen.length} imageRequestsBeforeScroll=${JSON.stringify(beforeScroll)}`);
  await ctx.close();
  expect(m.offscreen.length, "precondition: the figures start below the first screen on a phone").toBeGreaterThan(0);
  expect(beforeScroll, "off-screen screenshots requested while the first screen loads (no scrolling)").toEqual([]);
});
