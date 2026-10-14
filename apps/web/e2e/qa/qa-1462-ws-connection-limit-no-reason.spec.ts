import { expect, test, type Page } from "@playwright/test";
import { assertIsolated, saveJson, shot } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA-1462 재현(QA 2026-10-aws · 공개 데모 A1 · 화면): api 는 IP 당 WS 연결을 5개로 묶고(WAKELINE_WS_MAX_CONN_PER_IP — 넘으면 close 1013 "connection limit"),
 * 웹은 1013 을 긴 백오프(30 s)로만 다룬다(lib/ws-protocol.ts LONG_BACKOFF_CODES). 같은 브라우저(같은 IP)에서 상황판 탭을 6개 열면 6번째 탭은
 * 상태 칩 "WS CLOSED · RETRY n" · 알림 패널 "연결 끊김 — 마지막으로 받은 목록 · 갱신 안 됨"만 보이고, 까닭(같은 주소의 연결 수 상한)과 할 일(다른 탭 닫기)을
 * 말하지 않는다 — 서버가 준 close 까닭(1013 "connection limit")은 버려진다. 공개 데모(AWS)는 IPv6 를 끄고(ADR-039 덧붙임 2-5) IPv4 만 받으므로 통신사 ·
 * 회사 NAT 뒤 방문자들은 같은 IP 의 5개를 나눠 쓴다.
 * 기대: 연결 상한으로 닫힌 화면은 그렇다고(같은 주소에서 열린 연결이 많음 — 다른 탭을 닫으면 이어짐) 알린다.
 * 실행: cd apps/web && QA_BASE_URL=http://localhost:8701 QA_EVIDENCE_DIR=… npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1462
 */
async function state(p: Page) {
  return p.evaluate(() => {
    const conn = document.querySelector<HTMLElement>('[data-testid="conn"]');
    const stale = document.querySelector<HTMLElement>('[data-testid="alerts-stale"]');
    return { conn: conn?.innerText ?? null, connTitle: conn?.title ?? null, alerts: stale?.innerText ?? null,
      limitWords: (document.body.innerText.match(/[^\n]{0,30}(연결 (수 )?상한|connection limit|다른 탭|탭을 닫)[^\n]{0,30}/g) ?? []) };
  });
}

test("QA-1462 the 6th dashboard tab from one IP says why its WebSocket is refused", async ({ context, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(240_000);
  const pages: Page[] = [];
  const closes: { tab: number; code: number | null }[] = [];
  for (let i = 0; i < 6; i++) {
    const p = await context.newPage();
    await emptyExternal(p);
    p.on("websocket", (ws) => ws.on("close", () => closes.push({ tab: i + 1, code: null })));
    await p.goto("/", { waitUntil: "domcontentloaded" });
    pages.push(p);
    await p.waitForTimeout(3_000);
  }
  await pages[5].waitForTimeout(15_000);
  const states = await Promise.all(pages.map(state));
  await shot(pages[5], "qa-1462-sixth-tab.png");
  saveJson("qa-1462-ws-limit.json", { states, wsCloses: closes });
  console.log(`QA-1462 tabs=${JSON.stringify(states.map((s) => s.conn))} sixth=${JSON.stringify(states[5])}`);
  for (const p of pages) await p.close();
  expect(states.slice(0, 5).every((s) => /OPEN/i.test(s.conn ?? "")), "tabs 1-5 open (precondition)").toBe(true);
  expect(states[5].conn ?? "", "6th tab refused by the per-IP limit (precondition)").not.toMatch(/OPEN/i);
  expect(states[5].limitWords, "6th tab explains the per-IP connection limit").not.toEqual([]);
});
