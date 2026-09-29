/**
 * 지도 위 출처 표기를 작게(사용자 요청 2026-09-29 "[상황판] 지도 오른쪽 아래 source 정보 박스가 작은 화면에서 지도를 가린다").
 * - MapLibre compact 출처(ⓘ 단추 — 누르면 펼치고 접는다). 지도 폭이 기준보다 좁으면 접힌 채로 시작하고, 좁아지는 순간 접는다. 상태는 기억하지 않는다.
 * - 출처는 화면 아래 SOURCES 줄(AttributionFooter)에 늘 전부 보인다(NFR-15 상시 노출) — 지도 위 표기를 접어도 출처가 사라지지 않는다.
 * - 키보드: ⓘ 단추는 Tab 으로 닿고(summary), 안의 링크는 Tab 순서에서 뺀다(R-30). MapLibre 6 의 정화(DOM.sanitize)는 tabindex 를 지운다 —
 *   그래서 문자열(mapAttributionHtml)의 tabindex=-1 은 그려진 링크에 남지 않았다. 그려진 뒤의 링크에 건다(스타일이 붙인 배경지도 링크 포함, 다시 그려도).
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as A from "@/lib/map-attribution";
import { attributionText, CREDITS } from "@/lib/attribution";
import { AttributionFooter } from "@/components/AttributionFooter";

/** MapLibre AttributionControl 이 onAdd 에서 만드는 모양: <details class="maplibregl-ctrl maplibregl-ctrl-attrib …" open><summary …/><div inner>…</div></details> */
class FakeNode {
  attrs = new Map<string, string>();
  cls = new Set<string>();
  classList = { add: (...c: string[]) => c.forEach((x) => this.cls.add(x)), remove: (...c: string[]) => c.forEach((x) => this.cls.delete(x)), contains: (c: string) => this.cls.has(c) };
  constructor(public tag: string) {}
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  hasAttribute(k: string) { return this.attrs.has(k); }
}
class FakeDetails extends FakeNode {
  summary = new FakeNode("summary");
  links: FakeNode[] = [];
  constructor() { super("details"); }
  querySelector(sel: string) { return sel === "summary" ? this.summary : null; }
  querySelectorAll(sel: string) { return sel === "a" ? this.links : []; }
  /** MapLibre 가 출처 HTML 을 다시 그린 것처럼(정화 뒤라 tabindex 없음) */
  render(n: number) { this.links = Array.from({ length: n }, () => new FakeNode("a")); }
}
class FakeInner {
  el = new FakeDetails();
  removed = false;
  constructor(public opts: { compact?: boolean; customAttribution?: string }) {}
  onAdd() {
    // compact:true 일 때 MapLibre 는 펼친 채로 시작한다(_updateCompact: open + maplibregl-compact + maplibregl-compact-show)
    this.el.classList.add("maplibregl-ctrl", "maplibregl-ctrl-attrib");
    if (this.opts.compact) { this.el.classList.add("maplibregl-compact", "maplibregl-compact-show"); }
    this.el.setAttribute("open", "");
    this.el.render(13);
    return this.el as unknown as HTMLElement;
  }
  onRemove() { this.removed = true; }
}
function fakeMap(width: number) {
  const handlers = new Map<string, ((e?: unknown) => void)[]>();
  const m = {
    width,
    getContainer: () => ({ clientWidth: m.width }),
    on: (t: string, fn: () => void) => { (handlers.get(t) ?? handlers.set(t, []).get(t)!).push(fn); return m; },
    off: (t: string, fn: () => void) => { const l = handlers.get(t) ?? []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); return m; },
    fire: (t: string) => { for (const h of [...(handlers.get(t) ?? [])]) h(); },
    count: (t: string) => handlers.get(t)?.length ?? 0,
  };
  return m;
}
const ml = { AttributionControl: FakeInner };
const collapsed = (el: FakeDetails) => !el.cls.has("maplibregl-compact-show") && !el.hasAttribute("open");
function add(width: number, observe?: A.ObserveFn) {
  const map = fakeMap(width);
  const ctl = A.mapAttributionControl(ml as never, "<a>x</a>", observe);
  const el = ctl.onAdd(map as never) as unknown as FakeDetails;
  return { map, ctl, el, inner: (ctl as unknown as { inner: FakeInner }).inner };
}

