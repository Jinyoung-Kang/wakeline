import { test, type Page } from "@playwright/test";
import { assertIsolated, duplicates, focusInfo, instrument, isBlockedNoise, loginOps, overflow, runAxe, saveJson, shot, type Net } from "./qa-helpers";

/**
 * QA 2026-10 §3.3 · §3.6 — 운영(/ops) · 로그(/logs): 실제 로그인 폼으로 qa-b 로그인 → 탭마다 axe · 스크린샷 · 콘솔 · 요청,
 * 쓰기는 흐름만 보고 곧바로 되돌린다(스택 A 공유): 설정 sigmet_poll_s 를 +1 저장 → 원래 값으로 저장, 공급자 opensky 끄기 → 켜기(fixture 스택은 표에 실행한 공급자만 — opensky · fixture).
 * 로그: 목록 · 묶음 · 상세 · 필터(서비스 · 수준 · 기간 · 해결 · 글자 · 요청 id) · 이전 항목 더 보기 · 새 항목(브라우저 오류 하나를 보내 만든다) · AIS 수신 공백.
 * 결과: docs/qa/2026-10/evidence/ui-a11y/ops-logs-steps.json.
 */
interface Step { name: string; ok: boolean; note?: string; focus?: unknown; consoleErrors: string[]; pageErrors: string[]; bad: string[]; failed: string[]; dup: unknown[]; api: string[]; axe?: unknown; overflow?: unknown }
const steps: Step[] = [];

async function step(page: Page, net: Net, name: string, fn: () => Promise<string | void>, opts: { axe?: boolean; settle?: number; overflow?: boolean } = {}) {
  net.reset();
  let ok = true, note: string | undefined;
  try { note = (await fn()) ?? undefined; } catch (e) { ok = false; note = String(e).slice(0, 400); }
  await page.waitForTimeout(opts.settle ?? 1500);
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
  if (opts.overflow) s.overflow = await overflow(page);
  steps.push(s);
  saveJson("ops-logs-steps.json", { steps });
}

