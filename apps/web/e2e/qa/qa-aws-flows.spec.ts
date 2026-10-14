import { expect, test, type Page } from "@playwright/test";
import { assertIsolated, focusInfo, instrument, isBlockedNoise, loginOps, opsCredentials, saveJson, shot, type Net } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA 2026-10-aws(계획 §3.3) — 시험이 없던 흐름을 실제 브라우저로(격리 스택 A — 8701). 흐름마다 콘솔 오류 · 페이지 오류 · 실패한 요청과 화면 글자를 모은다.
 * 결과: $QA_EVIDENCE_DIR/aws-flows.json(흐름별) · aws-flow-*.png. 쓰기는 A 의 운영 설정 하나(바꾼 뒤 되돌림) · 해결 하나(만든 뒤 되돌림) · 익명 오류 보고 하나뿐.
 * 로그인 429 는 서버의 실제 제한(IP 분당 10회)을 쓰면 같은 호스트의 다른 점검이 1분 동안 로그인하지 못하므로 응답만 계약 모양으로 대신한다.
 */
const OUT: Record<string, unknown> = {};
const save = (k: string, v: unknown) => { OUT[k] = v; saveJson("aws-flows.json", OUT); };
const errs = (net: Net) => ({
  consoleErrors: net.console.filter((c) => c.type === "error" && !isBlockedNoise(c.text)).map((c) => c.text),
  pageErrors: net.pageErrors.map((e) => e.text),
  bad: net.bad.map((b) => `${b.status} ${b.method} ${b.url.replace(/^https?:\/\/[^/]+/, "")}`),
  failed: net.failed.map((f) => `${f.error} ${f.method} ${f.url.replace(/^https?:\/\/[^/]+/, "")}`),
});
const csrfOf = async (page: Page) => (await page.context().cookies()).find((c) => c.name === "WAKELINE_CSRF")?.value ?? "";

test.describe.configure({ mode: "serial" });

