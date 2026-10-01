/**
 * QA-307 — 운영 감사(audit) 탭이 첫 쪽(50건)만 그리고 next_cursor 를 버렸다: '더 보기'도, 잘렸다는 표시도 없었다(설정 변경 · 해결 기록이 로그인 · 로그아웃
 * 행에 밀려 화면에서 사라졌다). 이제 몇 건을 보이는지 · 앞선 기록이 남았는지 적고, next_cursor 가 있으면 '더 보기'로 이어 받는다(id 키셋 — api OpsController.auditLog).
 * - 15 s 주기가 첫 쪽을 다시 받아도 이어 받은 행은 남고 새 행은 위에 붙는다(겹치는 머리) — 겹치지 않으면(사이를 모름) 머리부터 다시 보이고 그렇다고 적는다.
 * - '더 보기'는 커서 하나에 한 번만, 실패는 보인 행을 두고 따로 적는다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installMiniDom } from "./helpers/mini-dom";
import { mounter, propsOf } from "./helpers/mount";
import { AUDIT_PAGE_LIMIT, auditCursor, auditPagePath, auditView, mergeAuditRows } from "@/lib/ops-audit";
import { domUtcLeaks } from "./helpers/kst-only";

describe("lib/ops-audit: cursor, path, merge, view", () => {
  it("cursor: a positive integer only; the next page asks for ids below it, 50 at a time", () => {
    expect(auditCursor(67)).toBe(67);
    for (const v of [null, undefined, 0, -1, 1.5, "67", Number.NaN]) expect(auditCursor(v)).toBeNull();
    expect(AUDIT_PAGE_LIMIT).toBe(50);
    expect(auditPagePath(67)).toBe("/api/v1/ops/audit?cursor=67&limit=50");
  });
  it("merge: one row per id, newest (largest id) first; rows without an id keep their order at the end", () => {
    expect(mergeAuditRows([{ id: 5, v: "new" }, { id: 4 }], [{ id: 5, v: "old" }, { id: 3 }, { x: 1 }]))
      .toEqual([{ id: 5, v: "new" }, { id: 4 }, { id: 3 }, { x: 1 }]);
  });
  const rows = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => ({ id: from - i }));
  it("view: no paging = the head as sent; paging = head merged on top of the rows already loaded", () => {
    expect(auditView({ items: rows(10, 6), next_cursor: 6 }, null)).toEqual({ rows: rows(10, 6), next: 6, reset: false });
    expect(auditView({ items: rows(10, 6), next_cursor: null }, null).next).toBeNull();
    expect(auditView(null, null)).toEqual({ rows: [], next: null, reset: false });
    // 이어 받은 뒤 새 기록 2건: 머리(12–8)가 쌓은 행(10–1)과 겹친다 → 12–1, 다음 = 쌓은 것의 다음
    const paged = { rows: rows(10, 1), next: null };
    expect(auditView({ items: rows(12, 8), next_cursor: 8 }, paged)).toEqual({ rows: rows(12, 1), next: null, reset: false });
    // 머리가 한 쪽 넘게 앞으로(겹침 없음): 사이를 모른다 → 머리만, reset
    expect(auditView({ items: rows(30, 26), next_cursor: 26 }, paged)).toEqual({ rows: rows(30, 26), next: 26, reset: true });
  });
});

const dom = installMiniDom();
(dom.document as unknown as { cookie: string }).cookie = "WAKELINE_CSRF=t";
const m = mounter(dom);
beforeAll(() => m.load());
afterAll(() => dom.restore());
afterEach(async () => { await m.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const row = (id: number, action = "LOGIN") => ({ id, username: "op", action, target: "op", before: null, after: null, ip: "127.0.0.1", request_id: `r${id}`, at: new Date(Date.UTC(2026, 9, 1, 0, 0, id)).toISOString() });
const page = (from: number, n: number, action?: string) => Array.from({ length: n }, (_, i) => row(from - i, action));
const BODY: Record<string, unknown> = {
  "/api/v1/ops/providers": { providers: [], active: {}, collector: {}, switches: [], budget_days: [] },
  "/api/v1/ops/runs?limit=50&resolved=hide": { items: [], summary_24h: [] },
  "/api/v1/ops/quality": { rule_counts: [], recent: [] },
  "/api/v1/ops/settings": { items: [] },
  "/api/v1/ops/dlq": { items: [] },
  "/api/v1/ops/pipeline": { collector: {}, api: {} },
};

function stub(audit: (url: string) => Response | Promise<Response>) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    if (url === "/api/v1/ops/session") return json(200, { username: "op" });
    if (url.startsWith("/api/v1/ops/audit")) return audit(url);
    return url in BODY ? json(200, BODY[url]) : json(404, { detail: "no such resource" });
  });
  return asked;
}
async function open() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: Date.parse("2026-10-01T03:00:00Z") });
  vi.stubGlobal("self", globalThis);
  await m.render(m.React.createElement((await import("@/app/ops/page")).default));
  await m.settle();
  await m.settle();
  await m.click(m.byTestId("ops-tab-audit"));
}
const tick = async () => { await m.act(() => { vi.advanceTimersByTime(15_000); }); await m.settle(); await m.settle(); };
/** 표의 행(머리 줄 빼고) → 감사 id(request 칸 "r<id>") */
const ids = () => m.findAll((e) => e.tagName === "TR").map((tr) => m.findAll((c) => c.tagName === "TD", tr)).filter((tds) => tds.length)
  .map((tds) => Number(tds[7].textContent.slice(1)));

