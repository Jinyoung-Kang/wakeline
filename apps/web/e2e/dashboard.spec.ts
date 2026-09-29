import { expect, test } from "@playwright/test";

const SOURCES = ["adsb.lol", "ODbL", "adsb.fi", "OpenSky Network", "aisstream.io", "adsbdb.com", "UN/LOCODE", "AviationWeather.gov", "RainViewer", "기상청 API허브", "OpenFreeMap", "OpenMapTiles", "OpenStreetMap"];

// fixture 모드 스택 대상(FR-12): 외부 호출 없이 전 화면 동작.
test("dashboard loads with attribution, lag badge and aircraft", async ({ page }) => {
  const cspViolations: string[] = [];
  page.on("console", (m) => { if (m.text().includes("Content Security Policy")) cspViolations.push(m.text()); });
  await page.goto("/");
  await expect(page.getByTestId("statusbar")).toBeVisible();
  // 출처는 항상 화면 안에, 잘리지 않고(FR-20 · NFR-15) — DOM 에 있기만 한 것이 아니라 뷰포트 안에 보여야 한다
  const attribution = page.getByTestId("attribution");
  await expect(attribution).toBeInViewport({ ratio: 1 });
  for (const src of SOURCES) await expect(attribution).toContainText(src);
  expect(await attribution.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 20_000 });
  // 지도 위 크레딧(compact ⓘ — 사용자 요청 2026-09-29): 이 창(1400 px)의 지도(1020 px)에서는 접힌 채로 시작하고, ⓘ 를 누르면 데이터 출처 전부(OpenSky·기상청 포함)
  const mapCredit = page.locator(".maplibregl-ctrl-attrib");
  await expect(mapCredit).toBeInViewport({ timeout: 20_000 });
  await expect(mapCredit).not.toHaveAttribute("open", "");
  const creditToggle = mapCredit.locator("summary");
  await expect(creditToggle).toHaveAttribute("aria-label", /SOURCES/);
  await creditToggle.click();
  await expect(mapCredit).toHaveAttribute("open", "");
  for (const src of ["adsb.lol", "ODbL", "adsb.fi", "OpenSky Network", "aisstream.io", "AviationWeather.gov", "RainViewer", "기상청 API허브", "OpenStreetMap"]) await expect(mapCredit).toContainText(src);
  await expect(mapCredit.locator(".maplibregl-ctrl-attrib-inner")).toBeVisible();
  // 펼친 상자 안의 링크도 Tab 순서 밖(R-30 — MapLibre 정화가 지운 tabindex 를 그린 뒤에 다시 건다)
  expect(await mapCredit.locator("a:not([tabindex='-1'])").count()).toBe(0);
  await creditToggle.click();
  await expect(mapCredit).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("fixture-badge")).toBeVisible({ timeout: 20_000 });
  // 배지만이 아니라 실제 수집 출처가 fixture 인지(외부 호출 없음) 확인 — 출처는 상태 바의 '상세' 표에 있다(2026-09-30 상태 바 칩)
  await expect(page.getByTestId("lag-badge")).toContainText("lag", { timeout: 30_000 });
  await page.getByTestId("statusbar-details-toggle").click();
  await expect(page.getByTestId("statusbar-details").locator('[data-row="region"]')).toContainText("fixture", { timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("layer-panel")).toBeVisible();
  expect(cspViolations).toEqual([]);
});

test("alert panel shows aircraft inside the synthetic fixture SIGMET with evidence", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 20_000 });
  const items = page.getByTestId("alert-item");
  await expect(items.first()).toBeVisible({ timeout: 60_000 });
  expect(await items.count()).toBeGreaterThanOrEqual(3);
  // 합성 SIGMET(RKRR FX1 TS, 한반도 중부) 안의 항공기가 관측 알림으로 잡혀야 한다
  await expect(page.locator('[data-testid="alert-item"][data-kind="OBSERVED"]', { hasText: "RKRR" }).first()).toBeVisible();
  // 행을 누르면 목록 안에서 근거가 펼쳐지고(선택하지 않음), 펼친 영역의 버튼이 항공기 카드를 연다(R-08)
  await items.first().getByTestId("alert-toggle").click();
  await expect(items.first().getByTestId("alert-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(items.first().getByTestId("evidence")).toBeVisible();
  await expect(items.first().getByTestId("evidence")).toContainText("고도대");
  await items.first().getByTestId("alert-open-aircraft").click();
  await expect(page.getByTestId("aircraft-card")).toBeVisible();
  // 알림 탭으로 돌아오면 펼친 근거가 그대로 있다
  await page.getByTestId("tab-alerts").click();
  await expect(items.first().getByTestId("evidence")).toBeVisible();
});

test("aircraft layer off: the status bar count becomes unknown ('—') instead of a frozen number, and comes back when on", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 20_000 });
  const count = page.getByTestId("aircraft-count");
  await expect(count).toContainText(/aircraft\s*[1-9]\d*/, { timeout: 30_000 });
  const btn = page.getByTestId("layer-aircraft");
  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  await expect(count).toContainText("—");
  await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
  await expect(count).toContainText(/aircraft\s*[1-9]\d*/, { timeout: 30_000 });
});

test("attribution footer stays fully visible at a narrow width", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  const attribution = page.getByTestId("attribution");
  await expect(attribution).toBeInViewport({ ratio: 1 });
  for (const src of SOURCES) await expect(attribution).toContainText(src);
  expect(await attribution.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

test("aircraft search: '/' focuses, Enter selects and opens the card (keyboard only)", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 20_000 });
  // fixture 스냅샷에서 호출부호가 있는 항공기 하나를 골라 그 접두사로 검색
  const fc = await (await request.get("/api/v1/aircraft?bbox=120,30,135,43")).json();
  const withCs = (fc.features as { properties: { callsign?: string; hex: string } }[]).find((f) => (f.properties.callsign ?? "").trim().length >= 4);
  expect(withCs, "fixture has an aircraft with a callsign").toBeTruthy();
  const cs = withCs!.properties.callsign!.trim();
  await page.locator("body").press("/");
  await expect(page.getByTestId("aircraft-search-input")).toBeFocused();
  await page.keyboard.type(cs);
  const first = page.getByTestId("aircraft-search-item").first();
  await expect(first).toBeVisible({ timeout: 10_000 });
  await expect(first).toContainText(cs);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("aircraft-card")).toBeVisible();
  await expect(page.getByTestId("aircraft-card")).toContainText(withCs!.properties.hex);
  await expect(page).toHaveURL(/#([89]|1[0-2])(\.\d+)?\//, { timeout: 10_000 }); // 지도가 줌 8 이상으로 이동
});

test("legend is collapsible and describes the map encodings", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByTestId("legend-toggle");
  const legend = page.getByTestId("map-legend");
  // 1600 px 보다 좁은 화면에서는 처음에 접혀 있다(R-31) — 이 시험의 기본 창은 그보다 좁다
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(legend).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  for (const t of ["FL250", "30분 안에 만료", "LIFR", "METAR 오래됨", "추정"]) await expect(legend).toContainText(t);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(legend).toHaveCount(0);
});

test("ops is 404 for anonymous API calls and shows login form", async ({ page, request }) => {
  const r = await request.get("/api/v1/ops/providers");
  expect(r.status()).toBe(404);
  await page.goto("/ops");
  await expect(page.getByTestId("ops-login")).toBeVisible();
});
