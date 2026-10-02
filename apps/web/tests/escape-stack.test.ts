/**
 * QA 2026-10 화면 개선 제안 1 — 겹쳐 뜨는 패널(범례 · 카드 · 상세)을 같은 규칙으로 Esc 로 닫는다(lib/escape-stack): 초점이 있는 곳의 것, 나중에 연 것부터,
 * 한 번에 하나. 다른 요소(검색 입력 · 단추)의 Esc 와 이미 처리된 Esc 는 건드리지 않는다.
 */
import { describe, expect, it } from "vitest";
import { handleEscape, type EscapeLayer } from "@/lib/escape-stack";

/** contains · closest 만 있는 가짜 요소(부모 사슬) */
class Node {
  constructor(public name: string, public parent: Node | null = null, public attrs: Record<string, string> = {}) {}
  contains(n: unknown): boolean {
    for (let x = n as Node | null; x; x = x.parent) if (x === this) return true;
    return false;
  }
  closest(sel: string): Node | null {
    const attr = sel.replace(/^\[|\]$/g, "");
    return attr in this.attrs ? this : (this.parent?.closest(sel) ?? null);
  }
}

const main = new Node("main");
const map = new Node("map", main, { "data-escape-neutral": "" });
const canvas = new Node("canvas", map);
const legendBtn = new Node("legend-toggle", main);
const legend = new Node("legend", main);
const legendLink = new Node("legend-link", legend);
const card = new Node("aircraft-card", main);
const cardBtn = new Node("card-close", card);
const search = new Node("search-input", main);

function layer(panel: Node, closed: string[], opener?: Node): EscapeLayer & { focusInside?: boolean } {
  const l: EscapeLayer & { focusInside?: boolean } = {
    panel: () => panel as unknown as Element,
    opener: opener ? () => opener as unknown as Element : undefined,
    close: (inside) => { l.focusInside = inside; closed.push(panel.name); },
  };
  return l;
}

function esc(target: unknown, extra: Partial<{ key: string; defaultPrevented: boolean; isComposing: boolean }> = {}) {
  const e = { key: "Escape", defaultPrevented: false, isComposing: false, target, prevented: false, preventDefault() { e.prevented = true; }, ...extra };
  return e;
}

describe("handleEscape", () => {
  it("closes the panel that holds the focus, even when another one is on top, and says the focus was inside", () => {
    const closed: string[] = [];
    const l = layer(legend, closed, legendBtn), c = layer(card, closed);
    const e = esc(legendLink);
    expect(handleEscape(e, [l, c])).toBe(true);
    expect(closed).toEqual(["legend"]);
    expect(l.focusInside).toBe(true);
    expect(e.prevented).toBe(true);
  });

  it("the opener's Esc belongs to its panel", () => {
    const closed: string[] = [];
    handleEscape(esc(legendBtn), [layer(legend, closed, legendBtn), layer(card, closed)]);
    expect(closed).toEqual(["legend"]);
  });

  it("from a neutral place (map, nothing focused, an ancestor) it closes only the top panel — the one opened last", () => {
    for (const target of [canvas, null, main]) {
      const closed: string[] = [];
      const c = layer(card, closed);
      expect(handleEscape(esc(target), [layer(legend, closed, legendBtn), c])).toBe(true);
      expect(closed).toEqual(["aircraft-card"]);
      expect(c.focusInside).toBe(false);
    }
  });

  it("leaves Esc alone in another control, when already handled, while composing, or for other keys", () => {
    const closed: string[] = [];
    const layers = [layer(card, closed)];
    expect(handleEscape(esc(search), layers)).toBe(false); // 검색 입력의 Esc(그 입력이 다룬다)
    expect(handleEscape(esc(cardBtn, { defaultPrevented: true }), layers)).toBe(false);
    expect(handleEscape(esc(cardBtn, { isComposing: true }), layers)).toBe(false);
    expect(handleEscape(esc(cardBtn, { key: "Enter" }), layers)).toBe(false);
    expect(handleEscape(esc(null), [])).toBe(false);
    expect(closed).toEqual([]);
  });
});
