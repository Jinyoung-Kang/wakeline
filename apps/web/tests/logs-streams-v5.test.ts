/**
 * 계약 v5 §G2(/logs 화면 쪽): api 가 서버 로그(wakeline:logs)와 브라우저 오류(wakeline:logs:client)를 합쳐 보인다 — 항목마다 stream,
 * 두 스트림은 id 를 따로 매기므로 같은 id 가 둘 다에 있을 수 있다(같은 id 는 server 가 앞). 화면은 항목을 stream + id 로 가르고,
 * cursor("client:<id>")를 그대로 돌려주고, 항목 하나는 stream 과 함께 연다.
 * §G5: 예외 종류가 빈 글(브라우저는 종류를 보내지 않는다)이면 화면 · 복사 텍스트 모두 "—".
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as L from "@/lib/logs";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";

const entry = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "1790000000000-0", v: 1, ts: "2026-09-29T01:02:03.456Z", service: "api", instance: "api-7f9c:1", level: "ERROR",
  logger: "dev.wakeline.ingest.StreamConsumer", thread: "stream-consumer-1", message: "apply failed",
  exception: { type: "java.lang.IllegalStateException", message: "boom", stack: "java.lang.IllegalStateException: boom" },
  fp: "0123456789abcdef", request_id: "5f2c9a0e1b7d4c3a", context: {}, suppressed: 0, ...o,
});
const browser = (o: Record<string, unknown> = {}) => entry({
  stream: "client", service: "web-client", logger: "browser", untrusted: true, request_id: null, fp: "fedcba9876543210",
  message: "TypeError: x is undefined", exception: { type: "", message: null, stack: "at f (app.js:1:2)" }, ...o,
});

describe("v5-G2 lib/logs: entries are told apart by stream + id", () => {
  it("stream is read as given (server | client); anything else is unknown (null)", () => {
    const p = L.parseLogPage({ items: [entry({ stream: "server" }), browser(), entry({ id: "1790000000001-0", stream: "edge" }), entry({ id: "1790000000002-0" })] });
    expect(p.items.map((e) => e.stream)).toEqual(["server", "client", null, null]);
    expect(p.items.map(L.entryKey)).toEqual(["server:1790000000000-0", "client:1790000000000-0", "server:1790000000001-0", "server:1790000000002-0"]);
  });
  it("the same id in both streams is two entries: appending a page and applying new entries keep both", () => {
    const a = L.parseLogPage({ items: [entry({ stream: "server" })], next_cursor: "server:1790000000000-0" });
    const b = L.parseLogPage({ items: [browser(), entry({ id: "1789999999999-0", stream: "server" })], next_cursor: null });
    expect(L.appendLogPage(a, b).items.map(L.entryKey)).toEqual(["server:1790000000000-0", "client:1790000000000-0", "server:1789999999999-0"]);
    expect(L.applyPending(b.items, a.items).map(L.entryKey)).toEqual(["server:1790000000000-0", "client:1790000000000-0", "server:1789999999999-0"]);
    expect(L.applyPending(a.items, a.items).map(L.entryKey)).toEqual(["server:1790000000000-0"]);
  });
  it("new entries follow the api order (id, then server before client): a client twin of the top row is older, a server twin of a client top row is newer", () => {
    const P = (items: unknown[]) => L.parseLogPage({ items }).items;
    const serverTop = P([entry({ stream: "server" })]);
    expect(L.pendingEntries(serverTop, P([entry({ stream: "server" }), browser()]), 100).items).toEqual([]);
    const clientTop = P([browser()]);
    expect(L.pendingEntries(clientTop, P([entry({ stream: "server" }), browser()]), 100).items.map(L.entryKey)).toEqual(["server:1790000000000-0"]);
    expect(L.entryCmp(P([entry({ stream: "server" })])[0], P([browser()])[0])).toBeGreaterThan(0);
    expect(L.entryCmp(P([entry({ id: "1790000000001-0", stream: "client" })])[0], P([entry({ stream: "server" })])[0])).toBeGreaterThan(0);
  });
  it("the cursor names the stream (\"client:<id>\") and goes back as given; a bare id (older api) still works", () => {
    expect(L.parseLogPage({ items: [], next_cursor: "client:1789999999999-3" }).nextCursor).toBe("client:1789999999999-3");
    expect(L.parseLogPage({ items: [], next_cursor: "server:1789999999999-3" }).nextCursor).toBe("server:1789999999999-3");
    expect(L.parseLogPage({ items: [], next_cursor: "1789999999999-3" }).nextCursor).toBe("1789999999999-3");
    for (const bad of ["edge:1-0", "client:", "client:1-0:x", "<x>"]) expect(L.parseLogPage({ items: [], next_cursor: bad }).nextCursor).toBeNull();
    const u = new URL(L.logsUrl(L.DEFAULT_LOG_FILTER, Date.parse("2026-09-29T02:00:00Z"), { cursor: "client:1789999999999-3" }), "http://x");
    expect(u.searchParams.get("cursor")).toBe("client:1789999999999-3");
  });
  it("one entry is opened with its stream (the api looks in server then client when none is given); links carry it too", () => {
    expect(L.logItemUrl("1790000000000-0", "client")).toBe("/api/v1/ops/logs/1790000000000-0?stream=client");
    expect(L.logItemUrl("1790000000000-0", "server")).toBe("/api/v1/ops/logs/1790000000000-0?stream=server");
    expect(L.logItemUrl("1790000000000-0")).toBe("/api/v1/ops/logs/1790000000000-0");
    expect(L.parseLogsHash("#id=1790000000000-0&stream=client")).toEqual({ id: "1790000000000-0", stream: "client" });
    expect(L.parseLogsHash("#id=1790000000000-0&stream=edge")).toEqual({ id: "1790000000000-0" });
    expect(L.logLinkHash(L.parseLogPage({ items: [browser()] }).items[0])).toBe("#id=1790000000000-0&stream=client");
    expect(L.logLinkHash(L.parseLogPage({ items: [entry()] }).items[0])).toBe("#id=1790000000000-0");
  });
  it("entry text names the stream when the api gave it (after the id)", () => {
    const t = L.logText(L.parseLogPage({ items: [browser()] }).items[0]).split("\n");
    expect(t.at(-1)).toContain("id=1790000000000-0 · stream=client(wakeline:logs:client) · fp=fedcba9876543210");
    expect(L.logText(L.parseLogPage({ items: [entry()] }).items[0])).not.toContain("stream=");
  });
});

describe("v5-G5 lib/logs: an empty exception type is shown as —", () => {
  it("entry text: '예외 —' (browser errors carry no type), never an empty name", () => {
    const t = L.logText(L.parseLogPage({ items: [browser()] }).items[0]).split("\n");
    expect(t).toContain("예외 —");
    expect(t).toContain("at f (app.js:1:2)");
    const withMsg = L.logText(L.parseLogPage({ items: [browser({ exception: { type: " ", message: "boom", stack: "" } })] }).items[0]);
    expect(withMsg.split("\n")).toContain("예외 —: boom");
    expect(L.exceptionTypeText("")).toBe("—");
    expect(L.exceptionTypeText(null)).toBe("—");
    expect(L.exceptionTypeText("java.io.IOException")).toBe("java.io.IOException");
  });
  it("group text: '예외 종류 —' for an empty type as for an unknown one", () => {
    const g = L.parseLogGroups({ groups: [{ fp: "fedcba9876543210", service: "web-client", level: "ERROR", logger: "browser", exception_type: "", sample_message: "TypeError", count: 2, suppressed: 0, first_at: "2026-09-29T00:00:00Z", last_at: "2026-09-29T01:00:00Z", last_id: "1790000000000-0" }] }).groups[0];
    expect(L.groupText(g, [], { truncated: false })).toContain("예외 종류 —\n");
  });
});

// ---- 화면(실제 react-dom 마운트 — logs-page-v5.test.ts 와 같은 최소 DOM) ----

const dom = installMiniDom();
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let LogsPage: typeof import("@/app/logs/page").default;

beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  LogsPage = (await import("@/app/logs/page")).default;
});
afterAll(() => dom.restore());
let root: Root | null = null;
afterEach(async () => {
  if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const NOW = Date.parse("2026-09-29T02:00:00Z");
const calls: string[] = [];
function stubFetch(handler: (url: string) => { status: number; body: unknown } | undefined) {
  calls.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url === "/api/v1/ops/session") return json(200, { username: "op" });
    const r = handler(url);
    return r ? json(r.status, r.body) : json(404, { detail: "no such resource" });
  });
}
const settle = () => React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const find = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container): MiniElement | null => {
  if (pred(from)) return from;
  for (const c of from.childNodes) { const f = c instanceof MiniElement ? find(pred, c) : null; if (f) return f; }
  return null;
};
const findAll = (pred: (e: MiniElement) => boolean, from: MiniElement = dom.container, out: MiniElement[] = []): MiniElement[] => {
  if (pred(from)) out.push(from);
  for (const c of from.childNodes) if (c instanceof MiniElement) findAll(pred, c, out);
  return out;
};
const byTestId = (id: string, from?: MiniElement) => find((e) => e.getAttribute?.("data-testid") === id, from);
const allByTestId = (id: string) => findAll((e) => e.getAttribute?.("data-testid") === id);
const button = (text: string, from?: MiniElement) => find((e) => e.tagName === "BUTTON" && e.textContent.trim() === text, from);
const propsOf = (e: MiniElement): Record<string, (...a: unknown[]) => unknown> => {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  return (e as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[k!];
};
const click = async (e: MiniElement | null) => { expect(e).not.toBeNull(); await React.act(async () => { await propsOf(e!).onClick?.({ preventDefault() {}, stopPropagation() {} }); }); await settle(); };
const key = async (e: MiniElement, k: string) => { await React.act(async () => { await propsOf(e).onKeyDown({ key: k, preventDefault() {}, altKey: false, ctrlKey: false, metaKey: false, target: e, currentTarget: e }); }); await settle(); };
async function open(hash = "") {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("location", { hash, pathname: "/logs", origin: "http://localhost:8700" });
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(React.createElement(LogsPage)); });
  await settle();
  await settle();
}

const TWINS = { items: [entry({ stream: "server" }), browser()], next_cursor: "client:1790000000000-0", scanned: 4000, scan_truncated: true };

describe("v5-G2 /logs: rows from both streams", () => {
  it("the same id in both streams gives two rows (stream shown), each opens its own detail; '이전 항목 더 보기' sends the stream cursor back", async () => {
    const written: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => { written.push(t); } } });
    stubFetch((url) => (url.includes("cursor=") ? { status: 200, body: { items: [], next_cursor: null } } : url.startsWith("/api/v1/ops/logs?") ? { status: 200, body: TWINS } : undefined));
    await open();
    const rows = allByTestId("log-row");
    expect(rows.map((r) => [r.getAttribute("data-id"), r.getAttribute("data-stream")])).toEqual([["1790000000000-0", "server"], ["1790000000000-0", "client"]]);
    expect(new Set(rows.map((r) => r.getAttribute("id"))).size).toBe(2); // 표(grid)의 활성 줄 id 가 겹치지 않는다
    expect(byTestId("logs-status")!.textContent).toContain("스캔 상한(4,000건 — 두 스트림 합)에서 잘림");
    const badge = (r: MiniElement) => findAll((e) => e.tagName === "SPAN" && (e.getAttribute("class") ?? "").includes("badge"), r).map((b) => b.textContent);
    expect(badge(rows[0])).toEqual(["ERROR"]);
    expect(badge(rows[1])).toEqual(["ERROR", "untrusted", "client"]); // 브라우저 오류 스트림의 항목
    // ↓ 두 번: 둘째 줄(client)로 — 같은 id 라도 따로 고른다
    const grid = byTestId("log-grid")!;
    await key(grid, "ArrowDown");
    await key(grid, "ArrowDown");
    expect(rows.map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    await key(grid, "Enter");
    const d = byTestId("log-detail")!;
    expect(d.textContent).toContain("TypeError: x is undefined");
    expect(d.textContent).toContain("wakeline:logs:client");
    await click(button("링크 복사", d));
    expect(written.at(-1)).toBe("http://localhost:8700/logs#id=1790000000000-0&stream=client");
    await click(button("이전 항목 더 보기"));
    expect(calls.at(-1)).toContain(`cursor=${encodeURIComponent("client:1790000000000-0")}`);
    // 수집 안내: 두 스트림과 보관 수, 요청당 훑기 상한
    const text = dom.container.textContent;
    expect(text).toContain("wakeline:logs 는 최근 약 3,000건");
    expect(text).toContain("wakeline:logs:client 는 최근 약 1,000건");
  });
  it("a #id=…&stream=client link opens that entry from the browser error stream", async () => {
    stubFetch((url) => {
      if (url.startsWith("/api/v1/ops/logs/1790000000000-0")) return { status: 200, body: browser() };
      if (url.startsWith("/api/v1/ops/logs?")) return { status: 200, body: { items: [] } };
      return undefined;
    });
    await open("#id=1790000000000-0&stream=client");
    expect(calls).toContain("GET /api/v1/ops/logs/1790000000000-0?stream=client");
    expect(byTestId("log-detail")!.textContent).toContain("TypeError: x is undefined");
  });
});

describe("v5-G5 /logs: an empty exception type is —", () => {
  it("detail and groups table show — for a browser error's empty exception type", async () => {
    stubFetch((url) => {
      if (url.startsWith("/api/v1/ops/logs/groups?")) return { status: 200, body: { groups: [{ fp: "fedcba9876543210", service: "web-client", level: "ERROR", logger: "browser", exception_type: "", sample_message: "TypeError", count: 2, suppressed: 0, first_at: "2026-09-29T00:00:00Z", last_at: "2026-09-29T01:00:00Z", last_id: "1790000000000-0" }], scanned: 2, scan_truncated: false } };
      if (url.startsWith("/api/v1/ops/logs?")) return { status: 200, body: { items: [browser()] } };
      return undefined;
    });
    await open();
    await click(allByTestId("log-row")[0]);
    const ex = byTestId("log-exception")!;
    expect(ex.textContent).toBe("—");
    await click(button("묶음(fp)"));
    const g = allByTestId("log-group")[0];
    expect(findAll((e) => e.tagName === "TD", g)[3].textContent).toBe("browser—");
  });
});