test("settings 409: another writer changes the value while I edit → '새 값 보기' · '내 값으로 덮어쓰기'", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(180_000);
  const net = await instrument(page);
  await emptyExternal(page);
  await loginOps(page);
  await page.getByTestId("ops-tab-settings").click();
  const row = page.getByTestId("setting-row").filter({ hasText: "sigmet_poll_s" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  const ver0 = Number(await row.locator("td").nth(2).innerText());
  const orig = await row.getByRole("spinbutton").inputValue();
  const n = Number(orig);
  const mine = String(n === 3600 ? n - 2 : n + 2);
  const theirs = String(n === 3600 ? n - 1 : n + 1);
  const log: Record<string, unknown> = { orig, ver0 };
  try {
    net.reset();
    await row.getByRole("spinbutton").fill(mine);
    // 다른 운영자(같은 세션의 다른 요청)가 먼저 저장
    const other = await page.request.put(`/api/v1/ops/settings/sigmet_poll_s`, { headers: { "If-Match": String(ver0), "X-CSRF-Token": await csrfOf(page), Origin: baseURL! }, data: { value: Number(theirs) } });
    log.otherPut = other.status();
    // 화면은 15 s 마다 다시 읽는다 — 충돌 표시를 기다린다
    const conflict = row.getByTestId("setting-conflict");
    await expect(conflict).toBeVisible({ timeout: 25_000 });
    log.conflictText = (await conflict.innerText()).replace(/\s+/g, " ");
    log.saveDisabled = await row.getByRole("button", { name: /save/ }).isDisabled();
    await shot(page, "aws-flow-settings-conflict.png");
    // '내 값으로 덮어쓰기' → 저장
    await conflict.getByRole("button", { name: "내 값으로 덮어쓰기" }).click();
    log.afterRebaseInput = await row.getByRole("spinbutton").inputValue();
    await row.getByRole("button", { name: /save/ }).click();
    await expect(page.getByTestId("settings-ok")).toBeVisible({ timeout: 10_000 });
    log.savedText = await page.getByTestId("settings-ok").innerText();
    await page.waitForTimeout(1500);
    log.afterSaveVersion = await row.locator("td").nth(2).innerText();
    log.afterSaveInput = await row.getByRole("spinbutton").inputValue();
    // 두 번째 충돌: 편집 → 다른 쪽 저장 → '새 값 보기'
    const v1 = Number(await row.locator("td").nth(2).innerText());
    await row.getByRole("spinbutton").fill(theirs);
    const other2 = await page.request.put(`/api/v1/ops/settings/sigmet_poll_s`, { headers: { "If-Match": String(v1), "X-CSRF-Token": await csrfOf(page), Origin: baseURL! }, data: { value: Number(orig) } });
    log.otherPut2 = other2.status();
    await expect(conflict).toBeVisible({ timeout: 25_000 });
    await conflict.getByRole("button", { name: "새 값 보기" }).click();
    log.afterDropInput = await row.getByRole("spinbutton").inputValue();
    log.afterDropFocus = await focusInfo(page);
    // 지금 서버 값을 보낸 상태로 저장하는 409 경로(요청 경쟁 — 같은 If-Match 로 저장 단추 대신 화면이 받는 409)
    await row.getByRole("spinbutton").fill(mine);
    const v2 = Number(await row.locator("td").nth(2).innerText());
    await page.request.put(`/api/v1/ops/settings/sigmet_poll_s`, { headers: { "If-Match": String(v2), "X-CSRF-Token": await csrfOf(page), Origin: baseURL! }, data: { value: Number(theirs) } });
    await row.getByRole("button", { name: /save/ }).click(); // 화면이 새로 읽기 전에 누르면 서버는 409
    await page.waitForTimeout(1500);
    log.saveRace409 = { error: await page.getByTestId("settings-error").innerText().catch(() => null), conflictShown: await conflict.isVisible().catch(() => false) };
    await shot(page, "aws-flow-settings-409.png");
    log.errors = errs(net);
  } finally {
    // 되돌린다(원래 값)
    const cur = await (await page.request.get("/api/v1/ops/settings")).json() as { items: { key: string; value: unknown; version: number }[] };
    const it = cur.items.find((i) => i.key === "sigmet_poll_s");
    if (it && String(it.value) !== orig) {
      const r = await page.request.put(`/api/v1/ops/settings/sigmet_poll_s`, { headers: { "If-Match": String(it.version), "X-CSRF-Token": await csrfOf(page), Origin: baseURL! }, data: { value: Number(orig) } });
      log.restored = r.status();
    }
    save("settings409", log);
  }
});

test("resolve / revoke confirm panel on /logs groups (Esc · 취소 · 확인 · 되돌리기)", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(180_000);
  const net = await instrument(page);
  await emptyExternal(page);
  const tag = `qa-1420-resolve-${Date.now()}`;
  const r = await page.request.post("/api/v1/client-errors", { data: { message: tag, stack: "", component: "qa-aws-flows", path: "/qa", ts: new Date().toISOString() } });
  const log: Record<string, unknown> = { report: r.status() };
  await loginOps(page);
  await page.goto("/logs");
  await page.getByTestId("logs-dashboard").waitFor({ timeout: 20_000 });
  await page.getByTestId("logs-filter-form").getByRole("button", { name: "묶음(fp)", exact: true }).click();
  const group = page.getByTestId("log-group").filter({ hasText: tag });
  await expect(group).toBeVisible({ timeout: 20_000 });
  net.reset();
  const opener = group.getByRole("button", { name: /해결 처리: 지문/ });
  await opener.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("resolve-confirm");
  await expect(panel).toBeVisible();
  log.panelText = (await panel.innerText()).replace(/\s+/g, " ").slice(0, 400);
  log.focusInPanel = await focusInfo(page);
  log.openerExpanded = await opener.getAttribute("aria-expanded");
  await page.keyboard.press("Escape");
  log.afterEsc = { visible: await panel.isVisible().catch(() => false), focus: await focusInfo(page) };
  await opener.click();
  await panel.getByRole("button", { name: "취소" }).click();
  log.afterCancel = { visible: await panel.isVisible().catch(() => false), focus: await focusInfo(page) };
  await opener.click();
  await panel.getByLabel("해결 메모").fill("x".repeat(201));
  log.noteTooLong = await panel.getByTestId("resolve-note-error").innerText().catch(() => null);
  await panel.getByLabel("해결 메모").fill("QA-1420 확인 흐름");
  await panel.getByRole("button", { name: "해결 처리 확인" }).click();
  await expect(panel).toBeHidden({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  log.afterResolve = { focus: await focusInfo(page), groupVisible: await group.isVisible().catch(() => false), status: await page.locator('[role="status"]').allInnerTexts().then((t) => t.filter(Boolean).slice(0, 6)) };
  await shot(page, "aws-flow-resolve-after.png");
  // 해결된 묶음 보기 → 되돌리기
  await page.getByTestId("logs-show-resolved").click();
  await expect(group).toBeVisible({ timeout: 20_000 });
  const revoke = group.getByRole("button", { name: /되돌리기: 지문/ });
  await revoke.click();
  await expect(panel).toBeVisible();
  log.revokePanel = (await panel.innerText()).replace(/\s+/g, " ").slice(0, 300);
  await panel.getByRole("button", { name: "되돌리기 확인" }).click();
  await expect(panel).toBeHidden({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  log.afterRevoke = { focus: await focusInfo(page), resolvedMark: await group.getByTestId("group-resolved-mark").count() };
  await page.getByTestId("logs-show-resolved").click();
  log.errors = errs(net);
  save("resolveConfirm", log);
});

test("error screens: unknown route (404) · forced render error (app/error.tsx) · retry", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(120_000);
  const net = await instrument(page);
  await emptyExternal(page);
  const log: Record<string, unknown> = {};
  const resp = await page.goto("/no-such-page-qa", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  log.notFound = {
    status: resp?.status(), title: await page.title(), lang: await page.evaluate(() => document.documentElement.lang),
    text: (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300), links: await page.getByRole("link").count(), h1: await page.locator("h1").allInnerTexts(),
    ...errs(net),
  };
  await shot(page, "aws-flow-404.png");
  // 강제 그리기 오류: Number.prototype.toFixed 를 켜고 끌 수 있게 바꿔 둔다(상태 바가 초마다 다시 그린다)
  net.reset();
  await page.addInitScript(() => {
    const f = Number.prototype.toFixed;
    Number.prototype.toFixed = function (this: number, d?: number) { if ((window as unknown as { __qaBoom?: boolean }).__qaBoom) throw new Error("qa forced render error"); return f.call(this, d); };
  });
  await page.goto("/stats");
  await page.locator("[data-stats-panel]").first().waitFor({ timeout: 20_000 });
  await page.evaluate(() => { (window as unknown as { __qaBoom?: boolean }).__qaBoom = true; });
  await page.getByLabel("집계 날짜(KST)").focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(3000);
  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  log.forced = { text: body.slice(0, 600), hasRetry: await page.getByRole("button", { name: "다시 시도" }).count(), nav: await page.getByRole("navigation").count(), ...errs(net) };
  await shot(page, "aws-flow-error-boundary.png");
  await page.evaluate(() => { (window as unknown as { __qaBoom?: boolean }).__qaBoom = false; });
  const retry = page.getByRole("button", { name: "다시 시도" }).first();
  if (await retry.count()) {
    await retry.click();
    await page.waitForTimeout(2500);
    log.afterRetry = { statsPanels: await page.locator("[data-stats-panel]").count(), text: (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200) };
  }
  save("errorScreens", log);
});

test("old chunks after a deploy: lazily loaded parts get 404 → 'missing' + reload advice; client navigation", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(120_000);
  const net = await instrument(page);
  await emptyExternal(page);
  const log: Record<string, unknown> = {};
  await page.goto("/");
  await page.getByTestId("layer-aircraft").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(6000);
  // 지금부터 받는 청크는 모두 404(새 판이 배포되어 옛 청크가 사라짐)
  const blocked: string[] = [];
  await page.route(/\/_next\/static\/chunks\/.+\.js(\?.*)?$/, async (route) => {
    blocked.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
  });
  net.reset();
  await page.getByTestId("tab-sigmet").click();
  await page.waitForTimeout(1000);
  const it = page.getByTestId("sigmet-list-item").first();
  if (await it.isVisible().catch(() => false)) await it.click();
  await page.waitForTimeout(4000);
  const errs1 = page.getByTestId("lazy-error");
  log.lazy = {
    count: await errs1.count(),
    items: await errs1.evaluateAll((es) => es.map((e) => ({ part: (e as HTMLElement).dataset.part, check: (e as HTMLElement).dataset.check, text: (e as HTMLElement).innerText.replace(/\s+/g, " ").slice(0, 300) }))),
    blocked: blocked.slice(0, 20),
  };
  await shot(page, "aws-flow-old-chunk.png");
  // 다른 화면으로(클라이언트 이동) — 머리말의 통계 링크
  net.reset();
  const before = page.url();
  const statsLink = page.getByRole("link", { name: /통계/ }).first();
  if (await statsLink.count()) {
    await statsLink.click();
    await page.waitForTimeout(6000);
    log.nav = { from: before, to: page.url(), text: (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300), blockedNow: blocked.length };
    await shot(page, "aws-flow-old-chunk-nav.png");
    // 오류 화면의 '다시 시도'(청크는 여전히 404) → 그다음 청크를 돌려 놓고 '다시 시도'
    const retry = page.getByRole("button", { name: "다시 시도" }).first();
    if (await retry.count()) {
      await retry.click();
      await page.waitForTimeout(3000);
      log.retryWhileGone = { url: page.url(), errorScreen: await page.getByRole("button", { name: "다시 시도" }).count(), text: (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160) };
      await page.unroute(/\/_next\/static\/chunks\/.+\.js(\?.*)?$/);
      await page.getByRole("button", { name: "다시 시도" }).first().click().catch(() => {});
      await page.waitForTimeout(4000);
      log.retryAfterBack = { url: page.url(), errorScreen: await page.getByRole("button", { name: "다시 시도" }).count(), statsPanels: await page.locator("[data-stats-panel]").count() };
    }
  }
  log.errors = errs(net);
  save("oldChunks", log);
});

test("WS: server connection drops → closed/retry chip, alert panel note; comes back → open, resumes", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(240_000);
  const net = await instrument(page);
  await emptyExternal(page);
  let down = false;
  const opened: number[] = [];
  const t0 = Date.now();
  type WsRoute = { close: (o?: { code?: number; reason?: string }) => Promise<void> };
  let live: WsRoute | null = null;
  await page.routeWebSocket(/\/ws\/v1$/, (ws) => {
    opened.push(Date.now() - t0);
    if (down) { void ws.close({ code: 1013, reason: "qa down" }); return; }
    ws.connectToServer();
    live = ws;
  });
  const log: Record<string, unknown> = {};
  await page.goto("/");
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 30_000 });
  await page.waitForTimeout(3000);
  log.before = await page.getByTestId("conn").innerText();
  net.reset();
  down = true;
  await (live as WsRoute | null)?.close({ code: 1006 as number, reason: "qa drop" }).catch(async () => (live as WsRoute | null)?.close());
  const samples: { t: number; chip: string; title: string | null; alerts: string }[] = [];
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(2500);
    samples.push({ t: Date.now() - t0, chip: await page.getByTestId("conn").innerText(), title: await page.getByTestId("conn").getAttribute("title"),
      alerts: (await page.getByTestId("tab-alerts").innerText().catch(() => "")).replace(/\s+/g, " ") });
  }
  await page.getByTestId("tab-alerts").click().catch(() => {});
  log.downPanel = (await page.locator("body").innerText()).match(/연결 끊김[^\n]{0,80}/)?.[0] ?? null;
  await shot(page, "aws-flow-ws-down.png");
  down = false;
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 45_000 });
  const upAt = Date.now() - t0;
  await page.waitForTimeout(3000);
  log.after = { chip: await page.getByTestId("conn").innerText(), upAt, panel: (await page.locator("body").innerText()).match(/연결 끊김[^\n]{0,80}/)?.[0] ?? null };
  log.samples = samples;
  log.socketOpens = opened;
  log.errors = errs(net);
  save("wsDrop", log);
});

