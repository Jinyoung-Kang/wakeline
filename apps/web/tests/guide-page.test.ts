/**
 * 설명서 화면(/guide) — 서버 렌더 결과로 확인한다(정적 렌더 · 클라이언트 자바스크립트는 목차의 현재 위치 표시와 좁은 화면 선택 상자뿐).
 * - 목차(넓은 화면 목록 · 좁은 화면 선택 상자)의 앵커와 절 id 가 같다(순서까지).
 * - 스크린샷: 결과(manifest)가 있으면 <img>(대체 글 · width · height · loading=lazy · decoding=async), 없으면 "스크린샷 준비 중" 자리표시.
 * - 번호: 그림 위 번호(HTML 겹침 — 이미지에 굽지 않음)마다 같은 번호의 설명 항목이 있고, 설명 목록은 1..n. 찍을 때 보이지 않은 번호는 목록에 그렇다고 적는다.
 * - 시각이 나오는 예는 KST 와 UTC 를 함께 적는다. 출처는 하단 출처 줄과 같은 목록(lib/attribution)에서.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CREDITS } from "@/lib/attribution";
import { flattenToc, parseManifest, PLAN, tocItem, type GuideManifest, type ManifestDrop } from "@/lib/guide";

const links: { href: string; prefetch?: boolean | null }[] = [];
vi.mock("next/link", () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean | null; children?: ReactNode }) => {
    links.push({ href, prefetch });
    return createElement("a", { href, ...rest }, children);
  },
}));

const { GuideView } = await import("@/components/guide/GuideView");
const GuidePage = (await import("@/app/guide/page")).default;

const EMPTY: GuideManifest = { version: 1, shots: {} };
/** 모든 스크린샷이 있는 결과 — 마지막 번호 하나는 "찍을 때 보이지 않음"으로 뺀다 */
const FULL: GuideManifest = parseManifest({
  version: 1,
  shots: Object.fromEntries(PLAN.shots.map((s, i) => [s.id, {
    file: `${s.id}.${(i + 10).toString(16).padStart(10, "0")}.webp`, format: "webp", width: 1440, height: 900, bytes: 90_000 + i,
    captured_at: "2026-09-29T05:22:11.000Z", variant: i === 0 ? "한반도 #6.3/36.1/127.9" : null,
    callouts: s.callouts.slice(0, -1).map((c) => ({ n: c.n, x: 10 + c.n, y: 20 + c.n })),
  }])),
}, PLAN).manifest;

