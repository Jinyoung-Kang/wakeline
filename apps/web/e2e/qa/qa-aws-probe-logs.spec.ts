import { expect, test } from "@playwright/test";
import { assertIsolated, instrument, loginOps, saveJson } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA 2026-10-aws 탐색(브라우저 · /logs): 앞선 QA 의 qa-ops-logs 가 2차 · 이번 모두 실패한 두 단계('logs-new' 40 s 무응답 · 'log-grid' 없음)가
 * 시험 쪽 문제(바뀐 화면)인지 제품 쪽 문제인지 가린다. 결과: $QA_EVIDENCE_DIR/aws-probe-logs.json
 */
test("probe: /logs new-items button and grid", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(180_000);
  const net = await instrument(page);
  await emptyExternal(page);
  const out: Record<string, unknown> = {};
  await loginOps(page);
  await page.goto("/logs");
  await page.getByTestId("logs-dashboard").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(3000);
  out.rows0 = await page.getByTestId("log-row").count();
  out.gridCount = await page.getByTestId("log-grid").count();
  out.gridRole = await page.locator('[role="grid"]').count();
  out.statusLine = (await page.getByTestId("logs-status").innerText()).replace(/\s+/g, " ");
  const tag = `qa-aws-probe-new-${Date.now()}`;
  const t0 = Date.now();
  net.reset();
  await page.evaluate(async (m) => { await fetch("/api/v1/client-errors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: m, stack: "", component: "qa-aws-probe", path: "/logs", ts: new Date().toISOString() }) }); }, tag);
  const nb = page.getByTestId("logs-new");
  const seen = await nb.waitFor({ timeout: 40_000 }).then(() => true, () => false);
  out.newButton = { seen, afterMs: Date.now() - t0, label: seen ? await nb.innerText() : null };
  out.rowWithTag = await page.getByTestId("log-row").filter({ hasText: tag }).count();
  out.apiCalls = net.requests.filter((r) => /\/api\/v1\/ops\/logs/.test(r.url)).map((r) => `${r.t} ${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, "")}`);
  out.bad = net.bad.map((b) => `${b.status} ${b.url}`);
  out.statusLine2 = (await page.getByTestId("logs-status").innerText()).replace(/\s+/g, " ");
  saveJson("aws-probe-logs.json", out);
  expect(true).toBe(true);
});
