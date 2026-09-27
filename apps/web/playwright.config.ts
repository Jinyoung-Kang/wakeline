import { defineConfig } from "@playwright/test";

// `make e2e` 가 띄우는 격리된 fixture 스택(http://localhost:8701)을 대상으로 한다. 개발 스택(8700)에는 돌리지 않는다.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8701", trace: "retain-on-failure", viewport: { width: 1400, height: 900 } },
  reporter: [["list"], ["html", { open: "never" }]],
});
