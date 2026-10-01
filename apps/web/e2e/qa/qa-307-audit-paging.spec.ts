import { expect, test } from "@playwright/test";
import { mockOpsApi } from "./qa-helpers";

/**
 * QA-307 · 보통 — 운영 감사(audit) 탭은 api 의 첫 쪽(50건)만 그리고 next_cursor 를 버린다: '더 보기' 도 '더 있음' 표시도 없다(app/ops/page.tsx — audit 표,
 * lib/endpoints/ops.ts — 감사에 커서 인자 없음). 로그인 · 로그아웃마다 2행이 쌓여(격리 스택 A 에서 45분 만에 50건) 설정 변경 · 해결 기록이 화면에서 밀려 사라진다.
 * 실제 응답: GET /api/v1/ops/audit → items 50 · next_cursor 67, ?cursor=67 → items 50 · next_cursor 17.
 */
test("QA-307 audit tab offers the next page when the api says there is one", async ({ page }) => {
  const t0 = Date.now();
  const items = Array.from({ length: 50 }, (_, i) => ({
    id: 200 - i, username: "qa-mock", action: i % 2 ? "LOGIN" : "LOGOUT", target: "qa-mock", before: null, after: null, ip: "172.25.0.1",
    request_id: `r${i}`, at: new Date(t0 - i * 60_000).toISOString(),
  }));
  await mockOpsApi(page, { "/api/v1/ops/audit": { items, next_cursor: 150, generated_at: new Date(t0).toISOString() } });
  await page.goto("/ops");
  await expect(page.getByTestId("ops-dashboard")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("ops-tab-audit").click();
  await expect(page.locator("table tbody tr")).toHaveCount(50);
  await expect(page.getByRole("button", { name: /더 보기|이전/ }).or(page.getByText(/더 있음/))).toBeVisible({ timeout: 3000 });
});
