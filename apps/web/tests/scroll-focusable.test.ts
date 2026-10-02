/**
 * QA-305 — 내용 스크롤 상자에 키보드 초점이 없었다(axe scrollable-region-focusable · WCAG 2.1.1): /about 본문 · /airports 본문(좁은 화면) · 설명서 표(좁은 화면) ·
 * 지도 범례 · 운영 quality · audit · pipeline 탭 본문. 본문(body)은 overflow hidden 이라 '본문으로 건너뛰기'(#main) 뒤 PageDown 이 듣지 않았다.
 * 이제 그 상자는 이름 붙은 영역이고 넘칠 때만 Tab 정지점(tabIndex 0 — 아니면 -1), 건너뛰기로 온 초점은 화면의 본문 상자로 넘어간다.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import { overflows, useScrollFocusable } from "@/lib/use-scroll-focusable";
import { ScrollRegion } from "@/components/ScrollRegion";

const dom = installMiniDom();
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.unstubAllGlobals(); });

describe("useScrollFocusable: a Tab stop only while the box overflows", () => {
  it("overflows: vertical or horizontal, with 1 px of rounding", () => {
    expect(overflows({ scrollHeight: 900, clientHeight: 400, scrollWidth: 300, clientWidth: 300 })).toBe(true);
    expect(overflows({ scrollHeight: 400, clientHeight: 400, scrollWidth: 560, clientWidth: 343 })).toBe(true);
    expect(overflows({ scrollHeight: 401, clientHeight: 400, scrollWidth: 300, clientWidth: 300 })).toBe(false);
  });
  it("sets tabIndex 0 / -1 on attach and again when the box or its content changes; detaching disconnects", async () => {
    const observers: { cb: () => void; off: boolean }[] = [];
    class Obs { o: { cb: () => void; off: boolean }; constructor(cb: () => void) { this.o = { cb, off: false }; observers.push(this.o); } observe() {} disconnect() { this.o.off = true; } }
    vi.stubGlobal("ResizeObserver", Obs);
    vi.stubGlobal("MutationObserver", Obs);
    let refFn: ((el: HTMLElement | null) => (() => void) | undefined) | null = null;
    const Probe = () => { refFn = useScrollFocusable<HTMLElement>(); return null; };
    await m.render(createElement(Probe));
    const box = { scrollHeight: 300, clientHeight: 300, scrollWidth: 100, clientWidth: 100, tabIndex: 99 } as unknown as HTMLElement;
    const cleanup = refFn!(box)!;
    expect(box.tabIndex).toBe(-1);
    (box as unknown as { scrollHeight: number }).scrollHeight = 1200; // 내용이 늘어남(감사 '더 보기' · 탭 바뀜)
    observers[1].cb();
    await m.settle();
    expect(box.tabIndex).toBe(0);
    cleanup();
    expect(observers.every((o) => o.off)).toBe(true);
  });
});

describe("where it is used", () => {
  it("ScrollRegion is a named region; the page's main box is marked for the skip link", () => {
    const html = renderToStaticMarkup(createElement(ScrollRegion, { label: "출처·한계 본문", main: true, className: "h-full overflow-y-auto" }, "x"));
    expect(html).toBe('<div class="h-full overflow-y-auto" role="region" aria-label="출처·한계 본문" data-main-scroll="true">x</div>');
    expect(renderToStaticMarkup(createElement(ScrollRegion, { label: "표: a" }, "x"))).not.toContain("data-main-scroll");
  });
  it("the scrolling boxes named in the finding use it (about · airports · stats · guide body and tables · map legend · ops tab body)", () => {
    const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    expect(src("app/about/page.tsx")).toMatch(/<ScrollRegion label="출처·한계 본문" main className="h-full overflow-y-auto/);
    expect(src("app/airports/[icao]/page.tsx")).toMatch(/<ScrollRegion label=\{`\$\{code\} 공항 기상 이력`\} main className="h-full overflow-y-auto/);
    expect(src("app/stats/page.tsx")).toMatch(/<ScrollRegion label="통계 본문" main className="h-full overflow-y-auto/);
    expect(src("components/guide/GuideView.tsx")).toMatch(/<ScrollRegion label="설명서 본문" main className="h-full overflow-y-auto" data-testid="guide" data-guide-scroll="">/);
    expect(src("components/guide/GuideView.tsx")).toMatch(/<ScrollRegion label=\{`표: \$\{label\}`\} className="g-table">/);
    expect(src("components/MapLegend.tsx")).toMatch(/ref=\{scrollRef\}[^>]*overflow-y-auto[^>]*role="region" aria-label="지도 범례"/);
    expect(src("app/ops/page.tsx")).toMatch(/ref=\{tabBodyRef\}[^>]*overflow-auto[^>]*role="region"/);
    // '본문으로 건너뛰기'로 온 초점은 본문 상자로(그래야 PageDown 이 그 상자를 스크롤한다)
    expect(src("components/Shell.tsx")).toMatch(/<main id="main"[\s\S]*?onFocus=\{\(e\) => \{ if \(e\.target === e\.currentTarget\) e\.currentTarget\.querySelector<HTMLElement>\("\[data-main-scroll\]"\)\?\.focus\(\); \}\}/);
  });
});
