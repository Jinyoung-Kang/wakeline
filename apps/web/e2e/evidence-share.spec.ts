import { expect, test } from "@playwright/test";

/**
 * 근거 공유(SPEC F5 · 계약 v5 §G51) — 격리 스택의 fixture 항공기가 합성 SIGMET 에 들어가 만든 실제 알림으로:
 * 고정 링크 화면(근거 카드 · 좌표 표 · SIGMET 원문 사본 · KST 만) → JSON 내려받기(응답 그대로 + 내려받은 시각) → 인쇄 모양(흰 바탕 · 머리 줄 없음 · A4 한 쪽)
 * → '그 시각 재생' 링크가 그 시각 · 그 항공기를 고른 재생 화면을 연다. 틀린 재생 링크는 버리고 안내하며, 없는 알림은 보존 기간 안내.
 */
test("alert permalink: evidence, coordinates, SIGMET copy, JSON download, one A4 page in print, and the replay link", async ({ page, request }) => {
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (r) => r.abort());
  let id = 0;
  await expect.poll(async () => {
    const items = (await (await request.get("/api/v1/alerts?kind=observed")).json()).items as { id: number; sigmet_id?: string }[];
    id = items.find((a) => a.sigmet_id)?.id ?? 0;
    return id;
  }, { timeout: 90_000, intervals: [2_000] }).toBeGreaterThan(0);

  await page.goto(`/alerts/${id}`);
  const sheet = page.getByTestId("alert-sheet");
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("evidence")).toBeVisible();
  await expect(page.getByTestId("alert-state")).toContainText("열림(지금 판정 중)");
  await expect(page.getByTestId("alert-position")).toContainText(/위도 · 경도 -?\d+\.\d{4}, -?\d+\.\d{4}/);
  await expect(page.getByTestId("alert-sigmet-copy")).toContainText("원문");
  await expect(page.getByTestId("evidence-permalink")).toHaveCount(0);
  const screen = (await page.getByTestId("alert-sheet").innerText()).replace(await page.locator('[data-raw="bulletin"]').innerText(), "");
  expect(screen).not.toContain("UTC");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("alert-download").click()]);
  expect(download.suggestedFilename()).toBe(`wakeline-alert-${id}.json`);
  const saved = JSON.parse(await (await import("node:fs/promises")).readFile((await download.path())!, "utf8"));
  expect(saved.downloaded_at_kst).toMatch(/KST$/);
  expect(saved.response.alert.id).toBe(id);

  await page.emulateMedia({ media: "print" });
  await expect(page.locator("header").first()).toBeHidden();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(255, 255, 255)");
  const pdf = await page.pdf({ format: "A4", printBackground: true });
  expect(pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g)?.length).toBe(1);
  await page.emulateMedia({ media: "screen" });

  const replay = page.getByTestId("evidence-replay");
  const href = await replay.getAttribute("href");
  expect(href).toMatch(/^\/replay\?at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ&bbox=[-\d.,]+&hex=[0-9a-f]{6}$/);
  await replay.click();
  await expect(page).toHaveURL(/\/replay\?/);
  await expect(page.getByTestId("replay-inspector")).toContainText("Aircraft · 기록", { timeout: 20_000 });
  await expect(page.getByTestId("replay-url-note")).toHaveCount(0);
});

test("replay link with bad values opens the defaults and says why; a missing alert says it is past retention", async ({ page }) => {
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (r) => r.abort());
  await page.goto("/replay?at=2020-01-01T00:00:00Z&bbox=100,0,160,60&hex=zz");
  const notes = page.getByTestId("replay-url-note");
  await expect(notes).toHaveCount(3, { timeout: 20_000 });
  await expect(notes.nth(0)).toContainText("재생할 수 있는 구간(최근 30일 ~ 1분 전) 밖");
  await expect(page.getByTestId("replay-inspector")).toHaveCount(0);
  await page.goto("/alerts/1");
  await expect(page.getByTestId("alert-page-error")).toContainText("보존 기간이 지나 볼 수 없음", { timeout: 20_000 });
});
