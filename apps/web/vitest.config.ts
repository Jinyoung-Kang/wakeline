import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // 커버리지(`vitest run --coverage`, @vitest/coverage-v8)는 시험이 불러온 파일만이 아니라 소스 전체를 센다 —
    // 불러오지 않은 파일(지도·페이지 이펙트 등)은 0 % 로 들어간다(R-34). 숫자를 높이려고 범위를 줄이지 않는다.
    coverage: {
      provider: "v8",
      include: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/**/*.ts", "public/*.js", "proxy.ts"],
      exclude: ["**/*.d.ts"],
    },
  },
  resolve: { alias: { "@": new URL(".", import.meta.url).pathname } },
});
