import { expect, test } from "@playwright/test";

// fixture 모드 스택 대상(FR-12): 외부 호출 없이 전 화면 동작.
test("dashboard loads with attribution, lag badge and aircraft", async ({ page }) => {
  const cspViolations: string[] = [];
  page.on("console", (m) => { if (m.text().includes("Content Security Policy")) cspViolations.push(m.text()); });
  await page.goto("/");
  await expect(page.getByTestId("statusbar")).toBeVisible();
  await expect(page.getByTestId("attribution")).toContainText("adsb.lol");
  await expect(page.getByTestId("attribution")).toContainText("AviationWeather.gov");
  await expect(page.getByTestId("attribution")).toContainText("RainViewer");
  await expect(page.getByTestId("attribution")).toContainText("OpenFreeMap");
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 20_000 });
  await expect(page.getByTestId("fixture-badge")).toBeVisible();
  await expect(page.getByTestId("lag-badge")).toContainText("lag", { timeout: 30_000 });
  await expect(page.getByTestId("layer-panel")).toBeVisible();
  expect(cspViolations).toEqual([]);
});

test("alert panel shows aircraft inside the synthetic fixture SIGMET with evidence", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 20_000 });
  const items = page.getByTestId("alert-item");
  await expect(items.first()).toBeVisible({ timeout: 60_000 });
  expect(await items.count()).toBeGreaterThanOrEqual(3);
  await items.first().locator("button").click();
  await expect(page.getByTestId("evidence").first()).toBeVisible();
  await expect(page.getByTestId("evidence").first()).toContainText("고도대");
  await expect(page.getByTestId("aircraft-card")).toBeVisible();
});

test("ops is 404 for anonymous API calls and shows login form", async ({ page, request }) => {
  const r = await request.get("/api/v1/ops/providers");
  expect(r.status()).toBe(404);
  await page.goto("/ops");
  await expect(page.getByTestId("ops-login")).toBeVisible();
});

test("forged X-Forwarded-For does not bypass rate limiting (3 paths)", async ({ request }) => {
  // edge 가 XFF 를 덮어쓰므로 위조 값은 api 에 닿지 않는다. 같은 IP 로 계산돼야 한다.
  const headers = [{ "X-Forwarded-For": "1.2.3.4" }, { "X-Forwarded-For": "5.6.7.8, 9.9.9.9" }, { "X-Real-IP": "10.0.0.1", Forwarded: "for=8.8.8.8" }];
  const remaining: number[] = [];
  for (const h of headers) {
    const r = await request.get("/api/v1/status", { headers: h });
    remaining.push(Number(r.headers()["x-ratelimit-remaining"]));
  }
  expect(remaining[0]).toBeGreaterThan(remaining[1]);
  expect(remaining[1]).toBeGreaterThan(remaining[2]);
});
