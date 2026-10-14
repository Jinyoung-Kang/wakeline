import { test } from "@playwright/test";
import { assertIsolated, instrument, saveJson, shot } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/** QA 2026-10-aws 탐색: /alerts/[id] — 형식은 맞지만 없는 번호 · 아주 큰 번호 · 0 · 음수 */
test("probe: /alerts/[id] edge ids", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  const net = await instrument(page);
  await emptyExternal(page);
  const out: Record<string, unknown> = {};
  for (const id of ["1", "999999999999999999", "99999999999999999999999", "0", "-1", "1e3", "０１"]) {
    net.reset();
    await page.goto(`/alerts/${encodeURIComponent(id)}`);
    await page.waitForTimeout(2500);
    out[id] = { text: (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200), api: net.requests.filter((r) => /\/api\//.test(r.url)).map((r) => r.url.replace(/^https?:\/\/[^/]+/, "")), bad: net.bad.map((b) => `${b.status} ${b.url.replace(/^https?:\/\/[^/]+/, "")}`), pageErrors: net.pageErrors.map((e) => e.text) };
  }
  await shot(page, "aws-probe-alert404.png");
  saveJson("aws-probe-alert404.json", out);
});
