/**
 * 운영 화면 · 시스템 로그 화면의 세션 확인(R-12 · 계약 v5 §C7): 두 화면은 같은 운영 세션을 같은 규칙으로 본다 — 확인 전에는 "…",
 * 세션이 있으면 대시보드, 없으면(401 · 404 — 익명 ops 호출은 404) 같은 자리에 로그인 폼, 로그인하면 대시보드.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter, propsOf } from "./helpers/mount";

const dom = installMiniDom();
// 변경 요청(로그인 POST)은 CSRF 쿠키 값을 헤더로 되돌려 보낸다(lib/api csrfToken) — 최소 DOM 에는 쿠키가 없어서 둔다
(dom.document as unknown as { cookie: string }).cookie = "WAKELINE_CSRF=t";
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Session = () => Promise<Response>;
const PAGES = [
  { name: "/ops", load: async () => (await import("@/app/ops/page")).default, dashboard: "ops-dashboard", title: "운영" },
  { name: "/logs", load: async () => (await import("@/app/logs/page")).default, dashboard: "logs-dashboard", title: "시스템 로그" },
] as const;

/** 세션 확인(GET) · 로그인(POST)은 정한 대로(로그인한 뒤의 확인은 200), 그 밖의 ops 조회는 빈 답 */
function stub(session: Session, login?: () => Promise<Response>) {
  const asked: string[] = [];
  let signedIn = false;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    asked.push(`${method} ${url}`);
    if (url === "/api/v1/ops/session" && method === "POST" && login) { const r = await login(); signedIn = r.ok; return r; }
    if (url === "/api/v1/ops/session") return signedIn ? json(200, { username: "op" }) : session();
    if (url.startsWith("/api/v1/ops/logs")) return json(200, { items: [], next_cursor: null, scanned: 0, scan_truncated: false });
    return json(404, { detail: "no such resource" });
  });
  return asked;
}
async function open(page: (typeof PAGES)[number]) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("location", { hash: "", pathname: page.name, origin: "http://localhost:8700" });
  const Page = await page.load();
  await m.render(m.React.createElement(Page));
}
const h1 = () => m.find((e) => e.tagName === "H1")?.textContent ?? "";

describe.each(PAGES)("$name session gate", (page) => {
  it("shows only '…' until the session check answers", async () => {
    stub(() => new Promise<Response>(() => {}));
    await open(page);
    expect(h1()).toBe(page.title);
    expect(m.byTestId(page.dashboard)).toBeNull();
    expect(m.byTestId("ops-login")).toBeNull();
    expect(dom.container.textContent).toBe(`${page.title}…`);
  });

  it("a session opens the dashboard", async () => {
    stub(async () => json(200, { username: "op" }));
    await open(page);
    await m.settle();
    expect(m.byTestId(page.dashboard)).not.toBeNull();
    expect(h1()).toBe(page.title);
  });

  it.each([401, 404])("HTTP %i on the session check shows the login form in the same place, and no ops data is asked", async (status) => {
    const asked = stub(async () => json(status, { detail: "not found" }));
    await open(page);
    await m.settle();
    expect(m.byTestId("ops-login")).not.toBeNull();
    expect(h1()).toBe(`${page.title} — 로그인`);
    expect(asked.filter((a) => a !== "GET /api/v1/ops/session")).toEqual([]);
  });

  it("signing in opens the dashboard", async () => {
    stub(async () => json(404, { detail: "not found" }), async () => json(200, { username: "op" }));
    await open(page);
    await m.settle();
    const field = (id: string) => m.find((e) => e.getAttribute("id") === id)!;
    await m.act(() => propsOf(field("ops-user")).onChange({ target: { value: "op" } }));
    await m.act(() => propsOf(field("ops-pass")).onChange({ target: { value: "correct horse" } }));
    await m.act(() => propsOf(m.byTestId("ops-login")!).onSubmit({ preventDefault() {} }));
    await m.settle();
    expect(m.byTestId(page.dashboard)).not.toBeNull();
  });
});

/**
 * 세션 확인이 401 · 404 가 아닌 까닭(500 · 망)으로 실패하면 '로그인 안 됨'이 아니라 '확인하지 못함'이다(web-review B15 · PLAN W15) —
 * 로그인한 운영자에게 로그인 폼을 보이지 않고, 까닭(요청 id)과 '다시 시도'를 보인다. 화면을 떠나면 확인 요청을 끊는다.
 */
describe.each(PAGES)("$name session check that fails for another reason", (page) => {
  const problem = (status: number) => new Response(JSON.stringify({ detail: "session store unavailable", request_id: "5e55e55e5e55e55e" }), { status, headers: { "Content-Type": "application/problem+json" } });

  it("HTTP 500 shows the reason with '다시 시도', not the login form; retrying with a session opens the dashboard", async () => {
    let answer: Session = async () => problem(500);
    stub(() => answer());
    await open(page);
    await m.settle();
    expect(m.byTestId("ops-login")).toBeNull();
    const alert = m.byTestId("ops-session-error")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("세션을 확인하지 못했습니다");
    expect(alert.textContent).toContain("session store unavailable");
    expect(alert.textContent).toContain("5e55e55e5e55e55e");
    expect(h1()).toBe(`${page.title} — 세션 확인 실패`);
    answer = async () => json(200, { username: "op" });
    await m.click(m.button("다시 시도"));
    await m.settle();
    expect(m.byTestId("ops-session-error")).toBeNull();
    expect(m.byTestId(page.dashboard)).not.toBeNull();
  });

  it("a network failure is the same error; a retry that answers 404 shows the login form", async () => {
    let answer: Session = async () => { throw new TypeError("Failed to fetch"); };
    stub(() => answer());
    await open(page);
    await m.settle();
    expect(m.byTestId("ops-login")).toBeNull();
    expect(m.byTestId("ops-session-error")!.textContent).toContain("Failed to fetch");
    answer = async () => json(404, { detail: "not found" });
    await m.click(m.button("다시 시도"));
    await m.settle();
    expect(m.byTestId("ops-login")).not.toBeNull();
  });

  it("leaving the page while the check is on the way aborts it", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => { signals.push(init?.signal); return new Promise<Response>(() => {}); });
    await open(page);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    await m.unmount();
    expect(signals[0]?.aborted).toBe(true);
  });
});
