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

/**
 * 운영 RUNS(errors F1 — 운영 2026-09-30: region adsb_fi error 13 중 마지막 하나의 까닭만 보였다): 요약의 ok 가 아닌 행에 가장 최근 실행의 오류 글자(원문),
 * 행을 열면 그 job · provider · status 의 실행을 연 때의 요약 창(since = summary_since)으로 50건씩 · next_cursor 로 '더 보기'. 예산 거절은 주황 · 제 뜻(title).
 * 운영 API 응답은 이 시험이 준다(e2e/rest-inject 와 같은 까닭 — fixture 스택에 운영 계정이 없다). 화면 시각은 KST 만(원문의 'Z' 는 data-raw 안).
 */
test("ops RUNS: a summary row shows its last error and opens its own runs, paged by the cursor", async ({ page }) => {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const since = iso(24 * 3600_000);
  const timeout = "ReadTimeout — read 제한 8 s 초과 (opendata.adsb.fi)";
  const grid = "MOF hourly window: grid share used (290 of 390 in UTC hour 2026093017, 100 left for port calls) — geometry fill resumes at 2026-09-30T18:00:00Z";
  const run = (id: number, msAgo: number, text: string, http: number | null = null) => ({
    id, job: "region", provider: "adsb_fi", started_at: iso(msAgo), finished_at: iso(msAgo - 8000), status: "error", http_status: http, latency_ms: 8000,
    records_in: 0, records_quarantined: 0, raw_ref: null, error_text: text,
  });
  const summary = {
    items: [], hidden_resolved_errors: 0, summary_since: since,
    summary_24h: [
      { job: "region", provider: "adsb_fi", status: "error", n: 13, avg_latency_ms: 8012, last_at: iso(60_000), last_error_text: timeout, last_http_status: null },
      { job: "region", provider: "adsb_fi", status: "ok", n: 8000, avg_latency_ms: 250, last_at: iso(5_000), last_error_text: null, last_http_status: null },
      { job: "traffic_grid_geom", provider: "mof_grid4", status: "budget_exhausted", n: 24, last_at: iso(600_000), last_error_text: grid, last_http_status: null },
    ],
  };
  const drillAsked: string[] = [];
  await page.route(/\/api\/v1\/ops\//, async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/v1/ops/runs" && url.searchParams.get("job") === "region") {
      drillAsked.push(url.search);
      expect(url.searchParams.get("provider")).toBe("adsb_fi");
      expect(url.searchParams.get("status")).toBe("error");
      expect(url.searchParams.get("since")).toBe(since); // 요약의 창 그대로 — 브라우저 시계로 만들지 않는다
      return url.searchParams.get("cursor") === "905"
        ? json({ items: [run(501, 15 * 3600_000, "HTTP 503 — Service Unavailable (opendata.adsb.fi)", 503)] })
        : json({ items: [run(912, 60_000, timeout), run(905, 80_000, timeout)], next_cursor: 905 });
    }
    const bodies: Record<string, unknown> = {
      "/api/v1/ops/session": { username: "e2e" }, "/api/v1/ops/providers": opsProviders(now), "/api/v1/ops/runs": summary,
      "/api/v1/ops/quality": { rule_counts: [], recent: [], day_zone: "Asia/Seoul" }, "/api/v1/ops/settings": { items: [] },
      "/api/v1/ops/audit": { items: [], next_cursor: null }, "/api/v1/ops/dlq": { items: [] }, "/api/v1/ops/pipeline": opsPipeline(now),
    };
    if (route.request().method() !== "GET" || !(url.pathname in bodies)) {
      await route.fulfill({ status: 404, contentType: "application/problem+json", body: JSON.stringify({ status: 404, detail: "not mocked" }) });
      return;
    }
    await json(bodies[url.pathname]);
  });
  await page.goto("/ops");
  await expect(page.getByTestId("ops-dashboard")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("ops-tab-runs").click();

  const rows = page.getByTestId("runs-summary-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByTestId("runs-last-error")).toHaveText(timeout);
  await expect(rows.nth(1).getByTestId("runs-last-error")).toHaveCount(0); // ok 행은 비운다
  await expect(rows.nth(2).getByTestId("runs-last-error")).toHaveText(grid);
  await expect(rows.nth(2).locator("td").nth(2)).toHaveClass("text-warn"); // 예산 거절: 주황 · 제 뜻(title)
  await expect(rows.nth(2).locator("td").nth(2)).toHaveAttribute("title", /공급자 오류가 아니다/);

  await rows.nth(0).getByTestId("runs-drill-open").click();
  const panel = page.getByTestId("runs-drill");
  await expect(panel.getByTestId("runs-drill-error")).toHaveCount(2);
  await expect(panel.getByTestId("runs-drill-count")).toHaveText("2건 · 더 있음");
  await expect(panel.getByTestId("runs-drill-window")).toContainText("KST 뒤에 시작한 실행");
  await expect(panel.getByTestId("runs-drill-window")).toContainText("연 때의 요약 창");
  await panel.getByTestId("runs-drill-more").click();
  await expect(panel.getByTestId("runs-drill-error")).toHaveCount(3);
  await expect(panel.getByTestId("runs-drill-count")).toHaveText("3건 · 끝");
  await expect(panel.getByTestId("runs-drill-more")).toHaveCount(0);
  expect(drillAsked).toHaveLength(2);
  // 원문 칸(data-raw) 밖에는 UTC 가 없다
  const visible = await page.getByTestId("ops-dashboard").evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    c.querySelectorAll("[data-raw]").forEach((n) => n.remove());
    return c.innerText;
  });
  expect(visible).not.toContain("UTC");
  expect(visible).not.toMatch(/\d\d:\d\d:\d\d(\.\d+)?Z/);
  await panel.getByTestId("runs-drill-close").click();
  await expect(page.getByTestId("runs-drill")).toHaveCount(0);
});
