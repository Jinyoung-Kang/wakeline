/**
 * 나중에 받는 화면 조각(components/LazyPart.tsx — ADR-026): 첫 화면 JS 에서 뺀 카드 · 목록 · 상세를 처음 쓸 때 받는다.
 * - 받는 동안: 진행 표시 규칙(lib/busy · globals.css) 그대로 — 글자(role=status)는 처음부터 DOM 에(화면 읽기 프로그램이 바로 읽는다),
 *   진행 막대 · 자리 표시는 BUSY_APPEAR_DELAY_MS 뒤에 보인다(빨리 받으면 번쩍이지 않는다). 자리 표시는 값처럼 보이지 않는 막대.
 * - 받은 뒤: 같은 그리기에서 바로 그린다(한 번 받은 조각은 다시 기다리지 않는다).
 * - 받지 못함(네트워크 · 배포 교체로 청크가 사라짐): 조용히 비우지 않는다 — 까닭과 '다시 시도'를 보이고 시스템 로그에 한 번 보고한다.
 *   받은 조각 자신의 그리기 오류는 여기서 삼키지 않고 위(화면 오류 경계 app/error.tsx)로 올린다.
 */
import type { ComponentType, ReactElement } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";

const reports: unknown[] = [];
vi.mock("@/lib/errorReport", async (orig) => ({
  ...(await orig<typeof import("@/lib/errorReport")>()),
  reportClientError: (input: unknown) => { reports.push(input); return "sent"; },
}));

const { lazyPart, LazyLoadError } = await import("@/components/LazyPart");

describe("server render / first render", () => {
  it("before the chunk arrives: status text at once, progress bar and skeleton after the busy delay, nothing that looks like a value", () => {
    const Part = lazyPart("항공기 카드", () => new Promise<ComponentType<{ x: string }>>(() => {}));
    const html = renderToStaticMarkup(createElement(Part, { x: "a" }));
    expect(html).toContain('data-testid="lazy-loading"');
    expect(html).toMatch(/<div role="status"[^>]*>항공기 카드 불러오는 중<\/div>/);
    expect(html).toMatch(/class="busy-appear[^"]*"[^>]*data-testid="lazy-progress"|data-testid="lazy-progress"[^>]*class="busy-appear/);
    expect(html).toMatch(/<span class="busy-bar[^"]*" aria-hidden="true"/);
    expect(html).toMatch(/aria-busy="true"/);
    expect(html).toContain('class="skeleton');
  });
  it("once loaded, renders the part in the same pass (no loading flash)", async () => {
    const Bold = ({ x }: { x: string }) => createElement("b", { "data-testid": "part" }, x);
    const Part = lazyPart("선박", async () => Bold);
    await Part.preload();
    const html = renderToStaticMarkup(createElement(Part, { x: "hello" }));
    expect(html).toContain('<b data-testid="part">hello</b>');
    expect(html).not.toContain("lazy-loading");
  });
  it("preload loads once and shares the result", async () => {
    let calls = 0;
    const Part = lazyPart("x", async () => { calls++; return () => null; });
    await Promise.all([Part.preload(), Part.preload()]);
    await Part.preload();
    expect(calls).toBe(1);
  });
});

describe("mounted (react-dom/client)", () => {
  const dom = installMiniDom();
  type Root = import("react-dom/client").Root;
  let React: typeof import("react");
  let createRoot: typeof import("react-dom/client").createRoot;
  let root: Root | null = null;
  beforeAll(async () => { React = await import("react"); ({ createRoot } = await import("react-dom/client")); });
  afterAll(() => dom.restore());
  afterEach(async () => { reports.length = 0; if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); } });
  const mount = async (el: ReactElement) => { root = createRoot(dom.container as never); await React.act(async () => { root!.render(el); }); };
  const find = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container): MiniElement | null => {
    if (pred(from)) return from;
    for (const c of from.childNodes) { const f = c instanceof MiniElement ? find(pred, c) : null; if (f) return f; }
    return null;
  };
  const byId = (id: string) => find((e) => e.getAttribute?.("data-testid") === id);
  const click = async (e: MiniElement | null) => {
    const k = Object.keys(e!).find((x) => x.startsWith("__reactProps$"))!;
    await React.act(async () => { (e as unknown as Record<string, { onClick: () => void }>)[k].onClick(); });
  };

  it("shows the part when its chunk arrives", async () => {
    let resolve!: (c: ComponentType) => void;
    const Part = lazyPart("공항 목록", () => new Promise<ComponentType>((r) => { resolve = r; }));
    await mount(createElement(Part));
    expect(byId("lazy-loading")).not.toBeNull();
    const Airports = () => createElement("p", { "data-testid": "airports" }, "RKSI");
    await React.act(async () => { resolve(Airports); });
    expect(byId("airports")?.textContent).toBe("RKSI");
    expect(byId("lazy-loading")).toBeNull();
  });

  it("a chunk that fails to load: the reason and a retry on screen, one report to the system log, retry loads again", async () => {
    let fail = true;
    const Ship = () => createElement("i", { "data-testid": "ship" }, "ok");
    const Part = lazyPart("선박 카드", async () => {
      if (fail) throw new Error("Failed to load chunk /_next/static/chunks/x.js");
      return Ship;
    });
    await mount(createElement(Part));
    const err = byId("lazy-error");
    expect(err?.getAttribute("role")).toBe("alert");
    expect(err?.textContent).toContain("선박 카드");
    expect(err?.textContent).toContain("Failed to load chunk /_next/static/chunks/x.js");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ component: "lazy:선박 카드" });
    expect((reports[0] as { message: string }).message).toContain("Failed to load chunk");
    fail = false;
    await click(byId("lazy-retry"));
    expect(byId("ship")?.textContent).toBe("ok");
    expect(byId("lazy-error")).toBeNull();
    expect(reports).toHaveLength(1);
  });

  it("a render error inside a loaded part is not swallowed: it reaches the route error boundary and is not reported as a load failure", async () => {
    const Broken = (): null => { throw new Error("boom in card"); };
    const Part = lazyPart("SIGMET 카드", async () => Broken);
    await Part.preload();
    const caught: unknown[] = [];
    class Outer extends React.Component<{ children: React.ReactNode }, { e: unknown }> {
      state = { e: null as unknown };
      static getDerivedStateFromError(e: unknown) { return { e }; }
      componentDidCatch(e: unknown) { caught.push(e); }
      render() { return this.state.e ? createElement("p", { "data-testid": "route-error" }, String(this.state.e)) : this.props.children; }
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await mount(createElement(Outer, null, createElement(Part)));
    } finally { spy.mockRestore(); }
    expect(byId("route-error")?.textContent).toContain("boom in card");
    expect(byId("lazy-error")).toBeNull();
    expect(caught).toHaveLength(1);
    expect(caught[0]).not.toBeInstanceOf(LazyLoadError);
    expect(reports).toHaveLength(0);
  });
});
