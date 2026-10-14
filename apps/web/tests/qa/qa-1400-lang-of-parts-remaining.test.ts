/**
 * QA 2026-10-aws(docs/qa/2026-10-aws — 영역 web-code) QA-1400: 문서는 lang="ko" 인데 상황판 오른쪽 패널의 탭 단추(주 탐색 — alerts · aircraft · ship ·
 * airport · watch)와 패널 · 카드 머리의 영어 이름표에 lang 표시가 없다(WCAG 3.1.2 부분의 언어). QA-313(QA 2026-10)은 그때 찾은 제목 · 단추만 고쳤고
 * (tests/lang-of-parts.test.ts 가 그 목록만 본다) 같은 부류의 나머지가 남았다 — 한국어 음성은 "alerts" · "Watchlist" 를 한국어 규칙으로 읽는다.
 * 'SIGMET' · 'wx' · 'METAR' 같은 약어 · 전문 용어는 3.1.2 의 예외라 보지 않는다.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SidePanelView } from "@/components/SidePanel";
import { byTestId, type HNode, parseHtml, textOf } from "../helpers/html-tree";

/** 글자 노드에 적용되는 언어 — 가장 가까운 lang(없으면 문서의 ko) */
function langOf(n: HNode | null): string {
  for (let c = n; c; c = c.parent) if (c.attrs?.lang) return c.attrs.lang;
  return "ko";
}
/** 요소 아래에서 그 글자를 담은 글자 노드 */
function textNode(n: HNode, text: string): HNode | null {
  if (n.tag === "#text" && n.text.trim() === text) return n;
  for (const c of n.children) { const f = textNode(c, text); if (f) return f; }
  return null;
}

describe("QA-1400 English words left without lang=\"en\" (after QA-313)", () => {
  it("dashboard side panel: the tab buttons (main navigation) and the alerts head", () => {
    const root = parseHtml(renderToStaticMarkup(createElement(SidePanelView, { panel: "alerts", hex: null, sigmet: null, airport: null })));
    const missing: string[] = [];
    for (const tab of ["alerts", "aircraft", "ship", "airport", "watch"]) {
      const btn = byTestId(root, `tab-${tab}`);
      expect(btn, `tab-${tab}`).not.toBeNull();
      const t = textNode(btn!, tab);
      if (!langOf(t ?? btn).startsWith("en")) missing.push(`tab "${textOf(btn!)}"`);
    }
    const head = textNode(root, "Alerts");
    if (head && !langOf(head).startsWith("en")) missing.push('head "Alerts"');
    console.info(`QA-1400 side panel without lang=en: ${JSON.stringify(missing)}`);
    expect(missing).toEqual([]);
  });

  it("other public panel heads (source lines — same check as tests/lang-of-parts for QA-313)", () => {
    const src = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
    const cases: [string, string][] = [
      ["components/WatchPanel.tsx", "Watchlist"], ["components/WarningPanel.tsx", "Weather warnings"], ["components/RadarTimeline.tsx", "Radar"],
      ["components/AttributionFooter.tsx", "Sources"], ["components/AircraftCard.tsx", "Active alerts"], ["components/ShipCard.tsx", "Ship"],
      ["app/airports/[icao]/page.tsx", "History (latest 24)"], ["app/replay/page.tsx", "Replay"], ["components/guide/GuideToc.tsx", "Contents"],
      ["components/Shell.tsx", "Aircraft · Ships · Hazardous Weather"],
    ];
    const missing = cases.filter(([f, w]) => {
      const line = src(f).split("\n").find((l) => l.includes(`>${w}<`));
      return line != null && !line.includes('lang="en"');
    }).map(([f, w]) => `${f}: ${w}`);
    console.info(`QA-1400 heads without lang=en: ${JSON.stringify(missing)}`);
    expect(missing).toEqual([]);
  });
});
