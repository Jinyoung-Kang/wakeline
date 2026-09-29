import { expect, test, type Page } from "@playwright/test";
import { predictedEvent, withPendingRoute } from "./ws-inject";

/**
 * 상황판 배치(사용자 스크린샷 2026-09-30 · 1427×829) — 격리된 fixture 스택(make e2e)에서 세 창 크기로 잰다.
 * - 상태 바: 가로로 스크롤되지 않고(scrollWidth ≤ clientWidth), 보이는 칩은 모두 줄 안에(잘리지 않음). 줄에서 뺀 칩은 '상세 +N' 과 상세 표에.
 * - 상세: 마우스(누름 · 바깥 누르기)와 키보드(Enter · Space · Esc — Esc 는 단추로 초점을 돌린다)로 열고 닫는다.
 * - 노선 조회 중: 가는 진행 막대 + 출발 · 도착 자리 표시(회전 사각형 없음), 나타남 지연 0.18 s, 움직임 줄이기 설정이면 막대 조각 없음.
 *   fixture 모드의 노선은 'disabled'(계약 v4 §G A-2)라 조회 중이 오지 않는다 — WS 를 실제 서버로 이어 주되 selected.route 만 pending 으로 바꿔 보낸다.
 * - 알림 배너: 두 줄(종류 · 호출부호 / SIGMET · 받은 시각)이 잘리지 않고 보인다 — 이벤트는 같은 방법으로 alerts_batch 하나를 끼워 넣는다.
 * - 알림 수 줄 · 검색 자리 글자 · 지도 위 배치(레이어 단추 · 칩 · 범례)가 서로 겹치거나 잘리지 않는다.
 * 모든 값은 fixture 스택의 자료나 이 파일이 끼워 넣은 메시지뿐이다(외부 호출 없음).
 */

const SIZES = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }] as const;

/** WS 를 실제 서버로 잇고, 받은 메시지를 바꿔(또는 그대로) 페이지에 준다. inject 로 메시지를 더 보낼 수 있다 */
async function proxyWs(page: Page, rewrite: (msg: Record<string, unknown>) => Record<string, unknown> = (m) => m) {
  let toPage: ((s: string) => void) | null = null;
  await page.routeWebSocket(/\/ws\/v1$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== "string") { ws.send(m); return; }
      let o: Record<string, unknown>;
      try { o = JSON.parse(m); } catch { ws.send(m); return; }
      ws.send(JSON.stringify(rewrite(o)));
    });
    toPage = (s) => ws.send(s);
  });
  return { inject: (o: unknown) => { expect(toPage, "WS connected").not.toBeNull(); toPage!(JSON.stringify(o)); } };
}

async function open(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 20_000 });
  await expect(page.getByTestId("lag-badge")).toContainText("lag", { timeout: 30_000 });
}

