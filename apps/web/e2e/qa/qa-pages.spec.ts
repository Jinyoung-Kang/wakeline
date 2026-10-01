import { test, type Page } from "@playwright/test";
import { assertIsolated, duplicates, focusInfo, instrument, isBlockedNoise, runAxe, saveJson, shot, type Net } from "./qa-helpers";

/**
 * QA 2026-10 §3.3 · §3.6 — 재생 · 통계 · 공항 · 설명서 · 출처 화면의 조작(쓰기 없음): 단계마다 콘솔 · 요청 · 중복 · 초점, 주요 상태에서 axe.
 * 결과: docs/qa/2026-10/evidence/ui-a11y/pages-steps.json.
 */
interface Step { name: string; ok: boolean; note?: string; focus?: unknown; consoleErrors: string[]; pageErrors: string[]; bad: string[]; failed: string[]; dup: unknown[]; api: string[]; axe?: unknown }
const steps: Step[] = [];

async function step(page: Page, net: Net, name: string, fn: () => Promise<string | void>, opts: { axe?: boolean; settle?: number } = {}) {
  net.reset();
  let ok = true, note: string | undefined;
  try { note = (await fn()) ?? undefined; } catch (e) { ok = false; note = String(e).slice(0, 400); }
  await page.waitForTimeout(opts.settle ?? 1200);
  const s: Step = {
    name, ok, note, focus: await focusInfo(page),
    consoleErrors: net.console.filter((c) => c.type === "error" && !isBlockedNoise(c.text)).map((c) => c.text),
    pageErrors: net.pageErrors.map((e) => e.text),
    bad: net.bad.map((b) => `${b.status} ${b.method} ${b.url.replace(/^https?:\/\/[^/]+/, "")}`),
    failed: net.failed.map((f) => `${f.error} ${f.method} ${f.url.replace(/^https?:\/\/[^/]+/, "")}`),
    dup: duplicates(net.requests),
    api: net.requests.filter((r) => /\/api\//.test(r.url)).map((r) => `${r.t} ${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, "")}`),
  };
  if (opts.axe) {
    const v = await runAxe(page);
    s.axe = v.map((x) => ({ id: x.id, impact: x.impact, wcag: x.tags.filter((t) => /^wcag\d/.test(t)), count: x.nodes.length, examples: x.nodes.slice(0, 3).map((n) => ({ target: n.target.join(" "), html: n.html.slice(0, 200), summary: n.failureSummary })) }));
  }
  steps.push(s);
  saveJson("pages-steps.json", { steps });
}

test("replay · stats · airports · guide · about: every control", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(600_000);
  const net = await instrument(page);
  const ctl = () => page.getByTestId("replay-controls");

  // ── 재생
  await step(page, net, "replay: open", async () => { await page.goto("/replay"); await ctl().waitFor(); return `map attrib control (load fired)=${await page.locator(".maplibregl-ctrl-attrib").count()} basemap notice=${await page.getByTestId("basemap-failed").count()}`; }, { axe: true, settle: 8000 });
  await step(page, net, "replay: 재생 (10×) 6 s", async () => { await ctl().getByRole("button", { name: "재생", exact: true }).click(); await page.waitForTimeout(6000); }, { settle: 0 });
  await step(page, net, "replay: 정지", async () => { await ctl().getByRole("button", { name: "정지", exact: true }).click(); });
  for (const sp of ["1×", "5×", "30×", "60×", "10×"]) await step(page, net, `replay: speed ${sp}`, async () => { const b = ctl().getByRole("button", { name: sp, exact: true }); await b.click(); return `pressed=${await b.getAttribute("aria-pressed")}`; }, { settle: 400 });
  for (const st of ["−1h", "−10m", "−1m", "+1m", "+10m", "+1h"]) await step(page, net, `replay: step ${st}`, async () => { const b = ctl().getByRole("button", { name: st, exact: true }); if (await b.isDisabled()) return "disabled"; await b.click(); return `input=${await page.getByTestId("replay-at-input").inputValue()}`; }, { settle: 1500 });
  await step(page, net, "replay: type datetime (KST) 1 h ago", async () => {
    const inp = page.getByTestId("replay-at-input");
    const v = await inp.inputValue();
    const d = new Date(Date.parse(v + ":00Z") - 3600_000).toISOString().slice(0, 16);
    await inp.fill(d);
    return `${v} → ${await inp.inputValue()} · status=${(await page.locator('[data-testid="replay-controls"] ~ div').first().innerText().catch(() => "")).slice(0, 160)}`;
  }, { settle: 2500 });
  await step(page, net, "replay: slider keyboard ← ← →", async () => { const s = page.getByRole("slider", { name: "재생 시각" }); await s.focus(); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowRight"); return `valuetext=${await s.getAttribute("aria-valuetext")}`; }, { settle: 2500 });
  await step(page, net, "replay: radar toggle", async () => { const b = ctl().getByRole("button", { name: "레이더", exact: true }); if (await b.isDisabled()) return "disabled (no radar for that time)"; await b.click(); const p = await b.getAttribute("aria-pressed"); await b.click(); return `pressed ${p} → ${await b.getAttribute("aria-pressed")}`; });
  await step(page, net, "replay: list open", async () => { await page.getByTestId("replay-list-toggle").click(); return `items=${await page.getByTestId("replay-list").locator("button, [role=option], li").count()}`; }, { axe: true, settle: 1500 });
  await shot(page, "replay-list-open.png");
  await step(page, net, "replay: list → first item (keyboard)", async () => {
    const it = page.getByTestId("replay-list").locator("button").first();
    if (!(await it.isVisible().catch(() => false))) return "no items";
    await it.focus(); await page.keyboard.press("Enter");
    return `inspector=${await page.getByTestId("replay-inspector").isVisible().catch(() => false)}`;
  }, { axe: true, settle: 1500 });
  await shot(page, "replay-inspector.png");
  await step(page, net, "replay: inspector 닫기 (keyboard)", async () => { const b = page.getByTestId("replay-inspector").getByRole("button", { name: "닫기" }); if (await b.isVisible().catch(() => false)) { await b.focus(); await page.keyboard.press("Enter"); } });
  await step(page, net, "replay: list close", async () => { await page.getByTestId("replay-list-toggle").click(); });

  // ── 통계
  await step(page, net, "stats: open", async () => { await page.goto("/stats"); await page.locator("[data-stats-panel]").first().waitFor(); }, { axe: true, settle: 3000 });
  await step(page, net, "stats: date − 1 day (keyboard ArrowDown on day field)", async () => {
    const d = page.getByLabel("집계 날짜(KST)"); const before = await d.inputValue(); await d.focus(); await page.keyboard.press("ArrowDown"); await page.waitForTimeout(800);
    return `${before} → ${await d.inputValue()} · traffic panel=${(await page.locator('[data-stats-panel="traffic"]').innerText()).replace(/\s+/g, " ").slice(0, 160)}`;
  }, { settle: 2000 });
  await step(page, net, "stats: date + 2 days (beyond max?)", async () => {
    const d = page.getByLabel("집계 날짜(KST)"); await d.focus(); await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowUp"); await page.waitForTimeout(800);
    return `now=${await d.inputValue()} max=${await d.getAttribute("max")} · traffic panel=${(await page.locator('[data-stats-panel="traffic"]').innerText()).replace(/\s+/g, " ").slice(0, 200)}`;
  }, { settle: 2000 });
  await step(page, net, "stats: panel texts", async () => (await page.locator("[data-stats-panel]").evaluateAll((ps) => ps.map((p) => `${(p as HTMLElement).dataset.statsPanel}[${(p as HTMLElement).dataset.state}]: ${(p as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 140)}`))).join(" || "));

  // ── 공항
  await step(page, net, "airport RKSI: open", async () => { await page.goto("/airports/RKSI"); await page.waitForTimeout(3000); return (await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 400); }, { axe: true });
  await shot(page, "airport-rksi.png", true);
  await step(page, net, "airport lower-case rksi", async () => { await page.goto("/airports/rksi"); await page.waitForTimeout(3000); return `h1=${await page.locator("h1").innerText()} · ${(await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 200)}`; });
  await step(page, net, "airport unknown ZZZZ: 로그 보기 link target", async () => { await page.goto("/airports/ZZZZ"); await page.waitForTimeout(2500); return `href=${await page.getByRole("link", { name: "로그 보기" }).getAttribute("href")}`; }, { axe: true });
  await step(page, net, "airport unknown: copy request id button", async () => { const b = page.getByRole("button", { name: /요청 id .* 복사/ }); await b.click(); return `after click: ${(await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 200)}`; });

  // ── 설명서
  await step(page, net, "guide: open", async () => { await page.goto("/guide"); await page.waitForTimeout(2500); });
  await step(page, net, "guide: TOC link 2.8 (keyboard)", async () => { const a = page.getByRole("link", { name: /2\.8.*레이더 타임라인/ }).first(); await a.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(800); return `hash=${await page.evaluate(() => location.hash)} focus=${(await focusInfo(page)).tag} scrollTarget visible=${await page.locator("#radar-timeline, [id*=radar]").first().isVisible().catch(() => false)}`; });
  await step(page, net, "guide: figure link opens a png", async () => { const a = page.getByRole("link", { name: /원본 크기로 열기/ }).first(); return `href=${await a.getAttribute("href")} target=${await a.getAttribute("target")}`; });
  await step(page, net, "guide mobile 375: TOC select", async () => {
    await page.setViewportSize({ width: 375, height: 812 }); await page.waitForTimeout(800);
    const sel = page.getByLabel("설명서 목차 — 이동할 절"); const vis = await sel.isVisible();
    if (vis) { const opts = await sel.locator("option").allInnerTexts(); await sel.selectOption({ index: Math.min(5, opts.length - 1) }); }
    return `select visible=${vis} hash=${await page.evaluate(() => location.hash)}`;
  }, { axe: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── 출처 · 한계(키보드로 스크롤할 수 있는가)
  await step(page, net, "about: keyboard scroll (skip link → main → PageDown/Space/End)", async () => {
    await page.goto("/about"); await page.waitForTimeout(1500);
    const sc = page.locator("main .overflow-y-auto").first();
    const max = await sc.evaluate((e) => e.scrollHeight - e.clientHeight);
    await page.keyboard.press("Tab"); await page.keyboard.press("Enter"); // 본문으로 건너뛰기
    for (const k of ["PageDown", "Space", "ArrowDown", "End"]) await page.keyboard.press(k);
    const after = await sc.evaluate((e) => e.scrollTop);
    let tabbable = false;
    for (let i = 0; i < 40; i++) { await page.keyboard.press("Tab"); if (await sc.evaluate((e) => document.activeElement === e || e.contains(document.activeElement))) { tabbable = true; break; } }
    return `scrollable by ${max}px · scrollTop after keys=${after} · focus can enter scroller=${tabbable}`;
  });
  saveJson("pages-steps.json", { steps });
});
