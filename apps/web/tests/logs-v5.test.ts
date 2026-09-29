/**
 * 계약 v5 §C7 시스템 로그 화면(/logs)과 §C2 로그 싱크 자기 지표(pipeline 탭). 순수 함수는 직접, 화면은 renderToStaticMarkup · 최소 DOM 마운트.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as opsLib from "@/lib/ops";
import { OpsPipeline } from "@/components/OpsPipeline";

describe("v5-C2 pipeline tab: log sink rows (sent · dropped · suppressed)", () => {
  const resp = {
    collector: { publish_dropped: 0, log_sent: 42, log_dropped: 3, heartbeat_age_s: 2 },
    ais: { dropped_total: 0, log_sent: 7, log_dropped: 0 },
    api: { dlq: 0, log_sent: 120, log_dropped: 0, log_suppressed: 31 },
    generated_at: "2026-09-29T01:00:00Z",
  };
  const rows = opsLib.pipelineRows(resp);
  const by = (g: string, k: string) => rows.find((r) => r.group === g && r.key === k);
  it("dropped log entries are loss rows (red when > 0); sent and suppressed are neutral counts", () => {
    expect(by("collector", "log_dropped")).toMatchObject({ value: 3, tone: "bad", text: "3" });
    expect(by("ais", "log_dropped")).toMatchObject({ value: 0, tone: "ok" });
    expect(by("api", "log_dropped")).toMatchObject({ value: 0, tone: "ok" });
    expect(by("collector", "log_sent")).toMatchObject({ value: 42, tone: "muted" });
    expect(by("ais", "log_sent")).toMatchObject({ value: 7, tone: "muted" });
    expect(by("api", "log_sent")).toMatchObject({ value: 120, tone: "muted", text: "120" });
    expect(by("api", "log_suppressed")).toMatchObject({ value: 31, tone: "muted" }); // 억제는 손실이 아니다(건수는 항목의 suppressed 에)
    expect(by("api", "log_suppressed")!.title).toMatch(/suppressed/);
    expect(opsLib.pipelineLossCount(resp)).toBe(1);
  });
  it("log_dropped tooltips name every cause the senders count, not only the queue cap", () => {
    // collector·ais(logsink.py): 대기열 상한 초과 · 항목을 만들지 못함(예외 · 8 KiB 에 맞추지 못함). api(LogSink): 대기열 상한 초과 · 종료 때 남은 항목
    for (const g of ["collector", "ais"]) {
      const t = by(g, "log_dropped")!.title;
      expect(t).toContain("대기열 상한(500건 · 2 MiB)");
      expect(t).toContain("항목을 만들지 못함");
      expect(t).not.toMatch(/^로그 대기열 상한\(500건 · 2 MiB\)으로 버린/);
    }
    const api = by("api", "log_dropped")!.title;
    expect(api).toContain("대기열 상한(500건 · 2 MiB)");
    expect(api).toContain("종료 때 보내지 못한 항목");
    // §G9: 억제 중인 발생이 있는 지문을 지문 표 상한에서 잊으면 그 발생(억제 수까지)을 버림으로 센다 — 세 프로세스 모두. api 도 항목 생성 실패를 센다
    for (const g of ["collector", "ais", "api"]) expect(by(g, "log_dropped")!.title).toContain("억제 중에 지문 표에서 밀려난 발생");
    expect(api).toContain("항목을 만들지 못함");
  });
  it("v5-G9: suppression is not only carried by a next entry — the last suppressed occurrence is sent when the 10 s window closes", () => {
    const t = by("api", "log_suppressed")!.title;
    expect(t).toContain("다음 항목이 오지 않으면 창(10 s)이 닫힐 때 마지막 억제 발생을 항목으로 보낸다");
    expect(t).toContain("계약 v5 §G9");
    expect(t).not.toMatch(/건수는 다음 항목의 suppressed 에 — 누적$/); // 예전 문구: 다음 항목에만 실린다고 읽혔다
  });
  it("an api / heartbeat without the fields (older lane, stale heartbeat → null) shows —, never 0", () => {
    const old = opsLib.pipelineRows({ collector: {}, ais: { log_dropped: null }, api: {} });
    for (const [g, k] of [["collector", "log_sent"], ["collector", "log_dropped"], ["ais", "log_dropped"], ["api", "log_suppressed"]]) {
      expect(old.find((r) => r.group === g && r.key === k)).toMatchObject({ value: null, text: "—", tone: "muted" });
    }
  });
  it("the tab renders the rows with their keys", () => {
    const html = renderToStaticMarkup(createElement(OpsPipeline, { data: resp }));
    expect(html).toMatch(/data-key="log_dropped" data-tone="bad"/);
    expect(html.match(/data-key="log_sent"/g)).toHaveLength(3);
    expect(html).toContain("log_suppressed");
  });
});

// ---- §C7 순수 함수(lib/logs.ts) ----

/** schemas/log_event.v1.json 형식의 항목 + 스트림 id */
const entry = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "1790000000000-0", v: 1, ts: "2026-09-29T01:02:03.456Z", service: "api", instance: "api-7f9c:1", level: "ERROR",
  logger: "dev.wakeline.ingest.StreamConsumer", thread: "stream-consumer-1",
  message: "apply failed for ship 440123456\nsecond line", exception: { type: "java.lang.IllegalStateException", message: "boom", stack: "java.lang.IllegalStateException: boom\n\tat dev.wakeline.X.y(X.java:10)" },
  fp: "0123456789abcdef", request_id: "5f2c9a0e1b7d4c3a", context: { job: "ship-apply", attempt: 2 }, suppressed: 3, ...o,
});