for (const size of SIZES) {
  test.describe(`${size.width}×${size.height}`, () => {
    test.use({ viewport: size });

    test("status bar: no horizontal scroll, no clipped chip; moved chips are counted and listed in 상세", async ({ page }) => {
      await open(page);
      const bar = page.getByTestId("statusbar");
      const row = page.getByTestId("statusbar-row");
      // 크기 관찰(ResizeObserver)이 한 번 돌 시간
      await page.waitForTimeout(300);
      const m = await row.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const kids = [...el.children].filter((c) => c.getAttribute("data-overflow") !== "true").map((c) => {
          const b = c.getBoundingClientRect();
          return { id: c.getAttribute("data-testid") ?? c.getAttribute("data-chip") ?? c.tagName, l: b.left, r: b.right, t: b.top, b: b.bottom, sw: (c as HTMLElement).scrollWidth, cw: (c as HTMLElement).clientWidth };
        });
        return { sw: el.scrollWidth, cw: el.clientWidth, l: r.left, r: r.right, t: r.top, b: r.bottom, kids, hidden: [...el.querySelectorAll('[data-overflow="true"]')].map((c) => c.getAttribute("data-chip")) };
      });
      expect(m.sw).toBeLessThanOrEqual(m.cw + 1);
      expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      for (const k of m.kids) {
        expect(k.l, k.id).toBeGreaterThanOrEqual(m.l - 1);
        expect(k.r, k.id).toBeLessThanOrEqual(m.r + 1);
        expect(k.b, k.id).toBeLessThanOrEqual(m.b + 1);
        expect(k.sw, k.id).toBeLessThanOrEqual(k.cw + 1); // 칩 안의 글자도 잘리지 않는다
      }
      // 줄에서 뺀 칩 수 = 단추의 +N, 이름은 단추 title 에 — 상세 표에는 모든 피드
      const toggle = page.getByTestId("statusbar-details-toggle");
      if (m.hidden.length) await expect(toggle).toContainText(`+${m.hidden.length}`);
      else await expect(toggle).not.toContainText("+");
      await toggle.click();
      const details = page.getByTestId("statusbar-details");
      for (const k of ["conn", "region", "world", "ais", "sigmet", "radar", "kma", "engine", "version", "fixture"]) await expect(details.locator(`[data-row="${k}"]`)).toHaveCount(1);
      // fixture 스택: 지역 피드의 실제 출처가 fixture(외부 호출 없음)이고 시각은 KST 만
      await expect(details.locator('[data-row="region"]')).toContainText("fixture");
      await expect(details).not.toContainText("UTC");
      expect(await details.evaluate((el) => { const b = el.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && el.scrollWidth <= el.clientWidth + 1; })).toBe(true);
    });

    test("상세 opens and closes by mouse and keyboard", async ({ page }) => {
      await open(page);
      const toggle = page.getByTestId("statusbar-details-toggle");
      const details = page.getByTestId("statusbar-details");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      await expect(details).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toHaveAttribute("aria-controls", (await details.getAttribute("id"))!);
      // 바깥(지도 왼쪽 아래)을 누르면 닫힌다
      const map = (await page.getByTestId("map").boundingBox())!;
      await page.mouse.click(map.x + 30, map.y + map.height - 30);
      await expect(details).toHaveCount(0);
      // 키보드: Enter 로 열고 Esc 로 닫으면 초점이 단추로 돌아온다 · Space 로 다시 열고 닫는다
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(details).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(details).toHaveCount(0);
      await expect(toggle).toBeFocused();
      await page.keyboard.press("Space");
      await expect(details).toBeVisible();
      await page.keyboard.press("Space");
      await expect(details).toHaveCount(0);
      // 안쪽을 눌러도 닫히지 않고, 닫기 단추로 닫힌다
      await toggle.click();
      await details.locator("th").first().click();
      await expect(details).toBeVisible();
      await details.getByRole("button", { name: "닫기" }).click();
      await expect(details).toHaveCount(0);
    });

    test("route lookup in progress: a thin bar and result-shaped placeholders, no rotating square", async ({ page, request }) => {
      await proxyWs(page, withPendingRoute);
      await open(page);
      const fc = await (await request.get("/api/v1/aircraft?bbox=120,30,135,43")).json();
      const withCs = (fc.features as { properties: { callsign?: string } }[]).find((f) => (f.properties.callsign ?? "").trim().length >= 4);
      expect(withCs, "fixture has an aircraft with a callsign").toBeTruthy();
      await page.locator("body").press("/");
      await page.keyboard.type(withCs!.properties.callsign!.trim());
      await expect(page.getByTestId("aircraft-search-item").first()).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Enter");
      const section = page.getByTestId("route-section");
      await expect(section).toHaveAttribute("data-status", "pending", { timeout: 20_000 });
      await expect(page.getByTestId("route-status")).toContainText("노선 조회 중");
      const loading = page.getByTestId("route-loading");
      await expect(loading).toBeVisible();
      const shape = await loading.evaluate((el) => {
        const bar = el.querySelector('[data-testid="route-progress"]')!;
        const b = bar.getBoundingClientRect();
        const after = getComputedStyle(bar, "::after");
        const rotating = [...document.querySelectorAll('[data-testid="route-section"] *')].some((e) => /rotate|matrix\(0/.test(getComputedStyle(e).transform) || getComputedStyle(e).animationName.includes("spin"));
        return { h: b.height, w: b.width, anim: after.animationName, delay: getComputedStyle(el).animationDelay, rows: [...el.querySelectorAll("[data-field]")].map((r) => r.getAttribute("data-field")), blocks: el.querySelectorAll(".skeleton").length, rotating };
      });
      expect(shape.h).toBe(2);
      expect(shape.w).toBeGreaterThan(200);
      expect(shape.anim).toBe("busy-slide");
      expect(shape.delay).toBe("0.18s");
      expect(shape.rows).toEqual(["출발", "도착"]);
      expect(shape.blocks).toBe(4);
      expect(shape.rotating).toBe(false);
      await expect(page.locator(".busy-spinner")).toHaveCount(0);
      // 움직임 줄이기: 막대 조각이 없다(글자 · 자리 표시는 그대로)
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await page.getByTestId("route-progress").evaluate((el) => getComputedStyle(el, "::after").display)).toBe("none");
      await expect(page.getByTestId("route-status")).toContainText("노선 조회 중");
    });

    test("alert banner: kind, callsign, SIGMET and time are all readable (two lines, nothing cut)", async ({ page }) => {
      const ws = await proxyWs(page);
      await open(page);
      await expect(page.getByTestId("alerts-counts")).toBeVisible();
      // 버전을 크게(틈) — 항목은 반영되고 배너가 뜬다(목록은 전체를 다시 받는다 — lib/ws-protocol applyAlertsBatch)
      ws.inject(predictedEvent(Date.now()));
      const banner = page.getByTestId("alert-banner");
      await expect(banner).toBeVisible({ timeout: 10_000 });
      await expect(banner.locator('[data-line="event"]')).toContainText("진입 예상(추정) · AAL2646");
      await expect(banner.locator('[data-line="sigmet"]')).toContainText("TS EMBD · MMEX");
      const time = page.getByTestId("alert-banner-time");
      await expect(time).toHaveText(/^수신 \d\d:\d\d:\d\d KST$/);
      await expect(time).toBeInViewport({ ratio: 1 });
      for (const line of await banner.locator("[data-line]").all()) expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      const panel = (await page.locator("#side-panel").boundingBox())!;
      const b = (await banner.boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
      await expect(banner).toHaveAttribute("title", /AAL2646 · SIGMET TS EMBD · MMEX\(MMEX:E2E1\) · 수신 \d\d-\d\d \d\d:\d\d:\d\d KST/);
    });

    test("alert counts, search placeholder and map overlays do not wrap, clip or overlap", async ({ page }) => {
      await page.addInitScript(() => { try { localStorage.setItem("wakeline.layers", JSON.stringify({ ships: true })); localStorage.setItem("wakeline.legend", "1"); } catch { /* 저장소 없음 */ } });
      await open(page);
      // 알림 수: 자기 줄 · 한 줄
      const counts = page.getByTestId("alerts-counts");
      expect(await counts.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().height <= 26)).toBe(true);
      const region = (await page.getByTestId("alerts-scope-region").boundingBox())!;
      const world = (await page.getByTestId("alerts-scope-world").boundingBox())!;
      expect(Math.abs(region.y - world.y)).toBeLessThan(2); // 범위 단추 둘이 한 줄
      // 검색: 자리 글자가 입력 안쪽 폭에 들어가고 "/" 표시와 겹치지 않는다
      const fit = await page.getByTestId("aircraft-search-input").evaluate((el) => {
        const input = el as HTMLInputElement;
        const cs = getComputedStyle(input);
        const ctx = document.createElement("canvas").getContext("2d")!;
        ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
        const inner = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const kbd = input.parentElement!.querySelector("kbd")!.getBoundingClientRect();
        const box = input.getBoundingClientRect();
        return { text: ctx.measureText(input.placeholder).width, inner, textEnd: box.left + parseFloat(cs.paddingLeft) + inner, kbdLeft: kbd.left };
      });
      expect(fit.text).toBeLessThanOrEqual(fit.inner);
      expect(fit.textEnd).toBeLessThanOrEqual(fit.kbdLeft + 1);
      // 지도 위: 레이어 단추 · 칩 · 교통량 상태 · 범례가 서로 겹치지 않고, 범례는 지도 안에서 끝난다
      await expect(page.getByTestId("ships-chip")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("map-legend")).toBeVisible();
      const boxes = await page.evaluate(() => [...document.querySelectorAll('[data-testid="layer-panel"] > button, [data-testid="map-chips"] > *, [data-testid="traffic-status"], [data-testid="map-legend"]')]
        .map((e) => { const b = e.getBoundingClientRect(); return { id: e.getAttribute("data-testid") ?? e.textContent?.slice(0, 10) ?? "", l: b.left, r: b.right, t: b.top, b: b.bottom }; }));
      const overlaps: string[] = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], c = boxes[j];
        if (a.l < c.r - 1 && c.l < a.r - 1 && a.t < c.b - 1 && c.t < a.b - 1) overlaps.push(`${a.id} × ${c.id}`);
      }
      expect(overlaps).toEqual([]);
      // 왼쪽 위 줌 단추와도 겹치지 않는다(겹침 배치의 왼쪽 경계 left-[48px] — 전에는 left-12 = 39 px 로 2 px 겹쳤다)
      const zoom = (await page.locator(".maplibregl-ctrl-top-left .maplibregl-ctrl-group").first().boundingBox())!;
      for (const b of boxes) if (b.t < zoom.y + zoom.height) expect(b.l, b.id).toBeGreaterThanOrEqual(zoom.x + zoom.width);
      const map = (await page.getByTestId("map").boundingBox())!;
      const legend = (await page.getByTestId("map-legend").boundingBox())!;
      expect(legend.y + legend.height).toBeLessThanOrEqual(map.y + map.height + 1);
    });
  });
}
