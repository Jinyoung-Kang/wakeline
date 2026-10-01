import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * QA 보안 점검(계획 §3.1 XSS) — 격리 스택(8701 · 8702)에서만. 저장형: 브라우저 오류 수집(POST /api/v1/client-errors 의 message · stack · component · path),
 * 조작한 스트림 엔트리(선박 이름 · 호출부호 · 목적지, 항공기 호출부호 · 등록 · 기종 — tools/qa/inject_stream.py, 생산자 ACL 사용자), 해결 메모(운영 감사 탭).
 * 반사형: 공항 경로 · /logs 의 #id= · #rid= · #fp= · 쿼리 · 지도 해시 · 로그 검색어.
 * 판정: 스크립트 표식(window.__qa_xss · window.q)이 없고, 주입한 요소(id 표식 · onerror/onload 속성)가 DOM 에 없고, CSP 위반 보고가 없다
 * (CSP 위반이 났다면 표시가 막아 준 것일 뿐 마크업이 들어간 것이다) — 그리고 표식 글자가 텍스트로 보인다.
 * 운영 화면은 시험 계정 qa-b 로 로그인한다(비밀번호는 0600 파일에서 읽고 출력하지 않는다).
 */
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:8701";
if (!["8701", "8702"].includes(new URL(BASE).port)) throw new Error(`QA 는 격리 스택만: ${BASE}`);
const CREDS = process.env.QA_CREDS ?? "/private/tmp/claude-501/-Users-jinyoung-Projects-wakeline/75437490-c65b-4783-9ac0-e224c92a9bab/scratchpad/qa-creds.json";
const password = (u: string): string => JSON.parse(readFileSync(CREDS, "utf8")).users[u];
const REPO = path.resolve(__dirname, "../../../..");

const P = [
  `<img src=x onerror="window.__qa_xss=1">`,
  `<script>window.__qa_xss=2</script>`,
  `<svg/onload=window.__qa_xss=3>`,
  `<i id="qa-xss-el">E</i>`,
  `javascript:window.__qa_xss=4`,
  `"><iframe srcdoc="<script>parent.__qa_xss=5</script>">`,
];
const INJECTED = "#qa-xss-el, #qaxn, #qr, #k, svg[onload], img[onerror], iframe[srcdoc], script:not([src]):not([nonce]):not([type])";

function watch(page: Page) {
  const csp: string[] = [];
  page.on("console", (m) => { const t = m.text(); if (/Content Security Policy|Refused to (execute|load|apply)/i.test(t)) csp.push(t.slice(0, 300)); });
  page.on("dialog", (d) => { csp.push(`dialog: ${d.message()}`); void d.dismiss(); });
  return csp;
}

async function assertClean(page: Page, csp: string[], label: string) {
  const flag = await page.evaluate(() => { const w = window as unknown as Record<string, unknown>; return w.__qa_xss ?? w.q ?? null; });
  const els = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((e) => e.outerHTML.slice(0, 120)), INJECTED);
  expect(flag, `${label}: script marker`).toBeNull();
  expect(els, `${label}: injected elements`).toEqual([]);
  expect(csp, `${label}: CSP violations (markup reached the DOM)`).toEqual([]);
}

async function login(page: Page, user: string) {
  const r = await page.request.post(`${BASE}/api/v1/ops/session`, { data: { username: user, password: password(user) } });
  expect(r.status(), "login").toBe(200);
}

test.describe.configure({ mode: "serial" });

