import { test } from "@playwright/test";
import { assertIsolated, duplicates, instrument, isBlockedNoise, overflow, runAxe, saveJson, shot } from "./qa-helpers";

/**
 * QA 2026-10 §3.3 · §3.6 — 모든 경로 × 세 화면 폭에서 첫 화면을 열고 모은다(쓰기 없음):
 * 콘솔 오류 · 경고, 페이지 오류, 실패한 요청(≥ 400 · 끊김), 첫 10 s 의 중복 요청(같은 method+URL 이 1.5 s 안에 두 번 이상), 긴 작업(longtask),
 * 가로 넘침, axe(WCAG 2.1 A · AA), 스크린샷. 결과는 docs/qa/2026-10/evidence/ui-a11y/sweep-<폭>.json · sweep-<폭>-<경로>.png.
 * 외부 호스트(OpenFreeMap 스타일 · 타일, RainViewer 레이더 타일)는 막는다 — 배경지도 · 레이더 그림은 보지 못한다(상황판은 대체 스타일로 그린다).
 * /ops · /logs 는 여기서는 로그인 전 화면(로그인 폼)만 — 로그인 뒤는 qa-ops-logs.spec.ts.
 */
const ROUTES = ["/", "/replay", "/stats", "/airports/RKSI", "/airports/ZZZZ", "/airports/abc", "/ops", "/logs", "/about", "/guide"];
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, tablet: { width: 768, height: 1024 }, mobile: { width: 375, height: 812 } } as const;
const slug = (r: string) => (r === "/" ? "dashboard" : r.slice(1).replace(/\//g, "-"));

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test(`sweep ${vpName} ${vp.width}x${vp.height}`, async ({ page, baseURL }) => {
    assertIsolated(baseURL);
    await page.setViewportSize(vp);
    await page.addInitScript(() => {
      const w = window as unknown as { __qaLong: number[] };
      w.__qaLong = [];
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__qaLong.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: true }); } catch { /* 없음 */ }
    });
    const net = await instrument(page);
    const results: unknown[] = [];
    for (const route of ROUTES) {
      net.reset();
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(route === "/" || route === "/replay" ? 10_000 : 6_000);
      const ov = await overflow(page);
      const axe = await runAxe(page);
      const longTasks = await page.evaluate(() => (window as unknown as { __qaLong?: number[] }).__qaLong ?? []);
      await shot(page, `sweep-${vpName}-${slug(route)}.png`);
      results.push({
        route,
        title: await page.title(),
        lang: await page.evaluate(() => document.documentElement.lang),
        consoleErrors: net.console.filter((c) => c.type === "error" && !isBlockedNoise(c.text)).map((c) => c.text),
        consoleWarnings: net.console.filter((c) => c.type === "warning" && !/GL Driver|GPU stall/.test(c.text)).map((c) => c.text),
        blockedNoiseErrors: net.console.filter((c) => isBlockedNoise(c.text)).length,
        pageErrors: net.pageErrors.map((e) => e.text),
        badResponses: net.bad.map((b) => `${b.status} ${b.method} ${b.url}`),
        failedRequests: net.failed.map((f) => `${f.error} ${f.method} ${f.url}`),
        duplicates: duplicates(net.requests),
        apiRequests: net.requests.filter((r) => /\/api\/|\/ws\//.test(r.url)).map((r) => `${r.t} ${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, "")}`),
        longTasks: { count: longTasks.length, maxMs: Math.max(0, ...longTasks), totalMs: longTasks.reduce((a, b) => a + b, 0) },
        overflow: ov,
        axe: axe.map((v) => ({ id: v.id, impact: v.impact, wcag: v.tags.filter((t) => /^wcag\d/.test(t)), count: v.nodes.length, help: v.help, examples: v.nodes.slice(0, 3).map((n) => ({ target: n.target.join(" "), html: n.html, summary: n.failureSummary })) })),
      });
    }
    saveJson(`sweep-${vpName}.json`, { viewport: vp, blockedExternalHosts: Object.fromEntries(net.blockedHosts), results });
  });
}
