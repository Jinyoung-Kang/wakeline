import { defineConfig } from "@playwright/test";

// `make e2e` 가 띄우는 격리된 fixture 스택(http://localhost:8701)을 대상으로 한다. 개발 스택(8700)에는 돌리지 않는다.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  // 작업자 1명: 모든 브라우저가 같은 IP 라 edge 의 IP당 제한(10 r/s · burst 60 — 제품 동작)을 나눠 쓴다. 작업자 여럿이 캐시 없는 첫 화면
  // (페이지·RSC 미리 받기·API)을 동시에 열면 호스트가 빠를수록 양동이가 넘쳐 429 가 났다(리뷰 4단계 — 느린 날엔 통과, 조용한 날엔 4건 실패).
  // 재시도로 가리지 않고 순서대로 돌린다.
  workers: 1,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8701", trace: "retain-on-failure", viewport: { width: 1400, height: 900 } },
  reporter: [["list"], ["html", { open: "never" }]],
  // API 를 직접 부르는 요청 제한 시험은 화면 시험이 끝난 뒤 혼자 돈다(같은 IP 의 페이지 로드와 edge 양동이를 나눠 쓰지 않게)
  projects: [
    { name: "app", testIgnore: /edge-limits\.spec\.ts/ },
    { name: "edge-limits", testMatch: /edge-limits\.spec\.ts/, dependencies: ["app"] },
  ],
});