describe("ops audit tab: says how many rows it shows, pages with the cursor, keeps paged rows across the 15 s refresh", () => {
  it("first page of 50 with next_cursor → count says older rows remain; '더 보기' asks for ids below the cursor and appends; the end is said", async () => {
    let head: unknown = { items: page(200, 50), next_cursor: 151 };
    const asked = stub((url) => {
      if (url === "/api/v1/ops/audit") return json(200, head);
      if (url === "/api/v1/ops/audit?cursor=151&limit=50") return json(200, { items: page(150, 50, "SETTING_UPDATE"), next_cursor: 101 });
      if (url === "/api/v1/ops/audit?cursor=101&limit=50") return json(200, { items: page(100, 3, "RESOLVE"), next_cursor: null });
      return json(404, { detail: "no" });
    });
    await open();
    expect(ids()).toHaveLength(50);
    expect(m.byTestId("audit-count")!.textContent).toBe("최신순 50건 — 앞선 기록이 남음(아래 단추로 이어 받음)");
    const more = m.byTestId("audit-more")!;
    expect(more.textContent).toBe("더 보기(이전 50건)");

    // 같은 프레임에 두 번 눌러도 한 번만 보낸다
    await m.act(() => { void propsOf(more).onClick(); void propsOf(more).onClick(); });
    await m.settle();
    expect(asked.filter((u) => u === "/api/v1/ops/audit?cursor=151&limit=50")).toHaveLength(1);
    expect(ids()).toHaveLength(100);
    expect(ids()[0]).toBe(200);
    expect(ids()[99]).toBe(101);

    // 15 s 주기: 새 기록 2건(머리가 쌓은 행과 겹친다) → 위에 붙고 이어 받은 행은 남는다
    head = { items: page(202, 50), next_cursor: 153 };
    await tick();
    expect(ids()).toHaveLength(102);
    expect(ids().slice(0, 3)).toEqual([202, 201, 200]);
    expect(m.byTestId("audit-reset")).toBeNull();

    // 끝까지
    await m.click(m.byTestId("audit-more"));
    expect(asked).toContain("/api/v1/ops/audit?cursor=101&limit=50");
    expect(ids()).toHaveLength(105);
    expect(ids()[104]).toBe(98);
    expect(m.byTestId("audit-more")).toBeNull();
    expect(m.byTestId("audit-count")!.textContent).toBe("최신순 105건 — 처음 기록까지 모두");

    // 머리가 한 쪽 넘게 앞으로(겹치지 않음): 사이를 모른다 — 머리만 보이고 그렇다고 적는다
    head = { items: page(400, 50), next_cursor: 351 };
    await tick();
    expect(ids()).toHaveLength(50);
    expect(ids()[0]).toBe(400);
    expect(m.byTestId("audit-reset")!.textContent).toContain("사이를 이어 붙일 수 없음");
    expect(m.byTestId("audit-more")).not.toBeNull();
  });

  it("a failed '더 보기' keeps the rows shown and says so (with the request id); the button works again", async () => {
    let fail = true;
    stub((url) => {
      if (url === "/api/v1/ops/audit") return json(200, { items: page(60, 50), next_cursor: 11 });
      if (fail) return json(503, { detail: "unavailable", request_id: "feedface0000beef" });
      return json(200, { items: page(10, 10), next_cursor: null });
    });
    await open();
    await m.click(m.byTestId("audit-more"));
    expect(ids()).toHaveLength(50);
    expect(m.byTestId("audit-more-failed")!.textContent).toContain("앞선 감사 기록을 불러오지 못함(보인 행은 그대로)");
    expect(m.byTestId("audit-more-failed")!.textContent).toContain("feedface0000beef");
    fail = false;
    await m.click(m.byTestId("audit-more"));
    expect(ids()).toHaveLength(60);
    expect(m.byTestId("audit-more-failed")).toBeNull();
  });

  it("an api without next_cursor (one page) shows no button and says it is the whole log", async () => {
    stub(() => json(200, { items: page(3, 3) }));
    await open();
    expect(ids()).toEqual([3, 2, 1]);
    expect(m.byTestId("audit-more")).toBeNull();
    expect(m.byTestId("audit-count")!.textContent).toBe("최신순 3건 — 처음 기록까지 모두");
  });
});

