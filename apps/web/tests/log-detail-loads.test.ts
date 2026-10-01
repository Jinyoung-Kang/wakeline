/**
 * 로그 항목 상세의 두 조회 — 같은 요청 id 의 다른 항목 · 같은 지문 묶음 통계(characterization: useApiResource 로 옮기기 전에 지금 동작을 고정한다).
 * 요청(기간 · 해결 표시 · 상한), 받는 중 · 없음 · 목록 · 더 있음 · 실패 · 세션 확인(401/404), 요청 id · 지문이 없을 때.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter } from "./helpers/mount";
import type { LogEntry } from "@/lib/logs";

const dom = installMiniDom();
const m = mounter(dom);
let L: typeof import("@/lib/logs");
let LogDetail: typeof import("@/components/logs/LogDetail").LogDetail;
beforeAll(async () => { await m.load(); L = await import("@/lib/logs"); ({ LogDetail } = await import("@/components/logs/LogDetail")); });
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const NOW = Date.parse("2026-09-29T02:00:00Z");
const T = (min: number) => `${NOW - min * 60_000}-0`;
const FP = "0123456789abcdef", RID = "5f2c9a0e1b7d4c3a";
const raw = (id: string, o: Record<string, unknown> = {}) => ({
  id, v: 1, ts: new Date(Number(id.split("-")[0])).toISOString(), service: "api", instance: "api-1", level: "ERROR", logger: "x.Y", thread: "t",
  message: `failure ${id}`, exception: null, fp: FP, request_id: RID, context: {}, suppressed: 0, ...o,
});
const entryOf = (o: Record<string, unknown> = {}): LogEntry => L.parseLogEntry(raw(T(1), o))!;
const group = (o: Record<string, unknown> = {}) => ({ fp: FP, service: "api", level: "ERROR", logger: "x.Y", exception_type: null, sample_message: "failure", count: 17, suppressed: 40,
  first_at: "2026-09-29T01:00:00Z", last_at: "2026-09-29T01:59:00Z", last_id: T(1), ...o });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Route = (url: string) => Response | Promise<Response>;
function stub(route: Route) {
  const calls: string[] = [];
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("location", { origin: "http://localhost:8700" });
  vi.stubGlobal("fetch", (url: string) => { calls.push(url); return Promise.resolve(route(url)); });
  return calls;
}
const authMisses: unknown[] = [];
const noop = () => {};
/** 부모(LogsDashboard)처럼 같은 함수를 계속 준다(useCallback) */
const onAuthMiss = async (e: unknown) => { authMisses.push(e); return "error" as const; };
const props = (entry: LogEntry, o: Partial<{ period: "1h" | "24h" | "7d"; resolvedMode: "hide" | "show" }> = {}) => ({
  entry, period: o.period ?? "1h", resolvedMode: o.resolvedMode ?? "hide", onClose: noop, onOpen: noop, onFilterFp: noop, onFilterRid: noop, onCopy: noop,
  onAuthMiss, onResolveChanged: noop,
});
const render = (entry: LogEntry, o?: Parameters<typeof props>[1]) => m.render(m.React.createElement(LogDetail, props(entry, o)));
const fpText = () => m.byTestId("log-fp-stats")!.textContent;
const relatedBlock = () => dom.container.textContent.split("같은 요청 id 의 다른 항목")[1] ?? "";
const q = (url: string) => new URL(url, "http://x").searchParams;

