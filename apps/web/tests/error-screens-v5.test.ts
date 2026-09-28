/**
 * 계약 v5 §C8 화면: 오류 문구의 요청 id(복사 · /logs 로 이어짐), app/error.tsx · app/global-error.tsx(읽기 쉬운 오류 화면 + 복사 + 다시 시도 + 보고),
 * 상단 메뉴 "로그"(§C7)와 전역 오류 수집 설치(Shell). 실제 react-dom 으로 마운트(최소 DOM) 또는 renderToStaticMarkup.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";
import { ApiError } from "@/lib/api";

const dom = installMiniDom();
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
});
afterAll(() => dom.restore());
let root: Root | null = null;
afterEach(async () => {
  if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
  vi.unstubAllGlobals();
});
/** next/link 의 가시성 효과가 self.requestIdleCallback 을 찾는다(브라우저 전역) — 최소 DOM 에서는 전역 객체로 */
const withSelf = () => vi.stubGlobal("self", globalThis);

const find = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container): MiniElement | null => {
  if (pred(from)) return from;
  for (const c of from.childNodes) { const f = c instanceof MiniElement ? find(pred, c) : null; if (f) return f; }
  return null;
};
const byTestId = (id: string) => find((e) => e.getAttribute?.("data-testid") === id);
/** React 가 host 요소에 붙여 둔 props(이벤트 처리기) — 최소 DOM 에는 이벤트 전파가 없으므로 처리기를 직접 부른다 */
const propsOf = (e: MiniElement): Record<string, (...a: unknown[]) => unknown> => {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  return (e as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[k!];
};
const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 20)); });
async function mount(el: React.ReactElement) {
  withSelf();
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(el); });
  await settle();
}

describe("v5-C8 request id in error text is visible and copyable", () => {
  it("ErrorNote shows message, HTTP status, code and the request id with a copy button and a link to /logs", async () => {
    const { ErrorNote } = await import("@/components/logs/ErrorNote");
    const html = renderToStaticMarkup(createElement(ErrorNote, { error: new ApiError(503, "data store unavailable", null, "STORE_UNAVAILABLE", "5f2c9a0e1b7d4c3a") }));
    expect(html).toContain("data store unavailable");
    expect(html).toContain("HTTP 503");
    expect(html).toContain("STORE_UNAVAILABLE");
    expect(html).toMatch(/<span[^>]*class="[^"]*mono[^"]*"[^>]*>5f2c9a0e1b7d4c3a<\/span>/);
    expect(html).toContain('aria-label="요청 id 5f2c9a0e1b7d4c3a 복사"');
    expect(html).toContain('href="/logs#rid=5f2c9a0e1b7d4c3a"');
    // 요청 id 가 없으면 복사 단추도 없다(지어내지 않는다) · 일반 오류는 메시지만
    const noRid = renderToStaticMarkup(createElement(ErrorNote, { error: new ApiError(500, "boom") }));
    expect(noRid).toContain("HTTP 500");
    expect(noRid).not.toContain("요청 id");
    expect(renderToStaticMarkup(createElement(ErrorNote, { error: new TypeError("Failed to fetch") }))).toContain("Failed to fetch");
  });
  it("the copy button copies the id and says so", async () => {
    const { RequestIdCopy } = await import("@/components/logs/ErrorNote");
    const written: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => { written.push(t); } } });
    await mount(createElement(RequestIdCopy, { id: "req-0001-abcd" }));
    const btn = find((e) => e.tagName === "BUTTON")!;
    await React.act(async () => { await propsOf(btn).onClick({}); });
    expect(written).toEqual(["req-0001-abcd"]);
    expect(btn.textContent).toBe("복사됨");
  });
});

