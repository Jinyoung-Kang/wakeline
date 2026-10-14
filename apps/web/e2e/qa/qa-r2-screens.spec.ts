import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { duplicates, instrument, isBlockedNoise, overflow, runAxe, type AxeViolation, type Net } from "./qa-helpers";

/**
 * 출시 QA 2차(docs/qa/2026-10-release — 계획 §3.3 화면 · §3.6 접근성): 앞선 QA 뒤 더한 화면 · 탭을 실제 브라우저로 눌러 보며 콘솔 오류 · 실패한 요청 · 중복 요청 ·
 * axe(WCAG 2.1 A · AA) 위반 · 가로 넘침을 모은다. 격리 스택 A(8701)만. 결과는 evidence/ui-a11y/r2-screens.json — 시험은 모은 것이 하나라도 있으면 실패한다
 * (무엇이 나왔는지 한 번에 보이게 끝에서 판정).
 */
const BASE = process.env.QA_BASE_URL ?? "http://localhost:8701";
if (new URL(BASE).port !== "8701") throw new Error(`QA 는 격리 스택 A 만: ${BASE}`);
const REPO = path.resolve(__dirname, "../../../..");
const OUT = process.env.QA_EVIDENCE_DIR ? path.resolve(process.env.QA_EVIDENCE_DIR) : path.join(REPO, "docs/qa/2026-10-release/evidence/ui-a11y");
type Finding = { screen: string; kind: string; detail: unknown };
const FOUND: Finding[] = [];
const LOG: Record<string, unknown>[] = [];

async function check(page: Page, net: Net, screen: string, opts: { overflow?: boolean; axeExclude?: string[] } = {}) {
  await page.waitForTimeout(800);
  const axe: AxeViolation[] = await runAxe(page, { exclude: opts.axeExclude ?? [] });
  const consoleErr = net.console.filter((c) => c.type === "error" && !isBlockedNoise(c.text));
  const dup = duplicates(net.requests).filter((d) => !/\/api\/v1\/(status|warnings|watch)|_rsc=/.test(d.url));
  const ov = opts.overflow ? await overflow(page) : null;
  LOG.push({ screen, axe: axe.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, t: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) })), console: consoleErr,
    pageErrors: [...net.pageErrors], bad: [...net.bad], failed: [...net.failed], dup, overflow: ov });
  for (const v of axe) FOUND.push({ screen, kind: `axe:${v.id}`, detail: v.nodes.slice(0, 3).map((n) => ({ t: n.target.join(" "), html: n.html.slice(0, 120) })) });
  for (const c of consoleErr) FOUND.push({ screen, kind: "console", detail: c.text });
  for (const e of net.pageErrors) FOUND.push({ screen, kind: "pageerror", detail: e.text });
  for (const b of net.bad.filter((x) => !/\/api\/v1\/alerts\/1$|\/alerts\/not-a-number/.test(x.url))) FOUND.push({ screen, kind: `http ${b.status}`, detail: b.url });
  for (const f of net.failed) FOUND.push({ screen, kind: "failed", detail: `${f.url} ${f.error}` });
  for (const d of dup) FOUND.push({ screen, kind: "duplicate", detail: d });
  if (ov?.overflow || (ov?.offenders.length ?? 0) > 0) FOUND.push({ screen, kind: "overflow", detail: ov });
  net.reset();
}

test.describe.configure({ mode: "serial" });

