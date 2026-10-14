import { expect, test } from "@playwright/test";
import { assertIsolated, saveJson, shot } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA-1463 재현(QA 2026-10-aws · 공개 데모 A1 — 공개 조회 허가 3 · 풀 6/3/2): 허가가 모두 잡히면 공개 조회는 1 s 뒤 503 UNAVAILABLE + Retry-After 10 이다
 * (PublicReadGate — 실제 재현: tools/qa/pd_public_reads_threshold.py · demo-states.json 의 airport "기상 이력을 불러오지 못했습니다(HTTP 503)."). 이 503 은
 * '잠시 뒤 다시'라는 뜻인데, 공항 기상 이력 화면(/airports/[icao])은 한 번 실패하면 Retry-After 뒤 다시 부르지도 않고(useApiResource 의 retry 를 쓰지 않음),
 * '다시 시도' 단추도 없다 — 방문자는 페이지 전체를 새로 불러야 한다. 재생 화면(lib/replay ReplayLoader)은 같은 503 에 "10초 뒤 다시 시도"로 한 번 다시
 * 부르고, 통계 화면은 '다시 시도' 단추를 둔다. (/alerts/[id] 의 같은 빈칸은 같은 QA 의 QA-1301 표에 있다 — 여기서는 세지 않는다.)
 * 흉내: 첫 /api/v1/airports/RKSI/wx 만 실제와 같은 503(본문 · Retry-After 2), 그 뒤는 실제 api.
 * 기대: Retry-After 뒤 다시 불러 기상 이력을 그리거나, 적어도 다시 시도 단추가 있다.
 * 실행: cd apps/web && QA_BASE_URL=http://localhost:8701 QA_EVIDENCE_DIR=… npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1463
 */
test("QA-1463 airport weather history recovers from a transient 503 + Retry-After", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(90_000);
  await emptyExternal(page);
  let n = 0;
  await page.route(/\/api\/v1\/airports\/RKSI\/wx/, async (r) => {
    if (n++ > 0) return r.continue();
    return r.fulfill({ status: 503, contentType: "application/problem+json", headers: { "Retry-After": "2", "X-Request-Id": "qa1463aaaabbbbccccddddeeeeffff00" },
      body: JSON.stringify({ type: "about:blank", title: "Service Unavailable", status: 503, detail: "data store temporarily unavailable; retry later", code: "UNAVAILABLE", request_id: "qa1463aaaabbbbccccddddeeeeffff00" }) });
  });
  await page.goto("/airports/RKSI", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(12_000);
  const m = await page.evaluate(() => ({
    error: document.querySelector<HTMLElement>('main [role="alert"]')?.innerText ?? null,
    retryButtons: Array.from(document.querySelectorAll("main button")).map((b) => b.textContent?.trim()).filter((t) => /다시|retry/i.test(t ?? "")),
    hasMetar: /METAR/.test(document.querySelector("main")?.innerText ?? "") && !document.querySelector('main [role="alert"]'),
  }));
  await shot(page, "qa-1463-airport-503.png");
  saveJson("qa-1463-airport-503.json", { requests: n, ...m });
  console.log(`QA-1463 wxRequests=${n} error=${JSON.stringify(m.error)} retryButtons=${JSON.stringify(m.retryButtons)} recovered=${m.hasMetar}`);
  expect(m.hasMetar || m.retryButtons.length > 0, "recovered after Retry-After, or offers a retry").toBe(true);
});
