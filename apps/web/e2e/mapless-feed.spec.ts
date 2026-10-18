import { expect, test } from "@playwright/test";
import { NO_LIVE_TEXT } from "../lib/ws-protocol";

/**
 * 지도 없는 실시간 피드(Q4 — docs/plans/mapless-feed-2026-10 §7-9): WebGL2 를 쓸 수 없는 브라우저(하드웨어 가속 끔 · GPU 차단 · VDI)에서도 상황판이
 * 실시간 연결을 열어 알림 · 피드 상태를 받고, 서버 수요를 만들지 않는 구독만 보낸다 — 두 레이어를 끈 구독 · zoom 5 · select 없음(사용자 결정 Q-B).
 * WebGL2 는 페이지 스크립트보다 먼저 canvas.getContext("webgl2") 가 null 을 돌려주게 바꿔 끈다 — MapLibre 의 Map 생성자가 GPUInitializationError 를 던지는
 * 실제 경로(components/map/useMapLifecycle 의 noWebgl → useMaplessFeed). 격리 스택의 fixture 항공기가 합성 SIGMET 에 들어가 만든 실제 알림으로.
 */

type Frame = { type?: unknown; [k: string]: unknown };

/** WS 프레임 하나를 메시지로(형식이 틀리면 표시만 — 시험이 그 사실을 본다) */
function frame(payload: string | Buffer): Frame {
  try { return JSON.parse(String(payload)) as Frame; } catch { return { type: "<not json>" }; }
}

test("no WebGL2: the dashboard opens a map-less live feed (alerts · status) that subscribes with both layers off at zoom 5 and never sends select", async ({ page, request }) => {
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (r) => r.abort());
  // 알림 행에서 카드를 열어 보려면 알림이 있어야 한다(fixture 항공기가 합성 SIGMET 에 들어가야 생긴다 — mobile.spec 과 같은 기다림)
  await expect.poll(async () => ((await (await request.get("/api/v1/alerts")).json()).items as unknown[]).length, { timeout: 90_000, intervals: [2_000] })
    .toBeGreaterThan(0);
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true, writable: true,
      value: function (this: HTMLCanvasElement, id: string, options?: unknown) { return id === "webgl2" ? null : getContext.call(this, id, options); },
    });
  });
  const sockets: string[] = [];
  const sent: Frame[] = [];
  const received: string[] = [];
  page.on("websocket", (ws) => {
    sockets.push(ws.url());
    ws.on("framesent", ({ payload }) => { sent.push(frame(payload)); });
    ws.on("framereceived", ({ payload }) => { received.push(String(frame(payload).type)); });
  });
  await page.goto("/");
  await expect(page.getByTestId("map-no-webgl")).toBeVisible({ timeout: 30_000 });

  // 상태 바: 실제 연결 상태 + '지도 없음'(R9 의 'WS off · 실시간 수신 안 함'이 아니다) · 항공기 수는 모름
  const conn = page.getByTestId("conn");
  await expect(conn).toContainText("WS open", { timeout: 20_000 });
  await expect(conn).toContainText("지도 없음");
  await expect(conn).not.toContainText("WS off");
  await expect(conn).toHaveAttribute("title", /지도 없이 연 연결 — 알림 · SIGMET · 레이더 · 피드 상태만 받고 항공기 · 선박 위치는 받지 않음/);
  await expect(page.getByTestId("aircraft-count")).toContainText("—");
  await expect(page.getByTestId("aircraft-count")).toHaveAttribute("title", "지도 없음 — 항공기 위치를 받지 않음");
  await expect(page.getByTestId("mapless-chip")).toHaveText("지도 없음 — 항공기 · 선박 위치를 받지 않음");

  // 알림 패널: 실시간 목록(off 띠 · '실시간 수신 안 함' 없음). 전세계 범위로 — 관심 지역 밖의 알림만 있어도 행이 보이게
  const panel = page.getByTestId("alert-panel");
  await expect(panel).not.toContainText(NO_LIVE_TEXT);
  await page.getByTestId("alerts-scope-world").click();
  const items = page.getByTestId("alert-item");
  await expect(items.first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("alerts-stale")).toHaveCount(0); // 목록 상태 live — 수신 대기 · 끊김 · off 띠가 없다
  await expect(page.getByTestId("alerts-counts")).toContainText(/\d+ inside · \d+ predicted/);
  await expect(panel).not.toContainText(NO_LIVE_TEXT);

  // 알림 행 → 근거 → 항공기 카드. 지도 없는 클라이언트는 선택을 서버에 알리지 않는다(집중 추적 안 함 — 카드가 그렇게 적는다)
  await items.first().getByTestId("alert-toggle").click();
  const expanded = page.locator('[data-testid="alert-item"]', { has: page.locator('[data-testid="alert-toggle"][aria-expanded="true"]') });
  await expect(expanded).toHaveCount(1);
  await expanded.getByTestId("alert-open-aircraft").click();
  const card = page.getByTestId("aircraft-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("demand-chip-none")).toContainText("지도 없음 — 선택을 서버에 알리지 않음(집중 추적 안 함)");
  await page.waitForTimeout(2_000); // 선택이 select 로 나갔다면 이 사이에 보낸다(선택 전달은 곧바로)

  // 보낸 프레임: hello → layers{둘 다 끔} → subscribe{고정 영역 · zoom 5}(lib/ws subscribeWithoutMap · NO_MAP_*). select · select_ship 은 한 번도 없다
  expect(sockets.filter((u) => /\/ws\/v1$/.test(u)), "지도 피드 없이 연결 하나").toHaveLength(1);
  expect(sent.slice(0, 3)).toEqual([
    expect.objectContaining({ type: "hello" }),
    { type: "layers", aircraft: false, ships: false },
    { type: "subscribe", bbox: [127, 36, 128, 37], zoom: 5, detail: "lite" },
  ]);
  expect(sent.filter((m) => m.type === "select" || m.type === "select_ship")).toEqual([]);
  expect(sent.filter((m) => m.type === "layers" && (m.aircraft !== false || m.ships !== false))).toEqual([]);
  expect(sent.filter((m) => m.type === "subscribe" && m.zoom !== 5)).toEqual([]);
  // 받은 것: 알림 · 상태는 오고, 항공기 · 선박 목록 · 선택 상태는 오지 않는다(두 레이어를 끈 구독 — 서버 수요 없음)
  expect(received).toEqual(expect.arrayContaining(["welcome", "alerts", "status"]));
  expect(received.filter((t) => /^(snapshot|diff|selected|ships_|ship_selected)/.test(t))).toEqual([]);
});
