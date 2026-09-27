import { expect, test, type APIRequestContext } from "@playwright/test";

/*
 * API 를 직접 부르는 시험 — playwright.config 의 "edge-limits" 프로젝트로, 화면 시험(app)이 모두 끝난 뒤에 돈다.
 * 화면 시험의 두 작업자가 같은 IP 로 페이지를 여는 동안에는 edge 의 IP당 요청 제한(10 r/s · burst)이 차서 nginx 가 HTML 429 를 준다.
 */

test.describe.configure({ mode: "serial" }); // 이 파일 안에서도 한 번에 하나씩

/** 앞선 요청으로 찬 edge 양동이가 빌 때까지 기다린다(제한 자체는 아래 XFF 시험이 그대로 시험한다). */
async function edgeReady(request: APIRequestContext) {
  await expect.poll(async () => (await request.get("/api/v1/status")).status(), { timeout: 15_000, intervals: [1_000] }).toBe(200);
  await new Promise((r) => setTimeout(r, 3_000)); // 새는 양동이가 비도록(10 r/s × 3 s)
}

test("status reports fixture collector and no external providers", async ({ request }) => {
  await edgeReady(request);
  const s = await (await request.get("/api/v1/status")).json();
  expect(s.fixture_mode).toBe(true);
  expect(s.region.provider).toBe("fixture");
  expect(s.sigmet.provider).toBe("fixture");
  expect(s.region.aircraft).toBeGreaterThan(50);
});

test("forged X-Forwarded-For does not bypass rate limiting (3 paths)", async ({ request }) => {
  // edge 가 XFF 를 덮어쓰므로 위조 값은 api 에 닿지 않는다. 같은 IP 로 계산돼야 한다.
  const headers: Record<string, string>[] = [{ "X-Forwarded-For": "1.2.3.4" }, { "X-Forwarded-For": "5.6.7.8, 9.9.9.9" }, { "X-Real-IP": "10.0.0.1", Forwarded: "for=8.8.8.8" }];
  const remaining: number[] = [];
  await edgeReady(request);
  for (const h of headers) {
    const r = await request.get("/api/v1/status", { headers: h });
    remaining.push(Number(r.headers()["x-ratelimit-remaining"]));
  }
  expect(remaining[0]).toBeGreaterThan(remaining[1]);
  expect(remaining[1]).toBeGreaterThan(remaining[2]);
});
