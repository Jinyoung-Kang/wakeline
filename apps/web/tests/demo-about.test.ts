/**
 * QA-1460: 공개 데모(WAKELINE_PUBLIC_DEMO=1 — ADR-039)의 /about 은 방문자가 열 수 없는 운영 화면을 가리키지 않는다(덧붙임 2-7). 로컬은 그대로.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import AboutPage from "@/app/about/page";

afterEach(() => { vi.unstubAllEnvs(); });

describe("/about on the public demo", () => {
  it("does not mention the operator screen; local keeps the line", () => {
    vi.stubEnv("WAKELINE_PUBLIC_DEMO", "1");
    const demo = renderToStaticMarkup(createElement(AboutPage));
    expect(demo).not.toMatch(/운영 화면|운영 메뉴|\/ops\b|\/logs\b/);
    expect(demo).toContain("통계의 날짜는 KST 날짜(00:00–24:00 KST)");
    vi.stubEnv("WAKELINE_PUBLIC_DEMO", "");
    expect(renderToStaticMarkup(createElement(AboutPage))).toContain("통계의 날짜와 운영 화면의 격리 수 날짜는 KST 날짜");
  });
});
