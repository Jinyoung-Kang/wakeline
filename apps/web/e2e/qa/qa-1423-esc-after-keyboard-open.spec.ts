import { expect, test } from "@playwright/test";
import { assertIsolated, focusInfo, loginOps, saveJson } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA-1423 재현(QA 2026-10-aws · 키보드): Esc 로 닫기 규칙(lib/escape-stack — "초점이 그 패널(또는 그 패널을 연 단추) 안이면 그 패널을 닫는다",
 * 대상 목록에 '운영 실행 목록 · 로그 상세')이 키보드로 연 바로 그 자리에서 듣지 않는다. 키보드 사용자는 연 요소(실행 단추 · 로그 표)에 초점이 남은 채
 * Enter 로 열고 Esc 를 누르는데, 두 패널은 useEscapeClose 에 opener 를 넘기지 않아(OpsRunsDrill.tsx:35 · LogDetail.tsx:39) 아무 일도 없다
 * (KrRadarPanel 은 opener 를 넘겨 같은 흐름에서 닫힌다).
 * 기대: Enter 로 연 직후 Esc → 패널이 닫힌다.
 */

test("QA-1423 (1) /ops runs: Enter on '실행 목록 열기' then Esc closes the run list", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  await emptyExternal(page);
  await loginOps(page);
  await page.getByTestId("ops-tab-runs").click();
  const b = page.getByTestId("runs-drill-open").first();
  await expect(b).toBeVisible({ timeout: 20_000 });
  await b.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("runs-drill")).toBeVisible({ timeout: 10_000 });
  const before = await focusInfo(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const open = await page.getByTestId("runs-drill").isVisible().catch(() => false);
  saveJson("qa-1423-runs.json", { focusWhenEsc: before, openAfterEsc: open });
  console.log(`QA-1423 (1) focus at Esc=${before.testid || before.tag} "${before.name}" → run list still open=${open}`);
  expect(open, "run list open after Esc").toBe(false);
});

test("QA-1423 (2) /logs: Enter on the log grid then Esc closes the detail", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  await emptyExternal(page);
  await page.request.post("/api/v1/client-errors", { data: { message: "qa-1423 probe", stack: "", component: "qa-1423", path: "/logs", ts: new Date().toISOString() } });
  await loginOps(page);
  await page.goto("/logs");
  const g = page.getByTestId("log-grid");
  await expect(g).toBeVisible({ timeout: 20_000 });
  await g.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("log-detail")).toBeVisible({ timeout: 10_000 });
  const before = await focusInfo(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const open = await page.getByTestId("log-detail").isVisible().catch(() => false);
  saveJson("qa-1423-logs.json", { focusWhenEsc: before, openAfterEsc: open });
  console.log(`QA-1423 (2) focus at Esc=${before.testid || before.tag} → detail still open=${open}`);
  expect(open, "log detail open after Esc").toBe(false);
});

test("QA-1423 (3) /replay: Enter on a list item then Esc closes the inspector", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  await emptyExternal(page);
  await page.goto("/replay");
  await page.getByTestId("replay-controls").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(4000);
  await page.getByTestId("replay-list-toggle").click();
  const it = page.getByTestId("replay-list").locator("button").first();
  await expect(it).toBeVisible({ timeout: 15_000 });
  await it.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("replay-inspector")).toBeVisible({ timeout: 10_000 });
  const before = await focusInfo(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const open = await page.getByTestId("replay-inspector").isVisible().catch(() => false);
  saveJson("qa-1423-replay.json", { focusWhenEsc: before, openAfterEsc: open });
  console.log(`QA-1423 (3) focus at Esc=${before.testid || before.tag} "${before.name}" → inspector still open=${open}`);
  expect(open, "replay inspector open after Esc").toBe(false);
});
