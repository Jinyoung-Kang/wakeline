/**
 * 해결 처리(ADR-022 · 사용자 요청 "해결 완료된 [운영/로그] 메뉴에 있는 error 는 지우는 기능") — /logs 화면(실제 react-dom 마운트 — 최소 DOM + fetch 대역).
 * 묶음 · 항목 상세의 "해결 처리"(메모 선택, 확인) · "보이는 묶음 모두 해결 처리"(수를 말하는 확인) · "해결된 항목 보기" 토글 · "해결 처리로 숨김 N건" ·
 * 해결된 항목 · 묶음(보일 때)은 흐리게 "해결됨 · <by> · <upto KST · UTC>" + "되돌리기"(DELETE). 쓰기는 CSRF 헤더 · 세션 만료 처리 · 요청 id 를 붙인 오류,
 * 화면은 201/204 뒤에만 바뀌고 영향받는 목록을 다시 불러온다. 지우지 않는다 — 가린 수를 늘 보인다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom, MiniElement } from "./helpers/mini-dom";

const dom = installMiniDom();
type Root = import("react-dom/client").Root;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let LogsPage: typeof import("@/app/logs/page").default;

beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  LogsPage = (await import("@/app/logs/page")).default;
  // 쓰기는 CSRF 쿠키 값을 헤더로 되돌려 보낸다(lib/api csrfToken)
  (dom.document as unknown as { cookie: string }).cookie = "WAKELINE_CSRF=t";
});
afterAll(() => dom.restore());
let root: Root | null = null;
afterEach(async () => {
  if (root) { const r = root; root = null; await React.act(async () => { r.unmount(); }); }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const NOW = Date.parse("2026-09-29T02:00:00Z");
const FP = "0123456789abcdef", FP2 = "fedcba9876543210", FP3 = "00000000000000aa", FP4 = "00000000000000bb";
/** 서버가 쓴 시각 그대로(µs) — upto 로 되돌려 보낼 때 자르지 않는다 */
const TS_A = "2026-09-29T01:59:00.123456Z";
const T = (min: number) => `${NOW - min * 60_000}-0`;
const entry = (id: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, v: 1, stream: "server", ts: new Date(Number(id.split("-")[0])).toISOString(), service: "api", instance: null, level: "ERROR",
  logger: "dev.wakeline.ingest.StreamConsumer", thread: null, message: `failure ${id}`, exception: null, fp: FP, request_id: null, context: {}, suppressed: 0, resolved: null, ...o,
});
const A = entry(T(1), { ts: TS_A });
const B = entry(T(2), { fp: FP2, level: "WARN", message: "slow response" });
const REF = { id: 12, upto: TS_A, resolved_by: "op" };
const PAGE = (items: unknown[], o: Record<string, unknown> = {}) => ({ items, next_cursor: null, scanned: 40, scan_truncated: false, hidden_resolved: 7, resolution_state: "ok", ...o });
const group = (fp: string, o: Record<string, unknown> = {}) => ({
  fp, service: "api", level: "ERROR", logger: "x.Y", exception_type: null, sample_message: `boom ${fp}`, count: 3, suppressed: 0,
  first_at: "2026-09-29T01:00:00Z", last_at: TS_A, last_id: T(1), resolved: null, ...o,
});
const GROUPS = (groups: unknown[], o: Record<string, unknown> = {}) => ({ groups, scanned: 40, scan_truncated: false, hidden_resolved: 2, resolution_state: "ok", ...o });

