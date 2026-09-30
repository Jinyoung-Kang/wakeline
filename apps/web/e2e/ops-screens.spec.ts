import { expect, test } from "@playwright/test";
import { opsPipeline, opsProviders } from "./rest-inject";

/**
 * 운영 화면의 이번 통합 행(통합 리뷰 2026-09-30 — 전에는 Vitest 만 보았다): PIPELINE 의 AIS 수신 진단 · providers 의 kma_radar '파일 없음' 줄.
 * fixture 스택에는 운영 계정이 없어(make ops-user 는 사람이 비밀번호를 넣는다) 운영 API 응답을 이 시험이 준다(e2e/rest-inject — 값은 계약 모양 그대로).
 * 빌드된 앱이 그 값을 그리는지만 본다: 고른 값(창 · 상한 · 시간 초과 · 회복 창)은 응답에서 읽어 '수집기 설정'으로 적고 색으로 판정하지 않는다 ·
 * '확인 멈춤'은 응답의 서버 시각(generated_at)으로 판정한다 · 시각은 KST 만.
 */
test("ops: PIPELINE shows the AIS receive diagnostics with the collector's chosen values from the response; providers shows the KMA line judged by server time", async ({ page }) => {
  const now = Date.now();
  const bodies: Record<string, unknown> = {
    "/api/v1/ops/session": { username: "e2e" },
    "/api/v1/ops/providers": opsProviders(now),
    "/api/v1/ops/runs": { items: [], summary_24h: [], hidden_resolved_errors: 0, generated_at: new Date(now).toISOString() },
    "/api/v1/ops/quality": { rule_counts: [], recent: [], day_zone: "Asia/Seoul" },
    "/api/v1/ops/settings": { items: [] },
    "/api/v1/ops/audit": { items: [], next_cursor: null },
    "/api/v1/ops/dlq": { items: [] },
    "/api/v1/ops/pipeline": opsPipeline(now),
  };
  await page.route(/\/api\/v1\/ops\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET" || !(path in bodies)) { await route.fulfill({ status: 404, contentType: "application/problem+json", body: JSON.stringify({ status: 404, detail: "not mocked" }) }); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bodies[path]) });
  });
  await page.goto("/ops");
  await expect(page.getByTestId("ops-dashboard")).toBeVisible({ timeout: 20_000 });

  // providers: kma_radar 행 아래 주의 줄 — 마지막 확인이 서버 시각보다 20분 앞서 '확인 멈춤'(브라우저 시계와 상관없이 응답의 generated_at 기준)
  const miss = page.getByTestId("provider-missing");
  await expect(miss).toHaveCount(1);
  await expect(miss).toContainText("기상청 내려받기 파일(PUB) 없음");
  await expect(miss).toContainText("확인한 tm 12개 모두 없음");
  await expect(miss).toContainText("15분 넘게 다시 확인하지 않음(확인 멈춤)");
  await expect(page.getByTestId("ops-dashboard")).not.toContainText("UTC");

  // PIPELINE: 진단 행 · 고른 값은 응답에서(90 s 창 · 64 상한 · 25 s 시간 초과 · 45 s 회복 창 · 60분에 4번째부터)
  await page.getByTestId("ops-tab-pipeline").click();
  const pipe = page.getByTestId("ops-pipeline");
  await expect(pipe).toBeVisible();
  const row = (k: string) => pipe.locator(`tr[data-key="${k}"]`);
  for (const k of ["ping_rtt_max_s", "loop_lag_max_s", "loop_stalls_total", "ws_queue_max", "queue_wait_max_s", "queue_depth_max", "reconnects_quick_total"]) await expect(row(k)).toHaveCount(1);
  await expect(row("ping_rtt_max_s")).toContainText("0.31 s");
  await expect(row("ping_rtt_max_s")).toContainText("최근 90 s 최대 · 시간 초과 25 s — 수집기 설정");
  await expect(row("ws_queue_max")).toContainText("상한 64 프레임 — 수집기 설정");
  await expect(row("ws_queue_max")).toContainText("상한 도달");
  await expect(row("ws_queue_max")).toHaveAttribute("data-tone", "muted"); // 판정하지 않는다
  await expect(row("reconnects_quick_total")).toContainText("45 s(수집기 고른 값)");
  await expect(row("reconnects_quick_total")).toContainText("60분에 4번째부터");
  await expect(row("reconnects_quick_total")).not.toContainText("INFO 로만");
  await expect(pipe).not.toContainText("UTC");
});
