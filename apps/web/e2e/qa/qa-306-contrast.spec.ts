import { expect, test } from "@playwright/test";
import { blockExternal, mockOpsApi, runAxe } from "./qa-helpers";

/**
 * QA-306 · 낮음 — 글자 대비 4.5:1 미만(WCAG 1.4.3, axe color-contrast):
 * 1) 지도 범례의 고도 m 보조 표기(components/MapLegend.tsx:137 의 text-fg-3/80, 9 px): #727982 / #111418 = 4.19:1 (0 m · 3,048 m · 7,620 m 등).
 * 2) 로그 목록에서 고른 줄(bg #1c2a3f)의 ERROR 배지(.badge.bad #ef5d62, 10 px) = 4.41:1(components/logs/LogsDashboard.tsx:350 고른 줄 배경 · :352 배지).
 */
const contrast = async (page: import("@playwright/test").Page) =>
  (await runAxe(page)).filter((x) => x.id === "color-contrast").flatMap((x) => x.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary?.split("\n")[1]?.trim() ?? ""}`));

test("QA-306 map legend: altitude metre labels meet 4.5:1", async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
  await page.getByTestId("legend-toggle").click();
  await expect(page.getByTestId("map-legend")).toBeVisible();
  expect(await contrast(page)).toEqual([]);
});

test("QA-306 logs: the ERROR badge on the selected row meets 4.5:1", async ({ page }) => {
  const now = new Date().toISOString();
  await mockOpsApi(page, {
    "/api/v1/ops/logs": {
      items: [{ id: "1790878145526-0", stream: "client", v: 1, ts: now, service: "web-client", instance: "qa:1", level: "ERROR", logger: "qa", thread: null, message: "QA-306 contrast probe",
        exception: null, fp: "b843b52a914a8479", request_id: null, context: { path: "/logs" }, suppressed: 0, untrusted: true, resolved: null }],
      next_cursor: null, scanned: 1, scan_truncated: false, invalid: 0, hidden_resolved: 0, resolution_state: "ok",
    },
  });
  await page.goto("/logs");
  const row = page.getByTestId("log-row").first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");
  expect(await contrast(page)).toEqual([]);
});
