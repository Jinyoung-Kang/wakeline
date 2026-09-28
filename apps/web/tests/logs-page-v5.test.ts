/**
 * 계약 v5 §C7 /logs 화면(실제 react-dom 으로 마운트 — 최소 DOM + fetch 대역). 운영 세션 없으면 같은 자리에 로그인 폼,
 * 목록 · 자동 새로 고침(새 항목은 단추로만) · 키보드 · 상세 · 복사 · 내려받기 · 묶음 · AIS 수신 공백 탭.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";

const dom = installMiniDom();
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let LogsPage: typeof import("@/app/logs/page").default;
let L: typeof import("@/lib/logs");

beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  LogsPage = (await import("@/app/logs/page")).default;
  L = await import("@/lib/logs");
});
afterAll(() => dom.restore());
let root: Root | null = null;
afterEach(async () => {
  if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const NOW = Date.parse("2026-09-29T02:00:00Z");
const entry = (id: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, v: 1, ts: new Date(Number(id.split("-")[0])).toISOString(), service: "api", instance: "api-7f9c:1", level: "ERROR",
  logger: "dev.wakeline.ingest.StreamConsumer", thread: "stream-consumer-1", message: `failure ${id}\nsecond line`,
  exception: { type: "java.lang.IllegalStateException", message: "boom", stack: "java.lang.IllegalStateException: boom\n\tat dev.wakeline.X.y(X.java:10)" },
  fp: "0123456789abcdef", request_id: "5f2c9a0e1b7d4c3a", context: { job: "ship-apply" }, suppressed: 3, ...o,
});
const T = (min: number) => `${NOW - min * 60_000}-0`;

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown } | undefined;
const calls: string[] = [];
function stubFetch(handler: Handler, session = true) {
  calls.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url === "/api/v1/ops/session") return session ? json(200, { username: "op" }) : json(404, { detail: "not found" });
    const r = handler(url, init);
    return r ? json(r.status, r.body) : json(404, { detail: "no such resource", request_id: "feedface0000beef" });
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
const key = async (e: MiniElement, k: string) => { await React.act(async () => { await propsOf(e).onKeyDown({ key: k, preventDefault() {}, altKey: false, ctrlKey: false, metaKey: false, target: e }); }); await settle(); };
async function open(hash = "") {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("location", { hash, pathname: "/logs", origin: "http://localhost:8700" });
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(React.createElement(LogsPage)); });
  await settle();
  await settle();
}

const FIRST = { items: [entry(T(1)), entry(T(2), { level: "WARN", exception: null, request_id: null, suppressed: undefined, message: "slow response 1.2 s" })], next_cursor: T(2), scanned: 812, scan_truncated: false };

describe("v5-C7 /logs: session gate", () => {
  it("without an operator session the same place shows the login form, and no log request is made", async () => {
    stubFetch(() => undefined, false);
    await open();
    expect(byTestId("ops-login")).not.toBeNull();
    expect(calls.filter((c) => c.includes("/ops/logs"))).toEqual([]);
    expect(find((e) => e.tagName === "H1")!.textContent).toContain("로그인");
  });
  it("a session that expires during use goes back to the login form with the notice", async () => {
    stubFetch((url) => (url.startsWith("/api/v1/ops/logs?") ? { status: 200, body: FIRST } : undefined));
    await open();
    expect(allByTestId("log-row")).toHaveLength(2);
    // 세션이 사라짐: 로그 조회도 세션 확인도 404(익명 ops 호출과 같은 응답)
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ detail: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } }));
    await React.act(async () => { vi.advanceTimersByTime(15_000); });
    await settle();
    expect(byTestId("ops-login")).not.toBeNull();
    expect(byTestId("ops-login-notice")!.textContent).toContain("세션이 만료");
  });
});

describe("v5-C7 /logs: list, auto refresh, keyboard, detail, copy", () => {
  it("first request follows §C4 defaults and the rows show time (UTC, ms) · level · service · logger · first line · suppressed · request id", async () => {
    stubFetch((url) => (url.startsWith("/api/v1/ops/logs?") ? { status: 200, body: FIRST } : undefined));
    await open();
    expect(calls).toContain(`GET ${L.logsUrl(L.DEFAULT_LOG_FILTER, NOW)}`);
    const rows = allByTestId("log-row");
    expect(rows).toHaveLength(2);
    const cells = findAll((e) => e.tagName === "TD", rows[0]).map((c) => c.textContent);
    expect(cells).toEqual(["09-29 01:59:00.000Z", "ERROR", "api", "dev.wakeline.ingest.StreamConsumer", `failure ${T(1)}`, "3", "5f2c9a0e1b7d4c3a"]);
    const second = findAll((e) => e.tagName === "TD", rows[1]).map((c) => c.textContent);
    expect([second[1], second[5], second[6]]).toEqual(["WARN", "—", "—"]); // 억제·요청 id 모름은 —
    const status = byTestId("logs-status")!.textContent;
    expect(status).toContain("2건");
    expect(status).toContain("812");
    // edge 로그는 범위 밖(§C9) — 화면에 적는다
    expect(dom.container.textContent).toContain("edge(nginx) 로그는 컨테이너 표준 출력에만");
  });
  it("auto refresh (15 s) keeps the rows still and offers '새 항목 N건'; the button prepends them", async () => {
    let body: unknown = FIRST;
    stubFetch((url) => (url.startsWith("/api/v1/ops/logs?") ? { status: 200, body } : undefined));
    await open();
    body = { ...FIRST, items: [entry(`${NOW + 5_000}-0`), entry(`${NOW + 1_000}-0`), ...FIRST.items] };
    await React.act(async () => { vi.advanceTimersByTime(15_000); });
    await settle();
    expect(allByTestId("log-row")).toHaveLength(2); // 보던 줄은 그대로
    expect(allByTestId("log-row")[0].getAttribute("data-id")).toBe(T(1));
    const btn = byTestId("logs-new")!;
    expect(btn.textContent).toBe("새 항목 2건");
    await click(btn);
    expect(allByTestId("log-row").map((r) => r.getAttribute("data-id"))).toEqual([`${NOW + 5_000}-0`, `${NOW + 1_000}-0`, T(1), T(2)]);
    expect(byTestId("logs-new")).toBeNull();
  });
  it("↑/↓ move the selection, Enter opens the detail (full message, exception, stack with wrap toggle, context), c copies the entry text", async () => {
    const written: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => { written.push(t); } } });
    stubFetch((url) => {
      if (url.startsWith("/api/v1/ops/logs/groups?")) return { status: 200, body: { groups: [{ fp: "0123456789abcdef", service: "api", level: "ERROR", logger: "x", exception_type: "java.lang.IllegalStateException", sample_message: "failure", count: 17, suppressed: 40, first_at: "2026-09-29T01:00:00Z", last_at: "2026-09-29T01:59:00Z", last_id: T(1) }], scanned: 900, scan_truncated: false } };
      if (url.includes("rid=5f2c9a0e1b7d4c3a")) return { status: 200, body: { items: [entry(T(1)), entry(`${NOW - 60_500}-0`, { service: "api", level: "WARN", logger: "dev.wakeline.config.ProblemAdvice", exception: null, message: "data store unavailable" })], next_cursor: null, scanned: 50, scan_truncated: false } };
      if (url.startsWith("/api/v1/ops/logs?")) return { status: 200, body: FIRST };
      return undefined;
    });
    await open();
    const list = byTestId("log-list")!;
    await key(list, "ArrowDown");
    expect(allByTestId("log-row")[0].getAttribute("aria-selected")).toBe("true");
    await key(list, "ArrowDown");
    expect(allByTestId("log-row")[1].getAttribute("aria-selected")).toBe("true");
    await key(list, "ArrowUp");
    await key(list, "Enter");
    const d = byTestId("log-detail")!;
    expect(d.textContent).toContain(`failure ${T(1)}\nsecond line`);
    expect(d.textContent).toContain("java.lang.IllegalStateException: boom");
    const stack = byTestId("log-stack", d)!;
    expect(stack.textContent).toContain("\tat dev.wakeline.X.y(X.java:10)");
    expect(stack.getAttribute("class")).toContain("whitespace-pre-wrap");
    await click(button("줄바꿈 켬", d));
    expect(byTestId("log-stack")!.getAttribute("class")).not.toContain("whitespace-pre-wrap");
    expect(d.textContent).toContain("ship-apply"); // context
    // 같은 지문 묶음 통계(기간 안) · 같은 요청 id 의 다른 항목(자기 자신 제외)
    expect(byTestId("log-fp-stats")!.textContent).toContain("17");
    expect(byTestId("log-fp-stats")!.textContent).toContain("40");
    const rel = allByTestId("log-related");
    expect(rel).toHaveLength(1);
    expect(rel[0].textContent).toContain("data store unavailable");
    await key(list, "c");
    expect(written.at(-1)).toBe(L.logText(L.parseLogPage(FIRST).items[0]));
    await click(button("JSON 복사", d));
    expect(JSON.parse(written.at(-1)!)).toEqual(FIRST.items[0]);
    expect(byTestId("logs-note")!.textContent).toContain("복사됨");
  });
  it("copy visible list (text) and download .txt / .ndjson are built in the browser from the shown rows", async () => {
    const written: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => { written.push(t); } } });
    const clicked: { download: string; href: string }[] = [];
    (MiniElement.prototype as unknown as { click: () => void }).click = function (this: MiniElement & { download: string; href: string }) { clicked.push({ download: this.download, href: this.href }); };
    const blobs: Blob[] = [];
    vi.stubGlobal("URL", Object.assign(function () {} as unknown as typeof URL, { createObjectURL: (b: Blob) => { blobs.push(b); return `blob:logs/${blobs.length}`; }, revokeObjectURL: () => {} }));
    stubFetch((url) => (url.startsWith("/api/v1/ops/logs?") ? { status: 200, body: FIRST } : undefined));
    await open();
    await click(button("보이는 목록 복사"));
    expect(written.at(-1)).toBe(L.logsText(L.parseLogPage(FIRST).items));
    await click(button(".ndjson"));
    await click(button(".txt"));
    expect(clicked.map((c) => c.download)).toEqual(["wakeline-logs-20260929T020000Z.ndjson", "wakeline-logs-20260929T020000Z.txt"]);
    expect(await blobs[0].text()).toBe(L.logsNdjson(L.parseLogPage(FIRST).items));
    expect(await blobs[1].text()).toBe(L.logsText(L.parseLogPage(FIRST).items));
    delete (MiniElement.prototype as unknown as { click?: () => void }).click;
  });
  it("filters: service toggles (several), level, period and request id change the request; a malformed request id is refused with a hint", async () => {
    stubFetch((url) => (url.startsWith("/api/v1/ops/logs?") ? { status: 200, body: { items: [] } } : undefined));
    await open();
    await click(button("collector"));
    await click(button("ais"));
    await click(button("ERROR"));
    await click(button("24 h"));
    const last = () => new URL(calls.filter((c) => c.startsWith("GET /api/v1/ops/logs?")).at(-1)!.slice(4), "http://x").searchParams;
    expect(last().get("service")).toBe("collector,ais");
    expect(last().get("level")).toBe("ERROR");
    expect(last().get("since")).toBe("2026-09-28T02:00:00.000Z");
    const rid = find((e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === "요청 id")!;
    await React.act(async () => { propsOf(rid).onChange({ target: { value: "bad id!" } }); });
    await React.act(async () => { propsOf(byTestId("logs-filter-form")!).onSubmit({ preventDefault() {} }); });
    await settle();
    expect(last().has("rid")).toBe(false);
    expect(byTestId("logs-rid-error")!.textContent).toContain("8–64");
    await React.act(async () => { propsOf(rid).onChange({ target: { value: "5f2c9a0e1b7d4c3a" } }); });
    await React.act(async () => { propsOf(byTestId("logs-filter-form")!).onSubmit({ preventDefault() {} }); });
    await settle();
    expect(last().get("rid")).toBe("5f2c9a0e1b7d4c3a");
    expect(byTestId("logs-empty")!.textContent).toContain("조건에 맞는 항목 없음");
  });
  it("a #rid= link (from an error message) opens the list filtered by that request id over 7 d", async () => {
    stubFetch((url) => (url.startsWith("/api/v1/ops/logs?") ? { status: 200, body: FIRST } : undefined));
    await open("#rid=5f2c9a0e1b7d4c3a");
    const first = new URL(calls.find((c) => c.startsWith("GET /api/v1/ops/logs?"))!.slice(4), "http://x").searchParams;
    expect(first.get("rid")).toBe("5f2c9a0e1b7d4c3a");
    expect(first.get("since")).toBe("2026-09-22T02:00:00.000Z");
  });
});

describe("v5-C7 /logs: groups view and the AIS gaps tab", () => {
  const GROUPS = { groups: [{ fp: "0123456789abcdef", service: "api", level: "ERROR", logger: "dev.wakeline.ingest.StreamConsumer", exception_type: "java.lang.IllegalStateException", sample_message: "failure x", count: 17, suppressed: 40, first_at: "2026-09-29T01:00:00Z", last_at: "2026-09-29T01:59:00Z", last_id: T(1) }], scanned: 900, scan_truncated: true };
  it("groups show fp, count, suppressed, first/last; copying a group fetches its entries; opening one filters the list by fp", async () => {
    const written: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => { written.push(t); } } });
    stubFetch((url) => {
      if (url.startsWith("/api/v1/ops/logs/groups?")) return { status: 200, body: GROUPS };
      if (url.startsWith("/api/v1/ops/logs?")) return { status: 200, body: FIRST };
      return undefined;
    });
    await open();
    await click(button("묶음(fp)"));
    expect(calls.some((c) => c.startsWith("GET /api/v1/ops/logs/groups?"))).toBe(true);
    const g = allByTestId("log-group");
    expect(g).toHaveLength(1);
    const text = g[0].textContent;
    for (const s of ["0123456789abcdef", "17", "40", "01:00:00", "01:59:00", "java.lang.IllegalStateException"]) expect(text).toContain(s);
    expect(byTestId("logs-status")!.textContent).toContain("잘림"); // scan_truncated 를 숨기지 않는다
    await click(button("묶음 복사", g[0]));
    expect(calls.at(-1)).toContain("fp=0123456789abcdef");
    expect(written.at(-1)!.split("\n")[0]).toContain("[묶음 fp=0123456789abcdef ERROR api/dev.wakeline.ingest.StreamConsumer] 항목 17건");
    await click(button("목록으로", g[0]));
    expect(calls.at(-1)).toMatch(/^GET \/api\/v1\/ops\/logs\?.*fp=0123456789abcdef/);
    expect(allByTestId("log-row")).toHaveLength(2);
  });
  it("the AIS 수신 공백 tab shows GET /api/v1/ais/gaps as a table (구역 · 시작 · 끝 · 길이 · 사유)", async () => {
    stubFetch((url) => {
      if (url.startsWith("/api/v1/ais/gaps?")) return { status: 200, body: { from: "2026-09-29T01:00:00Z", to: "2026-09-29T02:00:00Z", truncated: false, open: { started_at: "2026-09-29T01:50:00Z", reason: "no messages 120 s" }, items: [{ started_at: "2026-09-29T01:10:00Z", ended_at: "2026-09-29T01:13:05Z", reason: "ws closed 1006", provider: "aisstream", scope: "30,120,40,135" }] } };
      if (url.startsWith("/api/v1/ops/logs?")) return { status: 200, body: FIRST };
      return undefined;
    });
    await open();
    await click(button("AIS 수신 공백"));
    expect(calls.at(-1)).toBe("GET /api/v1/ais/gaps?from=2026-09-29T01%3A00%3A00.000Z");
    const heads = findAll((e) => e.tagName === "TH", byTestId("ais-gaps")!).map((h) => h.textContent);
    expect(heads.slice(0, 5)).toEqual(["구역", "시작(UTC)", "끝(UTC)", "길이", "사유"]);
    const rows = allByTestId("ais-gap-row").map((r) => findAll((e) => e.tagName === "TD", r).map((c) => c.textContent));
    expect(rows[0].slice(0, 5)).toEqual(["합계(가장 이른 열린 공백)", "09-29 01:50:00Z", "진행 중", "10m 00s(응답 시각까지)", "no messages 120 s"]);
    expect(rows[1].slice(0, 5)).toEqual(["30,120,40,135", "09-29 01:10:00Z", "09-29 01:13:05Z", "3m 05s", "ws closed 1006"]);
  });
});
