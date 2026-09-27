import { defineConfig } from "@playwright/test";

// fixture 모드로 띄운 스택(http://localhost:8700)을 대상으로 한다: SKYWX_FIXTURE_MODE=1 make up
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8700", trace: "retain-on-failure", viewport: { width: 1400, height: 900 } },
  reporter: [["list"], ["html", { open: "never" }]],
});
