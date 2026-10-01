import { test, type Page } from "@playwright/test";
import { assertIsolated, focusInfo, instrument, loginOps, saveJson } from "./qa-helpers";

/**
 * QA 2026-10 §3.3 · §3.6 — 키보드만으로: 경로마다 Tab 을 눌러 초점 순서 · 보이는 초점 · 화면 밖 초점 · 갇힘(같은 요소로 되돌아옴)을 적고,
 * 건너뛰기 링크와 카드 닫은 뒤의 다음 Tab 위치를 본다. 결과: docs/qa/2026-10/evidence/ui-a11y/keyboard.json. 쓰기 없음.
 */
type F = Awaited<ReturnType<typeof focusInfo>>;

async function tabWalk(page: Page, max: number) {
  const seq: (F & { i: number })[] = [];
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.locator("body").press("Escape").catch(() => {});
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const f = await focusInfo(page);
    seq.push({ i, ...f });
    // 한 바퀴(첫 정지점으로 되돌아옴)면 멈춘다
    if (i > 2 && f.tag === seq[0].tag && f.name === seq[0].name) break;
  }
  const problems = {
    notVisible: seq.filter((s) => !s.visible && s.tag !== "body").map((s) => `${s.i}:${s.tag}[${s.testid}] "${s.name}" outline=${s.outline}`),
    offscreen: seq.filter((s) => !s.inViewport && s.tag !== "body").map((s) => `${s.i}:${s.tag}[${s.testid}] "${s.name}"`),
    body: seq.filter((s) => s.tag === "body").map((s) => s.i),
  };
  return { stops: seq.length, seq: seq.map((s) => `${s.i}:${s.tag}${s.testid ? `[${s.testid}]` : ""} "${s.name}"${s.visible ? "" : " (no outline)"}${s.inViewport ? "" : " (off-screen)"}`), problems };
}

test("keyboard: tab order, visible focus, skip links on every screen", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(600_000);
  await instrument(page);
  const out: Record<string, unknown> = {};
  for (const route of ["/", "/replay", "/stats", "/airports/RKSI", "/airports/ZZZZ", "/about", "/guide", "/ops"]) {
    await page.goto(route);
    await page.waitForTimeout(route === "/" ? 9000 : 4000);
    out[route] = await tabWalk(page, route === "/" ? 220 : route === "/guide" ? 120 : 80);
  }

  // 건너뛰기 링크: 첫 Tab = '본문으로 건너뛰기' → Enter → 초점이 main · 다음 Tab 은 main 안
  await page.goto("/");
  await page.waitForTimeout(8000);
  const skip: Record<string, unknown> = {};
  await page.keyboard.press("Tab");
  skip.firstStop = await focusInfo(page);
  await page.keyboard.press("Enter");
  skip.afterEnter = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id ?? document.activeElement?.tagName);
  await page.keyboard.press("Tab");
  skip.nextAfterMain = await focusInfo(page);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
  skip.secondStop = await focusInfo(page);
  await page.keyboard.press("Enter");
  skip.afterEnter2 = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id ?? document.activeElement?.tagName);
  await page.keyboard.press("Tab");
  skip.nextAfterSide = await focusInfo(page);
  out.skipLinks = skip;

  // 핵심 작업(키보드만): '/' → 검색 → ↓ → Enter → 카드 → 닫기(Enter) → 다음 Tab 은 어디인가
  const core: Record<string, unknown> = {};
  await page.keyboard.press("/");
  await page.keyboard.type("KAL");
  await page.waitForTimeout(1500);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  core.afterSelect = await focusInfo(page);
  // 카드까지 몇 번의 Tab 이 드는가(검색 입력에서 출발)
  let n = 0, reached = false;
  for (; n < 80; n++) {
    await page.keyboard.press("Tab");
    const f = await focusInfo(page);
    if (f.name === "닫기" || f.testid === "aircraft-card") { reached = true; break; }
  }
  core.tabsFromSearchToCardClose = reached ? n + 1 : `not reached in ${n}`;
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  core.afterClose = await focusInfo(page);
  await page.keyboard.press("Tab");
  core.nextTabAfterClose = await focusInfo(page);
  await page.keyboard.press("Shift+Tab");
  core.shiftTabAfterClose = await focusInfo(page);
  out.coreTask = core;

  // SIGMET 목록 → Enter → 카드 → Tab 다음 위치
  const sig: Record<string, unknown> = {};
  await page.getByTestId("tab-sigmet").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  const item = page.getByTestId("sigmet-list-item").first();
  if (await item.isVisible().catch(() => false)) {
    await item.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(1500);
    sig.afterOpen = await focusInfo(page);
    await page.keyboard.press("Tab");
    sig.nextTab = await focusInfo(page);
  } else sig.note = "no sigmet item";
  out.sigmetFromList = sig;

  // 운영 로그인 폼: 라벨 · Tab 순서 · 빈 제출의 초점 이동
  await page.goto("/ops");
  await page.getByTestId("ops-login").waitFor();
  const login: Record<string, unknown> = {};
  login.labels = await page.evaluate(() => ["ops-user", "ops-pass"].map((id) => { const el = document.getElementById(id) as HTMLInputElement; return { id, labels: Array.from(el.labels ?? []).map((l) => l.textContent?.trim()), autocomplete: el.autocomplete, required: el.required }; }));
  await page.locator('[data-testid="ops-login"] button[type="submit"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  login.emptySubmitFocus = await focusInfo(page);
  login.emptySubmitError = await page.getByTestId("ops-login-error").textContent().catch(() => null);
  login.ariaInvalid = await page.locator("#ops-user").getAttribute("aria-invalid");
  out.opsLogin = login;

  // 로그인 뒤 운영 화면: Tab 순서(탭 단추 · 표)
  await loginOps(page, "qa-b");
  await page.waitForTimeout(3000);
  out["/ops (signed in)"] = await tabWalk(page, 150);
  await page.goto("/logs");
  await page.waitForTimeout(5000);
  out["/logs (signed in)"] = await tabWalk(page, 150);

  saveJson("keyboard.json", out);
});
