import { expect, test } from "@playwright/test";
import { assertIsolated, saveJson, shot } from "./qa-helpers";
import { emptyExternal } from "./qa-aws-helpers";

/**
 * QA-1421 재현(QA 2026-10-aws · 화면 · 접근성): 없는 경로(예: 오타 · 옛 공유 링크)는 Next 기본 404 화면이다 — 본문은 영어 "This page could not be found."인데
 * 문서 언어는 ko 이고 그 글자에 lang 표시가 없다(WCAG 3.1.2 — 앞선 QA-313 과 같은 부류), 제목(title)은 상황판과 같은 기본 제목이라 화면 읽기 ·
 * 탭 목록에서 '없는 페이지'임을 알 수 없다(WCAG 2.4.2). 앱의 다른 오류 화면(ErrorScreen · /alerts/[id] '알림 번호가 아님')은 한국어로 까닭과 갈 곳을 말한다.
 * 기대: 한국어 안내(또는 영어 글자에 lang="en") · 제목에 없는 페이지임이 드러남 · 상황판으로 가는 길.
 */
test("QA-1421 an unknown path shows a Korean (or lang-marked) not-found page with a telling title", async ({ page, baseURL }) => {
  assertIsolated(baseURL);
  await emptyExternal(page);
  const r = await page.goto("/no-such-page-qa-1421");
  await page.waitForTimeout(1500);
  const m = await page.evaluate(() => {
    const main = document.querySelector("main") ?? document.body;
    const english = Array.from(main.querySelectorAll<HTMLElement>("h1, h2, p, div, span")).filter((e) => e.children.length === 0 && /could not be found/i.test(e.textContent ?? ""));
    return {
      title: document.title, htmlLang: document.documentElement.lang,
      englishTexts: english.map((e) => ({ text: (e.textContent ?? "").trim(), lang: e.closest("[lang]")?.getAttribute("lang") ?? null })),
      h1: Array.from(document.querySelectorAll("h1")).map((h) => (h.textContent ?? "").trim()),
      hangulInMain: /[가-힣]/.test(Array.from(main.querySelectorAll("h1, h2")).map((h) => h.textContent).join(" ")),
    };
  });
  await shot(page, "qa-1421-not-found.png");
  saveJson("qa-1421-not-found.json", { status: r?.status(), ...m });
  console.log(`QA-1421 status=${r?.status()} title="${m.title}" html lang=${m.htmlLang} h1=${JSON.stringify(m.h1)} english=${JSON.stringify(m.englishTexts)}`);
  expect.soft(m.englishTexts.filter((t) => !t.lang?.startsWith("en")), "English text without lang=en on a lang=ko page").toEqual([]);
  expect(m.title, "title says the page does not exist").toMatch(/404|없|찾을 수 없|not found/i);
});
