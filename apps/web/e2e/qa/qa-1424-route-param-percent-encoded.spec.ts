import { expect, test } from "@playwright/test";
import { assertIsolated, instrument, saveJson, shot } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA-1424 재현(QA 2026-10-aws · 화면 표시): 동적 경로 값(/alerts/[id] · /airports/[icao])을 화면이 퍼센트 인코딩된 글자 그대로 보인다.
 * Next 16 의 params 는 디코딩되지 않은 경로 조각이라(실제 브라우저 · 운영 빌드에서 확인) 'RKSI' 같은 ASCII 는 그대로지만 한글 · 전각 숫자 · 공백 · 기호가 들어간
 * 공유 링크는 머리에 "%EF%BC%90…"처럼 나오고, 공항 화면은 그 글자를 다시 인코딩해 api 에 보낸다(%25… — 사람이 친 값과 다른 값을 묻는다).
 * 기대: 화면은 사람이 친(디코딩한) 값을 보인다 — 예: /alerts/０１ → "#０１" · /airports/김포 → "김포".
 */
test("QA-1424 route params are shown decoded (not percent-encoded)", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  const net = await instrument(page);
  await emptyExternal(page);
  const out: Record<string, unknown> = {};
  await page.goto(`/alerts/${encodeURIComponent("０１")}`);
  await expect(page.getByTestId("alert-page-error")).toBeVisible({ timeout: 20_000 });
  out.alertsH1 = await page.locator("h1").first().innerText();
  net.reset();
  await page.goto(`/airports/${encodeURIComponent("김포 공항")}`);
  await page.waitForTimeout(3000);
  out.airportH1 = await page.locator("h1").allInnerTexts();
  out.airportText = (await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 200);
  out.airportApi = net.requests.filter((r) => /\/api\/v1\/airports\//.test(r.url)).map((r) => r.url.replace(/^https?:\/\/[^/]+/, ""));
  await shot(page, "qa-1424-airport.png");
  saveJson("qa-1424-route-param.json", out);
  console.log(`QA-1424 alerts h1="${out.alertsH1}" · airport h1=${JSON.stringify(out.airportH1)} · api=${JSON.stringify(out.airportApi)}`);
  expect.soft(String(out.alertsH1)).not.toMatch(/%[0-9A-F]{2}/i);
  expect.soft(JSON.stringify(out.airportH1) + String(out.airportText)).not.toMatch(/%[0-9A-F]{2}/i);
  expect(JSON.stringify(out.airportApi), "api asked with the value the user typed (not %25-double-encoded)").not.toMatch(/%25/);
});