describe("log detail: same request id entries (characterization)", () => {
  it("asks for that request id over 7 d with resolved entries, at most 50; lists the others (not itself); '불러오는 중…' before", async () => {
    let answer!: (r: Response) => void;
    const calls = stub((url) => (url.startsWith("/api/v1/ops/logs?") ? new Promise<Response>((r) => { answer = r; }) as never : json(200, { groups: [] })));
    await render(entryOf());
    const rel = calls.find((c) => c.startsWith("/api/v1/ops/logs?"))!;
    expect([q(rel).get("rid"), q(rel).get("resolved"), q(rel).get("limit"), q(rel).get("since")]).toEqual([RID, "show", "50", new Date(NOW - 7 * 86_400_000).toISOString()]);
    expect(relatedBlock()).toContain("불러오는 중…");
    answer(json(200, { items: [raw(T(1)), raw(T(2), { message: "other one" })], next_cursor: null, scanned: 9, scan_truncated: false }));
    await m.settle();
    expect(m.allByTestId("log-related").map((r) => r.textContent.includes("other one"))).toEqual([true]);
    expect(relatedBlock()).not.toContain("더 있을 수 있음");
  });
  it("only itself → 없음; a next cursor or a truncated scan → 더 있을 수 있음", async () => {
    stub((url) => (url.startsWith("/api/v1/ops/logs?") ? json(200, { items: [raw(T(1))], next_cursor: T(1), scanned: 9, scan_truncated: false }) : json(200, { groups: [] })));
    await render(entryOf());
    await m.settle();
    expect(m.allByTestId("log-related")).toHaveLength(0);
    expect(relatedBlock()).toContain("없음");
    expect(relatedBlock()).toContain("더 있을 수 있음(목록 상한 50건 또는 스캔 잘림)");
  });
  it("a failure is shown with its request id; 401/404 also asks the session check", async () => {
    authMisses.length = 0;
    stub((url) => (url.startsWith("/api/v1/ops/logs?") ? json(404, { detail: "not found", request_id: "aaaabbbbccccdddd" }) : json(200, { groups: [] })));
    await render(entryOf());
    await m.settle();
    expect(relatedBlock()).toContain("aaaabbbbccccdddd");
    expect(authMisses).toHaveLength(1);
  });
  it("no request id → 요청 id 없음 and nothing asked", async () => {
    const calls = stub(() => json(200, { groups: [] }));
    await render(entryOf({ request_id: null }));
    await m.settle();
    expect(relatedBlock()).toContain("요청 id 없음");
    expect(calls.filter((c) => c.startsWith("/api/v1/ops/logs?"))).toEqual([]);
  });
});

describe("log detail: same fingerprint group (characterization)", () => {
  it("asks the groups of that service and level over the list's period and resolved mode; shows the group's line", async () => {
    let answer!: (r: Response) => void;
    const calls = stub((url) => (url.startsWith("/api/v1/ops/logs/groups?") ? new Promise<Response>((r) => { answer = r; }) as never : json(200, { items: [] })));
    await render(entryOf(), { period: "24h", resolvedMode: "show" });
    expect(fpText()).toBe("불러오는 중…");
    const g = calls.find((c) => c.startsWith("/api/v1/ops/logs/groups?"))!;
    expect([q(g).get("service"), q(g).get("level"), q(g).get("resolved"), q(g).get("since")]).toEqual(["api", "ERROR", "show", new Date(NOW - 86_400_000).toISOString()]);
    answer(json(200, { groups: [group()], scanned: 40, scan_truncated: false }));
    await m.settle();
    expect(fpText()).toBe("항목 17건 · 억제 합 40 · 처음 09-29 10:00:00 KST · 마지막 09-29 10:59:00 KST");
  });
  it("not in the period's groups → 이 기간의 묶음에 없음 (+ 스캔 상한에서 잘림 when the scan was cut)", async () => {
    stub((url) => (url.startsWith("/api/v1/ops/logs/groups?") ? json(200, { groups: [group({ fp: "fedcba9876543210" })], scanned: 40, scan_truncated: true }) : json(200, { items: [] })));
    await render(entryOf());
    await m.settle();
    expect(fpText()).toBe("이 기간의 묶음에 없음(스캔 상한에서 잘림)");
  });
  it("a failure is shown with its request id; 401/404 also asks the session check; no fingerprint → 지문 없음, nothing asked", async () => {
    authMisses.length = 0;
    stub((url) => (url.startsWith("/api/v1/ops/logs/groups?") ? json(401, { detail: "no", request_id: "1111222233334444" }) : json(200, { items: [] })));
    await render(entryOf());
    await m.settle();
    expect(fpText()).toContain("1111222233334444");
    expect(authMisses).toHaveLength(1);
    await m.unmount();
    const calls = stub(() => json(200, { items: [] }));
    await render(entryOf({ fp: null }));
    await m.settle();
    expect(fpText()).toBe("지문 없음");
    expect(calls.filter((c) => c.startsWith("/api/v1/ops/logs/groups?"))).toEqual([]);
  });
  it("another resolved mode or period asks again and shows the new answer; the same entry re-rendered does not ask again", async () => {
    let count = 17;
    const calls = stub((url) => (url.startsWith("/api/v1/ops/logs/groups?") ? json(200, { groups: [group({ count: count++ })], scanned: 40, scan_truncated: false }) : json(200, { items: [] })));
    const entry = entryOf();
    await render(entry);
    await m.settle();
    await render(entry);
    await m.settle();
    expect(calls.filter((c) => c.startsWith("/api/v1/ops/logs/groups?"))).toHaveLength(1);
    await render(entry, { resolvedMode: "show" });
    await m.settle();
    expect(fpText()).toContain("항목 18건");
    await render(entry, { resolvedMode: "show", period: "7d" });
    await m.settle();
    expect(fpText()).toContain("항목 19건");
    const groupsCalls = calls.filter((c) => c.startsWith("/api/v1/ops/logs/groups?")).map((c) => [q(c).get("resolved"), q(c).get("since")]);
    expect(groupsCalls).toEqual([["hide", new Date(NOW - 3_600_000).toISOString()], ["show", new Date(NOW - 3_600_000).toISOString()], ["show", new Date(NOW - 7 * 86_400_000).toISOString()]]);
  });
  it("a new resolution on the entry asks both again", async () => {
    const calls = stub((url) => (url.startsWith("/api/v1/ops/logs/groups?") ? json(200, { groups: [group()] }) : json(200, { items: [] })));
    await render(entryOf());
    await m.settle();
    await render(entryOf({ resolved: { id: 12, upto: "2026-09-29T01:59:00Z", resolved_by: "op" } }));
    await m.settle();
    expect([calls.filter((c) => c.startsWith("/api/v1/ops/logs/groups?")).length, calls.filter((c) => c.startsWith("/api/v1/ops/logs?")).length]).toEqual([2, 2]);
  });
});

