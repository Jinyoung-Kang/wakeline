import { defineConfig } from "@playwright/test";

// `make e2e` 가 띄우는 격리된 fixture 스택(http://localhost:8701)을 대상으로 한다. 개발 스택(8700)에는 돌리지 않는다.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8701", trace: "retain-on-failure", viewport: { width: 1400, height: 900 } },
  reporter: [["list"], ["html", { open: "never" }]],
  // API 를 직접 부르는 요청 제한 시험은 화면 시험이 끝난 뒤 혼자 돈다(같은 IP 의 페이지 로드와 edge 양동이를 나눠 쓰지 않게)
  projects: [
    { name: "app", testIgnore: /edge-limits\.spec\.ts/ },
    { name: "edge-limits", testMatch: /edge-limits\.spec\.ts/, dependencies: ["app"] },
  ],
});