test("round-2 screens: wx tab · watch tab · ship card · aircraft card · alert evidence · /alerts/[id] · /m · replay link", async ({ page, request }) => {
  test.setTimeout(600_000);
  execFileSync("python3", [path.join(REPO, "tools/qa/inject_stream.py"), "ship"], { cwd: REPO });
  await page.addInitScript(() => {
    localStorage.setItem("wakeline.watch", JSON.stringify([{ kind: "airport", id: "RKSI" }, { kind: "ship", id: "440999001" }]));
    class N { static permission = "default"; static requestPermission = async () => { N.permission = "granted"; return "granted"; }; onclick = null; constructor() {} close() {} }
    Object.defineProperty(window, "Notification", { value: N, configurable: true });
  });
  const net = await instrument(page);

  // 상황판 — wx · watch 탭
  await page.goto("/");
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 30_000 });
  await page.getByTestId("tab-wx").click();
  await expect(page.getByTestId("warnings-status")).toBeVisible();
  const land = page.getByTestId("warnings-land");
  if (await land.count()) await land.locator("summary").click();
  await check(page, net, "/ wx tab");
  await page.getByTestId("tab-watch").click();
  await expect(page.getByTestId("watch-item")).toHaveCount(2, { timeout: 30_000 });
  const allow = page.getByRole("button", { name: "알림 켜기" });
  if (await allow.count()) await allow.click();
  await check(page, net, "/ watch tab");

  // 선박 카드(신뢰도 한 줄 · 해상특보 줄 · 관심 대상 단추)
  await page.locator("body").press("/");
  await page.keyboard.type("440999001");
  const ship = page.locator('[data-testid="ship-search-item"][data-mmsi="440999001"]').first();
  await expect(ship).toBeVisible({ timeout: 20_000 });
  await ship.click();
  await expect(page.getByTestId("ship-card")).toBeVisible();
  await expect(page.getByTestId("reliability")).toBeVisible();
  await check(page, net, "/ ship card");
  await page.getByTestId("ship-card").getByTestId("watch-toggle").click();
  await check(page, net, "/ ship card after watch toggle");
  await page.keyboard.press("Escape");

  // 항공기 카드 — 관심 지역의 첫 항공기
  const ac = await (await request.get("/api/v1/aircraft?bbox=124,33,132,39")).json();
  const hex: string = ac.features[0].id;
  await page.locator("body").press("/");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(hex.toUpperCase());
  const acItem = page.getByTestId("aircraft-search-item").filter({ hasText: hex }).first();
  await expect(acItem).toBeVisible({ timeout: 20_000 });
  await acItem.click();
  await expect(page.getByTestId("aircraft-card")).toBeVisible();
  await check(page, net, "/ aircraft card");

  // 알림 근거 카드(링크 · 판정 때 신뢰도) — 알림 탭의 첫 줄을 펼친다
  await page.getByTestId("tab-alerts").click();
  const row = page.locator('[data-testid="alert-row"] button[aria-expanded]').first();
  if (await row.count()) { await row.click(); await expect(page.getByTestId("evidence").first()).toBeVisible(); }
  await check(page, net, "/ alert evidence");

  // 고정 링크 화면 · 인쇄 모양
  const alerts = await (await request.get("/api/v1/alerts")).json();
  const id = alerts.items[0]?.id ?? 1;
  await page.goto(`/alerts/${id}`);
  await expect(page.getByTestId("alert-sheet").or(page.getByTestId("alert-page-error"))).toBeVisible({ timeout: 20_000 });
  await check(page, net, `/alerts/${id} 1440`, { overflow: true });
  await page.emulateMedia({ media: "print" });
  await check(page, net, `/alerts/${id} print`);
  await page.emulateMedia({ media: "screen" });
  for (const w of [375, 320]) {
    await page.setViewportSize({ width: w, height: 760 });
    await page.goto(`/alerts/${id}`);
    await expect(page.getByTestId("alert-sheet").or(page.getByTestId("alert-page-error"))).toBeVisible({ timeout: 20_000 });
    await check(page, net, `/alerts/${id} ${w}`, { overflow: true });
    await page.goto("/m");
    await expect(page.getByTestId("mobile-status")).toContainText("열린 알림", { timeout: 20_000 });
    await check(page, net, `/m ${w}`, { overflow: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // 재생 링크(틀린 값 안내)
  await page.goto("/replay?at=2020-01-01T00:00:00Z&bbox=1,2,3&hex=zz");
  await expect(page.getByTestId("replay-url-note").first()).toBeVisible({ timeout: 20_000 });
  await check(page, net, "/replay bad link", { axeExclude: [".maplibregl-canvas"] });

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "r2-screens.json"), JSON.stringify({ screens: LOG, findings: FOUND }, null, 1));
  expect(FOUND, JSON.stringify(FOUND, null, 1).slice(0, 4000)).toEqual([]);
});
