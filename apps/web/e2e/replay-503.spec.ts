import { expect, test } from "@playwright/test";

/**
 * 재생의 503(errors F4 — 운영 2026-09-30 22:55 KST: 재생 조회가 503 UNAVAILABLE + Retry-After 10 이었는데 화면은 '서버 오류(HTTP 503)' 였고, 멈춘 화면은
 * 다시 부르지 않았다). 재생 응답만 이 시험이 준다(서버 자료는 건드리지 않는다): 처음 보는 (at, bbox) 는 503(code UNAVAILABLE · Retry-After 2 · 요청 id),
 * 같은 요청을 다시 부르면 한 프레임. 화면은 '데이터 저장소를 잠시 사용할 수 없음(HTTP 503) — 2초 뒤 다시 시도'와 요청 id 를 보이고, 2초 뒤 같은 요청을
 * 한 번만 다시 불러 그린다(오류가 사라진다).
 */
test("replay: a 503 with Retry-After says the data store is briefly unavailable and re-requests the same view once", async ({ page }) => {
  const seen = new Map<string, number>();
  const order: string[] = [];
  await page.route(/\/api\/v1\/replay\?/, async (route) => {
    const url = new URL(route.request().url());
    const key = `${url.searchParams.get("at")}|${url.searchParams.get("bbox")}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    order.push(key);
    if (n === 1) {
      await route.fulfill({
        status: 503, contentType: "application/problem+json", headers: { "Retry-After": "2", "X-Request-Id": "e2e5030503050305" },
        body: JSON.stringify({ type: "https://wakeline.invalid/problems/unavailable", title: "service unavailable", status: 503,
          detail: "data store temporarily unavailable; retry later", instance: "/api/v1/replay", code: "UNAVAILABLE", request_id: "e2e5030503050305" }),
      });
      return;
    }
    const at = url.searchParams.get("at") ?? new Date().toISOString();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ at, aircraft: [], sigmets: [], source: "track_point", radar: null }) });
  });
  await page.goto("/replay");
  const err = page.getByTestId("replay-error");
  await expect(err).toContainText("데이터 저장소를 잠시 사용할 수 없음(HTTP 503) — 2초 뒤 다시 시도", { timeout: 20_000 });
  await expect(err).toContainText("e2e5030503050305"); // 요청 id(/logs 에서 찾는다)
  await expect(err).not.toContainText("서버 오류");
  // 알림은 지도 위에 뜬다 — 지도 크기가 바뀌면 바뀐 영역으로 같은 시각을 다시 조회한다(2026-10-01 통합 E2E 에서 본 것)
  const canvas = page.locator(".maplibregl-canvas").first();
  const withNote = await canvas.boundingBox();
  // 2초 뒤 같은 요청을 한 번 다시 불러 그린다
  await expect(err).toHaveCount(0, { timeout: 10_000 });
  expect(await canvas.boundingBox()).toEqual(withNote);
  await page.waitForTimeout(3_000);
  // 지도가 영역을 정하는 동안 (at, bbox) 가 바뀌었으면 옛 요청은 다시 부르지 않는다 — 어느 요청도 두 번(처음 + 다시 한 번)을 넘지 않고,
  // 마지막 요청(지금 보이는 것)은 정확히 두 번
  expect([...seen.values()].every((n) => n <= 2)).toBe(true);
  expect(seen.get(order.at(-1)!)).toBe(2);
});
