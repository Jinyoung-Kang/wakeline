import { expect, test } from "@playwright/test";

/**
 * QA-800(출시 QA 2차 · 화면): 모바일 알림 화면 /m 은 서버가 그린 HTML 을 브라우저가 이어받는다(하이드레이션). 관심 대상 상태(lib/watch-store)는 모듈을 불러올 때
 * 브라우저 저장소(wakeline.watch)와 Notification.permission 을 읽어 처음 값으로 쓰므로, 서버(목록 없음 · 알림 'unsupported')와 브라우저의 첫 그리기가 다르다 —
 * 저장된 관심 대상이 있거나 알림 허락이 'default' 이면 React 가 하이드레이션 오류를 내고 화면을 클라이언트에서 다시 그린다(콘솔 오류 · /logs 의 브라우저 오류).
 * 기대: 콘솔 오류 없음(같은 첫 그리기 — 저장소 값은 마운트 뒤에).
 */
test("QA-800: /m with a stored watchlist hydrates without a mismatch error", async ({ page }) => {
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (r) => r.abort());
  await page.addInitScript(() => {
    localStorage.setItem("wakeline.watch", JSON.stringify([{ kind: "airport", id: "RKSI" }]));
    class N { static permission = "default"; static requestPermission = async () => "default"; onclick = null; close() {} }
    Object.defineProperty(window, "Notification", { value: N, configurable: true });
  });
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));
  await page.goto("/m");
  await expect(page.getByTestId("mobile-watch-item")).toHaveCount(1, { timeout: 20_000 });
  await page.waitForTimeout(1500);
  expect(errors, errors.join("\n")).toEqual([]); // 운영 빌드는 "Minified React error #418" 처럼 줄인 글이다 — 모든 콘솔 오류를 본다
});
