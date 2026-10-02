import { expect, test } from "@playwright/test";
import { blockExternal } from "./qa-helpers";

/**
 * QA-301 · 보통 — 재생 지도는 배경지도 스타일(외부 OpenFreeMap)을 받지 못하면 MapLibre 'load' 가 오지 않아 항공기 · SIGMET · 조회 상자 레이어가
 * 만들어지지 않는다(components/ReplayMap.tsx — 레이어는 'load' 에서만 더한다, 대체 스타일 · 시간 제한 · 알림이 없다). 상황판은 R-01 로 로컬
 * 대체 스타일로 바꾸고 "배경지도를 불러오지 못함"을 알린다(useMapLifecycle). 그래서 재생 화면은 "110 aircraft · 24 SIGMET" 을 적으면서 지도는 비어 있다.
 * 관찰 신호: 지도 'load' 처리기만 붙이는 출처 표기 컨트롤(.maplibregl-ctrl-attrib) — load 가 왔으면 있다.
 */
test("QA-301 replay map loads (fallback style) when the basemap host is unreachable — like the dashboard", async ({ page }) => {
  await blockExternal(page);
  await page.goto("/replay");
  await expect(page.getByTestId("replay-controls")).toBeVisible();
  await expect(page.getByTestId("replay-map").locator(".maplibregl-ctrl-attrib")).toHaveCount(1, { timeout: 25_000 });
});

test("QA-301 control: the dashboard map falls back and says so (passes)", async ({ page }) => {
  await blockExternal(page);
  await page.goto("/");
  await expect(page.getByTestId("basemap-failed")).toBeVisible({ timeout: 25_000 });
  await expect(page.locator(".maplibregl-ctrl-attrib")).toHaveCount(1, { timeout: 25_000 });
});
