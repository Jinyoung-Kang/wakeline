import { expect, test } from "@playwright/test";

/**
 * 기상특보 탭(계약 v5 §G49 · ADR-036 · SPEC F3) — 격리 스택의 수집기는 재생 공급자(2026-10-09 실제 응답 — 예비 풍랑 3건, 시각을 지금으로)를 5분마다 보낸다.
 * 실제 api 응답으로: 'wx' 탭 → 해상 상위 구역별 묶음 · 예비특보는 때(시간대)로 · 육상 없음 · KST 만. 선박 카드 한 줄은 단위 시험(warnings.test.ts)이 본다.
 */
test("wx tab: the replayed preliminary gale warnings grouped by sea area, with time slots in KST", async ({ page, request }) => {
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (r) => r.abort());
  // 수집기의 첫 발행(기동 15 s 뒤)을 기다린다 — 탭은 60 s 마다만 다시 묻는다
  await expect.poll(async () => (await (await request.get("/api/v1/warnings")).json()).received, { timeout: 60_000 }).toBe(true);
  await page.goto("/");
  await page.getByTestId("tab-wx").click();
  const status = page.getByTestId("warnings-status");
  // 예비특보는 아직 발효가 아니다 — 따로 센다(QA-709)
  await expect(status).toContainText("발효 중 0건(해상 0 · 육상 0) · 예비 3 · 기상청 API허브 특보현황", { timeout: 20_000 });
  await expect(status).toContainText(/받음 \d\d:\d\d KST/);
  await expect(page.getByTestId("warning-row")).toHaveCount(3);
  await expect(page.getByTestId("warnings-sea-group").first()).toContainText("해상 · 남해동부전해상");
  await expect(page.getByTestId("warning-row").first()).toContainText(/풍랑 예비 · 발표 · \d\d-\d\d 오후\(12–18시 KST\) 예상/);
  await expect(page.getByTestId("warnings-land")).toHaveCount(0);
  await expect(page.getByTestId("warning-panel")).not.toContainText("UTC");
});
