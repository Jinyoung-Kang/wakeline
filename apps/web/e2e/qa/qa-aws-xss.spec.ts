import { expect, test, type Page } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertIsolated, loginOps, saveJson, shot } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA 2026-10-aws(계획 §3.1 XSS) — 격리 스택 A 의 스트림에 조작 문자열을 넣고(tools/qa/inject_stream.py — WLQA_PROJECT=wlqa-a) 모든 화면에서 실행되지 않는지:
 * - SIGMET(FIR 이름 · 발표 기관 · 위험 · 한정어 · 이동 · 변화 · 원문 — 다각형은 한반도 가운데라 조작 항공기 0a5ec1(호출부호 · 등록 · 기종에 표식)이 들어가 알림이 된다)
 * - 특보(구역 · 상위 구역 · 종류 · 수준 · 명령 · 때 · 해제예고 · 원문) · 선박(이름 · 호출부호 · 목적지)
 * 화면: 상황판(SIGMET 목록 · 카드 · 알림 패널 · 근거 · 관심 탭) · /alerts/[id] 근거 화면 · /m · /replay · 브라우저 알림(Notification 대역) · JSON 내려받기 ·
 * 익명 POST /api/v1/client-errors 로 넣은 글자가 /logs 목록 · 상세 · 묶음에서.
 * 판정(앞선 QA 와 같다): 스크립트 표식 없음 · 주입 요소 없음 · CSP 위반 · 대화상자 없음, 표식 글자는 글자로 보인다.
 */
const REPO = path.resolve(__dirname, "../../../..");
const INJ = path.join(REPO, "tools/qa/inject_stream.py");
const ENV = { ...process.env, WLQA_PROJECT: process.env.WLQA_PROJECT ?? "wlqa-a" };
const INJECTED = "#qaxs, #qaxh, #qaxw, #qaxp, #qaxn, #qr, #k, #qa-xss-el, svg[onload], img[onerror], iframe[srcdoc], a[href^='javascript:'], script:not([src]):not([nonce]):not([type])";
const OUT: Record<string, unknown> = {};

function watch(page: Page) {
  const bad: string[] = [];
  page.on("console", (m) => { const t = m.text(); if (/Content Security Policy|Refused to (execute|load|apply)/i.test(t)) bad.push(t.slice(0, 300)); });
  page.on("dialog", (d) => { bad.push(`dialog: ${d.message()}`); void d.dismiss(); });
  return bad;
}
async function check(page: Page, bad: string[], label: string) {
  const flag = await page.evaluate(() => { const w = window as unknown as Record<string, unknown>; return w.__qa_xss ?? w.q ?? null; });
  const els = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((e) => e.outerHTML.slice(0, 120)), INJECTED);
  OUT[label] = { flag, els, bad: [...bad] };
  saveJson("aws-xss.json", OUT);
  expect(flag, `${label}: script marker`).toBeNull();
  expect(els, `${label}: injected elements`).toEqual([]);
  expect(bad, `${label}: CSP violations · dialogs`).toEqual([]);
}

test.describe.configure({ mode: "serial" });

