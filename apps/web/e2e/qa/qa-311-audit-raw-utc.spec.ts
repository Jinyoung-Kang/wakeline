import { expect, test } from "@playwright/test";
import { mockOpsApi } from "./qa-helpers";

/**
 * QA-311 · 낮음 — 운영 감사의 before · after 칸은 api 가 준 JSON 글자(안의 시각은 '…Z' = UTC)를 그대로 보이면서, 같은 화면의 다른 원본 칸(격리 detail ·
 * DLQ payload · 실행 오류 — data-raw + 머리글 "(raw)" + 툴팁 "‘…Z’ 는 KST 보다 9시간 이르다")과 달리 원본이라는 표시가 없다(app/ops/page.tsx — audit 표의
 * before/after 머리글 · 칸). 화면 시각은 KST 만이라는 규칙의 예외임을 알리지 않아 UTC 시각을 KST 로 읽게 된다.
 * 실제 행(격리 스택 A): UNRESOLVE provider_error:opensky — before {"…","upto": "2026-10-01T17:54:22Z", "resolved_at": "2026-10-01T17:56:09.181606Z", …}.
 */
test("QA-311 audit before/after JSON with UTC times is marked as raw like the other raw columns", async ({ page }) => {
  const before = JSON.stringify({ id: 3, key: "opensky", kind: "provider_error", note: "QA", upto: "2026-10-01T17:54:22Z", resolved_at: "2026-10-01T17:56:09.181606Z", resolved_by: "qa-b" });
  const after = JSON.stringify({ id: 3, revoked_at: "2026-10-01T17:56:09.814402Z", revoked_by: "qa-b" });
  await mockOpsApi(page, {
    "/api/v1/ops/audit": { items: [{ id: 70, username: "qa-b", action: "UNRESOLVE", target: "provider_error:opensky", before, after, ip: "172.25.0.1", request_id: "d51500a1", at: "2026-10-01T17:56:09.814Z" }], next_cursor: null },
  });
  await page.goto("/ops");
  await expect(page.getByTestId("ops-dashboard")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("ops-tab-audit").click();
  const cells = page.locator("td").filter({ hasText: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}[^"]*Z/ });
  await expect(cells).toHaveCount(2);
  for (const c of await cells.all()) await expect(c.locator("xpath=self::*[@data-raw] | .//*[@data-raw]")).toHaveCount(1);
  const headers = await page.locator("thead th").allInnerTexts();
  expect(headers.filter((h) => /before|after/i.test(h)).every((h) => /\(raw\)/i.test(h)), `headers: ${headers.join(" | ")}`).toBe(true);
});