type Reply = { status: number; body?: unknown };
type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };
type Handler = (method: string, url: string, body: Record<string, string> | undefined) => Reply | undefined | Promise<Reply | undefined>;
const calls: Call[] = [];
function stub(handler: Handler, session: () => boolean = () => true) {
  calls.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const res = (r: Reply) => (r.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } }));
    if (url === "/api/v1/ops/session") return session() ? res({ status: 200, body: { username: "op" } }) : res({ status: 404, body: { detail: "not found" } });
    const r = await handler(method, url, body);
    return res(r ?? { status: 404, body: { detail: "no such resource" } });
  });
}
const created = (body: Record<string, string> | undefined, id: number): Reply => ({
  status: 201, body: { id, kind: body!.kind, key: body!.key, upto: body!.upto ?? "2026-09-29T02:00:00Z", resolved_at: "2026-09-29T02:00:01Z", resolved_by: "op", note: body!.note ?? null },
});
const qs = (url: string) => new URL(url, "http://x").searchParams;
const gets = (prefix: string) => calls.filter((c) => c.method === "GET" && c.url.startsWith(prefix));
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
const allByTestId = (id: string, from?: MiniElement) => findAll((e) => e.getAttribute?.("data-testid") === id, from);
const button = (text: string, from?: MiniElement) => find((e) => e.tagName === "BUTTON" && e.textContent.trim() === text, from);
const input = (label: string, from?: MiniElement) => find((e) => e.tagName === "INPUT" && e.getAttribute("aria-label") === label, from);
const propsOf = (e: MiniElement): Record<string, (...a: unknown[]) => unknown> => {
  const k = Object.keys(e).find((x) => x.startsWith("__reactProps$"));
  return (e as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>)[k!];
};
const click = async (e: MiniElement | null) => {
  expect(e).not.toBeNull();
  await React.act(async () => { await propsOf(e!).onClick?.({ preventDefault() {}, stopPropagation() {} }); });
  await settle();
  await settle();
};
const type = async (e: MiniElement | null, value: string) => { expect(e).not.toBeNull(); await React.act(async () => { propsOf(e!).onChange({ target: { value } }); }); };
async function open() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("location", { hash: "", pathname: "/logs", origin: "http://localhost:8700" });
  root = createRoot(dom.container as never);
  await React.act(async () => { root!.render(React.createElement(LogsPage)); });
  await settle();
  await settle();
}
/** 목록 · 묶음 · 항목 하나의 기본 응답(해결된 A 는 show 에서만 보인다) */
const logsRoutes = (url: string, o: { aResolved?: Record<string, unknown> | null; groups?: unknown } = {}): Reply | undefined => {
  const a = { ...A, resolved: o.aResolved ?? null };
  if (url.startsWith(`/api/v1/ops/logs/${A.id}`)) return { status: 200, body: a };
  if (url.startsWith("/api/v1/ops/logs/groups?")) return { status: 200, body: o.groups ?? GROUPS([group(FP)]) };
  if (url.startsWith("/api/v1/ops/logs?")) {
    const show = qs(url).get("resolved") === "show";
    return { status: 200, body: show ? PAGE([a, B], { hidden_resolved: 0 }) : PAGE(a.resolved ? [B] : [a, B]) };
  }
  return undefined;
};