describe("v5-C7 lib/logs: parsing (unknown stays null, malformed entries are counted, not shown)", () => {
  it("a page keeps valid entries, counts malformed ones, and reads cursor / scan facts as given", async () => {
    const L = await import("@/lib/logs");
    const page = L.parseLogPage({
      items: [entry(), entry({ id: "not-an-id" }), entry({ id: "1790000000001-0", level: "INFO" }), entry({ id: "1790000000002-0", suppressed: undefined, request_id: null, exception: null, context: { big: { nested: 1 }, ok: "x" } }), "junk"],
      next_cursor: "1789999999999-3", scanned: 812, scan_truncated: false, invalid: 2,
    });
    expect(page.items.map((e) => e.id)).toEqual(["1790000000000-0", "1790000000002-0"]);
    expect(page.invalid).toBe(3); // 화면에서 버린 수
    expect(page.serverInvalid).toBe(2); // api 가 읽을 때 건너뛴 수(§C4)
    expect([page.nextCursor, page.scanned, page.scanTruncated]).toEqual(["1789999999999-3", 812, false]);
    const e = page.items[1];
    expect(e.suppressed).toBeNull(); // 없음 = 모름(0 으로 채우지 않는다)
    expect(e.request_id).toBeNull();
    expect(e.exception).toBeNull();
    expect(e.context).toEqual({ ok: "x" });
    expect(e.untrusted).toBe(false);
    expect(L.parseLogPage({ items: [] })).toMatchObject({ items: [], nextCursor: null, scanned: null, scanTruncated: null, serverInvalid: null });
    expect(L.parseLogPage(null).items).toEqual([]);
  });
  it("'이전 항목 더 보기' appends a page: both skipped counts are summed over the loaded pages (same scope), cursor and scan facts are the last request's", async () => {
    const L = await import("@/lib/logs");
    const a = L.parseLogPage({ items: [entry(), "junk"], next_cursor: "1789999999999-0", scanned: 3000, scan_truncated: true, invalid: 2 });
    const b = L.parseLogPage({ items: [entry(), entry({ id: "1789999999998-0" }), entry({ id: "bad" })], next_cursor: null, scanned: 40, scan_truncated: false, invalid: 5 });
    expect(a.pages).toBe(1);
    const m = L.appendLogPage(a, b);
    expect(m.items.map((e) => e.id)).toEqual(["1790000000000-0", "1789999999998-0"]); // 겹친 항목은 한 번
    expect([m.pages, m.invalid, m.serverInvalid]).toEqual([2, 2, 7]);
    expect([m.nextCursor, m.scanned, m.scanTruncated]).toEqual([null, 40, false]);
    // api 값을 모르는 쪽이 있으면 합도 모른다(아는 쪽만 더해 전체처럼 보이지 않는다)
    expect(L.appendLogPage(a, L.parseLogPage({ items: [] })).serverInvalid).toBeNull();
    expect(L.appendLogPage(L.parseLogPage({ items: [] }), a).serverInvalid).toBeNull();
  });
  it("groups keep count / suppressed / first / last as given", async () => {
    const L = await import("@/lib/logs");
    const g = L.parseLogGroups({ groups: [{ fp: "0123456789abcdef", service: "api", level: "ERROR", logger: "x.Y", exception_type: null, sample_message: "boom", count: 12, suppressed: 30, first_at: "2026-09-29T00:00:00Z", last_at: "2026-09-29T01:00:00Z", last_id: "1790000000000-0" }, { nope: 1 }], scanned: 3000, scan_truncated: true });
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0]).toMatchObject({ fp: "0123456789abcdef", count: 12, suppressed: 30, exception_type: null });
    expect([g.scanned, g.scanTruncated, g.invalid]).toEqual([3000, true, 1]);
  });
});

