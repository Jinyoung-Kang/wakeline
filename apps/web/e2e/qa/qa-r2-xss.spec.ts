import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * 출시 QA 2차(docs/qa/2026-10-release — 계획 §3.1 XSS) — 앞선 QA 뒤 더한 표면. 격리 스택(8701)만.
 * 저장형: 특보 목록(구역 이름 · 상위 구역 · 종류 · 수준 · 명령 · 때 · 해제예고 · 원문 — tools/qa/inject_stream.py warnings, 수집기 ACL 사용자로 XADD),
 * 관심 대상 이름(브라우저 저장소 wakeline.watch 의 label — 사용자가 조작할 수 있는 값) → 관심 탭 · 배너 · 브라우저 알림 · /m.
 * 반사형: /alerts/{id} 경로 값 · /replay?at&bbox&hex 링크 값.
 * 판정은 앞선 QA 의 qa-sec-xss 와 같다: 스크립트 표식 없음 · 주입 요소 없음 · CSP 위반 · 대화상자 없음, 표식 글자는 텍스트로 보인다.
 */
const BASE = process.env.E2E_BASE_URL ?? process.env.QA_BASE_URL ?? "http://localhost:8701";
if (new URL(BASE).port !== "8701") throw new Error(`QA 는 격리 스택 A 만: ${BASE}`);
const REPO = path.resolve(__dirname, "../../../..");
const MARK = `<img src=x onerror=window.__qa_xss=1>`;
const INJECTED = "#qaxw, #qaxp, #qa-xss-el, svg[onload], img[onerror], iframe[srcdoc], a[href^='javascript:'], script:not([src]):not([nonce]):not([type])";

function watch(page: Page) {
  const bad: string[] = [];
  page.on("console", (m) => { const t = m.text(); if (/Content Security Policy|Refused to (execute|load|apply)/i.test(t)) bad.push(t.slice(0, 300)); });
  page.on("dialog", (d) => { bad.push(`dialog: ${d.message()}`); void d.dismiss(); });
  return bad;
}

async function assertClean(page: Page, bad: string[], label: string) {
  const flag = await page.evaluate(() => (window as unknown as Record<string, unknown>).__qa_xss ?? null);
  const els = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((e) => e.outerHTML.slice(0, 120)), INJECTED);
  expect(flag, `${label}: script marker`).toBeNull();
  expect(els, `${label}: injected elements`).toEqual([]);
  expect(bad, `${label}: CSP violations · dialogs`).toEqual([]);
}

test.describe.configure({ mode: "serial" });

test("stored XSS: crafted warning texts render as text in the wx tab", async ({ page }) => {
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (r) => r.abort());
  execFileSync("python3", [path.join(REPO, "tools/qa/inject_stream.py"), "warnings"], { cwd: REPO });
  const bad = watch(page);
  await page.goto("/");
  await page.getByTestId("tab-wx").click();
  await expect(page.getByTestId("warning-row").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("warning-panel")).toContainText("<i id=qaxw>Z</i>");
  await page.getByTestId("warnings-land").locator("summary").click();
  await page.waitForTimeout(500);
  await assertClean(page, bad, "wx tab");
});

test("stored XSS: a crafted watch label renders as text in the watch tab, the banner and the notification", async ({ page }) => {
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (r) => r.abort());
  await page.addInitScript((mark) => {
    localStorage.setItem("wakeline.watch", JSON.stringify([{ kind: "airport", id: "RKSI", label: mark }, { kind: "aircraft", id: "71be01", label: `"><i id=qa-xss-el>` }]));
    const shown: string[] = [];
    (window as unknown as { __notes: string[] }).__notes = shown;
    class N { static permission = "granted"; static requestPermission = async () => "granted"; onclick = null; constructor(t: string, o?: { body?: string }) { shown.push(`${t}|${o?.body ?? ""}`); } close() {} }
    Object.defineProperty(window, "Notification", { value: N, configurable: true });
  }, MARK);
  const bad = watch(page);
  await page.goto("/");
  await page.getByTestId("tab-watch").click();
  await expect(page.getByTestId("watch-item")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId("watch-panel")).toContainText(MARK);
  await assertClean(page, bad, "watch tab");
  await page.goto("/m");
  await expect(page.getByTestId("mobile-watch-item")).toHaveCount(2, { timeout: 30_000 });
  await assertClean(page, bad, "/m watch list");
});

test("reflected XSS: /alerts/{id} path and /replay link values", async ({ page }) => {
  await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/, (r) => r.abort());
  const bad = watch(page);
  await page.goto(`/alerts/${encodeURIComponent(MARK)}`);
  await expect(page.getByTestId("alert-page-error")).toContainText("알림 번호가 아님", { timeout: 20_000 });
  await assertClean(page, bad, "/alerts/<mark>");
  await page.goto(`/replay?at=${encodeURIComponent(MARK)}&bbox=${encodeURIComponent(MARK)}&hex=${encodeURIComponent(MARK)}`);
  await expect(page.getByTestId("replay-url-note")).toHaveCount(3, { timeout: 20_000 });
  await assertClean(page, bad, "/replay link");
});