test("stored XSS: browser error reports (message · stack · component · path) render as text on /logs list · groups · detail", async ({ page, request }) => {
  const csp = watch(page);
  const r = await request.post(`${BASE}/api/v1/client-errors`, {
    headers: { "Content-Type": "application/json" },
    data: { message: `qa-xss-msg ${P.join(" ")}`, stack: `qa-xss-stack\n${P.join("\n")}`, component: `<i id="qa-xss-el">C</i><img src=x onerror="window.__qa_xss=9">`,
      path: `/<img src=x onerror="window.__qa_xss=6">`, ts: new Date().toISOString() },
  });
  expect(r.status(), "client-errors accepted").toBe(204);
  await login(page, "qa-b");
  await page.goto("/logs");
  const row = page.getByTestId("log-row").filter({ hasText: "qa-xss-msg" }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText("<img src=x onerror=");  // 글자 그대로 보인다
  await assertClean(page, csp, "/logs list");
  await row.click();
  const detail = page.getByTestId("log-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("qa-xss-stack");
  await assertClean(page, csp, "/logs detail");
  await page.getByTestId("logs-filter-form").getByRole("button", { name: "묶음(fp)", exact: true }).click();
  await expect(page.getByTestId("log-group").filter({ hasText: "qa-xss-msg" }).first()).toBeVisible({ timeout: 20_000 });
  await assertClean(page, csp, "/logs groups");
  // 로그 검색어(반사): 검색 칸에 표식을 넣어 적용
  await page.getByTestId("logs-filter-form").getByRole("button", { name: "목록", exact: true }).click();
  await page.getByLabel("글자 검색").fill(P[0]);
  await page.getByLabel("글자 검색").press("Enter");
  await expect(page.getByTestId("log-row").filter({ hasText: "qa-xss-msg" }).first()).toBeVisible({ timeout: 20_000 });
  await assertClean(page, csp, "/logs search");
});

test("stored XSS: resolution note in the ops audit tab renders as text", async ({ page }) => {
  const csp = watch(page);
  await login(page, "qa-b");
  const csrf = (await page.context().cookies(BASE)).find((c) => c.name === "WAKELINE_CSRF")?.value ?? "";
  const fp = "0" + Math.random().toString(16).slice(2).padEnd(15, "0").slice(0, 15);
  const note = `qa-xss-note <img src=x onerror="window.__qa_xss=7"><i id="qa-xss-el">N</i>`;
  const created = await page.request.post(`${BASE}/api/v1/ops/resolutions`, { headers: { "X-CSRF-Token": csrf, Origin: BASE }, data: { kind: "log_group", key: fp, note } });
  expect(created.status(), "resolution created").toBe(201);
  const id = (await created.json()).id;
  try {
    await page.goto("/ops");
    await expect(page.getByTestId("ops-dashboard")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("ops-tab-audit").click();
    await expect(page.getByText("qa-xss-note").first()).toBeVisible({ timeout: 20_000 });
    await assertClean(page, csp, "/ops audit");
  } finally {
    const csrf2 = (await page.context().cookies(BASE)).find((c) => c.name === "WAKELINE_CSRF")?.value ?? "";
    await page.request.delete(`${BASE}/api/v1/ops/resolutions/${id}`, { headers: { "X-CSRF-Token": csrf2, Origin: BASE } });
  }
});

test("stored XSS: crafted ship name · call sign · destination and aircraft callsign · registration · type from the stream render as text", async ({ page }) => {
  test.setTimeout(120_000);
  const csp = watch(page);
  execFileSync("python3", [path.join(REPO, "tools/qa/inject_stream.py"), "ship"], { stdio: "pipe" });
  await page.goto("/");
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 20_000 });
  await page.locator("body").press("/");
  await page.keyboard.type("440999001");
  const ship = page.locator('[data-testid="ship-search-item"][data-mmsi="440999001"]').first();
  await expect(ship).toBeVisible({ timeout: 15_000 });
  await expect(ship).toContainText("<i id=qaxn>");
  await assertClean(page, csp, "ship search");
  await ship.click();
  const card = page.getByTestId("ship-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("<i id=qaxn>N</i>");
  await expect(card).toContainText("<svg onload=q=1>", { ignoreCase: true });
  await assertClean(page, csp, "ship card");

  // 항공기: region 엔트리를 3 s 마다 다시 싣는다(수집기의 다음 발행이 덮으므로) — 시험 동안만
  const inj = await import("node:child_process").then((cp) => cp.spawn("python3", [path.join(REPO, "tools/qa/inject_stream.py"), "aircraft", "--loop", "40"], { stdio: "ignore" }));
  try {
    await page.waitForTimeout(4000);
    await page.keyboard.press("Escape");
    await page.locator("body").press("/");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("0A5EC1");
    const ac = page.getByTestId("aircraft-search-item").filter({ hasText: "0a5ec1" }).first();
    await expect(ac).toBeVisible({ timeout: 15_000 });
    await expect(ac).toContainText("<i id=k>");
    await assertClean(page, csp, "aircraft search");
    await ac.click();
    const acard = page.getByTestId("aircraft-card");
    await expect(acard).toBeVisible();
    await expect(acard).toContainText("<i id=qr>R</i>");
    await assertClean(page, csp, "aircraft card");
  } finally {
    inj.kill();
  }
});

test("reflected XSS: airport path · logs hash · query strings · map hash", async ({ page }) => {
  const csp = watch(page);
  const enc = encodeURIComponent;
  const urls = [
    `/airports/${enc(P[0])}`,
    `/airports/${enc(`"><svg/onload=window.__qa_xss=8>`)}`,
    `/?q=${enc(P[0])}&hex=${enc(P[2])}`,
    `/#${enc(P[0])}`,
    `/replay?at=${enc(P[0])}&bbox=${enc(P[2])}`,
    `/stats?day=${enc(P[0])}&from=${enc(P[1])}`,
    `/guide#${enc(P[0])}`,
    `/about?x=${enc(P[1])}`,
    `/nonexistent-${enc(P[0])}`,
  ];
  for (const u of urls) {
    await page.goto(u);
    await page.waitForTimeout(1500);
    await assertClean(page, csp, u);
  }
  await login(page, "qa-b");
  for (const h of [`#id=${enc(P[0])}`, `#rid=${enc(P[2])}`, `#fp=${enc(P[3])}`, `#id=1-0&stream=${enc(P[0])}`]) {
    await page.goto(`/logs${h}`);
    await expect(page.getByTestId("logs-dashboard")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1000);
    await assertClean(page, csp, `/logs${h}`);
  }
});
