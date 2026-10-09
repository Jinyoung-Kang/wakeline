import { expect, test, type Page } from "@playwright/test";
import { predictedEvent, withoutBannerEvents } from "./ws-inject";

/**
 * 관심 대상(SPEC F4 · ADR-037 · 계약 v5 §G50) — 받아들일 조건: 관심 항공기에 예측 진입을 주입하면 화면 배너가 뜨고 브라우저 알림 API 가 한 번 불린다(가짜 Notification).
 * 목록은 이 브라우저의 저장소(wakeline.watch)에 미리 넣는다. 실행기는 첫 화면 뒤 미리 받기 때 받아 곧바로 /api/v1/watch 를 한 번 부른다(기준).
 * 숨은 탭 요청 수는 단위 시험(tests/watch-runner.test.ts)이 본다.
 */
async function proxyWs(page: Page) {
  let toPage: ((s: string) => void) | null = null;
  await page.routeWebSocket(/\/ws\/v1$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      if (typeof m !== "string") { ws.send(m); return; }
      try { ws.send(JSON.stringify(withoutBannerEvents(JSON.parse(m)))); } catch { ws.send(m); }
    });
    toPage = (s) => ws.send(s);
  });
  return { inject: (o: unknown) => { expect(toPage, "WS connected").not.toBeNull(); toPage!(JSON.stringify(o)); } };
}

test("watch: a predicted entry for a watched aircraft shows a banner and one browser notification; the panel lists the target", async ({ page }) => {
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (r) => r.abort());
  await page.addInitScript(() => {
    localStorage.setItem("wakeline.watch", JSON.stringify([{ kind: "aircraft", id: "e2e001", label: "AAL2646" }]));
    const shown: string[] = [];
    (window as unknown as { __notes: string[] }).__notes = shown;
    class FakeNotification { static permission = "granted"; static requestPermission = async () => "granted"; onclick = null; constructor(title: string) { shown.push(title); } close() {} }
    Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true });
  });
  const ws = await proxyWs(page);
  const baseline = page.waitForRequest(/\/api\/v1\/watch\?aircraft=e2e001$/, { timeout: 60_000 });
  await page.goto("/");
  await expect(page.getByTestId("conn")).toContainText("open", { timeout: 20_000 });
  await baseline; // 실행기가 받아져 기준을 잡았다(WS 알림의 기준도 이때)
  ws.inject(predictedEvent(Date.now()));
  const event = page.getByTestId("watch-event");
  await expect(event).toHaveCount(1, { timeout: 10_000 });
  await expect(event).toContainText("항공기 AAL2646 (e2e001) — 예측 진입");
  await expect(event).toContainText("SIGMET TS MMEX:E2E1");
  await expect(event).toContainText(/\d\d:\d\d:\d\d KST/);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __notes: string[] }).__notes)).toEqual(["항공기 AAL2646 (e2e001) — 예측 진입"]);
  // 같은 사건을 다시 받아도(재전송 · 조회) 한 번만
  ws.inject(predictedEvent(Date.now()));
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => (window as unknown as { __notes: string[] }).__notes)).toHaveLength(1);
  // 관심 탭: 목록 · 알림 허락 상태 · 한계
  await page.getByTestId("tab-watch").click();
  await expect(page.getByTestId("watch-item")).toHaveCount(1);
  await expect(page.getByTestId("watch-item")).toContainText("항공기 AAL2646 (e2e001)");
  await expect(page.getByTestId("watch-permission")).toContainText("브라우저 알림 켜짐");
  await expect(page.getByTestId("watch-panel")).toContainText("지금 받는 범위");
  await expect(page.getByTestId("watch-panel")).not.toContainText("UTC");
  // 배너의 카드 단추 → 그 항공기 카드
  await event.getByRole("button", { name: "항공기 AAL2646 (e2e001) 카드" }).click();
  await expect(page.getByTestId("tab-aircraft")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("watch-banner")).toHaveCount(0);
});
