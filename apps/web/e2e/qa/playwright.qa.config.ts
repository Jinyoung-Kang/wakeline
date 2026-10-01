import { defineConfig } from "@playwright/test";

/**
 * QA 2026-10 화면 · 접근성 점검(계획 §3.3 · §3.6) 전용 설정 — 기존 `make e2e`(../../playwright.config.ts)와 따로 돈다.
 * 대상은 격리 스택 A(http://localhost:8701)만. 운영 스택(8700)에는 돌리지 않는다(qa-helpers 의 assertIsolated 가 막는다).
 *
 *   cd apps/web && npx playwright test -c e2e/qa/playwright.qa.config.ts                  # 전부
 *   cd apps/web && npx playwright test -c e2e/qa/playwright.qa.config.ts qa-sweep         # 하나
 *
 * 작업자 1명: 모든 페이지가 같은 IP 라 edge 의 IP당 제한(10 r/s · burst 60)을 나눠 쓴다(기존 설정과 같은 까닭).
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 180_000,
  retries: 0,
  workers: 1,
  outputDir: "../../test-results/qa",
  use: {
    baseURL: process.env.QA_BASE_URL ?? "http://localhost:8701",
    // 흔적(trace)은 끈다: 운영 로그인(qa-helpers loginOps)의 fill 값이 흔적 파일에 남는다 — 비밀번호를 파일에 남기지 않는다
    trace: "off",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    viewport: { width: 1440, height: 900 },
    locale: "ko-KR",
    // 브라우저 시간대를 KST 가 아닌 UTC 로 둔다: 화면이 브라우저 시간대가 아니라 KST 로 그리는지(제품 규칙) 드러나게
    timezoneId: "UTC",
  },
  reporter: [["list"]],
});