test("ops + logs: sign in through the form, every tab, guarded writes restored", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(900_000);
  const net = await instrument(page);
  await step(page, net, "ops: sign in (qa-b) through the login form", async () => { await loginOps(page, "qa-b"); }, { settle: 3000 });

  const tabs = await page.locator('[role="group"][aria-label="운영 탭"] button').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid ?? ""));
  for (const t of tabs) {
    await step(page, net, `ops tab ${t}`, async () => { await page.getByTestId(t).click(); return `pressed=${await page.getByTestId(t).getAttribute("aria-pressed")}`; }, { axe: true, settle: 2500 });
    await shot(page, `ops-${t}.png`);
  }

  // RUNS: 해결된 오류 포함 켜고 끔 · 요약 행 열기 · 더 보기 · 접기
  await step(page, net, "runs: 해결된 오류 포함 on", async () => { await page.getByTestId("ops-tab-runs").click(); await page.getByTestId("runs-show-resolved").click(); return `pressed=${await page.getByTestId("runs-show-resolved").getAttribute("aria-pressed")}`; }, { settle: 2500 });
  await step(page, net, "runs: 해결된 오류 포함 off", async () => { await page.getByTestId("runs-show-resolved").click(); return `pressed=${await page.getByTestId("runs-show-resolved").getAttribute("aria-pressed")}`; }, { settle: 2500 });
  await step(page, net, "runs: open first summary row (keyboard)", async () => {
    const b = page.getByTestId("runs-drill-open").first();
    if (!(await b.isVisible().catch(() => false))) return "no summary rows";
    await b.focus(); await page.keyboard.press("Enter");
    await page.getByTestId("runs-drill").waitFor({ timeout: 10_000 });
    return `drill rows=${await page.getByTestId("runs-drill").locator("tr").count()}`;
  }, { axe: true, settle: 2500 });
  await shot(page, "ops-runs-drill.png");
  await step(page, net, "runs: drill 더 보기 (if any)", async () => {
    const more = page.getByTestId("runs-drill").getByRole("button", { name: /더 보기/ });
    if (!(await more.isVisible().catch(() => false))) return "no more button";
    await more.click();
  }, { settle: 2500 });
  await step(page, net, "runs: close drill (Escape?)", async () => { await page.keyboard.press("Escape"); return `drill visible after Esc=${await page.getByTestId("runs-drill").isVisible().catch(() => false)}`; });
  await step(page, net, "runs: close drill (button)", async () => { const b = page.getByTestId("runs-drill-open").first(); if ((await b.getAttribute("aria-expanded")) === "true") { await b.focus(); await page.keyboard.press("Enter"); } return `expanded=${await b.getAttribute("aria-expanded")}`; });

  // SETTINGS: sigmet_poll_s 를 +1 저장 → 원래 값으로 저장(되돌림)
  let original = "";
  await step(page, net, "settings: edit sigmet_poll_s (+1) and save", async () => {
    await page.getByTestId("ops-tab-settings").click();
    const row = page.getByTestId("setting-row").filter({ hasText: "sigmet_poll_s" });
    const input = row.getByLabel("sigmet_poll_s 값");
    original = await input.inputValue();
    await input.fill(String(Number(original) + 1));
    await row.getByRole("button", { name: "save" }).click();
    await page.getByTestId("settings-ok").waitFor({ timeout: 10_000 });
    return `original=${original} → ${Number(original) + 1}: ${await page.getByTestId("settings-ok").textContent()}`;
  }, { axe: true, settle: 2500 });
  await shot(page, "ops-settings-saved.png");
  await step(page, net, "settings: restore sigmet_poll_s", async () => {
    const row = page.getByTestId("setting-row").filter({ hasText: "sigmet_poll_s" });
    const input = row.getByLabel("sigmet_poll_s 값");
    await input.fill(original);
    await row.getByRole("button", { name: "save" }).click();
    await page.waitForTimeout(1500);
    return `now=${await input.inputValue()} msg=${await page.getByTestId("settings-ok").textContent().catch(() => "")} err=${await page.getByTestId("settings-error").textContent().catch(() => "")}`;
  }, { settle: 2000 });
  await step(page, net, "settings: invalid value (client validation)", async () => {
    const row = page.getByTestId("setting-row").filter({ hasText: "sigmet_poll_s" });
    const input = row.getByLabel("sigmet_poll_s 값");
    await input.fill("-5");
    await row.getByRole("button", { name: "save" }).click();
    const err = await page.getByTestId("settings-error").textContent().catch(() => "");
    const desc = await input.getAttribute("aria-describedby");
    await input.fill(original); // 저장하지 않고 되돌림(편집 상태만)
    return `error="${err}" aria-invalid=${await input.getAttribute("aria-invalid")} describedby=${desc}`;
  }, { axe: true });

  // PROVIDERS: adsbdb 끄기 → 켜기(되돌림)
  await step(page, net, "providers: disable opensky", async () => {
    await page.getByTestId("ops-tab-providers").click();
    await page.waitForTimeout(1500);
    const row = page.locator("tr").filter({ has: page.locator("td.mono", { hasText: /^opensky/ }) }).first();
    await row.getByRole("button", { name: "disable" }).click();
    await page.waitForTimeout(2500);
    return `ok=${await page.getByTestId("switch-ok").textContent().catch(() => "")} err=${await page.getByTestId("switch-error").textContent().catch(() => "")} unmirrored=${await page.getByTestId("switch-unmirrored").textContent().catch(() => "")}`;
  }, { settle: 1500 });
  await shot(page, "ops-provider-disabled.png");
  await step(page, net, "providers: enable opensky (restore)", async () => {
    const row = page.locator("tr").filter({ has: page.locator("td.mono", { hasText: /^opensky/ }) }).first();
    await row.getByRole("button", { name: "enable" }).click();
    await page.waitForTimeout(2500);
    return `ok=${await page.getByTestId("switch-ok").textContent().catch(() => "")} enable-visible-still=${await row.getByRole("button", { name: "enable" }).isVisible().catch(() => false)}`;
  }, { settle: 1500 });
  await step(page, net, "ops: 새로고침", async () => { await page.getByRole("button", { name: "새로고침" }).click(); }, { settle: 2500 });
  await step(page, net, "ops: idle 35 s (15 s poll — duplicates?)", async () => { await page.waitForTimeout(35_000); }, { settle: 0 });
  await step(page, net, "ops: audit after writes", async () => {
    await page.getByTestId("ops-tab-audit").click(); await page.waitForTimeout(1500);
    return (await page.locator("table tbody tr").evaluateAll((rs) => rs.slice(0, 4).map((r) => (r as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 160)))).join(" || ");
  });

  // 모바일 폭: 운영 탭
  await step(page, net, "ops mobile 375: providers", async () => { await page.setViewportSize({ width: 375, height: 812 }); await page.getByTestId("ops-tab-providers").click(); }, { axe: true, overflow: true, settle: 2000 });
  await shot(page, "ops-mobile-providers.png");
  await page.setViewportSize({ width: 1440, height: 900 });

  // ── 로그
  await step(page, net, "logs: open /logs (list)", async () => { await page.goto("/logs"); await page.getByTestId("logs-dashboard").waitFor({ timeout: 20_000 }); }, { axe: true, settle: 4000 });
  await shot(page, "logs-list.png");
  await step(page, net, "logs: open first row (click) → detail", async () => { const r = page.getByTestId("log-row").first(); if (!(await r.isVisible().catch(() => false))) return "no rows"; await r.click(); await page.getByTestId("log-detail").waitFor({ timeout: 10_000 }); }, { axe: true, settle: 2000 });
  await shot(page, "logs-detail.png");
  await step(page, net, "logs: detail Escape", async () => { await page.keyboard.press("Escape"); return `detail visible=${await page.getByTestId("log-detail").isVisible().catch(() => false)}`; });
  await step(page, net, "logs: detail 닫기", async () => { const b = page.getByTestId("log-detail").getByRole("button", { name: "닫기" }); if (await b.isVisible().catch(() => false)) { await b.focus(); await page.keyboard.press("Enter"); } return `detail visible=${await page.getByTestId("log-detail").isVisible().catch(() => false)}`; });
  await step(page, net, "logs: keyboard grid ↓ ↓ Enter", async () => {
    const g = page.getByTestId("log-grid"); await g.focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    return `activedescendant=${await g.getAttribute("aria-activedescendant")} detail=${await page.getByTestId("log-detail").isVisible().catch(() => false)}`;
  }, { settle: 2000 });
  for (const name of ["api", "collector", "ais", "web-client"]) {
    await step(page, net, `logs: service ${name} on`, async () => { const b = page.getByTestId("logs-filter-form").getByRole("button", { name, exact: true }); await b.click(); return `pressed=${await b.getAttribute("aria-pressed")}`; }, { settle: 2000 });
    await step(page, net, `logs: service ${name} off`, async () => { const b = page.getByTestId("logs-filter-form").getByRole("button", { name, exact: true }); await b.click(); }, { settle: 1500 });
  }
  for (const name of ["WARN", "ERROR", "전체"]) await step(page, net, `logs: level ${name}`, async () => { const b = page.getByTestId("logs-filter-form").getByRole("button", { name, exact: true }); await b.click(); return `pressed=${await b.getAttribute("aria-pressed")}`; }, { settle: 2000 });
  const periods = await page.getByRole("group", { name: "기간" }).getByRole("button").allInnerTexts();
  for (const p of periods) await step(page, net, `logs: period ${p}`, async () => { await page.getByRole("group", { name: "기간" }).getByRole("button", { name: p, exact: true }).click(); }, { settle: 2000 });
  await step(page, net, "logs: 해결된 항목 보기 on/off", async () => { await page.getByTestId("logs-show-resolved").click(); await page.waitForTimeout(1500); await page.getByTestId("logs-show-resolved").click(); });
  await step(page, net, "logs: text search 'QA' + Enter", async () => { await page.getByLabel("글자 검색").fill("QA"); await page.keyboard.press("Enter"); }, { settle: 2500 });
  await step(page, net, "logs: invalid request id", async () => { await page.getByRole("textbox", { name: "요청 id" }).fill("zz!!"); await page.getByRole("button", { name: "적용" }).click(); return `rid error=${await page.getByTestId("logs-rid-error").textContent().catch(() => "")} focus→${(await focusInfo(page)).tag}`; }, { axe: true });
  await step(page, net, "logs: 초기화", async () => { await page.getByRole("button", { name: "초기화" }).click(); }, { settle: 2500 });
  await step(page, net, "logs: 이전 항목 더 보기", async () => { const b = page.getByRole("button", { name: "이전 항목 더 보기" }); if (!(await b.isVisible().catch(() => false))) return "no more button"; const before = await page.getByTestId("log-row").count(); await b.click(); await page.waitForTimeout(2000); return `rows ${before} → ${await page.getByTestId("log-row").count()}`; }, { settle: 1500 });
  await step(page, net, "logs: groups view", async () => { await page.getByRole("button", { name: "묶음(fp)" }).click(); }, { axe: true, settle: 2500 });
  await shot(page, "logs-groups.png");
  await step(page, net, "logs: group → filter by fp", async () => {
    const g = page.getByTestId("log-group").first(); if (!(await g.isVisible().catch(() => false))) return "no groups";
    await g.getByRole("button", { name: "목록으로" }).click(); return `view list pressed=${await page.getByRole("button", { name: "목록", exact: true }).getAttribute("aria-pressed")} fp chip=${await page.getByRole("button", { name: "지문 필터 해제" }).isVisible().catch(() => false)}`;
  }, { settle: 2500 });
  await step(page, net, "logs: back to list view", async () => { await page.getByRole("button", { name: "목록", exact: true }).click(); }, { settle: 2000 });
  // 새 항목: 브라우저 오류 하나를 보내(같은 출처 — 화면이 쓰는 경로) 15 s 확인 뒤 단추가 나오는지
  await step(page, net, "logs: '새 항목' button after a new client error", async () => {
    await page.getByRole("button", { name: "초기화" }).click();
    await page.waitForTimeout(2000);
    await page.evaluate(async () => { await fetch("/api/v1/client-errors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "QA-ui probe — 새 항목 확인(무해)", stack: "", component: "e2e/qa/qa-ops-logs", path: "/logs", ts: new Date().toISOString() }) }); });
    const nb = page.getByTestId("logs-new");
    await nb.waitFor({ timeout: 40_000 });
    const label = await nb.innerText();
    await nb.click();
    return `button "${label}" → rows=${await page.getByTestId("log-row").count()}`;
  }, { settle: 2000 });
  await step(page, net, "logs: AIS 수신 공백 tab", async () => { await page.getByRole("group", { name: "로그 탭" }).getByRole("button", { name: "AIS 수신 공백" }).click(); }, { axe: true, settle: 3000 });
  await shot(page, "logs-ais-gaps.png");
  await step(page, net, "logs: back to 로그 tab", async () => { await page.getByRole("group", { name: "로그 탭" }).getByRole("button", { name: "로그", exact: true }).click(); }, { settle: 2000 });
  await step(page, net, "logs mobile 375: list", async () => { await page.setViewportSize({ width: 375, height: 812 }); }, { axe: true, overflow: true, settle: 2000 });
  await shot(page, "logs-mobile-list.png");
  await page.setViewportSize({ width: 1440, height: 900 });
  await step(page, net, "logs: sign out", async () => { await page.getByRole("button", { name: "sign out" }).click(); await page.getByTestId("ops-login").waitFor({ timeout: 10_000 }); return `focus after sign out=${(await focusInfo(page)).tag}`; }, { settle: 1500 });
});