describe("/logs: hidden by default, counted, and shown on request", () => {
  it("the first request says resolved=hide; the status line shows '해결 처리로 숨김 N건'; a stale resolution record is announced", async () => {
    stub((_m, url) => (url.startsWith("/api/v1/ops/logs?") ? { status: 200, body: PAGE([A, B], { resolution_state: "stale" }) } : undefined));
    await open();
    expect(qs(gets("/api/v1/ops/logs?")[0].url).get("resolved")).toBe("hide");
    expect(byTestId("logs-hidden-resolved")!.textContent).toBe("해결 처리로 숨김 7건");
    expect(byTestId("logs-hidden-resolved")!.getAttribute("title")).toContain("지우지 않음");
    expect(byTestId("logs-resolution-state")!.textContent).toContain("stale");
    expect(button("해결된 항목 보기")!.getAttribute("aria-pressed")).toBe("false");
  });
  it("an api that does not report the count shows '—' alone (no unit), and no state line when it does not say", async () => {
    stub((_m, url) => (url.startsWith("/api/v1/ops/logs?") ? { status: 200, body: { items: [A] } } : undefined));
    await open();
    expect(byTestId("logs-hidden-resolved")!.textContent).toBe("해결 처리로 숨김 —");
    expect(byTestId("logs-resolution-state")).toBeNull();
  });
  it("an empty list whose entries were all hidden by resolutions says so (not just '없음')", async () => {
    stub((_m, url) => (url.startsWith("/api/v1/ops/logs?") ? { status: 200, body: PAGE([], { hidden_resolved: 4 }) } : undefined));
    await open();
    expect(byTestId("logs-empty")!.textContent).toBe("조건에 맞는 항목 없음(최근 1 h) — 해결 처리로 숨긴 항목 4건('해결된 항목 보기'로 다시 봄)");
  });
  it("'해결된 항목 보기' asks for resolved=show; resolved rows are muted with '해결됨 · <by> · <upto KST · UTC>'; 초기화 hides again", async () => {
    stub((_m, url) => logsRoutes(url, { aResolved: REF }));
    await open();
    expect(allByTestId("log-row")).toHaveLength(1); // 가림: A 는 해결됨
    await click(button("해결된 항목 보기"));
    expect(qs(gets("/api/v1/ops/logs?").at(-1)!.url).get("resolved")).toBe("show");
    expect(button("해결된 항목 보기")!.getAttribute("aria-pressed")).toBe("true");
    const rows = allByTestId("log-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute("data-resolved")).toBe("true");
    expect(rows[0].getAttribute("class")).toContain("text-fg-3");
    expect(byTestId("log-resolved-mark", rows[0])!.textContent).toBe("해결됨 · op · 09-29 10:59:00 KST · 01:59:00 UTC");
    expect(rows[1].getAttribute("data-resolved")).toBeNull();
    expect(byTestId("log-resolved-mark", rows[1])).toBeNull();
    expect(byTestId("logs-hidden-resolved")!.textContent).toBe("해결된 항목 포함(흐리게 표시)");
    await click(button("초기화"));
    expect(qs(gets("/api/v1/ops/logs?").at(-1)!.url).get("resolved")).toBe("hide");
  });
});

describe("/logs entry detail: resolve and revoke", () => {
  it("'해결 처리' confirms first (fp · upto = the entry's own time · what happens); the POST is exactly the contract body with the CSRF header; 해결됨 appears only after 201 and the list and the entry are re-read", async () => {
    let release: (() => void) | null = null;
    let done = false;
    stub(async (m, url, body) => {
      if (m === "POST" && url === "/api/v1/ops/resolutions") { await new Promise<void>((r) => { release = r; }); done = true; return created(body, 21); }
      return logsRoutes(url, { aResolved: done ? { id: 21, upto: TS_A, resolved_by: "op" } : null });
    });
    await open();
    await click(allByTestId("log-row")[0]);
    const d = byTestId("log-detail")!;
    expect(byTestId("log-detail-resolve", d)!.textContent).toContain("해결되지 않음");
    await click(button("해결 처리", d));
    const panel = byTestId("resolve-confirm", d)!;
    expect(panel.textContent).toContain(FP);
    expect(panel.textContent).toContain("upto 09-29 10:59:00 KST · 01:59:00 UTC");
    expect(panel.textContent).toContain("지우지 않");
    expect(panel.textContent).toContain("다시 보입니다");
    expect(calls.some((c) => c.method !== "GET")).toBe(false); // 확인 전에는 보내지 않는다
    await type(input("해결 메모", panel), "  배포 뒤 해결 ");
    await click(button("해결 처리 확인", panel));
    // 201 전: 보내는 중 — 화면은 아직 해결되지 않음(낙관적 표시는 201 뒤에만)
    expect(byTestId("log-detail-resolve")!.textContent).toContain("해결되지 않음");
    const busy = find((e) => e.tagName === "BUTTON" && e.getAttribute("aria-busy") === "true")!;
    expect(busy.textContent).toBe("처리 중…");
    expect(busy.getAttribute("disabled")).not.toBeNull();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/v1/ops/resolutions");
    expect(post.body).toEqual({ kind: "log_group", key: FP, upto: TS_A, note: "배포 뒤 해결" });
    expect(post.headers["X-CSRF-Token"]).toBe("t");
    expect(post.headers["Content-Type"]).toBe("application/json");
    const before = calls.length;
    await React.act(async () => { release!(); });
    await settle();
    await settle();
    expect(byTestId("log-detail-resolve")!.textContent).toContain("해결됨 · op · 09-29 10:59:00 KST · 01:59:00 UTC");
    expect(button("되돌리기", byTestId("log-detail")!)).not.toBeNull();
    expect(byTestId("resolve-confirm")).toBeNull();
    const after = calls.slice(before);
    expect(after.some((c) => c.method === "GET" && c.url.startsWith("/api/v1/ops/logs?"))).toBe(true);
    expect(after.some((c) => c.method === "GET" && c.url === `/api/v1/ops/logs/${A.id}?stream=server`)).toBe(true);
    expect(allByTestId("log-row").map((r) => r.getAttribute("data-id"))).toEqual([B.id]); // 가림 기본 — 다시 불러온 목록에서 빠진다
    expect(byTestId("logs-note")!.textContent).toContain("해결 처리됨");
  });
  it("a refused resolve (400 BAD_RESOLUTION) keeps the entry unresolved and shows the reason with HTTP · code · request id; nothing is reloaded", async () => {
    stub((m, url) => (m === "POST"
      ? { status: 400, body: { detail: "upto must not be in the future", code: "BAD_RESOLUTION", request_id: "abcd1234abcd1234" } }
      : logsRoutes(url)));
    await open();
    await click(allByTestId("log-row")[0]);
    await click(button("해결 처리", byTestId("log-detail")!));
    await click(button("해결 처리 확인", byTestId("resolve-confirm")!));
    const err = byTestId("resolve-error")!;
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toContain("해결 처리 실패 — 서버가 요청을 거절함: upto must not be in the future");
    expect(err.textContent).toContain("HTTP 400 · BAD_RESOLUTION");
    expect(err.textContent).toContain("abcd1234abcd1234");
    expect(find((e) => e.getAttribute?.("aria-label") === "요청 id abcd1234abcd1234 복사", err)).not.toBeNull();
    expect(byTestId("log-detail-resolve")!.textContent).toContain("해결되지 않음");
    const post = calls.findIndex((c) => c.method === "POST");
    expect(calls.slice(post + 1).filter((c) => c.url.startsWith("/api/v1/ops/logs"))).toEqual([]);
    // 확인 단추는 다시 누를 수 있다(같은 요청)
    expect(button("해결 처리 확인", byTestId("resolve-confirm")!)!.getAttribute("disabled")).toBeNull();
  });
  it("two clicks on the confirm button in the same frame send one request", async () => {
    stub((m, url, body) => (m === "POST" ? created(body, 21) : logsRoutes(url)));
    await open();
    await click(allByTestId("log-row")[0]);
    await click(button("해결 처리", byTestId("log-detail")!));
    const confirm = button("해결 처리 확인", byTestId("resolve-confirm")!)!;
    await React.act(async () => { propsOf(confirm).onClick({}); propsOf(confirm).onClick({}); });
    await settle();
    await settle();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
  it("a note over 200 characters (or with a line break) is refused before sending", async () => {
    stub((_m, url) => logsRoutes(url));
    await open();
    await click(allByTestId("log-row")[0]);
    await click(button("해결 처리", byTestId("log-detail")!));
    const panel = byTestId("resolve-confirm")!;
    await type(input("해결 메모", panel), "가".repeat(201));
    expect(byTestId("resolve-note-error")!.textContent).toContain("200자 이하");
    expect(button("해결 처리 확인", byTestId("resolve-confirm")!)!.getAttribute("disabled")).not.toBeNull();
    await click(button("취소", byTestId("resolve-confirm")!));
    expect(byTestId("resolve-confirm")).toBeNull();
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });
  it("'되돌리기' confirms, sends DELETE /api/v1/ops/resolutions/{id} with the CSRF header and no body; after 204 the entry is re-read (an earlier resolution may still cover it) and the list reloads", async () => {
    let revoked = false;
    stub((m, url) => {
      if (m === "DELETE" && url === "/api/v1/ops/resolutions/12") { revoked = true; return { status: 204 }; }
      return logsRoutes(url, { aResolved: revoked ? null : REF });
    });
    await open();
    await click(button("해결된 항목 보기"));
    await click(allByTestId("log-row")[0]);
    const d = byTestId("log-detail")!;
    expect(byTestId("log-detail-resolve", d)!.textContent).toContain("해결됨 · op · 09-29 10:59:00 KST · 01:59:00 UTC");
    await click(button("되돌리기", d));
    const panel = byTestId("resolve-confirm")!;
    expect(panel.textContent).toContain("해결 #12");
    expect(panel.textContent).toContain("다시 보입니다");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const before = calls.length;
    await click(button("되돌리기 확인", panel));
    const del = calls.find((c) => c.method === "DELETE")!;
    expect(del.url).toBe("/api/v1/ops/resolutions/12");
    expect(del.body).toBeUndefined();
    expect(del.headers["X-CSRF-Token"]).toBe("t");
    const after = calls.slice(before);
    expect(after.some((c) => c.method === "GET" && c.url === `/api/v1/ops/logs/${A.id}?stream=server`)).toBe(true);
    expect(after.some((c) => c.method === "GET" && c.url.startsWith("/api/v1/ops/logs?"))).toBe(true);
    expect(byTestId("log-detail-resolve")!.textContent).toContain("해결되지 않음");
    expect(button("해결 처리", byTestId("log-detail")!)).not.toBeNull();
    expect(byTestId("logs-note")!.textContent).toContain("되돌림");
  });
  it("a slow re-read of the entry after one write never overrides the re-read after a later write", async () => {
    let state: "none" | "resolved" | "revoked" = "none";
    let holdNext = false;
    let release: (() => void) | null = null;
    stub(async (m, url, body) => {
      if (m === "POST") { state = "resolved"; holdNext = true; return created(body, 21); }
      if (m === "DELETE") { state = "revoked"; return { status: 204 }; }
      if (url.startsWith(`/api/v1/ops/logs/${A.id}`)) {
        const snapshot = { ...A, resolved: state === "resolved" ? { id: 21, upto: TS_A, resolved_by: "op" } : null };
        if (holdNext) { holdNext = false; await new Promise<void>((r) => { release = r; }); }
        return { status: 200, body: snapshot };
      }
      return logsRoutes(url);
    });
    await open();
    await click(allByTestId("log-row")[0]);
    await click(button("해결 처리", byTestId("log-detail")!));
    await click(button("해결 처리 확인", byTestId("resolve-confirm")!)); // 201 뒤 항목 다시 읽기 — 해결된 값을 싣고 기다린다
    expect(byTestId("log-detail-resolve")!.textContent).toContain("해결됨");
    await click(button("되돌리기", byTestId("log-detail")!));
    await click(button("되돌리기 확인", byTestId("resolve-confirm")!)); // 204 뒤 항목 다시 읽기 — 바로 온다(해결 없음)
    expect(byTestId("log-detail-resolve")!.textContent).toContain("해결되지 않음");
    await React.act(async () => { release!(); });
    await settle();
    expect(byTestId("log-detail-resolve")!.textContent).toContain("해결되지 않음"); // 먼저 떠난 느린 응답은 버린다
  });
  it("revoking a resolution that is already gone (404, session alive) says so and reloads the list", async () => {
    stub((m, url) => (m === "DELETE" ? { status: 404, body: { detail: "no such resolution", request_id: "feed0000feed0000" } } : logsRoutes(url, { aResolved: REF })));
    await open();
    await click(button("해결된 항목 보기"));
    await click(allByTestId("log-row")[0]);
    await click(button("되돌리기", byTestId("log-detail")!));
    const before = calls.length;
    await click(button("되돌리기 확인", byTestId("resolve-confirm")!));
    expect(byTestId("resolve-error")!.textContent).toContain("이미 되돌렸거나 없는 해결");
    expect(byTestId("resolve-error")!.textContent).toContain("feed0000feed0000");
    expect(byTestId("ops-login")).toBeNull(); // 세션은 살아 있다 — 로그아웃시키지 않는다
    expect(calls.slice(before).some((c) => c.method === "GET" && c.url.startsWith("/api/v1/ops/logs?"))).toBe(true);
  });
  it("a session that expired before the POST goes back to the login form with the notice", async () => {
    let alive = true;
    stub((m, url) => { if (m === "POST") { alive = false; return { status: 404, body: { detail: "not found" } }; } return logsRoutes(url); }, () => alive);
    await open();
    await click(allByTestId("log-row")[0]);
    await click(button("해결 처리", byTestId("log-detail")!));
    await click(button("해결 처리 확인", byTestId("resolve-confirm")!));
    await settle();
    expect(byTestId("ops-login")).not.toBeNull();
    expect(byTestId("ops-login-notice")!.textContent).toContain("세션이 만료");
  });
  it("an entry without a fingerprint cannot be resolved (resolutions are per fingerprint)", async () => {
    stub((_m, url) => (url.startsWith("/api/v1/ops/logs?") ? { status: 200, body: PAGE([{ ...A, fp: null }]) } : undefined));
    await open();
    await click(allByTestId("log-row")[0]);
    const cell = byTestId("log-detail-resolve")!;
    expect(cell.textContent).toContain("지문 없음");
    expect(button("해결 처리", byTestId("log-detail")!)).toBeNull();
  });
});

describe("/logs groups: per group and bulk", () => {
  const G1 = group(FP), G2 = group(FP2, { last_at: "2026-09-29T01:10:00Z", resolved: { id: 13, upto: "2026-09-29T01:10:00Z", resolved_by: "kim" } });
  const G3 = group(FP3, { last_at: null }), G4 = group(FP4, { last_at: "2026-09-29T01:30:00.5Z" });
  async function groupsView(groups: unknown[], extra: Handler = () => undefined) {
    stub(async (m, url, body) => (await extra(m, url, body)) ?? logsRoutes(url, { groups: GROUPS(groups) }));
    await open();
    await click(button("묶음(fp)"));
  }
  it("each unresolved group offers '해결 처리' up to its last_at as given; resolved groups (shown) are muted with the mark and '되돌리기'; a group without last_at cannot be resolved", async () => {
    await groupsView([G1, G2, G3], (m, _u, body) => (m === "POST" ? created(body, 30) : undefined));
    expect(qs(gets("/api/v1/ops/logs/groups?").at(-1)!.url).get("resolved")).toBe("hide");
    expect(byTestId("logs-hidden-resolved")!.textContent).toBe("해결 처리로 숨김 2건");
    const heads = findAll((e) => e.tagName === "TH", byTestId("log-list")!).map((h) => h.textContent);
    expect(heads).toContain("해결");
    const [r1, r2, r3] = allByTestId("log-group");
    expect(r2.getAttribute("data-resolved")).toBe("true");
    expect(r2.getAttribute("class")).toContain("text-fg-3");
    expect(byTestId("group-resolved-mark", r2)!.textContent).toBe("해결됨 · kim · 09-29 10:10:00 KST · 01:10:00 UTC");
    expect(button("되돌리기", r2)).not.toBeNull();
    expect(button("해결 처리", r3)!.getAttribute("disabled")).not.toBeNull();
    expect(button("해결 처리", r3)!.getAttribute("title")).toContain("마지막 시각 모름");
    await click(button("해결 처리", r1));
    const panel = byTestId("resolve-confirm")!;
    expect(panel.textContent).toContain(`지문 묶음 ${FP}`);
    expect(panel.textContent).toContain("upto 09-29 10:59:00 KST · 01:59:00 UTC");
    expect(panel.textContent).toContain("마지막 항목 시각");
    const before = calls.length;
    await click(button("해결 처리 확인", panel));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ kind: "log_group", key: FP, upto: TS_A });
    expect(calls.slice(before).filter((c) => c.method === "GET" && c.url.startsWith("/api/v1/ops/logs/groups?")).length).toBeGreaterThanOrEqual(1);
    expect(byTestId("resolve-confirm")).toBeNull();
    expect(byTestId("logs-note")!.textContent).toContain(`해결 처리됨: 묶음 ${FP}`);
  });
  it("'되돌리기' on a resolved group sends DELETE for that resolution and reloads the groups", async () => {
    await groupsView([G1, G2], (m) => (m === "DELETE" ? { status: 204 } : undefined));
    const r2 = allByTestId("log-group")[1];
    await click(button("되돌리기", r2));
    expect(byTestId("resolve-confirm")!.textContent).toContain("해결 #13");
    const before = calls.length;
    await click(button("되돌리기 확인", byTestId("resolve-confirm")!));
    expect(calls.find((c) => c.method === "DELETE")!.url).toBe("/api/v1/ops/resolutions/13");
    expect(calls.slice(before).some((c) => c.method === "GET" && c.url.startsWith("/api/v1/ops/logs/groups?"))).toBe(true);
  });
  it("'보이는 묶음 모두 해결 처리' states the count and what is left out before sending; confirming sends one POST per group and reloads the groups", async () => {
    let n = 40;
    await groupsView([G1, G2, G3, G4], (m, _u, body) => (m === "POST" ? created(body, ++n) : undefined));
    await click(button("보이는 묶음 모두 해결 처리"));
    const panel = byTestId("resolve-confirm")!;
    expect(panel.textContent).toContain("보이는 묶음 2개를 해결 처리합니다");
    expect(panel.textContent).toContain("제외: 이미 해결됨 1개 · 마지막 시각 모름 1개");
    expect(panel.textContent).toContain("요청 2건");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    const before = calls.length;
    await click(button("2개 해결 처리 확인", panel));
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.body as Record<string, string>).sort((a, b) => a.key.localeCompare(b.key));
    expect(posts).toEqual([
      { kind: "log_group", key: FP4, upto: "2026-09-29T01:30:00.5Z" },
      { kind: "log_group", key: FP, upto: TS_A },
    ].sort((a, b) => a.key.localeCompare(b.key)));
    expect(calls.slice(before).filter((c) => c.method === "GET" && c.url.startsWith("/api/v1/ops/logs/groups?")).length).toBeGreaterThanOrEqual(1);
    expect(byTestId("resolve-confirm")).toBeNull();
    expect(byTestId("logs-note")!.textContent).toContain("해결 처리됨: 묶음 2개");
  });
  it("a partly failed bulk keeps the panel with what happened; '다시 시도' sends only what is left", async () => {
    let fail = true;
    await groupsView([G1, G4], (m, _u, body) => {
      if (m !== "POST") return undefined;
      if (body!.key === FP4 && fail) return { status: 400, body: { detail: "upto must not be in the future", code: "BAD_RESOLUTION", request_id: "0bad0bad0bad0bad" } };
      return created(body, 50);
    });
    await click(button("보이는 묶음 모두 해결 처리"));
    const before = calls.length;
    await click(button("2개 해결 처리 확인", byTestId("resolve-confirm")!));
    const panel = byTestId("resolve-confirm")!;
    expect(byTestId("resolve-summary", panel)!.textContent).toBe("1개 해결됨 · 1개 실패");
    expect(byTestId("resolve-error", panel)!.textContent).toContain("upto must not be in the future");
    expect(byTestId("resolve-error", panel)!.textContent).toContain("0bad0bad0bad0bad");
    // 하나는 저장됐다 — 묶음을 다시 불러온다
    expect(calls.slice(before).some((c) => c.method === "GET" && c.url.startsWith("/api/v1/ops/logs/groups?"))).toBe(true);
    fail = false;
    const mark = calls.length;
    await click(button("남은 1개 다시 시도", byTestId("resolve-confirm")!));
    expect(calls.slice(mark).filter((c) => c.method === "POST").map((c) => (c.body as Record<string, string>).key)).toEqual([FP4]);
    expect(byTestId("resolve-confirm")).toBeNull();
  });
  it("opening the bulk confirmation again starts from the groups now visible (not the drafts left from the last attempt)", async () => {
    const FP5 = "00000000000000cc";
    const G5 = group(FP5, { last_at: "2026-09-29T01:40:00Z" });
    let list = [G1, G4];
    stub(async (m, url, body) => {
      if (m === "POST") {
        if (body!.key === FP4) return { status: 400, body: { detail: "bad", code: "BAD_RESOLUTION" } };
        list = [G4, G5]; // G1 은 해결돼 빠지고 새 묶음 G5 가 보인다
        return created(body, 60);
      }
      return logsRoutes(url, { groups: GROUPS(list) });
    });
    await open();
    await click(button("묶음(fp)"));
    await click(button("보이는 묶음 모두 해결 처리"));
    await click(button("2개 해결 처리 확인", byTestId("resolve-confirm")!));
    expect(byTestId("resolve-summary")!.textContent).toBe("1개 해결됨 · 1개 실패");
    expect(allByTestId("log-group").map((r) => find((e) => e.tagName === "TD", r)!.textContent)).toEqual([FP4, FP5]); // 다시 불러온 묶음
    await click(button("보이는 묶음 모두 해결 처리"));
    const panel = byTestId("resolve-confirm")!;
    expect(panel.textContent).toContain("보이는 묶음 2개를 해결 처리합니다");
    expect(byTestId("resolve-summary", panel)).toBeNull();
    expect(byTestId("resolve-error", panel)).toBeNull();
    const mark = calls.length;
    await click(button("2개 해결 처리 확인", panel));
    expect(calls.slice(mark).filter((c) => c.method === "POST").map((c) => (c.body as Record<string, string>).key).sort()).toEqual([FP4, FP5].sort());
  });
  it("with nothing to resolve the bulk action is disabled and says why", async () => {
    await groupsView([G2, G3]);
    const b = button("보이는 묶음 모두 해결 처리")!;
    expect(b.getAttribute("disabled")).not.toBeNull();
    expect(b.getAttribute("title")).toContain("해결 처리할 묶음 없음");
  });
});

