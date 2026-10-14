import { test, type Page } from "@playwright/test";
import { assertIsolated, duplicates, focusInfo, instrument, isBlockedNoise, overflow, runAxe, saveJson, shot, type Net } from "./qa-helpers";
import { alertId, emptyExternal } from "./qa-aws-helpers";

/**
 * QA 2026-10-aws(계획 §3.3 · §3.6) — 10경로 × 1440 · 768 · 375 · 320 px 첫 화면 점검(쓰기 없음). 앞선 qa-sweep 에 /m · /alerts/[id](실제 알림 id) · 320 px ·
 * 키보드 Tab 순회를 더했다.
 * - 외부 호스트(OpenFreeMap 스타일 · 타일 · 글꼴, RainViewer 타일): page.route 로 막고 **빈 응답**으로 대신한다(사용자 결정 — 승인 질문 2).
 *   스타일 JSON 은 빈 스타일(레이어 0)을, 그 밖은 204 빈 본문. 막은 요청은 '실패한 요청'에 넣지 않고 호스트별로 따로 센다(blockedExternal).
 * - 모은 것: 콘솔 오류 · 경고, 페이지 오류, 실패한 요청(≥ 400 · 끊김 — 429 는 본문으로 edge/api 를 가른다), 첫 화면의 중복 요청(1.5 s 안 같은 method+URL),
 *   가로 넘침, axe(WCAG 2.1 A · AA), Tab 40번 순회(초점 표시 없는 요소 · 화면 밖 초점 · body 로 떨어짐), 스크린샷.
 * 결과: $QA_EVIDENCE_DIR/aws-sweep-<폭>.json · aws-sweep-<폭>-<경로>.png
 */
const VIEWPORTS = { w1440: { width: 1440, height: 900 }, w768: { width: 768, height: 1024 }, w375: { width: 375, height: 812 }, w320: { width: 320, height: 640 } } as const;
const slug = (r: string) => (r === "/" ? "dashboard" : r.slice(1).replace(/[/[\]]/g, "-"));

async function tabWalk(page: Page, n = 40) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur?.(); window.scrollTo(0, 0); });
  const seq: { tag: string; name: string; visible: boolean; inViewport: boolean; testid: string }[] = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press("Tab");
    seq.push(await focusInfo(page));
  }
  return {
    steps: seq.length,
    noIndicator: seq.filter((s) => s.tag !== "body" && !s.visible).map((s) => `${s.tag}[${s.testid}] "${s.name}"`),
    offscreen: seq.filter((s) => s.tag !== "body" && !s.inViewport).map((s) => `${s.tag}[${s.testid}] "${s.name}"`),
    toBody: seq.filter((s) => s.tag === "body").length,
    first5: seq.slice(0, 5).map((s) => `${s.tag}[${s.testid}] "${s.name}"`),
  };
}

async function bodies429(page: Page, net: Net) {
  // 429 의 출처(edge 본문 'per IP (edge)' · api 'RATE_LIMITED')를 가른다 — 결함으로 세지 않는다
  return net.bad.filter((b) => b.status === 429).map((b) => b.url);
}

for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
  test(`aws sweep ${vpName} ${vp.width}x${vp.height}`, async ({ page, baseURL }) => {
    assertIsolated(baseURL);
    test.setTimeout(900_000);
    await page.setViewportSize(vp);
    await page.addInitScript(() => {
      const w = window as unknown as { __qaLong: number[] };
      w.__qaLong = [];
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__qaLong.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: true }); } catch { /* 없음 */ }
    });
    const net = await instrument(page);
    const blocked = await emptyExternal(page);
    const id = await alertId(page);
    const ROUTES = ["/", "/m", "/replay", "/stats", "/airports/RKSI", `/alerts/${id}`, "/ops", "/logs", "/about", "/guide"];
    const results: unknown[] = [];
    for (const route of ROUTES) {
      net.reset();
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(route === "/" || route === "/replay" || route === "/m" ? 10_000 : 6_000);
      const ov = await overflow(page);
      const axe = await runAxe(page);
      const longTasks = await page.evaluate(() => (window as unknown as { __qaLong?: number[] }).__qaLong ?? []);
      await shot(page, `aws-sweep-${vpName}-${slug(route)}.png`);
      const firstScreen = {
        consoleErrors: net.console.filter((c) => c.type === "error" && !isBlockedNoise(c.text)).map((c) => c.text),
        consoleWarnings: net.console.filter((c) => c.type === "warning" && !/GL Driver|GPU stall|WebGL/.test(c.text)).map((c) => c.text),
        blockedNoise: net.console.filter((c) => isBlockedNoise(c.text)).length,
        pageErrors: net.pageErrors.map((e) => e.text),
        badResponses: net.bad.filter((b) => b.status !== 429).map((b) => `${b.status} ${b.method} ${b.url.replace(/^https?:\/\/[^/]+/, "")}`),
        rateLimited: await bodies429(page, net),
        failedRequests: net.failed.map((f) => `${f.error} ${f.method} ${f.url.replace(/^https?:\/\/[^/]+/, "")}`),
        duplicates: duplicates(net.requests),
        apiRequests: net.requests.filter((r) => /\/api\/|\/ws\//.test(r.url)).map((r) => `${r.t} ${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, "")}`),
      };
      net.reset();
      const keyboard = await tabWalk(page);
      const afterKeys = {
        consoleErrors: net.console.filter((c) => c.type === "error" && !isBlockedNoise(c.text)).map((c) => c.text),
        pageErrors: net.pageErrors.map((e) => e.text),
      };
      results.push({
        route,
        title: await page.title(),
        lang: await page.evaluate(() => document.documentElement.lang),
        ...firstScreen,
        longTasks: { count: longTasks.length, maxMs: Math.max(0, ...longTasks), totalMs: longTasks.reduce((a, b) => a + b, 0) },
        overflow: ov,
        keyboard, afterKeys,
        axe: axe.map((v) => ({ id: v.id, impact: v.impact, wcag: v.tags.filter((t) => /^wcag\d/.test(t)), count: v.nodes.length, help: v.help, examples: v.nodes.slice(0, 3).map((n) => ({ target: n.target.join(" "), html: n.html, summary: n.failureSummary })) })),
      });
      saveJson(`aws-sweep-${vpName}.json`, { viewport: vp, blockedExternal: Object.fromEntries(blocked), results });
    }
    saveJson(`aws-sweep-${vpName}.json`, { viewport: vp, blockedExternal: Object.fromEntries(blocked), results });
  });
}
