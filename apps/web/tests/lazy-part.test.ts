/**
 * 나중에 받는 화면 조각(components/LazyPart.tsx — ADR-026): 첫 화면 JS 에서 뺀 카드 · 목록 · 상세를 처음 쓸 때 받는다.
 * - 받는 동안: 진행 표시 규칙(lib/busy · globals.css) 그대로 — 글자(role=status)는 처음부터 DOM 에(화면 읽기 프로그램이 바로 읽는다),
 *   진행 막대 · 자리 표시는 BUSY_APPEAR_DELAY_MS 뒤에 보인다(빨리 받으면 번쩍이지 않는다). 자리 표시는 값처럼 보이지 않는 막대.
 * - 받은 뒤: 같은 그리기에서 바로 그린다(한 번 받은 조각은 다시 기다리지 않는다).
 * - 받지 못함: 조용히 비우지 않는다 — 까닭을 보이고, 서버에 그 청크가 있는지 한 번 확인해(lib/chunk-probe) 그 결과와 함께 시스템 로그에 한 번 보고한다.
 *   청크가 서버에 없으면(404 — 페이지를 연 뒤 새 판이 배포됨) '다시 시도'로는 받을 수 없으니 '페이지 새로고침'을, 있으면 '다시 시도'를 보인다.
 *   다시 시도가 또 실패하면 두 단추를 함께 보인다.
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
  // 청크 확인(HEAD)과 새로고침은 전역 fetch · location 으로 한다 — 시험이 대역을 둔다
  const g = globalThis as Record<string, unknown>;
  const savedFetch = g.fetch;
  const net = { status: 200 as number | "fail", heads: [] as string[], reloads: 0 };
  beforeAll(() => {
    g.location = { origin: "http://localhost:8700", reload: () => { net.reloads++; } };
    g.fetch = (u: string, init?: RequestInit) => {
      net.heads.push(`${init?.method ?? "GET"} ${u}`);
      return net.status === "fail" ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve({ status: net.status } as Response);
    };
  });
  afterAll(() => { g.fetch = savedFetch; delete g.location; });
  afterEach(() => { net.status = 200; net.heads.length = 0; net.reloads = 0; });
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
  /** 청크 확인(비동기) · 보고가 끝날 때까지 */
  const settle = async () => { await React.act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); }); };
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

  it("a chunk that fails to load while the server still has it: the reason, the check, a retry; one report with the check; retry loads again", async () => {
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
    await settle();
    expect(net.heads).toEqual(["HEAD /_next/static/chunks/x.js"]);
    expect(byId("lazy-error")?.getAttribute("data-check")).toBe("present");
    expect(byId("lazy-error")?.textContent).toContain("서버에 청크가 있음(HTTP 200)");
    expect(byId("lazy-reload")).toBeNull(); // 처음 실패 — 다시 시도로 충분하다
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ component: "lazy:선박 카드" });
    expect((reports[0] as { message: string }).message).toContain("Failed to load chunk");
    expect((reports[0] as { message: string }).message).toContain("청크 확인: 서버에 청크가 있음(HTTP 200)");
    fail = false;
    await click(byId("lazy-retry"));
    expect(byId("ship")?.textContent).toBe("ok");
    expect(byId("lazy-error")).toBeNull();
    expect(reports).toHaveLength(1);
  });

  it("the chunk is gone from the server (404 — a newer deploy): retry cannot help, so the screen says so and offers a page reload instead", async () => {
    net.status = 404;
    const Part = lazyPart("공항 목록", async () => { throw Object.assign(new Error("Failed to load chunk /_next/static/chunks/2fqx8-h0u9z_7.js from module 76195"), { name: "ChunkLoadError" }); });
    await mount(createElement(Part));
    await settle();
    const err = byId("lazy-error");
    expect(err?.getAttribute("data-check")).toBe("missing");
    expect(err?.textContent).toContain("서버에 이 청크가 없음(HTTP 404)");
    expect(err?.textContent).toContain("새 판이 배포");
    expect(byId("lazy-retry")).toBeNull();
    expect(byId("lazy-reload")?.textContent).toBe("페이지 새로고침");
    expect((reports[0] as { message: string }).message).toContain("청크 확인: 서버에 이 청크가 없음(HTTP 404)");
    await click(byId("lazy-reload"));
    expect(net.reloads).toBe(1);
  });

  it("a retry that fails again (or a check that cannot answer) keeps retry and adds the page reload", async () => {
    net.status = "fail";
    const Part = lazyPart("SIGMET 목록", async () => { throw new Error("Failed to load chunk /_next/static/chunks/s.js"); });
    await mount(createElement(Part));
    await settle();
    expect(byId("lazy-error")?.getAttribute("data-check")).toBe("unknown");
    expect(byId("lazy-error")?.textContent).toContain("청크를 확인하지 못함(TypeError: Failed to fetch)");
    expect(byId("lazy-reload")).toBeNull();
    await click(byId("lazy-retry"));
    await settle();
    const err = byId("lazy-error");
    expect(err?.textContent).toContain("다시 시도도 실패했습니다");
    expect(byId("lazy-retry")).not.toBeNull();
    expect(byId("lazy-reload")).not.toBeNull();
  });

  describe("keyboard focus after '다시 시도' (the pressed button disappears)", () => {
    const failing = (label: string, state: { fail: boolean }) => {
      const Card = () => createElement("section", { "data-testid": "card" }, createElement("button", null, "닫기"));
      return lazyPart(label, async () => { if (state.fail) throw new Error("Failed to load chunk /_next/static/chunks/c.js"); return Card; });
    };
    it("a successful retry moves focus to the loaded part (made focusable for that moment) instead of leaving it on the page body", async () => {
      const st = { fail: true };
      await mount(createElement(failing("항공기 카드", st)));
      await settle();
      const btn = byId("lazy-retry")!;
      btn.focus();
      st.fail = false;
      await click(btn);
      const card = byId("card");
      expect(card).not.toBeNull();
      expect(dom.document.activeElement).toBe(card);
      expect(card?.getAttribute("tabindex")).toBe("-1");
      card!.dispatch("blur"); // 초점이 떠나면 잠시 붙였던 tabindex 를 뗀다(클릭으로 초점이 가는 요소로 남지 않게)
      expect(card?.hasAttribute("tabindex")).toBe(false);
    });
    it("does not take focus from where the user already went", async () => {
      const st = { fail: true };
      const elsewhere = dom.document.createElement("input");
      dom.document.body.appendChild(elsewhere);
      try {
        await mount(createElement(failing("공항 카드", st)));
        await settle();
        st.fail = false;
        const btn = byId("lazy-retry")!;
        elsewhere.focus();
        await click(btn);
        expect(byId("card")).not.toBeNull();
        expect(dom.document.activeElement).toBe(elsewhere);
      } finally { dom.document.body.removeChild(elsewhere); }
    });
    it("a retry that fails again puts focus on the new error's first button", async () => {
      const st = { fail: true };
      await mount(createElement(failing("SIGMET 카드", st)));
      await settle();
      const btn = byId("lazy-retry")!;
      btn.focus();
      await click(btn);
      await settle();
      expect(byId("lazy-error")).not.toBeNull();
      expect(dom.document.activeElement).toBe(byId("lazy-retry"));
    });
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