// 상세의 두 목록은 지금 화면이 묻는 것의 답만 보인다(useApiResource 의 열쇠별 결과): 해결 표시 · 기간을 바꾸면 머리글은 곧바로 새 값을 말하는데
// 숫자는 앞 값이었다(새 머리글 아래 다른 조건의 수). 해결 처리 뒤 다시 읽는 동안에도 해결 전 목록을 지금 것처럼 두지 않는다. 앞 읽기의 실패도 새 읽기에 남기지 않는다.
describe("log detail: the lists show only the answer for what is on screen", () => {
  type Hold = { url: string; answer: (r: Response) => void };
  function holding() {
    const held: Hold[] = [];
    const calls = stub((url) => new Promise<Response>((answer) => { held.push({ url, answer }); }) as never);
    const answer = (prefix: string, r: Response) => { const h = held.filter((x) => x.url.startsWith(prefix)).at(-1)!; h.answer(r); };
    return { calls, answer };
  }
  it("another resolved mode: '불러오는 중…' under the new heading until its answer — not the previous mode's numbers", async () => {
    const { answer } = holding();
    const entry = entryOf();
    await render(entry);
    answer("/api/v1/ops/logs/groups?", json(200, { groups: [group({ count: 17 })] }));
    await m.settle();
    expect(fpText()).toContain("항목 17건");
    await render(entry, { resolvedMode: "show" });
    await m.settle();
    expect(dom.container.textContent).toContain("해결된 항목 포함");
    expect(fpText()).toBe("불러오는 중…");
    answer("/api/v1/ops/logs/groups?", json(200, { groups: [group({ count: 20 })] }));
    await m.settle();
    expect(fpText()).toContain("항목 20건");
  });
  it("after a resolution the same-request list re-reads with '불러오는 중…', not the list from before the resolution", async () => {
    const { answer } = holding();
    await render(entryOf());
    answer("/api/v1/ops/logs?", json(200, { items: [raw(T(1)), raw(T(2), { message: "other one" })], next_cursor: null }));
    await m.settle();
    expect(m.allByTestId("log-related")).toHaveLength(1);
    await render(entryOf({ resolved: { id: 12, upto: "2026-09-29T01:59:00Z", resolved_by: "op" } }));
    await m.settle();
    expect(m.allByTestId("log-related")).toHaveLength(0);
    expect(relatedBlock()).toContain("불러오는 중…");
  });
  it("a failed read's error is not shown while the next read (another period) loads", async () => {
    const { answer } = holding();
    const entry = entryOf();
    await render(entry);
    answer("/api/v1/ops/logs/groups?", json(503, { detail: "down", request_id: "9999888877776666" }));
    await m.settle();
    expect(fpText()).toContain("9999888877776666");
    await render(entry, { period: "24h" });
    await m.settle();
    expect(fpText()).toBe("불러오는 중…");
  });
});
