import { test, type Page } from "@playwright/test";
import { assertIsolated, duplicates, focusInfo, instrument, isBlockedNoise, runAxe, saveJson, shot, type Net } from "./qa-helpers";

/**
 * QA 2026-10 §3.3 · §3.6 — 상황판(/)의 모든 조작을 눌러 보며 단계마다 콘솔 오류 · 페이지 오류 · 실패한 요청 · 1.5 s 안의 같은 요청(중복)을 모으고,
 * 주요 상태(카드 열림 · 목록 탭 · 범례 · 근거 카드 · 상태 상세)에서 axe 를 돌린다. 쓰기 없음(조작은 모두 브라우저 상태 — 레이어 단추는 원래대로 되돌린다).
 * 결과: docs/qa/2026-10/evidence/ui-a11y/dashboard-steps.json. 외부 호스트는 막는다(배경지도 · 레이더 타일 그림은 보지 않는다).
 */
interface Step { name: string; ok: boolean; note?: string; focus?: unknown; consoleErrors: string[]; pageErrors: string[]; bad: string[]; failed: string[]; dup: unknown[]; api: string[]; axe?: unknown }

async function step(page: Page, net: Net, steps: Step[], name: string, fn: () => Promise<string | void>, opts: { axe?: boolean; settle?: number } = {}) {
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
  saveJson("dashboard-steps.json", { steps }); // 단계마다 — 중간에 멈춰도 남게
}

