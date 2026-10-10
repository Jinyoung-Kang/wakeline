/**
 * 공개 데모(AWS 배포 — ADR-039 · VERIFICATION #136): 앞단 Caddy 가 /ops · /logs · /api/v1/ops 를 404 JSON 으로 닫는다. 그런데 상단 메뉴의
 * [운영] · [로그]와 오류 문구의 '로그 보기'(/logs#rid=…)가 남아 누르면 404 JSON 화면이 됐다.
 * WAKELINE_PUBLIC_DEMO=1(compose.aws.yml 의 web)일 때만 그 메뉴 · 링크 · /logs 안내를 감추고, 그 밖(로컬 · 시험)은 지금과 같다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { ApiError } from "@/lib/api";

/** next/link 의 props 를 모은다(렌더마다 비운다) */
let links: { href: string; prefetch?: boolean | null }[] = [];
vi.mock("next/link", () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean | null; children?: ReactNode }) => {
    links.push({ href, prefetch });
    return createElement("a", { href, ...rest }, children);
  },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock("next/server", () => ({ connection: async () => {} }));

const NORMAL_NAV = ["/", "/replay", "/stats", "/ops", "/logs", "/about", "/guide"];
const DEMO_NAV = ["/", "/replay", "/stats", "/about", "/guide"];

/** 공급자로 감싸 정적 렌더 — demo 가 undefined 면 공급자 없이(로컬과 같은 기본값) */
async function render(el: ReactElement, demo?: boolean): Promise<string> {
  links = [];
  const { PublicDemoProvider } = await import("@/components/PublicDemo");
  return renderToStaticMarkup(demo === undefined ? el : createElement(PublicDemoProvider, { demo }, el));
}
/** 주 메뉴의 링크(첫 링크는 로고 WAKELINE → /) */
const navHrefs = () => links.slice(1).map((l) => l.href);