const render = (manifest: GuideManifest, dropped: ManifestDrop[] = []) => renderToStaticMarkup(createElement(GuideView, { manifest, dropped }));
const attrs = (tag: string) => Object.fromEntries([...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const tags = (html: string, name: string) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map((m) => m[0]);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
/** figure 하나씩(중첩 figure 없음) */
const figures = (html: string) => [...html.matchAll(/<figure\b[\s\S]*?<\/figure>/g)].map((m) => m[0]);

describe("guide page structure", () => {
  it("the route renders the committed manifest; the document title is 설명서", async () => {
    const html = renderToStaticMarkup(createElement(GuidePage));
    expect(html).toContain("data-testid=\"guide\"");
    expect(figures(html)).toHaveLength(PLAN.shots.length);
    expect((await import("@/app/guide/page")).metadata?.title).toBe("설명서");
  });
  it("TOC anchors (list and narrow-screen select) match the section ids, in document order", () => {
    const html = render(EMPTY);
    const ids = flattenToc().map((t) => t.id);
    const nav = /<nav[^>]*aria-label="설명서 목차"[^>]*>([\s\S]*?)<\/nav>/.exec(html)![1];
    expect([...nav.matchAll(/href="#([^"]+)"/g)].map((m) => m[1])).toEqual(ids);
    const select = /<select[^>]*aria-label="설명서 목차[^"]*"[^>]*>([\s\S]*?)<\/select>/.exec(html)![1];
    expect([...select.matchAll(/<option[^>]*value="([^"]+)"/g)].map((m) => m[1]).filter(Boolean)).toEqual(ids);
    const sections = [...html.matchAll(/data-guide-section="([^"]+)"/g)].map((m) => m[1]);
    expect(sections).toEqual(ids);
    for (const id of ids) expect(tags(html, "section").filter((t) => attrs(t).id === id)).toHaveLength(1);
    expect(tags(html, "h1")).toHaveLength(1);
  });
  it("links: /about is linked; every next/link has prefetch off; external links open safely", () => {
    links.length = 0;
    const html = render(EMPTY);
    expect(links.some((l) => l.href === "/about")).toBe(true);
    expect(links.filter((l) => l.prefetch !== false)).toEqual([]);
    for (const a of tags(html, "a").map(attrs).filter((a) => /^https?:/.test(a.href))) {
      expect(a.target).toBe("_blank");
      expect(a.rel).toBe("noopener noreferrer");
    }
  });
  it("section 1 names every data source from the footer list (no other list to drift)", () => {
    const t = text(render(EMPTY));
    for (const c of CREDITS) expect(t).toContain(c.label);
  });
});

describe("screenshots", () => {
  it("missing screenshots render a clear placeholder that describes the screen — no <img>, no markers", () => {
    const html = render(EMPTY);
    expect(tags(html, "img")).toEqual([]);
    const figs = figures(html);
    expect(figs).toHaveLength(PLAN.shots.length);
    figs.forEach((f, i) => {
      const ph = tags(f, "div").map(attrs).find((a) => a["data-guide-placeholder"] != null)!;
      expect(ph.role).toBe("img");
      expect(ph["aria-label"]).toContain(PLAN.shots[i].alt.replace(/&/g, "&amp;").replace(/"/g, "&quot;"));
      expect(text(f)).toContain("1440×900"); // 찍을 크기를 적는다
      expect(text(f)).toContain("스크린샷 준비 중");
      expect(f).not.toContain("data-callout-marker");
    });
  });
  it("every image has alt · width · height · lazy loading · async decoding and a /guide/ source", () => {
    const html = render(FULL);
    const imgs = tags(html, "img").map(attrs);
    expect(imgs).toHaveLength(PLAN.shots.length);
    imgs.forEach((a, i) => {
      expect(a.alt?.length).toBeGreaterThan(0);
      expect(a.alt).toBe(PLAN.shots[i].alt.replace(/&/g, "&amp;").replace(/"/g, "&quot;"));
      expect(a.width).toBe("1440");
      expect(a.height).toBe("900");
      expect(a.loading).toBe("lazy");
      expect(a.decoding).toBe("async");
      expect(a.src).toBe(`/guide/${FULL.shots[PLAN.shots[i].id].file}`);
    });
    expect(html).not.toContain("스크린샷 준비 중");
  });
  it("callout numbers over the image match the numbered list; numbers not seen at capture are said so in the list", () => {
    const figs = figures(render(FULL));
    figs.forEach((f, i) => {
      const shot = PLAN.shots[i];
      const markers = [...f.matchAll(/data-callout-marker="(\d+)"[^>]*>(\d+)</g)].map((m) => [Number(m[1]), Number(m[2])]);
      const items = [...f.matchAll(/data-callout-item="(\d+)"/g)].map((m) => Number(m[1]));
      expect(items).toEqual(shot.callouts.map((c) => c.n));
      expect(markers.map(([n, shown]) => n === shown)).toEqual(markers.map(() => true)); // 겹침 글자 = 번호
      expect(markers.map(([n]) => n)).toEqual(shot.callouts.slice(0, -1).map((c) => c.n));
      expect(markers.every(([n]) => items.includes(n))).toBe(true);
      // 위치는 찍을 때 잰 값(%) 그대로
      const first = /data-callout-marker="1"[^>]*style="([^"]*)"|style="([^"]*)"[^>]*data-callout-marker="1"/.exec(f)!;
      expect(first[1] ?? first[2]).toContain("left:11%");
      expect(first[1] ?? first[2]).toContain("top:21%");
      const last = shot.callouts[shot.callouts.length - 1].n;
      const lastItem = new RegExp(`data-callout-item="${last}"[\\s\\S]*?</li>`).exec(f)![0];
      expect(text(lastItem)).toContain("이 스크린샷에는 보이지 않음");
      expect(text(f)).toContain(`그림 ${i + 1}`);
    });
  });
  it("capture meta follows the time rule (KST with UTC alongside) and names the capture condition", () => {
    const f = figures(render(FULL))[0];
    const t = text(f);
    expect(t).toContain("2026-09-29 14:22:11 KST");
    expect(t).toContain("2026-09-29 05:22:11 UTC");
    expect(t).toContain("한반도 #6.3/36.1/127.9");
    expect(t).toMatch(/WebP · 1440×900 · 88 KB/);
  });
  it("dropped manifest parts are shown at the top, each saying what it did to the figure (placeholder · image without that part · not in the plan)", () => {
    const html = render(EMPTY, [
      { text: "dashboard: file 이름이 …", effect: "placeholder" },
      { text: "search: variant(캡처 조건)가 …", effect: "partial" },
      { text: "nosuch: 계획에 없는 스크린샷", effect: "unused" },
    ]);
    expect(html).toMatch(/role="alert"/);
    const alert = text(html.slice(html.indexOf('role="alert"'), html.indexOf('data-guide-section="overview"')));
    expect(alert).toMatch(/항목을 버림 — 그 그림은 자리표시[\s\S]*dashboard: file 이름이/);
    expect(alert).toMatch(/일부만 버림 — 그림은 보이고 그 부분만 빠짐[\s\S]*search: variant/);
    expect(alert).toMatch(/계획에 없어 무시[\s\S]*nosuch/);
    // 해당 없는 묶음은 적지 않는다
    expect(text(render(EMPTY, [{ text: "search: variant …", effect: "partial" }]))).not.toMatch(/자리표시로 보입니다|항목을 버림/);
  });
});

/** 설명서 밖의 화면 코드(app · components · lib, guide 파일 제외) — 설명서가 없는 기능을 적지 않는지 대조한다 */
const WEB = new URL("..", import.meta.url).pathname;
const walk = (d: string): string[] => readdirSync(join(WEB, d)).flatMap((n) => {
  const rel = join(d, n);
  return statSync(join(WEB, rel)).isDirectory() ? (n === "guide" ? [] : walk(rel)) : /\.tsx?$/.test(n) && !/guide/.test(n) ? [rel] : [];
});
const SCREENS = ["app", "components", "lib"].flatMap(walk).map((f) => readFileSync(join(WEB, f), "utf8")).join("\n");

describe("features the guide describes exist in the screens", () => {
  // 오류 '해결' 표시(ADR-022 · 계약 §G13 — 지우지 않고 upto 까지 가림)는 api 에만 있고 화면(/ops/resolutions 호출 · hidden_resolved 표시)이 아직 없다.
  // 화면이 들어오면 이 시험이 실패한다 — 그때 6.2 · 6.3 에 가림 · 가린 수 · 다시 보기 · 되돌리기 · 재발은 다시 보임을 적는다(지운다고 쓰지 않는다).
  const RESOLVE_UI = /ops\/resolutions|hidden_resolved/.test(SCREENS);
  it("resolving errors is described only when the ops/logs screens have it — and never as deleting", () => {
    const html = render(EMPTY);
    const logs = text(/<section[^>]*id="ops-logs"[\s\S]*?<\/section>/.exec(html)![0]);
    const ops = text(/<section[^>]*id="ops"[\s\S]*?<\/section>\s*<\/section>/.exec(html)?.[0] ?? html);
    expect(ops).not.toMatch(/지울 수|삭제/);
    if (!RESOLVE_UI) {
      expect(logs).not.toMatch(/해결/);
      expect(tocItem("ops-logs").title).not.toMatch(/해결/);
    } else {
      expect(logs).toMatch(/해결/);
      expect(logs).toMatch(/지우지 않/);
      expect(logs).toMatch(/다시 보/);
    }
  });
});

describe("time examples", () => {
  it("the time section shows each example in KST and UTC; the stats run time is given in both", () => {
    const html = render(EMPTY);
    const sec = /<section[^>]*id="time"[\s\S]*?<\/section>/.exec(html)![0];
    const t = text(sec);
    expect(t).toContain("2026-09-29 14:22:11");
    expect(t).toContain("2026-09-29 05:22:11");
    expect(t).toContain("290500Z"); // 원문은 발표 그대로
    expect(text(html)).toMatch(/12:30 KST\s*\(03:30 UTC\)/);
  });
  it("unknown values are shown as — without a unit", () => {
    const t = text(render(EMPTY));
    expect(t).not.toMatch(/— (ft|kt|ms|m|km|s)\b/);
  });
});