test("stored XSS: crafted SIGMET + aircraft → list · card · alert · evidence page · notification · JSON download · /m · /replay", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(300_000);
  await emptyExternal(page);
  const bad = watch(page);
  await page.addInitScript(() => {
    localStorage.setItem("wakeline.watch", JSON.stringify([{ kind: "aircraft", id: "0a5ec1", label: "qa-watch-0a5ec1" }]));
    const shown: string[] = [];
    (window as unknown as { __notes: string[] }).__notes = shown;
    class N { static permission = "granted"; static requestPermission = async () => "granted"; onclick = null; constructor(t: string, o?: { body?: string }) { shown.push(`${t}|${o?.body ?? ""}`); } close() {} }
    Object.defineProperty(window, "Notification", { value: N, configurable: true });
  });
  const sig = spawn("python3", [INJ, "sigmet", "--loop", "150"], { env: ENV, stdio: "ignore" });
  const ac = spawn("python3", [INJ, "aircraft", "--loop", "150"], { env: ENV, stdio: "ignore" });
  try {
    await page.waitForTimeout(5000);
    await page.goto("/");
    await expect(page.getByTestId("conn")).toContainText("open", { timeout: 30_000 });
    await page.getByTestId("tab-sigmet").click();
    const item = page.locator('[data-testid="sigmet-list-item"][data-id^="RKRR:Q9:"]').first();
    await expect(item).toBeVisible({ timeout: 30_000 });
    await check(page, bad, "sigmet list");
    await item.click();
    await page.waitForTimeout(1500);
    OUT.sigmetCardText = (await page.locator("body").innerText()).match(/RKRR SIGMET Q9[^\n]{0,160}/)?.[0] ?? null;
    await check(page, bad, "sigmet card");
    await shot(page, "aws-xss-sigmet-card.png");
    // 알림: 조작 항공기가 조작 SIGMET 안에 — 확인 두 번(약 20 s) 뒤 알림
    await page.getByTestId("tab-alerts").click();
    await page.getByTestId("alerts-scope-world").click().catch(() => {});
    const row = page.getByTestId("alert-toggle").filter({ hasText: /0a5ec1|<i id=k>/i }).first();
    await expect(row).toBeVisible({ timeout: 90_000 });
    await row.click();
    await page.waitForTimeout(1000);
    await check(page, bad, "alert panel evidence");
    await shot(page, "aws-xss-alert-evidence.png");
    // 관심 탭 · 브라우저 알림
    await page.getByTestId("tab-watch").click();
    await page.waitForTimeout(3000);
    await check(page, bad, "watch tab");
    OUT.notifications = await page.evaluate(() => (window as unknown as { __notes: string[] }).__notes);
    // 근거 화면(공유 링크) · JSON 내려받기
    const hist = await (await page.request.get("/api/v1/alerts/history?limit=50")).json() as { items: { id: number; hex: string; sigmet_id: string }[] };
    const a = hist.items.find((x) => x.sigmet_id?.startsWith("RKRR:Q9:"));
    expect(a, "an alert for the crafted SIGMET").toBeTruthy();
    await page.goto(`/alerts/${a!.id}`);
    await page.waitForTimeout(3000);
    OUT.alertPageText = (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600);
    await check(page, bad, "/alerts/[id]");
    await shot(page, "aws-xss-alert-page.png", true);
    const dl = page.getByTestId("alert-download");
    if (await dl.count()) {
      const [d] = await Promise.all([page.waitForEvent("download"), dl.click()]);
      const p = path.join(REPO, "docs/qa/2026-10-aws/evidence/browser", `aws-xss-${d.suggestedFilename()}`);
      await d.saveAs(p);
      const txt = fs.readFileSync(p, "utf8");
      OUT.download = { name: d.suggestedFilename(), bytes: txt.length, parses: (() => { try { JSON.parse(txt); return true; } catch { return false; } })(), hasMark: txt.includes("onerror") };
      await check(page, bad, "after JSON download");
    }
    for (const r of ["/m", `/replay?hex=0a5ec1`]) {
      await page.goto(r);
      await page.waitForTimeout(6000);
      await check(page, bad, r);
    }
  } finally {
    sig.kill();
    ac.kill();
    saveJson("aws-xss.json", OUT);
  }
});

test("stored XSS: crafted warnings and ship (wx tab · ship search · card)", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(150_000);
  await emptyExternal(page);
  const bad = watch(page);
  execFileSync("python3", [INJ, "warnings"], { env: ENV });
  execFileSync("python3", [INJ, "ship"], { env: ENV });
  await page.goto("/");
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 30_000 });
  await page.getByTestId("tab-wx").click();
  await expect(page.getByTestId("warning-panel")).toContainText("<i id=qaxw>", { timeout: 30_000 });
  await page.getByTestId("warnings-land").locator("summary").click().catch(() => {});
  await page.waitForTimeout(800);
  await check(page, bad, "wx tab");
  await page.locator("body").press("/");
  await page.keyboard.type("440999001");
  const ship = page.locator('[data-testid="ship-search-item"][data-mmsi="440999001"]').first();
  await expect(ship).toBeVisible({ timeout: 15_000 });
  await ship.click();
  await expect(page.getByTestId("ship-card")).toBeVisible();
  await check(page, bad, "ship card");
});

