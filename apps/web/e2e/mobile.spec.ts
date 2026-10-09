import { expect, test } from "@playwright/test";
import { overflow, runAxe } from "./qa/qa-helpers";

/**
 * 모바일 알림 화면 `/m`(SPEC F8 · 계약 v5 §G52 받아들일 조건): 375 · 320 px 에서 가로 넘침 없음 · 접근성(axe WCAG 2.1 A · AA) 위반 0 ·
 * 지도 · MapLibre · WS 요청 없음 · 열린 알림 줄을 누르면 근거 화면. 격리 스택의 fixture 항공기가 합성 SIGMET 에 들어가 만든 실제 알림으로.
 */
for (const width of [375, 320]) {
  test(`mobile /m at ${width} px: alerts list, no map or WS, no horizontal overflow, no axe violations`, async ({ page, request }) => {
    await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (r) => r.abort());
    await expect.poll(async () => ((await (await request.get("/api/v1/alerts")).json()).items as unknown[]).length, { timeout: 90_000, intervals: [2_000] })
      .toBeGreaterThan(0);
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));
    let ws = 0;
    page.on("websocket", () => { ws++; });
    await page.setViewportSize({ width, height: 740 });
    await page.addInitScript(() => localStorage.setItem("wakeline.watch", JSON.stringify([{ kind: "airport", id: "RKSI" }])));
    await page.goto("/m");
    await expect(page.getByTestId("mobile-status")).toContainText(/열린 알림 \d+건 · 15초마다/, { timeout: 20_000 });
    await expect(page.getByTestId("mobile-alert").first()).toBeVisible();
    await expect(page.getByTestId("mobile-watch-item")).toHaveCount(1);
    const o = await overflow(page);
    expect(o.overflow, JSON.stringify(o.offenders)).toBe(false);
    expect(o.offenders).toEqual([]);
    expect(await runAxe(page)).toEqual([]);
    expect(ws).toBe(0);
    expect(urls.filter((u) => /maplibre|\/ws\/v1/.test(u))).toEqual([]);
    expect(await page.getByTestId("mobile").innerText()).not.toContain("UTC");
    if (width === 320) {
      const href = await page.getByTestId("mobile-alert").first().getAttribute("href");
      await page.getByTestId("mobile-alert").first().click();
      await expect(page).toHaveURL(new RegExp(`${href}$`));
      await expect(page.getByTestId("alert-sheet")).toBeVisible({ timeout: 20_000 });
    }
  });
}
