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
    // 단추 이름(aria-label)은 고정이라 결과는 따로 알린다(화면 읽기 프로그램 — role=status)
    expect(find((e) => e.getAttribute?.("role") === "status")?.textContent).toBe("요청 id req-0001-abcd 복사됨");
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

describe("v5-C8 screens show the request id of a failed call", () => {
  const OK: Record<string, unknown> = {
    "/api/v1/ops/session": { username: "op" },
    "/api/v1/ops/runs?limit=50": { items: [], summary_24h: [] },
    "/api/v1/ops/quality": { rule_counts: [], recent: [] },
    "/api/v1/ops/settings": { items: [] },
    "/api/v1/ops/audit": { items: [] },
    "/api/v1/ops/dlq": { items: [] },
    "/api/v1/ops/pipeline": { collector: {}, api: {} },
  };
  it("ops: the failing tab's error names the tab, keeps the server detail and shows the request id with a copy button", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url === "/api/v1/ops/providers") return json(500, { detail: "provider status unavailable", code: "INTERNAL", request_id: "a1b2c3d4e5f60718" });
      return url in OK ? json(200, OK[url]) : json(404, { detail: "no such resource" });
    });
    const OpsPage = (await import("@/app/ops/page")).default;
    await mount(createElement(OpsPage));
    await settle();
    const alert = find((e) => e.getAttribute?.("role") === "alert")!;
    expect(alert.textContent).toContain("providers");
    expect(alert.textContent).toContain("provider status unavailable");
    expect(alert.textContent).toContain("a1b2c3d4e5f60718");
    expect(find((e) => e.getAttribute?.("aria-label") === "요청 id a1b2c3d4e5f60718 복사", alert)).not.toBeNull();
  });
  const problemFetch = (status: number, body: Record<string, unknown>) => async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/problem+json" } });
  const copyButtonFor = (rid: string, from: MiniElement) => find((e) => e.getAttribute?.("aria-label") === `요청 id ${rid} 복사`, from);
  it("ops login: a failed sign-in keeps the Korean explanation and adds the request id with a copy button", async () => {
    vi.stubGlobal("fetch", problemFetch(401, { detail: "bad credentials", code: "BAD_CREDENTIALS", request_id: "0badc0de0badc0de" }));
    (dom.document as unknown as { cookie: string }).cookie = "";
    (MiniElement.prototype as unknown as { focus: () => void }).focus = () => {};
    const { OpsLogin } = await import("@/components/OpsLogin");
    await mount(createElement(OpsLogin, { onLogin: () => {}, notice: null }));
    const [user, pass] = [0, 1].map((i) => { const all: MiniElement[] = []; const walk = (n: MiniElement) => { if (n.tagName === "INPUT") all.push(n); n.childNodes.forEach((c) => c instanceof MiniElement && walk(c)); }; walk(dom.container); return all[i]; });
    await React.act(async () => { propsOf(user).onChange({ target: { value: "op" } }); propsOf(pass).onChange({ target: { value: "password123" } }); });
    await React.act(async () => { await propsOf(byTestId("ops-login")!).onSubmit({ preventDefault() {} }); });
    await settle();
    const err = byTestId("ops-login-error")!;
    expect(err.textContent).toContain("아이디 또는 비밀번호가 올바르지 않습니다");
    expect(err.textContent).toContain("0badc0de0badc0de");
    expect(copyButtonFor("0badc0de0badc0de", err)).not.toBeNull();
    delete (MiniElement.prototype as unknown as { focus?: () => void }).focus;
  });
  it("ops settings: a failed save keeps '저장 실패(HTTP 500)' and adds the request id with a copy button", async () => {
    (dom.document as unknown as { cookie: string }).cookie = "WAKELINE_CSRF=t0k";
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (init?.method === "PUT") return json(500, { detail: "internal error", code: "INTERNAL", request_id: "5e7715e75e7715e7" });
      if (url === "/api/v1/ops/providers") return json(200, { providers: [], active: {}, collector: {}, switches: [], budget_days: [] });
      if (url === "/api/v1/ops/settings") return json(200, { items: [{ key: "region_poll_s", value: 10, version: 3 }] });
      return url in OK ? json(200, OK[url]) : json(404, { detail: "no such resource" });
    });
    const OpsPage = (await import("@/app/ops/page")).default;
    await mount(createElement(OpsPage));
    await settle();
    await React.act(async () => { propsOf(byTestId("ops-tab-settings")!).onClick({}); });
    const input = find((e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === "region_poll_s 값")!;
    await React.act(async () => { propsOf(input).onChange({ target: { value: "12" } }); });
    const save = find((e) => e.tagName === "BUTTON" && e.textContent === "save")!;
    await React.act(async () => { await propsOf(save).onClick({}); });
    await settle();
    const e = byTestId("settings-error")!;
    expect(e.textContent).toContain("region_poll_s: 저장 실패(HTTP 500)");
    expect(e.textContent).toContain("5e7715e75e7715e7");
    expect(copyButtonFor("5e7715e75e7715e7", e)).not.toBeNull();
  });
  it("airport history page: the Korean explanation stays and the request id is added with a copy button", async () => {
    vi.stubGlobal("fetch", problemFetch(503, { detail: "wx unavailable", code: "STORE_UNAVAILABLE", request_id: "a1a1a1a1b2b2b2b2" }));
    const AirportPage = (await import("@/app/airports/[icao]/page")).default;
    await mount(createElement(AirportPage, { params: Promise.resolve({ icao: "rksi" }) }));
    await settle();
    const alert = find((e) => e.getAttribute?.("role") === "alert")!;
    expect(alert.textContent).toContain("기상 이력을 불러오지 못했습니다(HTTP 503)");
    expect(alert.textContent).toContain("a1a1a1a1b2b2b2b2");
    expect(copyButtonFor("a1a1a1a1b2b2b2b2", alert)).not.toBeNull();
  });
  it("aircraft card: the REST detail failure shows the request id next to the server detail", async () => {
    vi.stubGlobal("fetch", problemFetch(503, { detail: "aircraft store unavailable", request_id: "ac1dac1dac1dac1d" }));
    const { AircraftCard } = await import("@/components/AircraftCard");
    await mount(createElement(AircraftCard, { hex: "abc123" }));
    await settle();
    const e = byTestId("aircraft-detail-error")!;
    expect(e.textContent).toContain("aircraft store unavailable");
    expect(e.textContent).toContain("ac1dac1dac1dac1d");
    expect(copyButtonFor("ac1dac1dac1dac1d", e)).not.toBeNull();
  });
  it("replay: a failed request keeps its request id for the copy button (null when unknown or after a load)", async () => {
    const { replayReduce } = await import("@/lib/replay");
    const failed = replayReduce({ frame: null, err: null, latencyMs: null }, { type: "failed", error: new ApiError(500, "internal error", null, "INTERNAL", "0123abcd0123abcd") });
    expect(failed.err).toContain("HTTP 500");
    expect(failed.rid).toBe("0123abcd0123abcd");
    expect(replayReduce(failed, { type: "failed", error: new TypeError("Failed to fetch") }).rid).toBeNull();
    expect(replayReduce(failed, { type: "loaded", frame: { at: "2026-09-29T00:00:00Z", aircraft: [], sigmets: [], source: "track_point" }, latencyMs: 5 }).rid).toBeNull();
  });
  it("stats and airport card render the error through ErrorNote (request id visible)", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ detail: "stats unavailable", code: "STORE_UNAVAILABLE", request_id: "feedface0000beef" }), { status: 503, headers: { "Content-Type": "application/problem+json" } }));
    const StatsPage = (await import("@/app/stats/page")).default;
    await mount(createElement(StatsPage));
    await settle();
    expect(byTestId("error-note")?.textContent).toContain("feedface0000beef");
    const r = root!; root = null;
    await React.act(async () => { r.unmount(); });
    const { AirportCard } = await import("@/components/AirportCard");
    await mount(createElement(AirportCard, { icao: "RKSI" }));
    await settle();
    expect(byTestId("error-note")?.textContent).toContain("feedface0000beef");
  });
});