test("dashboard: every control, step by step", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(480_000);
  const net = await instrument(page);
  const steps: Step[] = [];
  await page.goto("/");
  await page.getByTestId("layer-aircraft").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(8000);

  // ── 통합 검색: "/" → 입력 → ↓ → Enter → 카드
  await step(page, net, steps, "search: '/' focuses the input", async () => { await page.locator("body").click({ position: { x: 700, y: 400 } }); await page.keyboard.press("/"); });
  await step(page, net, steps, "search: type KAL (debounced)", async () => { await page.keyboard.type("KAL"); }, { settle: 2000 });
  await step(page, net, steps, "search: ArrowDown + Enter opens aircraft card", async () => {
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "닫기" }).first().waitFor({ timeout: 10_000 });
    return `panel aircraft pressed=${await page.getByTestId("tab-aircraft").getAttribute("aria-pressed")}`;
  }, { axe: true, settle: 2500 });
  await shot(page, "dashboard-aircraft-card.png");
  await step(page, net, steps, "card: Escape (does it close the card?)", async () => {
    await page.getByRole("button", { name: "닫기" }).first().focus();
    await page.keyboard.press("Escape");
    return `close button still visible=${await page.getByRole("button", { name: "닫기" }).first().isVisible().catch(() => false)}`;
  });
  await step(page, net, steps, "card: click 닫기 — where does focus go?", async () => {
    const b = page.getByRole("button", { name: "닫기" }).first();
    if (await b.isVisible().catch(() => false)) { await b.focus(); await page.keyboard.press("Enter"); }
  });

  // ── 레이어 단추: 하나씩 켜고 끄고 원래대로
  for (const id of ["layer-radar", "layer-sigmet", "layer-aircraft", "layer-ships", "layer-reception", "layer-airports", "layer-tracks", "layer-prediction", "layer-traffic"]) {
    await step(page, net, steps, `layer toggle ${id} (1st)`, async () => { const b = page.getByTestId(id); const before = await b.getAttribute("aria-pressed"); await b.click(); return `pressed ${before} → ${await b.getAttribute("aria-pressed")}`; }, { settle: 2500, axe: id === "layer-ships" || id === "layer-traffic" || id === "layer-reception" });
    if (id === "layer-ships" || id === "layer-traffic" || id === "layer-reception") await shot(page, `dashboard-${id}-on.png`);
    await step(page, net, steps, `layer toggle ${id} (restore)`, async () => { const b = page.getByTestId(id); await b.click(); return `pressed → ${await b.getAttribute("aria-pressed")}`; }, { settle: 1500 });
  }

  // ── 범례
  await step(page, net, steps, "legend open", async () => { const b = page.getByTestId("legend-toggle"); await b.click(); return `expanded=${await b.getAttribute("aria-expanded")}`; }, { axe: true });
  await shot(page, "dashboard-legend-open.png");
  await step(page, net, steps, "legend: Escape", async () => { await page.keyboard.press("Escape"); return `expanded=${await page.getByTestId("legend-toggle").getAttribute("aria-expanded")}`; });
  await step(page, net, steps, "legend close (click)", async () => { const b = page.getByTestId("legend-toggle"); if ((await b.getAttribute("aria-expanded")) === "true") await b.click(); return `expanded=${await b.getAttribute("aria-expanded")}`; });

  // ── 오른쪽 탭
  await step(page, net, steps, "tab aircraft (no selection)", async () => { await page.getByTestId("tab-aircraft").click(); });
  await step(page, net, steps, "tab ship (layer off → 선박 켜기)", async () => {
    await page.getByTestId("tab-ship").click();
    const on = page.getByTestId("ship-panel-off").getByRole("button", { name: "선박 켜기" });
    if (await on.isVisible().catch(() => false)) { await on.click(); return "clicked 선박 켜기"; }
    return "ship layer already on";
  }, { settle: 3000 });
  await step(page, net, steps, "ship list: zoom out to see ships", async () => {
    await page.getByRole("button", { name: "Zoom out" }).first().click(); await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Zoom out" }).first().click();
    return `rows=${await page.getByTestId("ship-list").locator("[data-mmsi]").count()}`;
  }, { axe: true, settle: 4000 });
  await shot(page, "dashboard-tab-ship.png");
  await step(page, net, steps, "ship list: filter by text", async () => {
    const f = page.getByTestId("ship-list-filter"); await f.fill("A"); await page.waitForTimeout(500);
    const n = await page.getByTestId("ship-list").locator("[data-mmsi]").count(); await f.fill(""); return `rows with 'A'=${n}`;
  });
  await step(page, net, steps, "ship list: sort by each header (twice)", async () => {
    const sorts = page.getByTestId("ship-list").locator('button[data-testid*="-sort-"]');
    const n = await sorts.count();
    const done: string[] = [];
    for (let i = 0; i < n; i++) { const b = sorts.nth(i); await b.click(); await page.waitForTimeout(150); await b.click(); done.push(`${await b.getAttribute("data-testid")}:${await b.locator("xpath=..").getAttribute("aria-sort")}`); }
    return done.join(", ");
  });
  await step(page, net, steps, "ship list: open first ship card (keyboard Enter on row button)", async () => {
    const row = page.getByTestId("ship-list").locator("[data-mmsi] button").first();
    if (!(await row.isVisible().catch(() => false))) return "no ship rows";
    await row.focus(); await page.keyboard.press("Enter");
    await page.getByTestId("ship-card").waitFor({ timeout: 10_000 });
  }, { axe: true, settle: 3000 });
  await shot(page, "dashboard-ship-card.png");
  await step(page, net, steps, "ship card: track hours buttons", async () => {
    const hs = page.locator('[data-testid^="ship-track-hours-"]'); const n = await hs.count(); const out: string[] = [];
    for (let i = 0; i < n; i++) { await hs.nth(i).click(); await page.waitForTimeout(700); out.push(`${await hs.nth(i).getAttribute("data-testid")}=${await hs.nth(i).getAttribute("aria-pressed")}`); }
    if (n) await hs.first().click();
    return out.join(", ");
  }, { settle: 1500 });
  await step(page, net, steps, "ship card: close (keyboard) — focus after?", async () => { const b = page.getByTestId("ship-card").getByRole("button", { name: "닫기" }); if (await b.isVisible().catch(() => false)) { await b.focus(); await page.keyboard.press("Enter"); } });
  await step(page, net, steps, "ship layer: restore off", async () => { const b = page.getByTestId("layer-ships"); if ((await b.getAttribute("aria-pressed")) === "true") await b.click(); return `pressed=${await b.getAttribute("aria-pressed")}`; });
  await step(page, net, steps, "tab sigmet (list)", async () => { await page.getByTestId("tab-sigmet").click(); }, { axe: true, settle: 2000 });
  await step(page, net, steps, "sigmet list: open first", async () => {
    const it = page.getByTestId("sigmet-list-item").first();
    if (!(await it.isVisible().catch(() => false))) return "no sigmet item";
    await it.focus(); await page.keyboard.press("Enter");
  }, { axe: true, settle: 2500 });
  await shot(page, "dashboard-sigmet-card.png");
  await step(page, net, steps, "sigmet card: close (keyboard)", async () => { const b = page.getByRole("button", { name: "닫기" }).first(); if (await b.isVisible().catch(() => false)) { await b.focus(); await page.keyboard.press("Enter"); } });
  await step(page, net, steps, "tab airport (list)", async () => { await page.getByTestId("tab-airport").click(); }, { axe: true, settle: 2000 });
  await step(page, net, steps, "airport list: open first", async () => {
    const it = page.getByTestId("airport-list-item").first();
    if (!(await it.isVisible().catch(() => false))) return "no airport item";
    await it.focus(); await page.keyboard.press("Enter");
  }, { axe: true, settle: 3000 });
  await shot(page, "dashboard-airport-card.png");
  await step(page, net, steps, "airport card: close (keyboard)", async () => { const b = page.getByRole("button", { name: "닫기" }).first(); if (await b.isVisible().catch(() => false)) { await b.focus(); await page.keyboard.press("Enter"); } });
  await step(page, net, steps, "tab alerts", async () => { await page.getByTestId("tab-alerts").click(); });

  // ── 알림: 범위 · 근거 카드
  await step(page, net, steps, "alerts scope world", async () => { await page.getByTestId("alerts-scope-world").click(); return `pressed=${await page.getByTestId("alerts-scope-world").getAttribute("aria-pressed")}`; });
  await step(page, net, steps, "alerts scope region", async () => { await page.getByTestId("alerts-scope-region").click(); });
  await step(page, net, steps, "alert toggle: open evidence", async () => { const t = page.getByTestId("alert-toggle").first(); await t.click(); return `expanded=${await t.getAttribute("aria-expanded")}`; }, { axe: true });
  await shot(page, "dashboard-alert-evidence.png");
  await step(page, net, steps, "alert evidence: open aircraft card (keyboard)", async () => { const b = page.getByTestId("alert-open-aircraft").first(); if (await b.isVisible().catch(() => false)) { await b.focus(); await page.keyboard.press("Enter"); } else return "no button"; }, { settle: 2500 });
  await step(page, net, steps, "back to alerts: evidence still open?", async () => { await page.getByTestId("tab-alerts").click(); return `expanded toggles=${await page.locator('[data-testid="alert-toggle"][aria-expanded="true"]').count()}`; });
  await step(page, net, steps, "alert toggle: close evidence", async () => { const t = page.locator('[data-testid="alert-toggle"][aria-expanded="true"]').first(); if (await t.isVisible().catch(() => false)) await t.click(); });

  // ── 레이더 타임라인
  await step(page, net, steps, "radar source KMA", async () => { if (await page.getByTestId("radar-src-kma").isDisabled()) return `disabled title=${await page.getByTestId("radar-src-kma").getAttribute("title")}`; await page.getByTestId("radar-src-kma").click(); return `pressed=${await page.getByTestId("radar-src-kma").getAttribute("aria-pressed")} disabled=${await page.getByTestId("radar-src-kma").isDisabled()}`; }, { settle: 2500, axe: true });
  await shot(page, "dashboard-radar-kma.png");
  await step(page, net, steps, "radar source RainViewer", async () => { await page.getByTestId("radar-src-rv").click(); }, { settle: 2000 });
  await step(page, net, steps, "radar play", async () => { await page.getByTestId("radar-play").click(); return `pressed=${await page.getByTestId("radar-play").getAttribute("aria-pressed")}`; }, { settle: 3000 });
  await step(page, net, steps, "radar pause", async () => { await page.getByTestId("radar-play").click(); return `pressed=${await page.getByTestId("radar-play").getAttribute("aria-pressed")}`; });
  await step(page, net, steps, "radar slider ← ← (keyboard)", async () => { const s = page.getByRole("slider", { name: "레이더 프레임" }); await s.focus(); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft"); return `value=${await s.inputValue()} valuetext=${await s.getAttribute("aria-valuetext")}`; });
  await step(page, net, steps, "radar latest", async () => { await page.getByTestId("radar-latest").click(); });
  await step(page, net, steps, "radar 범례·정합 open", async () => { await page.getByTestId("kr-radar-toggle").click(); return `pressed=${await page.getByTestId("kr-radar-toggle").getAttribute("aria-pressed")}`; }, { axe: true });
  await shot(page, "dashboard-kr-radar-panel.png");
  await step(page, net, steps, "radar 범례·정합 close", async () => { await page.getByTestId("kr-radar-toggle").click(); });

  // ── 상태 바 상세
  await step(page, net, steps, "statusbar details open", async () => { await page.getByTestId("statusbar-details-toggle").click(); }, { axe: true });
  await shot(page, "dashboard-statusbar-details.png");
  await step(page, net, steps, "statusbar details: Escape (focus returns?)", async () => { await page.keyboard.press("Escape"); return `expanded=${await page.getByTestId("statusbar-details-toggle").getAttribute("aria-expanded")}`; });

  // ── 지도 확대 · 축소 단추
  await step(page, net, steps, "map zoom in", async () => { await page.getByRole("button", { name: "Zoom in" }).first().click(); }, { settle: 2500 });
  await step(page, net, steps, "map zoom out", async () => { await page.getByRole("button", { name: "Zoom out" }).first().click(); }, { settle: 2500 });

  // ── 30 s 가만히: 주기 요청과 중복
  await step(page, net, steps, "idle 30 s (poll cadence / duplicates)", async () => { await page.waitForTimeout(30_000); }, { settle: 0 });

  saveJson("dashboard-steps.json", { blockedExternalHosts: Object.fromEntries(net.blockedHosts), steps });
});