describe("WAKELINE_PUBLIC_DEMO is read only as exactly \"1\"", () => {
  it("isPublicDemo", async () => {
    const { isPublicDemo } = await import("@/lib/public-demo");
    expect(isPublicDemo({ WAKELINE_PUBLIC_DEMO: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", " 1", "1 "]) expect(isPublicDemo({ WAKELINE_PUBLIC_DEMO: v })).toBe(false);
    expect(isPublicDemo({})).toBe(false);
  });
});

describe("main menu", () => {
  it("public demo: 운영 (/ops) and 로그 (/logs) are not in the menu; the others keep their order and prefetch={false}", async () => {
    const { Shell } = await import("@/components/Shell");
    const html = await render(createElement(Shell, null, createElement("p", null, "x")), true);
    expect(navHrefs()).toEqual(DEMO_NAV);
    expect(links.filter((l) => l.prefetch !== false)).toEqual([]);
    expect(html).not.toMatch(/href="\/(ops|logs)/);
    expect(html).not.toMatch(/>운영<|>로그</);
  });

  it("not a public demo (no provider, or demo=false): the menu is unchanged", async () => {
    const { Shell } = await import("@/components/Shell");
    for (const demo of [undefined, false]) {
      const html = await render(createElement(Shell, null, createElement("p", null, "x")), demo);
      expect(navHrefs()).toEqual(NORMAL_NAV);
      expect(html).toMatch(/<a[^>]*href="\/logs"[^>]*>로그<\/a>/);
      expect(html).toMatch(/<a[^>]*href="\/ops"[^>]*>운영<\/a>/);
    }
  });

  it("the root layout passes WAKELINE_PUBLIC_DEMO (read at request time) down to the menu", async () => {
    const RootLayout = (await import("@/app/layout")).default;
    try {
      vi.stubEnv("WAKELINE_PUBLIC_DEMO", "1");
      await render(await RootLayout({ children: createElement("p", null, "x") }));
      expect(navHrefs()).toEqual(DEMO_NAV);
      vi.stubEnv("WAKELINE_PUBLIC_DEMO", "0");
      await render(await RootLayout({ children: createElement("p", null, "x") }));
      expect(navHrefs()).toEqual(NORMAL_NAV);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("request id in error text", () => {
  const err = new ApiError(503, "data store unavailable", null, "STORE_UNAVAILABLE", "5f2c9a0e1b7d4c3a");

  it("public demo: the id stays visible and copyable, without the '로그 보기' link or a /logs hint", async () => {
    const { ErrorNote, RequestIdCopy } = await import("@/components/logs/ErrorNote");
    for (const el of [createElement(ErrorNote, { error: err }), createElement(RequestIdCopy, { id: "5f2c9a0e1b7d4c3a" })]) {
      const html = await render(el, true);
      expect(html).toMatch(/<span[^>]*class="[^"]*mono[^"]*"[^>]*>5f2c9a0e1b7d4c3a<\/span>/);
      expect(html).toContain('aria-label="요청 id 5f2c9a0e1b7d4c3a 복사"');
      expect(html).not.toContain("로그 보기");
      expect(html).not.toContain("/logs");
      expect(links).toEqual([]);
    }
  });

  it("not a public demo: the '로그 보기' link to /logs#rid= is unchanged", async () => {
    const { ErrorNote } = await import("@/components/logs/ErrorNote");
    for (const demo of [undefined, false]) {
      const html = await render(createElement(ErrorNote, { error: err }), demo);
      expect(html).toContain('href="/logs#rid=5f2c9a0e1b7d4c3a"');
      expect(html).toContain("로그 보기");
    }
  });

  it("operator screens (/ops · /logs — reached only through the operator tunnel on the demo) keep the link", async () => {
    const { RequestIdCopy } = await import("@/components/logs/ErrorNote");
    for (const mod of ["@/app/ops/layout", "@/app/logs/layout"] as const) {
      const Layout = (await import(mod)).default as (p: { children: ReactNode }) => ReactElement;
      const html = await render(createElement(Layout, null, createElement(RequestIdCopy, { id: "abc123" })), true);
      expect(html).toContain('href="/logs#rid=abc123"');
    }
  });

  it("the '이 요청 id 로 거르기' button inside /logs is not affected", async () => {
    const { RequestIdCopy } = await import("@/components/logs/ErrorNote");
    const html = await render(createElement(RequestIdCopy, { id: "abc123", onFilter: () => {} }), true);
    expect(html).toContain("이 요청 id 로 거르기");
  });
});

describe("error boundary screen", () => {
  const dom = installMiniDom();
  type Root = import("react-dom/client").Root;
  let React: typeof import("react");
  let createRoot: typeof import("react-dom/client").createRoot;
  let root: Root | null = null;
  beforeAll(async () => {
    React = await import("react");
    ({ createRoot } = await import("react-dom/client"));
  });
  afterAll(() => dom.restore());
  afterEach(async () => {
    if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
    vi.unstubAllGlobals();
  });
  const find = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container): MiniElement | null => {
    if (pred(from)) return from;
    for (const c of from.childNodes) { const f = c instanceof MiniElement ? find(pred, c) : null; if (f) return f; }
    return null;
  };
  async function mountScreen(error: unknown, demo: boolean) {
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    const { PublicDemoProvider } = await import("@/components/PublicDemo");
    const ErrorPage = (await import("@/app/error")).default;
    root = createRoot(dom.container as never);
    await React.act(async () => { root!.render(createElement(PublicDemoProvider, { demo }, createElement(ErrorPage, { error: error as Error, retry: () => {} }))); });
    await React.act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    return find((e) => e.getAttribute?.("data-testid") === "error-screen")!;
  }

  it("public demo: no /logs path in the guidance, the report result or the request id row", async () => {
    // 스택은 비운다(시험 파일 경로가 글자 비교에 섞이지 않게)
    const screen = await mountScreen(Object.assign(new ApiError(500, "demo boundary failure", null, "INTERNAL", "rid-demo-1"), { stack: "" }), true);
    const text = screen.textContent;
    expect(text).toContain("rid-demo-1");
    expect(text).toContain("보냄 — 운영자 시스템 로그의 web-client 항목");
    expect(text).toContain("운영자는 시스템 로그에서 같은 내용을 봅니다");
    expect(text).not.toContain("/logs");
    expect(text).not.toContain("로그 보기");
  });

  it("not a public demo: the guidance and report result still name /logs", async () => {
    const screen = await mountScreen(Object.assign(new ApiError(500, "normal boundary failure", null, "INTERNAL", "rid-normal-1"), { stack: "" }), false);
    const text = screen.textContent;
    expect(text).toContain("운영자는 /logs 에서 같은 내용을 봅니다");
    expect(text).toContain("보냄 — 운영 화면 /logs 의 web-client 항목");
    expect(text).toContain("로그 보기");
  });
});