describe("/logs: a write whose confirmation is gone before the answer still counts", () => {
  /** POST 를 붙잡아 두는 대역 — release 로 201 을 보낸다 */
  const holdPost = (o: { groups?: () => unknown } = {}) => {
    const s = { release: null as (() => void) | null, done: false };
    stub(async (m, url, body) => {
      if (m === "POST" && url === "/api/v1/ops/resolutions") { await new Promise<void>((r) => { s.release = r; }); s.done = true; return created(body, 21); }
      return logsRoutes(url, { aResolved: s.done ? { id: 21, upto: TS_A, resolved_by: "op" } : null, ...(o.groups ? { groups: o.groups() } : {}) });
    });
    return s;
  };
  it("closing the detail while the POST is in flight: the 201 reloads the list, says so, and the resolved entry leaves the hidden list", async () => {
    const s = holdPost();
    await open();
    await click(allByTestId("log-row")[0]);
    await click(button("해결 처리", byTestId("log-detail")!));
    await click(button("해결 처리 확인", byTestId("resolve-confirm")!));
    await click(button("닫기", byTestId("log-detail")!)); // 보내는 중에 상세를 닫는다
    expect(byTestId("log-detail")).toBeNull();
    const before = calls.length;
    await React.act(async () => { s.release!(); });
    await settle(); await settle();
    expect(calls.slice(before).some((c) => c.method === "GET" && c.url.startsWith("/api/v1/ops/logs?"))).toBe(true);
    expect(byTestId("logs-note")!.textContent).toContain(`해결 처리됨: 묶음 ${FP}(해결 #21)`);
    expect(allByTestId("log-row").map((r) => r.getAttribute("data-id"))).toEqual([B.id]);
  });
  it("switching to the groups view while an entry's POST is in flight: the 201 reloads the view now shown", async () => {
    const s = holdPost();
    await open();
    await click(allByTestId("log-row")[0]);
    await click(button("해결 처리", byTestId("log-detail")!));
    await click(button("해결 처리 확인", byTestId("resolve-confirm")!));
    await click(button("묶음(fp)"));
    const before = calls.length;
    await React.act(async () => { s.release!(); });
    await settle(); await settle();
    const after = calls.slice(before).filter((c) => c.method === "GET").map((c) => c.url);
    expect(after.some((u) => u.startsWith("/api/v1/ops/logs/groups?"))).toBe(true);
    expect(after.some((u) => u.startsWith("/api/v1/ops/logs?"))).toBe(false); // 보이지 않는 목록을 읽지 않는다
    expect(allByTestId("log-group")).toHaveLength(1);
    expect(byTestId("logs-note")!.textContent).toContain("해결 처리됨");
  });
  it("a group's 201 that lands after another group's confirmation was opened does not close that one", async () => {
    const G4 = group(FP4, { last_at: "2026-09-29T01:30:00.5Z" });
    const s = holdPost({ groups: () => GROUPS([group(FP), G4]) });
    await open();
    await click(button("묶음(fp)"));
    const [r1, r4] = allByTestId("log-group");
    await click(button("해결 처리", r1));
    await click(button("해결 처리 확인", byTestId("resolve-confirm")!));
    await click(button("해결 처리", r4)); // 첫 쓰기가 떠 있는 동안 다른 묶음의 확인을 연다
    expect(byTestId("resolve-confirm")!.textContent).toContain(`지문 묶음 ${FP4}`);
    await React.act(async () => { s.release!(); });
    await settle(); await settle();
    expect(byTestId("resolve-confirm")?.textContent ?? "").toContain(`지문 묶음 ${FP4}`);
    expect(byTestId("logs-note")!.textContent).toContain(`해결 처리됨: 묶음 ${FP}(해결 #21)`);
  });
});

