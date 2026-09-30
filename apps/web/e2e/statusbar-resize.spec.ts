import { expect, test, type Page } from "@playwright/test";

/**
 * 브라우저 오류 'ResizeObserver loop completed with undelivered notifications.'(사용자 로그 2026-09-30 07:10 · 07:35 KST, 경로 "/", 데스크톱 앱의
 * 브라우저 창 크기를 바꾸는 동안 ERROR 두 번). 원인(이 시험을 로컬 하네스 — 이 레인의 next dev, 자료 없음 — 에 돌려 확인, 수정 전 4–5건):
 * 상태 바가 줄(statusbar-row)을 ResizeObserver 로 보고, 그 콜백 안에서 칩을 상세로 옮기는 결과를 바로(flushSync) 반영했다 — 창이 좁아져 줄이 두 줄로
 * 넘어간 뒤 칩을 옮기면 같은 콜백 안에서 관찰 중인 줄의 높이(와 '+N' 이 붙은 상세 단추의 높이 21.75 → 22.75 px)가 다시 바뀌어 브라우저가 그 알림을
 * 이번 프레임에 전하지 못한다. 줄을 보지 않게 한 뒤에도 1건이 남았다(632 px): 줄 높이가 바뀌면 아래 지도(MapLibre 의 ResizeObserver)의 높이도 같은 프레임에
 * 두 번 바뀐다 — 그래서 줄은 옮길 칩을 옮기면 들어가는 동안 한 줄로 둔다.
 * 이 시험: 창 폭을 1440 · 1280 · 1024 · 800 사이로 여러 번 오가고(한 번에 크게), 1440 에서 SWEEP_MIN 까지 8 px 씩 촘촘히 오가며(칩을 옮기는 경계를
 * 모두 지난다 — 자료가 없어 칩이 작은 스택에서도 경계가 800 아래에 있다) window 의 'error' 이벤트를 모아 ResizeObserver 오류가 없는지 본다. 줄은 여전히 가로로 넘치지 않고 '+N' 은 옮긴 칩 수와 같다(자리 흔들림 없이 끝난다). 브라우저 오류 보고기는 그대로다 — 이 메시지를 거르지
 * 않는다(원인을 없앴다). 외부 타일 요청은 막는다(상태 바만 본다 — 결과가 네트워크에 달리지 않게).
 * WS 가 열리지 않아도(자료 없음 — 칩이 모두 '모름') 돈다: 줄을 한 번 잰 뒤(data-measured)부터 본다.
 * 줄 높이(통합 리뷰 2026-09-30 — 전에는 단위 시험만 보았다): 끄는 동안 프레임마다(requestAnimationFrame) 줄 높이 · 줄바꿈 여부 · 상세 단추 높이를 적어 두고,
 * 줄바꿈이 아닌 모든 프레임에서 줄 높이가 한 줄 높이(1440 에서 잰 값)와 같고 상세 단추 높이가 늘 같은지 본다 — 두 줄로 번쩍이거나 오가지 않는다.
 * 줄바꿈(고정 항목 · 경고 칩만으로도 넘칠 때 — 잘리지 않게)은 제품 동작이라 그 프레임은 높이를 견주지 않는다.
 */

const WIDTHS = [1440, 1280, 1024, 800] as const;
/**
 * 촘촘히 끌 때의 가장 좁은 폭 — 칩이 적은(자료 없는) 스택에서도 칩을 옮기는 경계를 지나게. 자료 없는 로컬 하네스에서 잰 경계: 744 · 636 · 524 · 440 px
 * (칩이 많고 넓을수록 경계는 넓은 폭 쪽에 온다 — fixture 스택은 칩이 더 많다).
 */
const SWEEP_MIN = 480;

async function collectErrors(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __wlErrors: string[] };
    w.__wlErrors = [];
    // 오류 보고기(lib/errorReport)와 같은 곳에서 듣는다 — 캡처 단계라 다른 처리기가 막아도 센다
    window.addEventListener("error", (e) => { w.__wlErrors.push(String(e.message ?? e)); }, true);
  });
}
const roErrors = (page: Page) => page.evaluate(() => (window as unknown as { __wlErrors: string[] }).__wlErrors.filter((m) => m.includes("ResizeObserver")));

test.describe("status bar resize", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("resizing across 1440/1280/1024/800 raises no 'ResizeObserver loop' error and the row still fits", async ({ page }) => {
    await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (r) => r.abort());
    await collectErrors(page);
    await page.goto("/");
    const row = page.getByTestId("statusbar-row");
    await expect(row).toHaveAttribute("data-measured", "true", { timeout: 30_000 });
    const height = 900;
    // 한 번에 크게(창 끌기의 끝값) — 넓게 · 좁게 · 되돌리기를 세 번
    for (let round = 0; round < 3; round++) {
      for (const w of [...WIDTHS, ...[...WIDTHS].reverse()]) {
        await page.setViewportSize({ width: w, height });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      }
    }
    // 창을 끄는 것처럼 촘촘히(8 px) — 칩 경계를 모두 지난다. 그동안 프레임마다 줄 높이를 적는다
    await page.setViewportSize({ width: 1440, height });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate(() => {
      const w = window as unknown as { __wlRow: { h: number; wrap: boolean; btn: number; width: number }[]; __wlRowStop: boolean };
      w.__wlRow = [];
      w.__wlRowStop = false;
      const tick = () => {
        const row = document.querySelector<HTMLElement>('[data-testid="statusbar-row"]');
        const btn = document.querySelector<HTMLElement>('[data-testid="statusbar-details-toggle"]');
        if (row && btn) w.__wlRow.push({ h: row.getBoundingClientRect().height, wrap: row.classList.contains("flex-wrap"), btn: btn.getBoundingClientRect().height, width: innerWidth });
        if (!w.__wlRowStop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    for (let w = 1440; w >= SWEEP_MIN; w -= 8) {
      await page.setViewportSize({ width: w, height });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    }
    for (let w = SWEEP_MIN; w <= 1440; w += 8) {
      await page.setViewportSize({ width: w, height });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    }
    await page.waitForTimeout(300);
    expect(await roErrors(page)).toEqual([]);
    const samples = await page.evaluate(() => { const w = window as unknown as { __wlRow: { h: number; wrap: boolean; btn: number; width: number }[]; __wlRowStop: boolean }; w.__wlRowStop = true; return w.__wlRow; });
    expect(samples.length).toBeGreaterThan(100); // 끄는 동안 프레임마다
    const flat = samples.filter((x) => !x.wrap);
    expect(flat.length).toBeGreaterThan(0);
    const one = flat[0].h; // 1440 에서 한 줄
    expect(flat.filter((x) => Math.abs(x.h - one) > 0.5).map((x) => `${x.width}px ${x.h}`)).toEqual([]);
    expect(new Set(samples.map((x) => x.btn)).size).toBe(1); // 상세 단추('+N' 이 있어도 없어도) 높이 고정

    // 끝난 뒤에도 줄은 맞다(각 끝값에서): 가로 스크롤 없음 · 옮긴 칩 수 = '+N'
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const m = await row.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, hidden: el.querySelectorAll('[data-overflow="true"]').length }));
      expect(m.sw, `${w}px`).toBeLessThanOrEqual(m.cw + 1);
      const toggle = page.getByTestId("statusbar-details-toggle");
      if (m.hidden) await expect(toggle, `${w}px`).toContainText(`+${m.hidden}`);
      else await expect(toggle, `${w}px`).not.toContainText("+");
    }
    expect(await roErrors(page)).toEqual([]);
  });
});