describe("v5-C7 lib/logs: requests follow §C4", () => {
  it("list: services comma-joined, level, since from the period, q trimmed, rid only when well-formed, fp, cursor, limit", async () => {
    const L = await import("@/lib/logs");
    const now = Date.parse("2026-09-29T02:00:00Z");
    const url = L.logsUrl({ services: ["api", "collector"], level: "ERROR", period: "6h", q: "  timeout ", rid: "5f2c9a0e1b7d4c3a", fp: "0123456789abcdef" }, now, { cursor: "1790000000000-0", limit: 100 });
    const u = new URL(url, "http://x");
    expect(u.pathname).toBe("/api/v1/ops/logs");
    expect(Object.fromEntries(u.searchParams)).toEqual({ service: "api,collector", level: "ERROR", since: "2026-09-28T20:00:00.000Z", q: "timeout", rid: "5f2c9a0e1b7d4c3a", fp: "0123456789abcdef", cursor: "1790000000000-0", limit: "100" });
    const plain = new URL(L.logsUrl(L.DEFAULT_LOG_FILTER, now), "http://x");
    expect(Object.fromEntries(plain.searchParams)).toEqual({ since: "2026-09-29T01:00:00.000Z", limit: "100" }); // 기본: 전체 서비스·수준, 1 h
    const badRid = new URL(L.logsUrl({ ...L.DEFAULT_LOG_FILTER, rid: "<x>" }, now), "http://x");
    expect(badRid.searchParams.has("rid")).toBe(false);
    expect(L.logsUrl(L.DEFAULT_LOG_FILTER, now, { limit: 999 })).toContain("limit=200");
    const g = new URL(L.logGroupsUrl({ ...L.DEFAULT_LOG_FILTER, services: ["ais"], level: "WARN", period: "7d" }, now), "http://x");
    expect(g.pathname).toBe("/api/v1/ops/logs/groups");
    expect(Object.fromEntries(g.searchParams)).toEqual({ since: "2026-09-22T02:00:00.000Z", service: "ais", level: "WARN" });
    expect(L.logItemUrl("1790000000000-0")).toBe("/api/v1/ops/logs/1790000000000-0");
    expect(L.validRid("5f2c9a0e")).toBe(true);
    expect(L.validRid("short")).toBe(false);
  });
  it("hash links: #rid= opens the list filtered by that request id over 7 d, #id= opens one entry, #fp= a group", async () => {
    const L = await import("@/lib/logs");
    expect(L.parseLogsHash("#rid=5f2c9a0e1b7d4c3a")).toEqual({ rid: "5f2c9a0e1b7d4c3a" });
    expect(L.parseLogsHash("#id=1790000000000-0")).toEqual({ id: "1790000000000-0" });
    expect(L.parseLogsHash("#fp=0123456789abcdef")).toEqual({ fp: "0123456789abcdef" });
    expect(L.parseLogsHash("#rid=%3Cscript%3E&id=x")).toEqual({});
    expect(L.parseLogsHash("")).toEqual({});
  });
});