describe("v5-C8 error boundaries: readable screen, copy, retry, report", () => {
  it("app/error.tsx shows the error name, message, digest and stack with retry / copy, reports once to /api/v1/client-errors", async () => {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { posts.push({ url, body: JSON.parse(String(init.body)) }); return new Response(null, { status: 204 }); });
    const written: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => { written.push(t); } } });
    const ErrorPage = (await import("@/app/error")).default;
    const err = Object.assign(new TypeError("Cannot read properties of undefined (reading 'lat')"), { digest: "2718281828" });
    let retried = 0;
    await mount(createElement(ErrorPage, { error: err, retry: () => { retried++; } }));
    const screen = byTestId("error-screen")!;
    expect(screen.textContent).toContain("TypeError");
    expect(screen.textContent).toContain("Cannot read properties of undefined (reading 'lat')");
    expect(screen.textContent).toContain("2718281828");
    expect(byTestId("error-stack")!.textContent).toContain("TypeError");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("/api/v1/client-errors");
    expect(posts[0].body).toMatchObject({ message: "TypeError: Cannot read properties of undefined (reading 'lat')", component: "app/error.tsx · digest 2718281828" });
    expect(byTestId("error-report")!.textContent).toContain("보냄");
    await React.act(async () => { await propsOf(byTestId("error-copy")!).onClick({}); });
    expect(written[0].split("\n")[0]).toMatch(/^\[\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z ERROR web-client\/app\/error\.tsx\] rid=—$/);
    expect(written[0]).toContain("TypeError: Cannot read properties of undefined (reading 'lat')");
    expect(written[0]).toContain("digest=2718281828");
    await React.act(async () => { propsOf(byTestId("error-retry")!).onClick({}); });
    expect(retried).toBe(1);
  });
  it("an ApiError thrown into the boundary shows its request id (copyable) and the copy text carries it", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    const written: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => { written.push(t); } } });
    const ErrorPage = (await import("@/app/error")).default;
    await mount(createElement(ErrorPage, { error: new ApiError(500, "internal error", null, "INTERNAL", "rid-2222-3333"), retry: () => {} }));
    expect(byTestId("error-screen")!.textContent).toContain("rid-2222-3333");
    await React.act(async () => { await propsOf(byTestId("error-copy")!).onClick({}); });
    expect(written[0].split("\n")[0]).toMatch(/ rid=rid-2222-3333$/);
    expect(written[0]).toContain("HTTP 500 · INTERNAL");
  });
  it("app/global-error.tsx renders its own html/body (lang ko) with the same screen", async () => {
    const GlobalError = (await import("@/app/global-error")).default;
    const html = renderToStaticMarkup(createElement(GlobalError, { error: new Error("root layout failed"), retry: () => {} }));
    expect(html).toMatch(/^<html lang="ko"/);
    expect(html).toContain("<body");
    expect(html).toContain('data-testid="error-screen"');
    expect(html).toContain("root layout failed");
    expect(html).toContain("<title>");
  });
});

describe("v5-C7/C8 shell: top menu '로그' and the global error listeners", () => {
  it("the top menu has 로그 → /logs", async () => {
    const { Shell } = await import("@/components/Shell");
    const html = renderToStaticMarkup(createElement(Shell, null, createElement("p", null, "x")));
    expect(html).toMatch(/<a[^>]*href="\/logs"[^>]*>로그<\/a>/);
  });
  it("mounting the shell installs error and unhandledrejection listeners on window; unmounting removes them", async () => {
    const added: string[] = [], removed: string[] = [];
    vi.stubGlobal("addEventListener", (t: string) => { added.push(t); });
    vi.stubGlobal("removeEventListener", (t: string) => { removed.push(t); });
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    const { Shell } = await import("@/components/Shell");
    await mount(createElement(Shell, null, createElement("p", null, "x")));
    expect(added).toEqual(expect.arrayContaining(["error", "unhandledrejection"]));
    const r = root!; root = null;
    await React.act(async () => { r.unmount(); });
    expect(removed).toEqual(expect.arrayContaining(["error", "unhandledrejection"]));
  });
});