test("stored XSS: anonymous /api/v1/client-errors text on /logs (list · detail · groups)", async ({ page, baseURL, request }) => {
  assertIsolated(baseURL);
  test.setTimeout(120_000);
  await emptyExternal(page);
  const bad = watch(page);
  const tag = `qa-aws-xss-${Date.now()}`;
  const P = [`<img src=x onerror="window.__qa_xss=21">`, `<svg/onload=window.__qa_xss=22>`, `<i id="qa-xss-el">E</i>`, `javascript:window.__qa_xss=23`];
  const r = await request.post("/api/v1/client-errors", { data: { message: `${tag} ${P.join(" ")}`, stack: `${tag}\n${P.join("\n")}`, component: P[0], path: `/${P[1]}`, ts: new Date().toISOString() } });
  OUT.clientErrorStatus = r.status();
  await loginOps(page);
  await page.goto("/logs");
  const row = page.getByTestId("log-row").filter({ hasText: tag }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await check(page, bad, "/logs list");
  await row.click();
  await expect(page.getByTestId("log-detail")).toBeVisible();
  await check(page, bad, "/logs detail");
  await page.getByTestId("logs-filter-form").getByRole("button", { name: "묶음(fp)", exact: true }).click();
  await expect(page.getByTestId("log-group").filter({ hasText: tag }).first()).toBeVisible({ timeout: 20_000 });
  await check(page, bad, "/logs groups");
});

/**
 * 공역 이름: 공역은 스트림이 아니라 DB 로 가져오는 자료(make airspace-import)라, A 의 판(합성 시험 공역 1차 — 다른 점검이 쓴다)을 바꾸지 않고
 * 브라우저가 받는 응답(/api/v1/airspace · /api/v1/aircraft/{hex} 의 inside_airspace)만 조작한 이름으로 바꿔 화면 그리기를 본다.
 */
test("stored XSS: crafted airspace names (layer status · aircraft card airspace row) render as text", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(120_000);
  await emptyExternal(page);
  const bad = watch(page);
  const MARK = `<img src=x onerror=window.__qa_xss=31><i id="qa-xss-el">A</i>`;
  await page.route(/\/api\/v1\/airspace(\?.*)?$/, async (route) => {
    const r = await route.fetch();
    const j = await r.json() as { edition?: { label?: string }; features: { properties: Record<string, unknown> }[] };
    if (j.edition) j.edition.label = `QA판 ${MARK}`;
    for (const f of j.features) { f.properties.name = `${MARK}${String(f.properties.name)}`; f.properties.label = `${MARK}L`; f.properties.type_ko = `<b>${String(f.properties.type_ko)}`; }
    await route.fulfill({ response: r, json: j });
  });
  await page.route(/\/api\/v1\/aircraft\/[0-9a-f]{6}(\?.*)?$/, async (route) => {
    const r = await route.fetch();
    const j = await r.json() as Record<string, unknown>;
    j.inside_airspace = { edition: `QA판 ${MARK}`, items: [{ id: 1, category: "prohibited", type_ko: `<b>금지`, label: `${MARK}P-73`, name: MARK, level: "alert", vertical: "inside" }] };
    await route.fulfill({ response: r, json: j });
  });
  await page.goto("/");
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 30_000 });
  const layer = page.getByTestId("layer-airspace");
  if ((await layer.getAttribute("aria-pressed")) !== "true") await layer.click();
  await page.waitForTimeout(3000);
  OUT.airspaceStatus = (await page.locator("body").innerText()).match(/공역[^\n]{0,120}/g)?.slice(0, 4) ?? null;
  await check(page, bad, "airspace layer status");
  await page.locator("body").press("/");
  await page.keyboard.type("KAL");
  await page.waitForTimeout(1500);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("aircraft-airspace")).toBeVisible({ timeout: 15_000 });
  OUT.aircraftAirspace = (await page.getByTestId("aircraft-airspace").innerText()).replace(/\s+/g, " ").slice(0, 300);
  await check(page, bad, "aircraft card airspace row");
  await page.getByTestId("layer-airspace").click(); // 되돌림(브라우저 상태)
});