test("login 429 (Retry-After) message · session expiry → login → back", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(180_000);
  const net = await instrument(page);
  await emptyExternal(page);
  const log: Record<string, unknown> = {};
  await page.goto("/ops");
  await expect(page.getByTestId("ops-login")).toBeVisible({ timeout: 20_000 });
  await page.route("**/api/v1/ops/session", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({ status: 429, headers: { "Retry-After": "37", "Content-Type": "application/problem+json", "X-Request-Id": "qa1420rid" },
      body: JSON.stringify({ type: "https://wakeline.invalid/problems/rate-limited", title: "Too Many Requests", status: 429, detail: "too many login attempts", code: "RATE_LIMITED", request_id: "qa1420rid" }) });
  });
  await page.locator("#ops-user").fill("qa-nobody");
  await page.locator("#ops-pass").fill("not-a-real-password");
  await page.locator('[data-testid="ops-login"] button[type="submit"]').click();
  await expect(page.getByTestId("ops-login-error")).toBeVisible({ timeout: 10_000 });
  log.login429 = { text: await page.getByTestId("ops-login-error").innerText(), focus: await focusInfo(page), submitDisabled: await page.locator('[data-testid="ops-login"] button[type="submit"]').isDisabled() };
  await page.unroute("**/api/v1/ops/session");
  // 세션 만료: 로그인 → 설정 탭 → 세션 쿠키를 지운다(서버 쪽 만료와 같은 답 — 익명 ops 는 404) → 15 s 주기 · 새로고침
  await loginOps(page);
  await page.getByTestId("ops-tab-settings").click();
  await page.waitForTimeout(1500);
  const sess = (await page.context().cookies()).filter((c) => c.name === "WAKELINE_SESSION");
  await page.context().clearCookies({ name: "WAKELINE_SESSION" });
  net.reset();
  await page.getByRole("button", { name: "새로고침" }).click();
  await expect(page.getByTestId("ops-login")).toBeVisible({ timeout: 25_000 });
  log.expired = { notice: await page.getByTestId("ops-login-notice").innerText().catch(() => null), focus: await focusInfo(page), hadCookie: sess.length, ...errs(net) };
  await shot(page, "aws-flow-session-expired.png");
  const c = opsCredentials();
  await page.locator("#ops-user").fill(c.username);
  await page.locator("#ops-pass").fill(c.password);
  await page.locator('[data-testid="ops-login"] button[type="submit"]').click();
  await expect(page.getByTestId("ops-dashboard")).toBeVisible({ timeout: 20_000 });
  log.backTab = await page.locator('[data-testid^="ops-tab-"][aria-pressed="true"]').getAttribute("data-testid");
  // /logs: 필터(해시)를 둔 채 만료 → 다시 로그인 → 해시가 남는가
  await page.goto("/logs#level=ERROR");
  await page.getByTestId("logs-dashboard").waitFor({ timeout: 20_000 });
  await page.context().clearCookies({ name: "WAKELINE_SESSION" });
  await page.getByRole("button", { name: "새로고침" }).first().click().catch(() => {});
  await page.waitForTimeout(16_000);
  log.logsExpired = { url: page.url(), loginShown: await page.getByTestId("ops-login").isVisible().catch(() => false), text: (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200) };
  log.errors = errs(net);
  save("login429AndExpiry", log);
});
