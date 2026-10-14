import { test, type Page } from "@playwright/test";
import { assertIsolated, duplicates, instrument, isBlockedNoise, runAxe, saveJson, type Net } from "./qa-helpers";
import { alertId, emptyExternal } from "./qa-aws-helpers";

/**
 * QA 2026-10-aws(계획 §3.3) — 앞선 QA 의 단계별 점검이 없던 화면(/m · /alerts/[id])과 공용 화면(/stats · /airports/RKSI · /about · /guide · /replay)에서
 * 보이는 단추 · 요약(summary)을 하나씩 모두 눌러 본다(쓰기 단추 없음 — 이 화면들은 읽기 전용; 다른 화면으로 가는 링크는 누르지 않는다).
 * 누를 때마다 콘솔 오류 · 페이지 오류 · 실패한 요청 · 1.5 s 안 중복 요청을 모으고, 다 누른 뒤 axe 를 돌린다. 375 px 와 1440 px.
 * 결과: $QA_EVIDENCE_DIR/aws-click-all-<폭>.json
 */
const SKIP = /인쇄|print|sign out|새로고침|reload/i;

async function clickAll(page: Page, net: Net) {
  const out: { i: number; name: string; ok: boolean; note?: string; consoleErrors: string[]; pageErrors: string[]; bad: string[]; failed: string[]; dup: unknown[] }[] = [];
  const n = await page.locator("main button:visible, main summary:visible, main [role=tab]:visible").count();
  for (let i = 0; i < Math.min(n, 60); i++) {
    const el = page.locator("main button:visible, main summary:visible, main [role=tab]:visible").nth(i);
    const name = ((await el.getAttribute("aria-label").catch(() => null)) ?? (await el.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (SKIP.test(name) || (await el.isDisabled().catch(() => true))) continue;
    net.reset();
    let ok = true, note: string | undefined;
    try {
      await el.click({ timeout: 3000 });
      await page.waitForTimeout(700);
      if (await page.locator("main").count() === 0) note = "main gone";
    } catch (e) { ok = false; note = String(e).split("\n")[0].slice(0, 160); }
    out.push({
      i, name, ok, note,
      consoleErrors: net.console.filter((c) => c.type === "error" && !isBlockedNoise(c.text)).map((c) => c.text),
      pageErrors: net.pageErrors.map((e) => e.text),
      bad: net.bad.map((b) => `${b.status} ${b.method} ${b.url.replace(/^https?:\/\/[^/]+/, "")}`),
      failed: net.failed.map((f) => `${f.error} ${f.method} ${f.url.replace(/^https?:\/\/[^/]+/, "")}`),
      dup: duplicates(net.requests),
    });
    await page.keyboard.press("Escape").catch(() => {});
  }
  return out;
}

for (const vp of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  test(`click every control on /m · /alerts/[id] · /stats · /airports · /about · /guide · /replay at ${vp.width}`, async ({ page, baseURL }) => {
    assertIsolated(baseURL);
    test.setTimeout(600_000);
    await page.setViewportSize(vp);
    const net = await instrument(page);
    await emptyExternal(page);
    const id = await alertId(page);
    const res: Record<string, unknown> = {};
    for (const route of ["/m", `/alerts/${id}`, "/stats", "/airports/RKSI", "/about", "/guide", "/replay"]) {
      await page.goto(route);
      await page.waitForTimeout(route === "/replay" || route === "/m" ? 6000 : 3000);
      const startUrl = page.url();
      const clicks = await clickAll(page, net);
      const axe = await runAxe(page);
      res[route] = {
        startUrl, endUrl: page.url(), clicks: clicks.length,
        problems: clicks.filter((c) => !c.ok || c.consoleErrors.length || c.pageErrors.length || c.bad.length || c.failed.length || c.dup.length),
        axe: axe.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, examples: v.nodes.slice(0, 2).map((x) => x.target.join(" ")) })),
      };
      saveJson(`aws-click-all-${vp.width}.json`, res);
    }
  });
}