describe("v5-C7 lib/logs: new entries wait behind a button", () => {
  it("stream ids compare numerically (ms, then sequence)", async () => {
    const L = await import("@/lib/logs");
    expect(L.streamIdCmp("1790000000000-10", "1790000000000-9")).toBe(1);
    expect(L.streamIdCmp("999-0", "1000-0")).toBe(-1);
    expect(L.streamIdCmp("5-5", "5-5")).toBe(0);
  });
  it("fresh first page → only entries newer than the top shown row are pending; a full page means there may be more", async () => {
    const L = await import("@/lib/logs");
    const P = L.parseLogPage;
    const shown = P({ items: [entry({ id: "1790000000005-0" }), entry({ id: "1790000000004-0" })] }).items;
    const fresh = P({ items: [entry({ id: "1790000000007-0" }), entry({ id: "1790000000006-0" }), entry({ id: "1790000000005-0" })] }).items;
    const p = L.pendingEntries(shown, fresh, 100);
    expect(p.items.map((e) => e.id)).toEqual(["1790000000007-0", "1790000000006-0"]);
    expect(p.more).toBe(false);
    const full = L.pendingEntries(shown, fresh.slice(0, 2), 2); // 한 쪽이 모두 새 항목 → 그 뒤에도 있을 수 있다
    expect(full.more).toBe(true);
    expect(L.pendingEntries([], fresh, 100).items).toHaveLength(3);
    // 반영: 위에 붙이고 겹치는 id 는 한 번만
    expect(L.applyPending(shown, p.items).map((e) => e.id)).toEqual(["1790000000007-0", "1790000000006-0", "1790000000005-0", "1790000000004-0"]);
  });
});

describe("v5-C7 lib/logs: copy formats", () => {
  it("entry text: first line [ts LEVEL service/logger] rid=…, then message, exception, stack, then the facts", async () => {
    const L = await import("@/lib/logs");
    const e = L.parseLogPage({ items: [entry()] }).items[0];
    const t = L.logText(e).split("\n");
    expect(t[0]).toBe("[2026-09-29T10:02:03.456+09:00 ERROR api/dev.wakeline.ingest.StreamConsumer] rid=5f2c9a0e1b7d4c3a"); // KST(+09:00) — 운영·로그 화면
    expect(t.slice(1, 3)).toEqual(["apply failed for ship 440123456", "second line"]);
    expect(t[3]).toBe("예외 java.lang.IllegalStateException: boom");
    expect(t.slice(4, 6)).toEqual(["java.lang.IllegalStateException: boom", "\tat dev.wakeline.X.y(X.java:10)"]);
    expect(t[6]).toBe("id=1790000000000-0 · fp=0123456789abcdef · instance=api-7f9c:1 · thread=stream-consumer-1 · 억제 3");
    expect(t[7]).toBe("context: job=ship-apply · attempt=2");
    const bare = L.parseLogPage({ items: [entry({ request_id: null, exception: null, suppressed: undefined, context: {}, thread: null, service: "web-client", untrusted: true })] }).items[0];
    const b = L.logText(bare).split("\n");
    expect(b[0]).toMatch(/ rid=—$/);
    expect(b).not.toContain("예외");
    expect(b[b.length - 1]).toBe("id=1790000000000-0 · fp=0123456789abcdef · instance=api-7f9c:1 · thread=— · 억제 — · 브라우저가 보낸 내용(검증 안 됨)");
  });
  it("list text joins entries with a blank line; ndjson is one JSON object per line with the stream id", async () => {
    const L = await import("@/lib/logs");
    const items = L.parseLogPage({ items: [entry(), entry({ id: "1789999999999-0", level: "WARN", exception: null })] }).items;
    expect(L.logsText(items).split("\n\n")).toHaveLength(2);
    const lines = L.logsNdjson(items).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toEqual(entry({ id: "1789999999999-0", level: "WARN", exception: null })); // api 가 준 그대로(화면용 정리 없음)
    expect(JSON.parse(L.logJson(items[0]))).toEqual(entry());
    expect(L.logsNdjson(items).endsWith("\n")).toBe(true);
    expect(L.logsFileName("ndjson", Date.parse("2026-09-29T01:02:03Z"))).toBe("wakeline-logs-20260929T100203+0900.ndjson");
  });
  it("group text: header with count, suppressed, first/last and how complete the attached entries are", async () => {
    const L = await import("@/lib/logs");
    const g = L.parseLogGroups({ groups: [{ fp: "0123456789abcdef", service: "api", level: "ERROR", logger: "x.Y", exception_type: "java.io.IOException", sample_message: "read timed out", count: 12, suppressed: 30, first_at: "2026-09-29T00:00:00Z", last_at: "2026-09-29T01:00:00Z", last_id: "1790000000000-0" }] }).groups[0];
    const items = L.parseLogPage({ items: [entry()] }).items;
    const t = L.groupText(g, items, { truncated: true });
    expect(t.split("\n")[0]).toBe("[묶음 fp=0123456789abcdef ERROR api/x.Y] 항목 12건 · 억제 합 30 · 처음 2026-09-29T09:00:00.000+09:00 · 마지막 2026-09-29T10:00:00.000+09:00");
    expect(t).toContain("예외 종류 java.io.IOException");
    expect(t).toContain("표본 메시지 read timed out");
    expect(t).toContain("아래 항목 1건 — 묶음의 일부만(목록 상한 또는 스캔 잘림)");
    expect(t).toContain(L.logText(items[0]));
  });
  it("list time is KST with milliseconds (UTC on the second line); first line of a message", async () => {
    const L = await import("@/lib/logs");
    const T = await import("@/lib/time");
    expect(T.dualCell("2026-09-29T01:02:03.456Z", { ms: true })).toMatchObject({ kst: "09-29 10:02:03.456", utc: "01:02:03.456 UTC" });
    expect(T.dualCell("bad", { ms: true })).toBeNull();
    expect(L.firstLine("a\r\nb")).toBe("a");
  });
});

