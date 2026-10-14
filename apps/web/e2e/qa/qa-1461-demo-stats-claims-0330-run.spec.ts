import { expect, test } from "@playwright/test";
import { assertIsolated, saveJson, shot } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA-1461 재현(QA 2026-10-aws · 공개 데모 화면 — 스택 A1, WAKELINE_PUBLIC_DEMO=1): ADR-039 덧붙임 2-1 "03:30 KST 정시 집계는 AWS 에서 돌지 않는다 — 기동 뒤
 * 따라잡기가 그 몫을 한다"(평일 08:50–18:00 KST 만 켬). 공개 데모(= AWS 판에만 켜는 표시 — compose.aws.yml)의 통계 화면은 그래도 머리에 "매일 03:30 KST 에
 * 전날(KST 날짜) 집계"(title "api 집계 작업은 매일 03:30 KST 에 돈다"), 빈 칸에 "다음 03:30 KST 집계 뒤 채워집니다"라고 적는다(lib/stats.ts:16 STATS_RUN_KST ·
 * app/stats/page.tsx:57 · lib/stats.ts:91,93,126) — 방문자에게 실제로 돌지 않는 시각을 집계 시각으로 알린다. 설명서 4.x '집계 시각'(GuideView.tsx:396)도 같다.
 * 기대: 공개 데모에서는 03:30 정시 집계를 말하지 않는다(예: '기동 뒤 따라잡기로 집계').
 * 실행: cd apps/web && QA_BASE_URL=http://localhost:8701 QA_EVIDENCE_DIR=… npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1461
 */
test("QA-1461 public demo /stats does not claim the 03:30 KST daily run that AWS never runs", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  await emptyExternal(page);
  await page.goto("/stats", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const nav = await page.evaluate(() => Array.from(document.querySelectorAll('nav[aria-label="주 메뉴"] a')).map((a) => a.textContent));
  expect(nav, "A1 is a public demo — precondition").not.toContain("운영");
  const claims = await page.evaluate(() => {
    const out: string[] = [];
    for (const l of (document.querySelector("main")?.innerText ?? "").split("\n")) if (/03:30/.test(l)) out.push(l.trim());
    for (const el of Array.from(document.querySelectorAll("main [title]"))) { const t = el.getAttribute("title") ?? ""; if (/03:30/.test(t)) out.push(`title: ${t}`); }
    return out;
  });
  await shot(page, "qa-1461-stats.png");
  saveJson("qa-1461-stats.json", { nav, claims });
  console.log(`QA-1461 claims=${JSON.stringify(claims)}`);
  expect(claims, "03:30 KST daily-run claims on the public demo stats screen").toEqual([]);
});
