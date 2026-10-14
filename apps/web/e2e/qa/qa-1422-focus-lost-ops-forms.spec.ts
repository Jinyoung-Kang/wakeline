import { expect, test } from "@playwright/test";
import { assertIsolated, focusInfo, loginOps, saveJson } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA-1422 재현(QA 2026-10-aws · 접근성 — WCAG 2.4.3 초점 순서, 앞선 QA-304 와 같은 부류):
 *  (1) 운영 설정 충돌 줄의 '새 값 보기'를 누르면 그 단추가 든 줄이 사라지고 초점이 body 로 떨어진다(다음 Tab 이 문서 맨 앞부터).
 *  (2) 로그인 서버 오류(429 · 401 · 503)에서 Sign in 을 마우스 · 키보드(단추에 초점)로 누르면 초점이 body 로 떨어진다 — 코드 주석(OpsLogin)은
 *      "오류가 나면 해당 칸(또는 오류 문구)으로 초점을 옮긴다"인데 오류 문구(tabIndex=-1)로 가지 않는다.
 * 기대: 초점이 화면에 남는다(그 줄의 값 입력 · 오류 문구).
 * (1)은 A 의 설정 sigmet_poll_s 를 다른 쓰기로 바꾼 뒤 되돌린다. (2)는 서버 제한을 쓰지 않고 응답만 429 계약 모양으로 대신한다.
 */
const csrfOf = async (page: import("@playwright/test").Page) => (await page.context().cookies()).find((c) => c.name === "WAKELINE_CSRF")?.value ?? "";

test("QA-1422 (1) settings conflict: '새 값 보기' keeps focus on the page", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  test.setTimeout(120_000);
  await emptyExternal(page);
  await loginOps(page);
  await page.getByTestId("ops-tab-settings").click();
  const row = page.getByTestId("setting-row").filter({ hasText: "sigmet_poll_s" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  const ver = Number(await row.locator("td").nth(2).innerText());
  const orig = await row.getByRole("spinbutton").inputValue();
  let focus: unknown = null;
  try {
    await row.getByRole("spinbutton").fill(String(Number(orig) + 2));
    await page.request.put("/api/v1/ops/settings/sigmet_poll_s", { headers: { "If-Match": String(ver), "X-CSRF-Token": await csrfOf(page), Origin: baseURL! }, data: { value: Number(orig) + 1 } });
    const conflict = row.getByTestId("setting-conflict");
    await expect(conflict).toBeVisible({ timeout: 25_000 });
    const b = conflict.getByRole("button", { name: "새 값 보기" });
    await b.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    focus = await focusInfo(page);
  } finally {
    const cur = await (await page.request.get("/api/v1/ops/settings")).json() as { items: { key: string; value: unknown; version: number }[] };
    const it = cur.items.find((i) => i.key === "sigmet_poll_s")!;
    if (String(it.value) !== orig) await page.request.put("/api/v1/ops/settings/sigmet_poll_s", { headers: { "If-Match": String(it.version), "X-CSRF-Token": await csrfOf(page), Origin: baseURL! }, data: { value: Number(orig) } });
  }
  saveJson("qa-1422-settings-focus.json", { focus });
  console.log(`QA-1422 (1) focus after '새 값 보기' (Enter): ${JSON.stringify(focus)}`);
  expect((focus as { tag: string }).tag, "focus after '새 값 보기'").not.toBe("body");
});

test("QA-1422 (2) login server error: focus goes to the error text, not body", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  await emptyExternal(page);
  await page.goto("/ops");
  await expect(page.getByTestId("ops-login")).toBeVisible({ timeout: 20_000 });
  await page.route("**/api/v1/ops/session", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({ status: 429, headers: { "Retry-After": "37", "Content-Type": "application/problem+json" }, body: JSON.stringify({ status: 429, title: "Too Many Requests", detail: "too many login attempts", code: "RATE_LIMITED" }) });
  });
  await page.locator("#ops-user").fill("qa-nobody");
  await page.locator("#ops-pass").fill("not-a-real-password");
  const submit = page.locator('[data-testid="ops-login"] button[type="submit"]');
  await submit.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("ops-login-error")).toBeVisible();
  await page.waitForTimeout(500);
  const focus = await focusInfo(page);
  const text = await page.getByTestId("ops-login-error").innerText();
  saveJson("qa-1422-login-focus.json", { focus, text });
  console.log(`QA-1422 (2) error="${text.split("\n")[0]}" focus=${JSON.stringify(focus)}`);
  expect(focus.tag, "focus after a login server error").toBe("div#ops-login-err");
});