describe("/logs entry detail: its two server scans run once per change", () => {
  const RID = "abcdabcdabcdabcd";
  const A2 = { ...A, request_id: RID };
  /** 상세의 두 훑기: 같은 요청 id 항목(7 d) · 같은 지문 묶음 */
  const scans = (from: number) => {
    const after = calls.slice(from).filter((c) => c.method === "GET");
    return { rid: after.filter((c) => c.url.startsWith("/api/v1/ops/logs?") && qs(c.url).get("rid") === RID).length, groups: after.filter((c) => c.url.startsWith("/api/v1/ops/logs/groups?")).length };
  };
  function routes() {
    const s = { done: false };
    stub(async (m, url, body) => {
      if (m === "POST") { s.done = true; return created(body, 21); }
      const a = { ...A2, resolved: s.done ? { id: 21, upto: TS_A, resolved_by: "op" } : null };
      if (url.startsWith(`/api/v1/ops/logs/${A.id}`)) { await new Promise((r) => setTimeout(r, 10)); return { status: 200, body: a }; } // 다시 읽기는 낙관적 표시 뒤에 온다
      if (url.startsWith("/api/v1/ops/logs/groups?")) return { status: 200, body: GROUPS([group(FP)]) };
      if (url.startsWith("/api/v1/ops/logs?")) return { status: 200, body: qs(url).get("rid") ? PAGE([a]) : PAGE(s.done ? [B] : [a, B]) };
      return undefined;
    });
    return s;
  }
  it("one resolve re-runs each scan once (the optimistic mark and the re-read entry are the same resolution)", async () => {
    routes();
    await open();
    const opened = calls.length;
    await click(allByTestId("log-row")[0]);
    expect(scans(opened)).toEqual({ rid: 1, groups: 1 });
    await click(button("해결 처리", byTestId("log-detail")!));
    const before = calls.length;
    await click(button("해결 처리 확인", byTestId("resolve-confirm")!));
    await settle(); await settle();
    expect(byTestId("log-detail-resolve")!.textContent).toContain("해결됨");
    expect(scans(before)).toEqual({ rid: 1, groups: 1 });
  });
  it("'해결된 항목 보기' re-runs only the fingerprint stats (they follow it), not the request-id scan (it always includes resolved entries)", async () => {
    routes();
    await open();
    await click(allByTestId("log-row")[0]);
    const before = calls.length;
    await click(button("해결된 항목 보기"));
    expect(byTestId("log-detail")).not.toBeNull();
    expect(scans(before)).toEqual({ rid: 0, groups: 1 });
  });
});
