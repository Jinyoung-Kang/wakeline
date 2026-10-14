import { expect, test } from "@playwright/test";
import { assertIsolated, focusInfo, instrument, isBlockedNoise, loginOps, saveJson } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/** QA 2026-10-aws 탐색: 앞선 qa-ops-logs 의 바뀐 이름 때문에 돌지 않은 단계(로그 표 키보드)를 지금 이름으로 — 공급자 끄기 · 켜기는 fixture 모드에 opensky 행이 없고 fixture 를 끄면 A 를 쓰는 다른 점검의 자료가 멈추므로 하지 않는다 */
test("probe: logs grid keyboard", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(120_000);
  const net = await instrument(page);
  await emptyExternal(page);
  const out: Record<string, unknown> = {};
  await loginOps(page);
  await page.goto("/logs");
  const g = page.getByTestId("log-grid");
  await expect(g).toBeVisible({ timeout: 20_000 });
  await g.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  out.grid = { activedescendant: await g.getAttribute("aria-activedescendant"), detail: await page.getByTestId("log-detail").isVisible().catch(() => false) };
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  out.afterEsc = { detail: await page.getByTestId("log-detail").isVisible().catch(() => false), focus: await focusInfo(page) };
  out.errors = { console: net.console.filter((c) => c.type === "error" && !isBlockedNoise(c.text)).map((c) => c.text), page: net.pageErrors, bad: net.bad.map((b) => `${b.status} ${b.url}`) };
  saveJson("aws-probe-ops-misc.json", out);
});
