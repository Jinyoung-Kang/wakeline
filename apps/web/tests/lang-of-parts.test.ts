/**
 * QA-313 — 문서는 lang="ko" 인데 영어 제목 · 문구에 lang 표시가 없었다(WCAG 3.1.2 부분의 언어): h1 "Statistics" · "Data sources · licenses" ·
 * "Airport weather · RKSI", 로그인 "Operator sign-in" · "Sign in", 'sign out' · 'save' · 'latest'. 한국어 음성이 이 글자를 한국어 규칙으로 읽었다.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpsLogin } from "@/components/OpsLogin";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

describe("English headings and labels declare lang=\"en\"", () => {
  it("page headings: /stats, /about, /airports/[icao] (and the English panel headings beside them)", () => {
    expect(src("app/stats/page.tsx")).toMatch(/<h1 className="label" lang="en">Statistics<\/h1>/);
    for (const h of ["SIGMET by FIR (7d, top 24)", "SIGMET by hazard (7d)", "Distinct aircraft by hour (KST)", "Alerts by kind (7d) · avg dwell"]) {
      expect(src("app/stats/page.tsx"), h).toContain(`lang="en">${h}</h2>`);
    }
    expect(src("app/about/page.tsx")).toMatch(/<h1 className="label mb-2" lang="en">Data sources · licenses<\/h1>/);
    expect(src("app/about/page.tsx")).toMatch(/<h2 className="label mt-4 mb-2" lang="en">Design<\/h2>/);
    expect(src("app/airports/[icao]/page.tsx")).toMatch(/<h1 className="label mb-2" lang="en">Airport weather · \{code\}<\/h1>/);
  });
  it("sign-in form: the heading and the submit button", () => {
    const html = renderToStaticMarkup(createElement(OpsLogin, { onLogin: () => {}, notice: null }));
    expect(html).toContain('<div class="label mb-3" lang="en">Operator sign-in</div>');
    expect(html).toMatch(/<button class="btn w-full" type="submit" lang="en">Sign in<\/button>/);
  });
  it("buttons: sign out (ops · logs), save (ops settings), latest (radar) — only the English text, not the Korean tooltip", () => {
    expect(src("app/ops/page.tsx")).toContain('onClick={logout} lang="en">sign out</button>');
    expect(src("components/logs/LogsDashboard.tsx")).toContain('onClick={logout} lang="en">sign out</button>');
    expect(src("app/ops/page.tsx")).toContain('<span lang="en">save</span></button>');
    expect(src("components/RadarTimeline.tsx")).toContain('data-testid="radar-latest"><span lang="en">latest</span></button>');
  });
});
