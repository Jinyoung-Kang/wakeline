/**
 * 상태 바의 AIS 수신 공백 모델(lib/statusbar aisGapInfo — 줄의 칩 · 앞쪽 경고 · 상세 표가 함께 쓴다). 사용자 보고 2026-09-30: 1분이 안 되는
 * 재시작 공백이 "02:22–02:22 KST" 처럼 같은 두 시각으로 보였다 → 길이를 먼저(1분 미만은 초). 시각은 KST 만(사용자 결정 2026-09-30).
 * - 시각 글자는 lib/time 의 공유 형식기(fmtKst · fmtKstRange · fmtTimeTitle)만 만든다(계약 v5 §G20). 이 모델이 ships.ts 의 옛 상태 바 배지(aisGapBadge)를
 *   대신한다 — 세 레인을 합친 뒤 옛 배지와 그 시험을 지웠다.
 * 수정 전 코드에서 실패하는 것을 먼저 확인했다(statusbar 에 aisGapInfo 가 없었다).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aisGapInfo } from "@/lib/statusbar";
import { parseAisStatus } from "@/lib/ships";

const NOW = Date.parse("2026-09-28T03:00:00Z"); // KST 09-28 12:00
const AMERICAS = [[-90, -180, 90, 0]];
const ASIA = [[-90, 45, 90, 180]];
const base = { connected: true, lag_s: 1, msgs_per_s: 1 };
const ais = (over: Record<string, unknown>, now = NOW) => parseAisStatus({ sources: { ais: { ...base, ...over } } }, now);
const status = (shards: unknown, over: Record<string, unknown> = {}) => ais({ msgs_per_s: 60, lag_s: 2, coverage: [...AMERICAS, ...ASIA], shards, ...over });
const shard = (coverage: unknown, over: Record<string, unknown> = {}) => ({ coverage, state: "receiving", connected: true, gap_open_since: null, ...over });

describe("AIS gap: a duration first, never an identical start–end", () => {
  it("open gap: its running duration against the server clock; without a clock no duration is invented", () => {
    const g = aisGapInfo(ais({ gap_open_since: "2026-09-28T02:50:00Z" }), NOW)!;
    expect(g).toMatchObject({ text: "AIS 공백 진행 중 10m 00s", value: "진행 중 10m 00s", open: true, recent: true, durationS: 600, span: "11:50:00 KST 부터" });
    expect(g.title).toContain("AIS 수신이 11:50:00 KST 부터 끊겨 있음");
    expect(aisGapInfo(ais({ gap_open_since: "2026-09-28T02:50:00Z" }), 0)).toMatchObject({ value: "진행 중", durationS: null });
  });
  it("ended gap: duration + end time in the row within 30 minutes; older ones stay for the details with the KST span in seconds", () => {
    const ended = { started_at: "2026-09-28T02:40:00Z", ended_at: "2026-09-28T02:45:00Z", reason: null };
    expect(aisGapInfo(ais({ last_gap: ended }), NOW)).toMatchObject({ text: "AIS 공백 5m 00s · 11:45 KST 끝남", open: false, recent: true, durationS: 300 });
    const old = aisGapInfo(ais({ last_gap: { started_at: "2026-09-28T02:15:00Z", ended_at: "2026-09-28T02:20:00Z", reason: "restart" } }), NOW)!;
    expect(old).toMatchObject({ recent: false, value: "5m 00s", span: "09-28 11:15:00 – 09-28 11:20:00 KST", reason: "restart" });
    // 42 s 재시작 공백 — 같은 두 분 시각이 아니라 42s
    const short = aisGapInfo(ais({ last_gap: { started_at: "2026-09-28T02:50:00Z", ended_at: "2026-09-28T02:50:42Z", reason: "restart" } }), NOW)!;
    expect(short.text).toBe("AIS 공백 42s · 11:50 KST 끝남");
    expect(short.text).not.toMatch(/11:50\s*[–-]\s*11:50/);
    // 끝을 모르는 지난 공백 · 공백 기록 없음 · 상태 없음 → 없음(지어내지 않는다)
    expect(aisGapInfo(ais({ last_gap: { started_at: "2026-09-28T02:40:00Z", ended_at: null, reason: null } }), NOW)).toBeNull();
    expect(aisGapInfo(ais({}), NOW)).toBeNull();
    expect(aisGapInfo(null, NOW)).toBeNull();
  });
  it("the date is added when the KST day differs from today (KST), also across UTC midnight", () => {
    const now = Date.parse("2026-09-28T15:10:00Z"); // KST 09-29 00:10
    const g = aisGapInfo(ais({ gap_open_since: "2026-09-28T14:50:00Z" }, now), now)!; // KST 09-28 23:50
    expect(g.span).toBe("09-28 23:50:00 KST 부터");
    const same = aisGapInfo(ais({ gap_open_since: "2026-09-28T15:05:00Z" }, now), now)!; // KST 09-29 00:05 — 오늘
    expect(same.span).toBe("00:05:00 KST 부터");
    const closed = aisGapInfo(ais({ last_gap: { started_at: "2026-09-28T14:58:00Z", ended_at: "2026-09-28T15:01:00Z", reason: "keepalive" } }, now), now)!;
    expect(closed.state).toBe("00:01 KST 끝남");
    expect(closed.title).toContain("AIS 수신 공백 3m 00s — 09-28 23:58:00 – 09-29 00:01:00 KST (keepalive)");
  });
});

describe("AIS gap in zones (contract v4 §D)", () => {
  it("only some zones in a gap: 'n/m 구역 진행 중', the zones and their start in the tooltip (KST only)", () => {
    const g = aisGapInfo(status([shard(AMERICAS, { gap_open_since: "2026-09-28T02:50:00Z", connected: false }), shard(ASIA)], { gap_open_since: "2026-09-28T02:50:00Z", connected: false }), NOW)!;
    expect(g.text).toMatch(/^AIS 공백 1\/2 구역 진행 중/);
    expect(g.partial).toBe(true);
    expect(g.title).toContain("구역 1 -90,-180,90,0 — 공백 11:50:00 KST 부터");
    expect(g.title).toMatch(/구역 2 -90,45,90,180 — 공백 없음 · 연결$/m);
  });
  it("a gap open in only some zones shows how long it has run (from the earliest zone) — in the row and in 상세 (review finding)", () => {
    const two = status([shard(AMERICAS, { gap_open_since: "2026-09-28T02:50:00Z", connected: false }), shard(ASIA, { gap_open_since: null })]);
    expect(aisGapInfo(two, NOW)).toMatchObject({ text: "AIS 공백 1/2 구역 진행 중 10m 00s", durationS: 600, zones: { open: 1, total: 2 } });
    // 서버 시각을 모르면 길이를 지어내지 않는다
    expect(aisGapInfo(two, 0)).toMatchObject({ text: "AIS 공백 1/2 구역 진행 중", durationS: null });
  });
  it("the other zones' reported connection, never 'receiving' by assumption", () => {
    const back = aisGapInfo(status([shard(AMERICAS, { gap_open_since: "2026-09-28T02:50:00Z", connected: false }), shard(ASIA, { connected: false, state: "backoff" })]), NOW)!;
    expect(back.title).toContain("구역 2 -90,45,90,180 — 공백 없음 · 끊김(재연결 중)");
    expect(back.title).not.toContain("수신 중");
    const unk = aisGapInfo(status([shard(AMERICAS, { gap_open_since: "2026-09-28T02:50:00Z", connected: false }), shard(ASIA, { connected: null, state: null })]), NOW)!;
    expect(unk.title).toContain("구역 2 -90,45,90,180 — 공백 없음 · 연결 모름");
  });
  it("every zone in a gap, or a single zone: the plain open gap (all zones named)", () => {
    const all = aisGapInfo(status([shard(AMERICAS, { gap_open_since: "2026-09-28T02:40:00Z" }), shard(ASIA, { gap_open_since: "2026-09-28T02:50:00Z" })], { gap_open_since: "2026-09-28T02:40:00Z" }), NOW)!;
    expect(all.text).toBe("AIS 공백 진행 중 20m 00s");
    expect(all.title).toContain("모든 구역(2개)");
    const one = aisGapInfo(status([shard(AMERICAS, { gap_open_since: "2026-09-28T02:40:00Z" })], { gap_open_since: "2026-09-28T02:40:00Z" }), NOW)!;
    expect(one.text).toBe("AIS 공백 진행 중 20m 00s");
    expect(one.partial).toBeUndefined();
  });
  it("a closed gap cannot be attributed to a zone (the status has no scope) — the tooltip says so", () => {
    const g = aisGapInfo(status([shard(AMERICAS), shard(ASIA)], { last_gap: { started_at: "2026-09-28T02:40:00Z", ended_at: "2026-09-28T02:45:00Z", reason: "keepalive" } }), NOW)!;
    expect(g.text).toBe("AIS 공백 5m 00s · 11:45 KST 끝남");
    expect(g.title).toContain("어느 구역의 공백인지는 상태에 없음");
  });
  it("no UTC anywhere in the texts", () => {
    const all = [
      aisGapInfo(ais({ gap_open_since: "2026-09-28T02:50:00Z" }), NOW)!,
      aisGapInfo(ais({ last_gap: { started_at: "2026-09-28T02:40:00Z", ended_at: "2026-09-28T02:45:00Z", reason: null } }), NOW)!,
      aisGapInfo(status([shard(AMERICAS, { gap_open_since: "2026-09-28T02:50:00Z" }), shard(ASIA)]), NOW)!,
    ].flatMap((g) => [g.text, g.title, g.span]).join("\n");
    expect(all).not.toMatch(/UTC|\d\dZ\b/);
  });
});

describe("lib/statusbar builds its times with the shared KST formatters only", () => {
  it("imports from ./time only the KST API (no removed dual-time name), and ships.ts no longer has the old gap badge", async () => {
    const src = readFileSync(new URL("../lib/statusbar.ts", import.meta.url), "utf8");
    const names = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/time"/g)].flatMap((m) => m[1].split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(["fmtKst", "fmtKstRange", "fmtTimeTitle", "kstWallMs", "timeParts", "TimeIn"], n).toContain(n);
    expect("aisGapBadge" in (await import("@/lib/ships"))).toBe(false);
  });
});