describe("compact map attribution", () => {
  it("uses MapLibre's compact attribution (the ⓘ toggle) with our credit HTML", () => {
    const { inner } = add(800);
    expect(inner.opts).toEqual({ compact: true, customAttribution: "<a>x</a>" });
  });
  it("starts collapsed when the map is narrower than the breakpoint, expanded when wider", () => {
    expect(collapsed(add(A.ATTRIB_EXPANDED_MIN_PX - 1).el)).toBe(true);
    expect(collapsed(add(1020).el)).toBe(true); // e2e 1400 px 창의 상황판 지도(1400 − 380)
    const wide = add(A.ATTRIB_EXPANDED_MIN_PX).el;
    expect(collapsed(wide)).toBe(false);
    expect(wide.cls.has("maplibregl-compact")).toBe(true); // 넓어도 ⓘ 로 접을 수 있다
  });
  it("collapses when the map becomes narrow (window resize); widening again does not force it open; nothing is remembered", () => {
    const { map, el } = add(A.ATTRIB_EXPANDED_MIN_PX + 200);
    expect(collapsed(el)).toBe(false);
    map.width = 900; map.fire("resize");
    expect(collapsed(el)).toBe(true);
    // 사용자가 ⓘ 로 다시 펼쳤다(MapLibre _toggleAttribution 과 같은 상태)
    el.classList.add("maplibregl-compact-show"); el.setAttribute("open", "");
    map.width = 950; map.fire("resize"); // 좁은 채로 크기만 바뀜 — 사용자가 펼친 것을 다시 접지 않는다
    expect(collapsed(el)).toBe(false);
    map.width = 2000; map.fire("resize");
    expect(collapsed(el)).toBe(false);
    expect(localStorageUsed()).toBe(false);
  });
  it("the toggle is labelled in Korean and says the full list is in the SOURCES footer", () => {
    const { el } = add(800);
    expect(el.summary.getAttribute("aria-label")).toBe(A.ATTRIB_TOGGLE_LABEL);
    expect(el.summary.getAttribute("title")).toBe(A.ATTRIB_TOGGLE_LABEL);
    expect(A.ATTRIB_TOGGLE_LABEL).toContain("SOURCES");
  });
  it("every rendered link is out of the Tab order (R-30), also after MapLibre re-renders the credits (style sources arrive later)", () => {
    let rerender: () => void = () => {};
    const { el } = add(800, (_node, fn) => { rerender = fn; return () => {}; });
    expect(el.links.length).toBe(13);
    expect(el.links.every((a) => a.getAttribute("tabindex") === "-1")).toBe(true);
    el.render(16); // 스타일 소스의 배경지도 출처가 붙어 다시 그림(정화로 tabindex 없음)
    expect(el.links.some((a) => a.getAttribute("tabindex") === "-1")).toBe(false);
    rerender();
    expect(el.links.every((a) => a.getAttribute("tabindex") === "-1")).toBe(true);
    expect(el.summary.getAttribute("tabindex")).toBeNull(); // ⓘ 단추는 Tab 으로 닿는다(summary 기본)
  });
  it("removing the control stops the observer, drops the resize listener and removes MapLibre's control", () => {
    let stopped = 0;
    const { map, ctl, inner } = add(800, () => () => { stopped++; });
    expect(map.count("resize")).toBe(1);
    ctl.onRemove();
    expect(stopped).toBe(1);
    expect(map.count("resize")).toBe(0);
    expect(inner.removed).toBe(true);
    expect(ctl.getDefaultPosition()).toBe("bottom-right");
  });
});

function localStorageUsed() { return false; } // 저장소를 쓰지 않는다 — 모듈에 localStorage 가 없는지 아래에서 본다

describe("both maps use it; attribution stays visible in the footer", () => {
  const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  it("dashboard and replay maps add the compact control instead of an always-expanded one", () => {
    for (const f of ["components/MapView.tsx", "components/ReplayMap.tsx"]) {
      const s = src(f);
      expect(s, f).toMatch(/mapAttributionControl\(/);
      expect(s, f).not.toMatch(/AttributionControl\(\{ compact: false/);
    }
    expect(src("lib/map-attribution.ts")).not.toMatch(/localStorage|sessionStorage/);
  });
  it("the SOURCES footer still lists every credit", () => {
    const t = renderToStaticMarkup(createElement(AttributionFooter)).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
    for (const c of CREDITS) expect(t).toContain(c.label);
    expect(attributionText().length).toBeGreaterThan(100);
  });
  it("the expanded box is narrower than before (max 760 px → a smaller cap) and the ⓘ button is visible on the dark map", () => {
    const css = src("app/globals.css");
    expect(css).not.toMatch(/max-width: min\(70vw, 760px\)/);
    expect(css).toMatch(/\.maplibregl-ctrl-attrib-button\s*\{[^}]*background-image/);
  });
});
