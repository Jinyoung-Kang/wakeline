/**
 * /logs 의 텍스트 복사 · .txt · 묶음 복사 · 오류 화면 복사의 머리 줄 시각은 한국 표준시, 오프셋을 붙인 ISO 8601("…+09:00", ms 유지).
 * .ndjson · JSON 복사는 api 가 준 그대로(ts 는 UTC — 원본을 바꾸지 않는다). 형식 함수 자체는 tests/kst-format.test.ts.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다.
 */
import { describe, expect, it } from "vitest";

/** 사용자가 붙여 넣은 /logs 항목(2026-09-28T23:41:14.906Z WARN collector/job.kma_radar) — UTC 자정 직전이라 KST 로는 다음 날 */
const USER_TS = "2026-09-28T23:41:14.906Z";

/** schemas/log_event.v1.json 형식의 항목 — 사용자가 붙여 넣은 첫 항목 */
const userEntry = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "1790638875284-0", v: 1, stream: "server", ts: USER_TS, service: "collector", instance: "1e5af9fc47c4:7", level: "WARN", logger: "job.kma_radar",
  thread: "MainThread", message: "kma radar: ReadTimeout('')", exception: null, fp: "b6e32bdad7eeca61", request_id: null,
  context: { task: "job:radar_kr", module: "kma_radar", func: "_fail", line: 136 }, suppressed: 0, ...o,
});

describe("KST in /logs copy text and export (lib/logs · lib/log-line · ErrorScreen)", () => {
  it("entry text: the header timestamp is ISO 8601 with +09:00 (milliseconds kept); the rest of the text is unchanged", async () => {
    const L = await import("@/lib/logs");
    const e = L.parseLogPage({ items: [userEntry()] }).items[0];
    expect(L.logText(e).split("\n")).toEqual([
      "[2026-09-29T08:41:14.906+09:00 WARN collector/job.kma_radar] rid=—",
      "kma radar: ReadTimeout('')",
      "id=1790638875284-0 · stream=server(wakeline:logs) · fp=b6e32bdad7eeca61 · instance=1e5af9fc47c4:7 · thread=MainThread · 억제 0",
      "context: task=job:radar_kr · module=kma_radar · func=_fail · line=136",
    ]);
  });
  it("list time: KST \"MM-DD HH:MM:SS.mmm\" on the first line, UTC on the second (the column header says KST · UTC); unreadable → —", async () => {
    const T = await import("@/lib/time");
    expect(T.dualCell(USER_TS, { ms: true })).toMatchObject({ kst: "09-29 08:41:14.906", utc: "09-28 23:41:14.906 UTC" });
    expect(T.dualCell("bad", { ms: true })).toBeNull();
    expect(T.dualCell(null, { ms: true })).toBeNull();
  });
  it("group text: first / last in ISO 8601 with +09:00", async () => {
    const L = await import("@/lib/logs");
    const g = L.parseLogGroups({ groups: [{ fp: "8dee472131af8d17", service: "collector", level: "WARN", logger: "job.aircraft", exception_type: null, sample_message: "rate limited", count: 5, suppressed: 0, first_at: "2026-09-28T23:06:00.698Z", last_at: USER_TS, last_id: "1790638822133-0" }] }).groups[0];
    expect(L.groupText(g, [], { truncated: false }).split("\n")[0]).toBe(
      "[묶음 fp=8dee472131af8d17 WARN collector/job.aircraft] 항목 5건 · 억제 합 0 · 처음 2026-09-29T08:06:00.698+09:00 · 마지막 2026-09-29T08:41:14.906+09:00");
  });
  it("group text: an unknown count is \"—\" alone — no unit after it (\"—건\" reads like a measured count)", async () => {
    const L = await import("@/lib/logs");
    const g = L.parseLogGroups({ groups: [{ fp: "0123456789abcdef", service: "api", level: "ERROR", logger: "x", exception_type: null, sample_message: null, count: null, suppressed: null, first_at: "2026-09-28T23:00:00Z", last_at: USER_TS, last_id: "1790638875284-0" }] }).groups[0];
    expect(g.count).toBeNull();
    const head = L.groupText(g, [], { truncated: false }).split("\n")[0];
    expect(head).toBe("[묶음 fp=0123456789abcdef ERROR api/x] 항목 — · 억제 합 — · 처음 2026-09-29T08:00:00.000+09:00 · 마지막 2026-09-29T08:41:14.906+09:00");
    expect(head).not.toContain("—건");
    expect(L.groupCountText(null)).toBe("—");
    expect(L.groupCountText(0)).toBe("0건");
    expect(L.groupCountText(12)).toBe("12건");
  });
  it(".ndjson and JSON copy stay the stored entry as the api gave it (ts in UTC); the file name carries the KST offset", async () => {
    const L = await import("@/lib/logs");
    const items = L.parseLogPage({ items: [userEntry()] }).items;
    expect(JSON.parse(L.logsNdjson(items).trimEnd()).ts).toBe(USER_TS);
    expect(JSON.parse(L.logJson(items[0])).ts).toBe(USER_TS);
    expect(L.logsFileName("txt", Date.parse("2026-09-28T23:41:14Z"))).toBe("wakeline-logs-20260929T084114+0900.txt");
    expect(L.logsFileName("ndjson", Date.parse("2026-09-28T23:41:14Z"))).toBe("wakeline-logs-20260929T084114+0900.ndjson");
  });
  it("the error screen's copy text uses the same header frame as a /logs entry (+09:00)", async () => {
    const { errorScreenText } = await import("@/components/logs/ErrorScreen");
    const t = errorScreenText(new Error("boom"), "OpsPage", Date.parse(USER_TS), "/ops").split("\n");
    expect(t[0]).toBe("[2026-09-29T08:41:14.906+09:00 ERROR web-client/OpsPage] rid=—");
    expect(t[1]).toBe("Error: boom");
  });
});
