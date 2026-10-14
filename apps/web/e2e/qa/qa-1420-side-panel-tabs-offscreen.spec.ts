import { expect, test } from "@playwright/test";
import { assertIsolated, saveJson, shot } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA-1420 재현(QA 2026-10-aws · 화면): 상황판 오른쪽 패널의 탭 줄(alerts · aircraft · ship · sigmet · airport · wx · watch)이 패널 폭보다 넓어
 * 1440 px(기본 데스크톱)에서 'watch'(관심) 탭이 창 밖으로 나가 보이지 않고 'wx' 가 잘린다(375 · 320 px 도 같음). 탭 줄은 줄바꿈 · 가로 스크롤이 없고
 * 문서가 창보다 넓어진다(본문은 overflow hidden 이라 손으로 스크롤할 수 없다). 키보드로 그 탭에 가면 브라우저가 화면 전체를 옆으로 민다.
 * 기대: 모든 탭이 창 안에 보이고(또는 탭 줄 안에서 스크롤로 닿고) 문서 폭이 창 폭을 넘지 않는다(WCAG 1.4.10 리플로 · 기능 접근).
 */
const WIDTHS = [1440, 375, 320] as const;
for (const w of WIDTHS) {
  test(`QA-1420 every side-panel tab is inside the window at ${w} px and the page does not overflow`, async ({ page, baseURL }) => {
    assertIsolated(baseURL);
    await emptyExternal(page);
    await page.setViewportSize({ width: w, height: w === 1440 ? 900 : 812 });
    await page.goto("/");
    await page.getByTestId("tab-alerts").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(3000);
    const m = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="tab-"]')).filter((b) => b.tagName === "BUTTON" && /^tab-(alerts|aircraft|ship|sigmet|airport|wx|watch)$/.test(b.dataset.testid ?? ""));
      const row = tabs[0]?.parentElement as HTMLElement;
      const rr = row.getBoundingClientRect();
      return {
        innerWidth, docScrollWidth: document.documentElement.scrollWidth,
        row: { left: Math.round(rr.left), right: Math.round(rr.right), scrollWidth: row.scrollWidth, clientWidth: row.clientWidth, overflowX: getComputedStyle(row).overflowX },
        tabs: tabs.map((b) => { const r = b.getBoundingClientRect(); return { id: b.dataset.testid, left: Math.round(r.left), right: Math.round(r.right), inside: r.right <= innerWidth + 0.5 }; }),
      };
    });
    // 키보드로 마지막 탭(watch)에 초점 → 화면이 옆으로 밀리는가
    await page.getByTestId("tab-watch").focus();
    await page.waitForTimeout(300);
    const afterFocus = await page.evaluate(() => ({ scrollX: Math.round(document.scrollingElement?.scrollLeft ?? 0), bodyScroll: document.body.scrollLeft, mapLeft: Math.round(document.querySelector(".maplibregl-map")?.getBoundingClientRect().left ?? -1) }));
    await shot(page, `qa-1420-tabs-${w}.png`);
    saveJson(`qa-1420-tabs-${w}.json`, { ...m, afterFocus });
    console.log(`QA-1420 ${w}px doc=${m.docScrollWidth} > window=${m.innerWidth}? tabs outside: ${m.tabs.filter((t) => !t.inside).map((t) => `${t.id}(right ${t.right})`).join(", ") || "none"} · after keyboard focus on watch: scrollLeft=${afterFocus.scrollX} map.left=${afterFocus.mapLeft}`);
    expect.soft(m.tabs.filter((t) => !t.inside).map((t) => t.id), "tabs outside the window").toEqual([]);
    expect.soft(m.docScrollWidth, "document wider than the window").toBeLessThanOrEqual(m.innerWidth);
    expect(afterFocus.scrollX, "keyboard focus on the watch tab shifts the whole page sideways").toBe(0);
  });
}
