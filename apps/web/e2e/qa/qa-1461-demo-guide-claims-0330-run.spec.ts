import { expect, test } from "@playwright/test";
import { assertIsolated, saveJson } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA-1461 남은 곳(QA 2026-10-aws · 공개 데모 화면 — 스택 A1, WAKELINE_PUBLIC_DEMO=1): 통계 화면은 고쳤지만(b7901193 — 공개 데모는 '켜진 뒤 따라잡기'),
 * 설명서의 통계 절은 공개 데모에서도 그대로 "매일 03:30 KST" 집계를 말한다 — 그림 13의 번호 4 설명(lib/guide-shots.json "KST 날짜로 고릅니다(오늘은 아직
 * 집계 전 — 매일 03:30 KST 에 전날을 셉니다).")과 '집계 시각' 항목의 첫 문장(GuideView "매일 03:30 KST 에 전날(KST 날짜 …)을 집계합니다").
 * 기대: 공개 데모의 설명서는 통계 화면과 같이 03:30 정시 집계를 약속하지 않는다(켜진 뒤 따라잡기).
 * 실행: cd apps/web && QA_BASE_URL=http://localhost:8701 QA_EVIDENCE_DIR=… npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1461-demo-guide
 */
test("QA-1461 public demo /guide does not promise the 03:30 KST daily run either", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  await emptyExternal(page);
  await page.goto("/guide", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#stats")).toBeVisible();
  const nav = await page.evaluate(() => Array.from(document.querySelectorAll('nav[aria-label="주 메뉴"] a')).map((a) => a.textContent));
  expect(nav, "A1 is a public demo — precondition").not.toContain("운영");
  const claims = await page.evaluate(() => {
    const out: string[] = [];
    for (const l of (document.querySelector("main")?.innerText ?? "").split("\n")) if (/03:30/.test(l)) out.push(l.trim());
    for (const el of Array.from(document.querySelectorAll("main [title]"))) { const t = el.getAttribute("title") ?? ""; if (/03:30/.test(t)) out.push(`title: ${t}`); }
    return out;
  });
  saveJson("qa-1461-guide.json", { nav, claims });
  console.log(`QA-1461 guide claims=${JSON.stringify(claims)}`);
  expect(claims, "03:30 KST daily-run claims on the public demo guide").toEqual([]);
});
