import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * 계약 v2 E2E — 격리된 fixture 스택(make e2e: collector·ais 모두 fixture 재생, 외부 호출 없음)을 대상으로 한다.
 * 선박(ais 컨테이너가 fixtures/ais_east_asia_90s.jsonl 을 재생) · 집중 추적 칩 · 레이더 타임라인 · 통계·재생 화면 · CSP.
 */

/** fixture AIS 재생 영역(동아시아 18–46N, 105–150E) — REST bbox 상한 2 500 sq° 안 */
const AIS_BBOX = "105,18,150,46";

type ShipFeature = { geometry: { coordinates: [number, number] }; properties: { mmsi: string; name?: string | null } };

/** api 가 fixture 선박을 받을 때까지 기다렸다가 목록을 돌려준다(ais 는 10 s 마다 묶어 보낸다) */
async function fixtureShips(request: APIRequestContext): Promise<ShipFeature[]> {
  let ships: ShipFeature[] = [];
  await expect.poll(async () => {
    const r = await request.get(`/api/v1/ships?bbox=${AIS_BBOX}`);
    if (!r.ok()) return 0;
    const fc = await r.json();
    ships = Array.isArray(fc.features) ? fc.features : [];
    return ships.length;
  }, { timeout: 90_000, intervals: [2_000, 5_000] }).toBeGreaterThan(0);
  return ships;
}

/** 지도 해시(#zoom/lat/lon)로 연다. 첫 로드에 해시가 적용되지 않았으면(개발 모드의 이중 마운트 등) hashchange 로 한 번 더 옮긴다. */
async function openAt(page: Page, zoom: number, lat: number, lon: number) {
  const hash = `#${zoom}/${lat.toFixed(4)}/${lon.toFixed(4)}`;
  await page.goto(`/${hash}`);
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 20_000 });
  await page.evaluate((h) => { if (location.hash.split("/")[0] !== h.split("/")[0]) location.hash = h; }, hash);
}

async function shipsOn(page: Page) {
  const btn = page.getByTestId("layer-ships");
  if ((await btn.getAttribute("aria-pressed")) !== "true") await btn.click();
  await expect(btn).toHaveAttribute("aria-pressed", "true");
}

test("ships layer: fixture ships at zoom ≥ 7, a count grid at low zoom, and the toggle is remembered", async ({ page, request }) => {
  const ships = await fixtureShips(request);
  const [lon, lat] = ships[0].geometry.coordinates;
  await openAt(page, 9, lat, lon);
  await shipsOn(page);
  const chip = page.getByTestId("ships-chip");
  await expect(chip).toHaveAttribute("data-mode", "points", { timeout: 30_000 });
  await expect(chip).toContainText(/선박 [1-9][\d,]*척 · 화면 안/);
  // 범례는 1600 px 보다 좁은 창에서 처음에 접혀 있다(R-31) — 펼쳐서 확인
  const legendToggle = page.getByTestId("legend-toggle");
  if ((await legendToggle.getAttribute("aria-expanded")) !== "true") await legendToggle.click();
  await expect(page.getByTestId("map-legend")).toContainText("선박 · 선종");
  // 줌 4 미만으로 축소하면 서버가 격자(칸별 선박 수)로 바꿔 보낸다(계약 v4 §C — 줌 4–6 은 화면 안 1,500척 이하면 개별)
  await page.evaluate(() => { location.hash = "#3/32/128"; });
  await expect(chip).toHaveAttribute("data-mode", "grid", { timeout: 30_000 });
  await expect(chip).toContainText(/격자 \d+칸으로 묶음 · 줌 4 이상에서 개별 표시/);
  // 뷰어별 기억(localStorage): 새로 고쳐도 선박 레이어가 켜져 있다
  await page.reload();
  await expect(page.getByTestId("layer-ships")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("ships-chip")).toBeVisible({ timeout: 30_000 });
});

