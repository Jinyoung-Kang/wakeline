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

test("an ETag the edge weakened with gzip still revalidates to 304 through the edge", async ({ request }) => {
  // edge(nginx)는 1,024 B 이상의 JSON 을 gzip 으로 줄이며 강한 ETag 를 W/"…" 로 바꾼다 — 브라우저 · lib/etag-poller 는 그 값을 If-None-Match 로 되돌려 보낸다.
  // 전에는 api 가 글자 그대로 견줘 edge 를 거친 조건부 요청이 늘 200 이었다(리뷰 2026-09-30 밤 — api Etags.notModified). fixture 항공기 목록은 1 KB 를 넘는다.
  // 두 요청 사이에 fixture 가 바뀌면 ETag 도 바뀌므로(10 s 주기) 맞을 때까지 몇 번 다시 한다.
  await edgeReady(request);
  const url = "/api/v1/aircraft?bbox=120,30,135,43";
  let weak = "";
  await expect.poll(async () => {
    const a = await request.get(url, { headers: { "Accept-Encoding": "gzip" } });
    weak = a.headers()["etag"] ?? "";
    if (!weak.startsWith('W/"')) return `ETag not weakened: ${weak} (content-encoding ${a.headers()["content-encoding"]})`;
    return (await request.get(url, { headers: { "Accept-Encoding": "gzip", "If-None-Match": weak } })).status();
  }, { timeout: 30_000, intervals: [1_000] }).toBe(304);
  expect(weak).toMatch(/^W\/"/);
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