/**
 * QA-311 — 감사의 before · after 칸은 api 가 기록한 JSON 글자(안의 시각은 '…Z' = UTC)인데, 같은 화면의 다른 원본 칸(격리 detail · DLQ payload · 실행 오류)과 달리
 * 원본 표시(data-raw · 머리글 "(raw)" · 툴팁)가 없어 UTC 시각을 KST 로 읽게 했다(계약 v5 §G20 — 원문은 글자 그대로, 표시로 예외를 밝힌다).
 */
describe("ops audit before/after are marked as raw like the other raw columns (QA-311)", () => {
  it("headers say (raw) with the UTC note; cells are data-raw and keep the api's text unchanged; nothing else leaks UTC", async () => {
    const before = JSON.stringify({ id: 3, key: "opensky", upto: "2026-10-01T17:54:22Z", resolved_at: "2026-10-01T17:56:09.181606Z" });
    const after = JSON.stringify({ id: 3, revoked_at: "2026-10-01T17:56:09.814402Z" });
    stub(() => json(200, { items: [{ ...row(70, "UNRESOLVE"), target: "provider_error:opensky", before, after }, row(69)], next_cursor: null }));
    await open();
    const ths = m.findAll((e) => e.tagName === "TH").map((e) => [e.textContent, e.getAttribute("title") ?? ""] as const);
    for (const name of ["before (raw)", "after (raw)"]) {
      const th = ths.find(([t]) => t === name);
      expect(th, name).toBeDefined();
      expect(th![1]).toContain("‘…Z’ 는 KST 보다 9시간 이르다");
    }
    const tds = m.findAll((e) => e.tagName === "TR").map((tr) => m.findAll((c) => c.tagName === "TD", tr)).filter((t) => t.length);
    expect(tds[0][4].textContent).toBe(before);
    expect(tds[0][5].textContent).toBe(after);
    expect([tds[0][4].getAttribute("data-raw"), tds[0][5].getAttribute("data-raw")]).toEqual(["record", "record"]);
    expect(tds[1][4].getAttribute("title")).toBeNull(); // 값이 없는 칸(null)에는 툴팁을 달지 않는다
    expect(domUtcLeaks(m.byTestId("ops-dashboard")!)).toEqual([]);
  });
});