test("ship card: every field is listed and values the ship did not report are '—'", async ({ page, request }) => {
  const ships = await fixtureShips(request);
  // IMO 를 보고하지 않은 선박(정적 보고 없음 또는 Class B) 하나를 고른다 — 공개 API 분당 한도(IP 당 120)를 생각해 몇 척만 본다
  let target: ShipFeature | null = null;
  let sogReported = false;
  for (const s of ships.slice(0, 8)) {
    const r = await request.get(`/api/v1/ships/${s.properties.mmsi}`);
    if (!r.ok()) continue;
    const d = await r.json();
    if (!d.static || d.static.imo == null) { target = s; sogReported = d.state?.sog_kn != null; break; }
  }
  expect(target, "fixture has a ship without a reported IMO").toBeTruthy();
  const [lon, lat] = target!.geometry.coordinates;
  const mmsi = target!.properties.mmsi;
  await openAt(page, 10, lat, lon);
  await shipsOn(page);
  await page.getByTestId("tab-ship").click();
  await page.getByTestId("ship-list-filter").fill(mmsi);
  const item = page.locator(`[data-testid="ship-list-item"][data-mmsi="${mmsi}"]`);
  await expect(item).toBeVisible({ timeout: 30_000 });
  await item.click();
  const card = page.getByTestId("ship-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText(mmsi);
  for (const f of ["선박명", "MMSI", "호출부호", "IMO", "선종", "크기", "흘수", "출발지(보고)", "목적지(보고)", "ETA", "속력/침로/선수방위", "항해 상태", "위치 출처", "관측 시각", "처음 기록", "마지막 저장 위치"]) {
    await expect(card.locator(`[data-field="${f}"]`)).toHaveCount(1);
  }
  // 속력 줄(침로·선수방위 줄과 따로)은 kn 과 km/h 를 함께(계약 v5 §A) — 상세가 속력을 줬으면 반드시 두 단위, 아니면 두 단위이거나 "—" 하나
  const dual = /^\d+\.\d kn · \d+\.\d km\/h$/;
  await expect(card.getByTestId("ship-sog")).toHaveText(sogReported ? dual : /^(\d+\.\d kn · \d+\.\d km\/h|—)$/);
  await expect(card.locator('[data-field="IMO"]')).toContainText("—");
  // 출발지(보고): A>B 로 적힌 목적지의 풀이이거나, AIS 에 출발지 항목이 없다는 설명 또는 모름(—) — 지어낸 항구가 아니다
  await expect(card.locator('[data-field="출발지(보고)"]')).toContainText(/UN\/LOCODE|AIS 에는 출발지 항목이 없습니다|—/);
  // ETA 는 네 값이 모두 있을 때만 KST + "선원 입력 · 연도 없음"(달력에 없는 입력 날짜는 그렇다고만), 아니면 "—" — 연도를 지어내지 않는다(계약 v5 §G19 — UTC 없음)
  await expect(card.locator('[data-field="ETA"]')).toContainText(/—|선원 입력/);
  await expect(card.getByTestId("ship-track-info")).toBeVisible();
});

test("focus tracking chip appears after selecting an aircraft and goes away when deselected", async ({ page, request }) => {
  await openAt(page, 7, 36.5, 127.8);
  const fc = await (await request.get("/api/v1/aircraft?bbox=120,30,135,43")).json();
  const withCs = (fc.features as { properties: { callsign?: string; hex: string } }[]).find((f) => (f.properties.callsign ?? "").trim().length >= 4);
  expect(withCs, "fixture has an aircraft with a callsign").toBeTruthy();
  await page.locator("body").press("/");
  await page.keyboard.type(withCs!.properties.callsign!.trim());
  await expect(page.getByTestId("aircraft-search-item").first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("aircraft-card")).toBeVisible();
  // 서버가 보고한 상태·주기 그대로("집중 추적 N초 · …") — fixture 수집기는 집중 추적을 fixture 스냅샷으로 응답한다
  await expect(page.getByTestId("demand-chip")).toContainText(/집중 추적 \d+(\.\d)?초/, { timeout: 45_000 });
  await expect(page.locator('[data-testid="demand-map-chip"][data-kind="focus"]')).toBeVisible();
  await page.getByTestId("aircraft-card").getByRole("button", { name: "닫기" }).click();
  await expect(page.locator('[data-testid="demand-map-chip"][data-kind="focus"]')).toHaveCount(0);
});

test("radar timeline: frame and source switches update the UI within 200 ms", async ({ page }) => {
  await openAt(page, 6, 36.5, 127.8);
  const label = page.getByTestId("radar-frame-time");
  await expect(label).not.toHaveText("—", { timeout: 30_000 });
  await expect(page.getByTestId("radar-src-rv")).toHaveAttribute("aria-pressed", "true");
  // 슬라이더를 첫 프레임으로 — 라벨이 바뀔 때까지 걸린 시간(React 반영)
  const frameMs = await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const el = document.querySelector('[data-testid="radar-frame-time"]')!;
    const input = document.querySelector('input[aria-label="레이더 프레임"]') as HTMLInputElement;
    const before = el.textContent;
    const t0 = performance.now();
    const mo = new MutationObserver(() => { if (el.textContent !== before) { mo.disconnect(); resolve(performance.now() - t0); } });
    mo.observe(el, { characterData: true, childList: true, subtree: true });
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "0");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    setTimeout(() => reject(new Error("frame label did not change")), 2_000);
  }));
  expect(frameMs).toBeLessThan(200);
  const kma = page.getByTestId("radar-src-kma");
  if (await kma.isDisabled()) {
    // 기상청 레이더가 없는 스택(키 없음): 전환 버튼은 막혀 있고 이유를 말한다 — 없는 자료로 바꾸는 척하지 않는다
    await expect(kma).toHaveAttribute("title", /.+/);
    test.info().annotations.push({ type: "note", description: "KMA radar unavailable in this stack — source switch checked as disabled" });
    return;
  }
  const switchMs = await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const el = document.querySelector('[data-testid="radar-frame-time"]')!;
    const before = el.textContent;
    const t0 = performance.now();
    const mo = new MutationObserver(() => { if (el.textContent !== before) { mo.disconnect(); resolve(performance.now() - t0); } });
    mo.observe(el, { characterData: true, childList: true, subtree: true });
    (document.querySelector('[data-testid="radar-src-kma"]') as HTMLButtonElement).click();
    setTimeout(() => reject(new Error("source switch did not change the label")), 2_000);
  }));
  expect(switchMs).toBeLessThan(200);
  await expect(kma).toHaveAttribute("aria-pressed", "true");
  await expect(label).toHaveText(/^\d\d-\d\d \d\d:\d\d KST$/); // KST 만(계약 v5 §G19)
  await expect(label).toHaveAttribute("title", /기상청이 준 KST/); // 기상청 tm 은 원래 KST — 그대로
  const kmaText = await label.textContent();
  await page.getByTestId("radar-src-rv").click();
  await expect(page.getByTestId("radar-src-rv")).toHaveAttribute("aria-pressed", "true");
  // 두 공급자 라벨이 같은 모양("MM-DD HH:MM KST" — §G19)이라 모양만으로는 라벨이 RainViewer 로 돌아왔는지 알 수 없다:
  // 툴팁이 RainViewer 프레임의 연도 · ms 까지의 KST 이고, 글자가 방금 본 기상청 라벨과 달라야 한다(첫 프레임 2 h 전 ≠ 기상청 최신 프레임)
  await expect(label).toHaveAttribute("title", /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} KST$/);
  await expect(label).not.toHaveText(kmaText ?? "");
  await expect(label).toHaveText(/^\d\d-\d\d \d\d:\d\d KST$/);
});

