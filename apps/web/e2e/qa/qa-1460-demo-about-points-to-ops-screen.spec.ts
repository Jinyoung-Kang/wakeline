import { expect, test } from "@playwright/test";
import { assertIsolated, saveJson, shot } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA-1460 재현(QA 2026-10-aws · 공개 데모 화면 — 스택 A1, WAKELINE_PUBLIC_DEMO=1): ADR-039 덧붙임 2-7(#142 D-8)은 "공개 데모에서는 운영 메뉴 · 화면을
 * 가리키는 문구를 쓰지 않는다"고 정했고 WS 형식 오류 상세 · 특보 수신 전 줄 · 머리말 · 오류 문구 · 오류 화면은 demo 일 때 문구를 바꾼다. 그런데 공개 화면
 * '출처·한계'(/about)의 시각 항목은 공개 데모에서도 "…통계의 날짜와 운영 화면의 격리 수 날짜는 KST 날짜…"라고 방문자가 열 수 없는 운영 화면을 가리킨다
 * (app/about/page.tsx:34 — usePublicDemo 를 읽지 않는 서버 컴포넌트의 고정 글). 설명서(/guide)의 운영 · 로그 절은 ADR-039 '남는 것'으로 수용 — 이 시험은 /about 만 본다.
 * 기대: 공개 데모의 /about 에 '운영 화면' · /ops · /logs 를 가리키는 글이 없다.
 * 실행: cd apps/web && QA_BASE_URL=http://localhost:8701 QA_EVIDENCE_DIR=… npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1460
 */
test("QA-1460 public demo /about does not point visitors to the operator screen", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  await emptyExternal(page);
  await page.goto("/about", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const demo = await page.evaluate(() => Array.from(document.querySelectorAll('nav[aria-label="주 메뉴"] a')).map((a) => a.textContent));
  expect(demo, "A1 is a public demo (no 운영 · 로그 menu) — precondition").not.toContain("운영");
  const lines = await page.evaluate(() => (document.querySelector("main")?.innerText ?? "").split("\n").filter((l) => /운영 화면|운영 메뉴|\/ops\b|\/logs\b/.test(l)).map((l) => l.trim()));
  await shot(page, "qa-1460-about.png", true);
  saveJson("qa-1460-about.json", { nav: demo, lines });
  console.log(`QA-1460 nav=${JSON.stringify(demo)} operatorLines=${JSON.stringify(lines.map((l) => l.match(/.{0,30}운영 화면.{0,20}/)?.[0] ?? l.slice(0, 60)))}`);
  expect(lines, "public demo /about lines pointing to the operator screen").toEqual([]);
});
