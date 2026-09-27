import { expect, test } from "@playwright/test";

const SOURCES = ["adsb.lol", "ODbL", "adsb.fi", "OpenSky Network", "AviationWeather.gov", "RainViewer", "기상청 API허브", "OpenFreeMap", "OpenMapTiles", "OpenStreetMap"];

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
  // 지도 위 크레딧에도 데이터 출처 전부(OpenSky·기상청 포함)
  const mapCredit = page.locator(".maplibregl-ctrl-attrib");
  await expect(mapCredit).toBeInViewport({ timeout: 20_000 });
  for (const src of ["adsb.lol", "ODbL", "adsb.fi", "OpenSky Network", "AviationWeather.gov", "RainViewer", "기상청 API허브", "OpenStreetMap"]) await expect(mapCredit).toContainText(src);
  await expect(page.getByTestId("fixture-badge")).toBeVisible({ timeout: 20_000 });
  // 배지만이 아니라 실제 수집 출처가 fixture 인지(외부 호출 없음) 확인
  await expect(page.getByTestId("statusbar")).toContainText("fixture", { timeout: 20_000 });
  await expect(page.getByTestId("lag-badge")).toContainText("lag", { timeout: 30_000 });
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
  await items.first().locator("button").click();
  await expect(page.getByTestId("evidence").first()).toBeVisible();
  await expect(page.getByTestId("evidence").first()).toContainText("고도대");
  await expect(page.getByTestId("aircraft-card")).toBeVisible();
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
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const legend = page.getByTestId("map-legend");
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

test("status reports fixture collector and no external providers", async ({ request }) => {
  const s = await (await request.get("/api/v1/status")).json();
  expect(s.fixture_mode).toBe(true);
  expect(s.region.provider).toBe("fixture");
  expect(s.sigmet.provider).toBe("fixture");
  expect(s.region.aircraft).toBeGreaterThan(50);
});

test("forged X-Forwarded-For does not bypass rate limiting (3 paths)", async ({ request }) => {
  // edge 가 XFF 를 덮어쓰므로 위조 값은 api 에 닿지 않는다. 같은 IP 로 계산돼야 한다.
  const headers = [{ "X-Forwarded-For": "1.2.3.4" }, { "X-Forwarded-For": "5.6.7.8, 9.9.9.9" }, { "X-Real-IP": "10.0.0.1", Forwarded: "for=8.8.8.8" }];
  const remaining: number[] = [];
  for (const h of headers) {
    const r = await request.get("/api/v1/status", { headers: h });
    remaining.push(Number(r.headers()["x-ratelimit-remaining"]));
  }
  expect(remaining[0]).toBeGreaterThan(remaining[1]);
  expect(remaining[1]).toBeGreaterThan(remaining[2]);
});