test("stats page renders its four panels (data or an explicit 'not aggregated yet')", async ({ page }) => {
  await page.goto("/stats");
  await expect(page.getByRole("heading", { name: "Statistics" })).toBeVisible();
  for (const h of ["SIGMET by FIR", "SIGMET by hazard", "Distinct aircraft by hour", "Alerts by kind"]) {
    await expect(page.getByRole("heading", { name: new RegExp(h) })).toBeVisible();
  }
  await expect(page.getByLabel("집계 날짜(KST)")).toBeVisible(); // 집계 날짜는 KST 날짜(서버가 KST 날짜로 센다 — 계약 v5 §G19)
  await expect(page.getByTestId("stats-zone-error")).toHaveCount(0); // api 가 KST 날짜로 셌다고 밝혔다(day_zone)
  await expect(page.locator(".text-bad")).toHaveCount(0); // API 오류 문구 없음
});

test("replay page renders a frame for a past time", async ({ page }) => {
  await page.goto("/replay");
  await expect(page.getByTestId("replay-at")).not.toHaveText("—", { timeout: 10_000 });
  // 재생 시각은 KST 만(§G19 — 연도까지), api 에는 그 순간(UTC ISO — 전송 형식)
  await expect(page.getByTestId("replay-at")).toHaveText(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d KST$/);
  await expect(page.getByLabel("재생 시각(KST)")).toBeVisible();
  await expect(page.getByTestId("replay-summary")).toContainText(/\d+ aircraft · \d+ SIGMET · /, { timeout: 20_000 });
  await expect(page.getByTestId("replay-map")).toBeVisible();
  await expect(page.getByTestId("attribution")).toBeInViewport();
});

