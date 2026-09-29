import { expect, test } from "@playwright/test";

/**
 * 재생 목록 패널(2026-09-30 설명서 캡처에서 발견): 목록이 패널(max-h 만 있는 flex 열) 밖으로 넘쳐 아래 SOURCES 줄 위에 글자가 겹쳤다.
 * 낮은 창에서도 목록은 패널 안에서만 스크롤되고, 패널은 지도 영역 안에 머문다. 새로 뜬 fixture 스택에는 재생할 항적이 없어(목록이 비어 넘칠 것이 없다)
 * 재생 응답만 이 시험이 만든 한 프레임(항공기 300대 — 계약의 모양 그대로, 값은 시험용)으로 바꿔 준다. 서버 자료는 건드리지 않는다.
 */
const frameFor = (at: string) => ({
  at,
  aircraft: Array.from({ length: 300 }, (_, i) => ({
    hex: `e2e${i.toString(16).padStart(3, "0")}`, ts: at, lat: 34 + (i % 30) * 0.1, lon: 126 + Math.floor(i / 30) * 0.2,
    alt_ft: 30000, gs_kt: 450, track_deg: 90, on_ground: false, provider: "fixture", averaged: false,
  })),
  sigmets: [],
  source: "track_point",
  radar: null,
});
test("replay list stays inside its panel and the map area on a short window", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 560 });
  await page.route(/\/api\/v1\/replay\?/, async (route) => {
    const at = new URL(route.request().url()).searchParams.get("at") ?? new Date().toISOString();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(frameFor(at)) });
  });
  await page.goto("/replay");
  const list = page.getByTestId("replay-list");
  if (!(await list.isVisible())) await page.getByTestId("replay-list-toggle").click();
  await expect(list).toBeVisible();
  await expect(page.getByTestId("replay-list-aircraft").first()).toBeVisible({ timeout: 20_000 });
  const m = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="replay-list"]')!.getBoundingClientRect();
    const map = document.querySelector('[data-testid="replay-map"]')!.getBoundingClientRect();
    const last = [...document.querySelectorAll('[data-testid="replay-list"] li, [data-testid="replay-list"] .label')].map((e) => e.getBoundingClientRect());
    // 보이는(스크롤 영역에 잘리지 않은) 줄만 — 패널 밖으로 그려진 줄이 있으면 실패
    const scroller = document.querySelector('[data-testid="replay-list"] .overflow-y-auto') as HTMLElement | null;
    const clip = scroller?.getBoundingClientRect();
    const drawnOutside = last.filter((r) => r.height > 0 && clip && r.top < clip.bottom - 1 && r.bottom > panel.bottom + 1).length;
    return { panelBottom: panel.bottom, mapBottom: map.bottom, drawnOutside, scrolls: scroller ? scroller.scrollHeight > scroller.clientHeight : null, scrollerBottom: clip?.bottom ?? null };
  });
  expect(m.panelBottom).toBeLessThanOrEqual(m.mapBottom + 1);
  expect(m.scrollerBottom).not.toBeNull();
  expect(m.scrollerBottom!).toBeLessThanOrEqual(m.panelBottom + 1);
  expect(m.drawnOutside).toBe(0);
});