describe("v5-C7 lib/logs: AIS reception gaps table rows", () => {
  it("closed gaps get an exact length, the open one is on top as '진행 중' up to the response time; no scope = all regions", async () => {
    const L = await import("@/lib/logs");
    const r = L.aisGapRows({
      from: "2026-09-28T02:00:00Z", to: "2026-09-29T02:00:00Z", truncated: false,
      items: [
        { started_at: "2026-09-28T10:00:00Z", ended_at: "2026-09-28T10:03:05Z", reason: "ws closed 1006", provider: "aisstream", scope: "30,120,40,135" },
        { started_at: "2026-09-28T12:00:00Z", ended_at: "2026-09-28T13:00:00Z", reason: null, provider: null },
        { started_at: "bad" },
      ],
      open: { started_at: "2026-09-29T01:50:00Z", reason: "no messages 120 s" },
    });
    expect(r.rows.map((x) => [x.open, x.startedAt, x.durationS, x.scope, x.reason])).toEqual([
      [true, "2026-09-29T01:50:00Z", 600, null, "no messages 120 s"],
      [false, "2026-09-28T12:00:00Z", 3600, null, null],
      [false, "2026-09-28T10:00:00Z", 185, "30,120,40,135", "ws closed 1006"],
    ]);
    expect(r.invalid).toBe(1);
    expect(r.truncated).toBe(false);
    expect(L.aisGapRows(null)).toMatchObject({ rows: [], truncated: null });
  });
});

describe("v5-C7 /logs page title (R-30: every route has its own title)", () => {
  it("the logs layout names the page and the name differs from the other routes", async () => {
    const title = (await import("@/app/logs/layout")).metadata.title;
    expect(title).toBe("시스템 로그");
    const others = await Promise.all(["replay", "stats", "ops"].map(async (r) => (await import(`@/app/${r}/layout.tsx`)).metadata.title as string));
    expect(others).not.toContain(title);
  });
});