test("replay slider keeps its geometry while dragging; the label follows at once; frame requests are debounced", async ({ page }) => {
  // 사용자 영상(2026-09-29): 끄는 동안 슬라이더 폭 · 위치가 바뀌어 손잡이가 커서에서 떨어졌다(상태 글자와 한 flex 줄)
  const replayReqs: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/api/v1/replay?")) replayReqs.push(r.url()); });
  await page.goto("/replay");
  await expect(page.getByTestId("replay-summary")).toContainText(/\d+ aircraft · /, { timeout: 20_000 });
  const slider = page.locator('input[type="range"][aria-label="재생 시각"]');
  const box0 = (await slider.boundingBox())!;
  const before = replayReqs.length;
  const y = box0.y + box0.height / 2;
  await page.mouse.move(box0.x + box0.width * 0.9, y);
  await page.mouse.down();
  const boxes: { x: number; width: number; y: number }[] = [];
  const labels: string[] = [];
  // 72 h 경계를 넘나들며(원해상도 ↔ 1분 요약 — 상태 글자 길이가 바뀐다) 끈다
  for (const f of [0.8, 0.6, 0.4, 0.2, 0.05, 0.3, 0.7, 0.95]) {
    await page.mouse.move(box0.x + box0.width * f, y, { steps: 4 });
    const b = (await slider.boundingBox())!;
    boxes.push({ x: Math.round(b.x), width: Math.round(b.width), y: Math.round(b.y) });
    labels.push((await page.getByTestId("replay-at").textContent()) ?? "");
  }
  await page.mouse.up();
  for (const b of boxes) expect(b).toEqual({ x: Math.round(box0.x), width: Math.round(box0.width), y: Math.round(box0.y) });
  expect(new Set(labels).size).toBeGreaterThan(4); // 라벨은 입력마다 바로 바뀐다
  await expect(page.getByTestId("replay-frame-at")).toContainText("= 재생 시각", { timeout: 20_000 }); // 마지막 값의 프레임이 그려진다
  // 끄는 동안 입력(수십 건)마다 요청하지 않는다 — debounce 뒤 마지막 값만(움직임 사이 멈춤마다 최대 1건)
  expect(replayReqs.length - before).toBeLessThanOrEqual(boxes.length + 1);
});

test("no CSP violations or uncaught errors across pages (ships layer on)", async ({ page }) => {
  const errors: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      const w = window as unknown as { __csp?: string[] };
      (w.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const cspOf = () => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  await openAt(page, 8, 35, 129.5);
  await shipsOn(page);
  await expect(page.getByTestId("ships-chip")).toBeVisible({ timeout: 30_000 });
  errors.push(...(await cspOf()).map((x) => `csp: ${x}`));
  const pages: [string, string][] = [["/replay", "replay-summary"], ["/stats", "attribution"], ["/about", "attribution"], ["/airports/RKSI", "attribution"], ["/ops", "ops-login"], ["/logs", "ops-login"]];
  for (const [path, ready] of pages) {
    await page.goto(path);
    await expect(page.getByTestId(ready)).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState("load");
    errors.push(...(await cspOf()).map((x) => `csp ${path}: ${x}`));
  }
  expect(errors).toEqual([]);
});
