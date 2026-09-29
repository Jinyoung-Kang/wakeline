/**
 * 해결 표시(ADR-022) — lib/logs 가 읽는 것과 보내는 것. 목록 · 묶음 · 항목 하나에 "resolved": {"id","upto","resolved_by"} | null,
 * 목록 · 묶음 응답에 "hidden_resolved"(이 쪽을 훑으며 가린 수) · "resolution_state", 요청에 resolved=hide|show(기본 hide — 웹은 늘 명시).
 */
import { describe, expect, it } from "vitest";
import * as L from "@/lib/logs";

const NOW = Date.parse("2026-09-29T02:00:00Z");
const entry = (o: Record<string, unknown> = {}) => ({
  id: "1790000000000-0", v: 1, ts: "2026-09-29T01:59:00.123456Z", service: "api", instance: null, level: "ERROR", logger: "x.Y", thread: null, message: "boom",
  exception: null, fp: "0123456789abcdef", request_id: null, context: {}, suppressed: 0, ...o,
});
const REF = { id: 12, upto: "2026-09-29T01:59:00.123456Z", resolved_by: "op" };

describe("reading: resolved on entries and groups, hidden_resolved and resolution_state on pages", () => {
  it("an entry carries its resolution (or null — also when malformed or absent)", () => {
    expect(L.parseLogEntry(entry({ resolved: REF }))!.resolved).toEqual(REF);
    expect(L.parseLogEntry(entry({ resolved: null }))!.resolved).toBeNull();
    expect(L.parseLogEntry(entry())!.resolved).toBeNull(); // 해결 전 api — 필드 없음
    expect(L.parseLogEntry(entry({ resolved: { id: "x" } }))!.resolved).toBeNull();
  });
  it("a page reads hidden_resolved (count or unknown) and resolution_state", () => {
    const p = L.parseLogPage({ items: [entry()], hidden_resolved: 7, resolution_state: "stale" });
    expect([p.hiddenResolved, p.resolutionState]).toEqual([7, "stale"]);
    const old = L.parseLogPage({ items: [entry()] });
    expect([old.hiddenResolved, old.resolutionState]).toEqual([null, null]);
    expect(L.parseLogPage({ items: [], hidden_resolved: -1 }).hiddenResolved).toBeNull();
  });
  it("'이전 항목 더 보기': hidden counts add up over the loaded pages (unknown on any page → unknown), the state is the latest", () => {
    const a = L.parseLogPage({ items: [entry()], hidden_resolved: 3, resolution_state: "ok", next_cursor: "server:1789999999999-0" });
    const b = L.parseLogPage({ items: [entry({ id: "1789999999998-0" })], hidden_resolved: 2, resolution_state: "stale" });
    const ab = L.appendLogPage(a, b);
    expect([ab.hiddenResolved, ab.resolutionState, ab.pages]).toEqual([5, "stale", 2]);
    expect(L.appendLogPage(a, L.parseLogPage({ items: [] })).hiddenResolved).toBeNull();
  });
  it("a group carries its resolution only when all its entries are resolved (as the api says); groups read hidden_resolved and the state", () => {
    const g = L.parseLogGroups({
      groups: [
        { fp: "0123456789abcdef", service: "api", level: "ERROR", logger: "x", exception_type: null, sample_message: "boom", count: 3, suppressed: 0, first_at: "2026-09-29T01:00:00Z", last_at: "2026-09-29T01:59:00.123456Z", last_id: "1790000000000-0", resolved: REF },
        { fp: "fedcba9876543210", service: "api", level: "WARN", logger: "x", exception_type: null, sample_message: "slow", count: 1, suppressed: 0, first_at: "2026-09-29T01:10:00Z", last_at: "2026-09-29T01:10:00Z", last_id: "1789999999000-0", resolved: null },
      ],
      scanned: 40, scan_truncated: false, hidden_resolved: 9, resolution_state: "ok",
    });
    expect(g.groups.map((x) => x.resolved)).toEqual([REF, null]);
    expect([g.hiddenResolved, g.resolutionState]).toEqual([9, "ok"]);
    // 묶음의 last_at 은 받은 글자 그대로(해결의 upto 로 되돌려 보낸다 — µs 를 자르지 않는다)
    expect(g.groups[0].last_at).toBe("2026-09-29T01:59:00.123456Z");
  });
  it("the copied text of a resolved entry says so (KST +09:00 like the header), an unresolved one does not", () => {
    const t = L.logText(L.parseLogEntry(entry({ resolved: REF }))!);
    expect(t).toContain("해결됨 #12(op · upto 2026-09-29T10:59:00.123+09:00)");
    expect(L.logText(L.parseLogEntry(entry())!)).not.toContain("해결됨");
  });
});

describe("requests: resolved=hide|show is always sent (the default filter hides)", () => {
  it("list and groups", () => {
    expect(L.DEFAULT_LOG_FILTER.resolved).toBe("hide");
    const list = new URL(L.logsUrl(L.DEFAULT_LOG_FILTER, NOW), "http://x").searchParams;
    expect(list.get("resolved")).toBe("hide");
    const shown = new URL(L.logsUrl({ ...L.DEFAULT_LOG_FILTER, resolved: "show" }, NOW), "http://x").searchParams;
    expect(shown.get("resolved")).toBe("show");
    const groups = new URL(L.logGroupsUrl({ ...L.DEFAULT_LOG_FILTER, resolved: "show" }, NOW), "http://x").searchParams;
    expect(Object.fromEntries(groups)).toEqual({ since: "2026-09-29T01:00:00.000Z", resolved: "show" });
    expect(new URL(L.logGroupsUrl(L.DEFAULT_LOG_FILTER, NOW), "http://x").searchParams.get("resolved")).toBe("hide");
  });
});
