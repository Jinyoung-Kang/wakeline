import { expect, test } from "@playwright/test";

/**
 * 통계(/stats) 패널마다의 받기 상태 — 받는 중 · 실패를 '자료 없음'으로 보이지 않는다(2026-09-30 22:49 KST 배포 직후 설명서 캡처: api 재시작 6분 뒤 DB 가 바쁠 때
 * 네 패널이 모두 '자료 없음 — … 구분할 수 없습니다'로 찍혔다). 네 요청을 이 시험이 대신 답한다(route — 스택의 집계 상태와 무관하게 결정적):
 * FIR 은 늦게(그동안 그 패널만 '불러오는 중'), 알림은 503(요청 id 와 함께) → 그 패널만 '조회 실패' · HTTP 상태 · 요청 id · 다시 시도 → 다시 시도하면 그 패널만 다시 받는다.
 */
const Z = { day_zone: "Asia/Seoul" };
const RID = "e2e0stats0000503";

test("stats: a slow panel says 불러오는 중 (not 자료 없음); a failed panel says 조회 실패 with its request id and retries on its own", async ({ page }) => {
  let releaseFir: () => void = () => {};
  const firGate = new Promise<void>((r) => { releaseFir = r; });
  let alertsFail = true;
  const alertCalls: string[] = [];
  await page.route(/\/api\/v1\/stats\/sigmet\?group=fir$/, async (route) => {
    await firGate;
    await route.fulfill({ json: { items: [{ day: "2026-09-28", dim: "RKRR", value: 4 }], days: [], aggregated: true, ...Z } });
  });
  await page.route(/\/api\/v1\/stats\/sigmet\?group=hazard$/, (route) => route.fulfill({ json: { items: [], days: [], aggregated: true, ...Z } }));
  await page.route(/\/api\/v1\/stats\/traffic\?day=/, (route) => {
    const day = new URL(route.request().url()).searchParams.get("day");
    return route.fulfill({ json: { day, items: [{ day, dim: "07", value: 12 }], aggregated: true, scope: null, region: null, ...Z } });
  });
  await page.route(/\/api\/v1\/stats\/alerts$/, (route) => {
    alertCalls.push(route.request().url());
    return alertsFail
      ? route.fulfill({ status: 503, contentType: "application/problem+json", body: JSON.stringify({ detail: "stats unavailable", code: "STORE_UNAVAILABLE", request_id: RID }) })
      : route.fulfill({ json: { items: [], days: [], aggregated: false, ...Z } });
  });
  await page.goto("/stats");

  const fir = page.locator('[data-stats-panel="fir"]');
  const alerts = page.locator('[data-stats-panel="alerts"]');
  // 늦은 패널: 받는 중 — 빈 상태 문구가 아니다
  await expect(fir).toHaveAttribute("data-state", "loading");
  await expect(fir.getByRole("status")).toHaveText("불러오는 중");
  await expect(fir.getByTestId("stats-empty")).toHaveCount(0);
  await expect(fir).not.toContainText("구분할 수 없습니다");
  // 다른 패널은 제 응답대로(한 요청이 늦어도 기다리지 않는다)
  await expect(page.locator('[data-stats-panel="hazard"]')).toHaveAttribute("data-state", "empty");
  await expect(page.locator('[data-stats-panel="traffic"]')).toHaveAttribute("data-state", "ready");
  // 실패한 패널: 조회 실패 · HTTP 상태 · 요청 id · 다시 시도 — 빈 상태 문구가 아니다
  await expect(alerts).toHaveAttribute("data-state", "error");
  await expect(alerts.getByRole("alert")).toContainText("조회 실패");
  await expect(alerts).toContainText("HTTP 503");
  await expect(alerts.getByTestId("request-id")).toContainText(RID);
  await expect(alerts.getByTestId("stats-empty")).toHaveCount(0);

  releaseFir();
  await expect(fir).toHaveAttribute("data-state", "ready");
  await expect(fir.locator("svg")).toBeVisible();

  alertsFail = false;
  const before = alertCalls.length;
  await alerts.getByRole("button", { name: "다시 시도" }).click();
  await expect(alerts).toHaveAttribute("data-state", "empty");
  await expect(alerts.getByTestId("stats-empty")).toContainText("아직 집계되지 않았습니다");
  expect(alertCalls.length).toBe(before + 1);
  await expect(fir).toHaveAttribute("data-state", "ready"); // 다른 패널은 그대로
  await expect(page.locator("[data-stats-panel][data-state=error]")).toHaveCount(0);
});
