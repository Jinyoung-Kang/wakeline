import { test, type Page } from "@playwright/test";
import { assertIsolated, instrument, loginOps, saveJson } from "./qa-helpers";

/**
 * QA 2026-10 §3.3 — 화면 시각은 KST 만(CLAUDE.md 제품 규칙). 브라우저 시간대를 UTC 로 두고(설정) 화면의 보이는 글자에서 시각(HH:MM)을 모아,
 * 지금 UTC 시각 ±90분에 들고 KST ±90분에는 들지 않는 것(= 브라우저 시간대 · UTC 로 그린 것으로 보이는 값)과 'UTC' · 'Z' 표기를 찾는다.
 * 원문 칸(data-raw · pre — METAR · TAF · 로그 원문)은 규칙상 그대로이므로 뺀다. 결과: docs/qa/2026-10/evidence/ui-a11y/kst-scan.json. 쓰기 없음.
 */
async function scan(page: Page) {
  return page.evaluate(() => {
    const now = new Date();
    const mins = (h: number, m: number) => h * 60 + m;
    const utcNow = mins(now.getUTCHours(), now.getUTCMinutes());
    const kstNow = (utcNow + 9 * 60) % 1440;
    const near = (a: number, b: number) => Math.min(Math.abs(a - b), 1440 - Math.abs(a - b)) <= 90;
    const out: { text: string; why: string }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest("[data-raw], pre, script, style, [hidden]")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const t = n.textContent ?? "";
      const ctx = (el.closest("td, li, div, span") as HTMLElement | null)?.innerText?.replace(/\s+/g, " ").slice(0, 120) ?? t;
      if (/\bUTC\b|GMT/.test(t)) out.push({ text: ctx, why: "UTC/GMT 표기" });
      if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z/.test(t)) out.push({ text: ctx, why: "ISO …Z 문자열" });
      for (const m of t.matchAll(/(?<![\d:])(\d{1,2}):(\d{2})(?::\d{2})?(?![\d])/g)) {
        const v = mins(Number(m[1]), Number(m[2]));
        if (Number(m[1]) > 23) continue;
        if (near(v, utcNow) && !near(v, kstNow)) out.push({ text: ctx, why: `UTC 시각으로 보임(${m[0]} · 지금 UTC ${Math.floor(utcNow / 60)}:${String(utcNow % 60).padStart(2, "0")})` });
      }
    }
    // 같은 글을 한 번만
    const seen = new Set<string>();
    return out.filter((o) => (seen.has(o.text + o.why) ? false : (seen.add(o.text + o.why), true))).slice(0, 40);
  });
}

test("KST only: no browser-zone or UTC times on any screen", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(400_000);
  await instrument(page);
  const out: Record<string, unknown> = { browserTimeZone: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) };
  for (const route of ["/", "/replay", "/stats", "/airports/RKSI", "/about", "/guide"]) {
    await page.goto(route);
    await page.waitForTimeout(route === "/" ? 9000 : 4000);
    out[route] = await scan(page);
  }
  // 상황판: 카드 · 알림 근거 · 상태 상세
  await page.goto("/");
  await page.waitForTimeout(8000);
  await page.getByTestId("alert-toggle").first().click().catch(() => {});
  await page.waitForTimeout(800);
  await page.getByTestId("statusbar-details-toggle").click().catch(() => {});
  await page.waitForTimeout(800);
  out["/ (evidence + status details)"] = await scan(page);
  await page.keyboard.press("Escape");
  await page.keyboard.press("/"); await page.keyboard.type("KAL"); await page.waitForTimeout(1500); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  out["/ (aircraft card)"] = await scan(page);
  await loginOps(page, "qa-b");
  for (const t of ["providers", "runs", "quality", "settings", "audit", "dlq", "pipeline"]) {
    await page.getByTestId(`ops-tab-${t}`).click();
    await page.waitForTimeout(1500);
    out[`/ops ${t}`] = await scan(page);
  }
  await page.goto("/logs");
  await page.waitForTimeout(4000);
  await page.getByTestId("log-row").first().click().catch(() => {});
  await page.waitForTimeout(1500);
  out["/logs (list + detail)"] = await scan(page);
  await page.getByRole("button", { name: "sign out" }).click();
  saveJson("kst-scan.json", out);
});
