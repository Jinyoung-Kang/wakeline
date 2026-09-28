/**
 * R-93(계약 v5 §E2): diff 는 적용이 끝난 뒤에만 lastSeq(선박 sseq)를 올린다. 이전 코드는 lastSeq 를 먼저 올리고 적용했다 —
 * 적용 도중 예외(워커 전달 실패 · 화면 구독자 예외)가 나면 그 diff 는 반쯤만 적용됐는데 다음 diff(seq+1)가 그 위에 그대로 적용됐고,
 * 예외는 onmessage 밖으로 새어 나갔다(resync 도 보고도 없음). 고친 뒤: 예외를 잡아 세고, 그 흐름의 seq 를 버려(null) 다음 스냅샷까지 diff 를
 * 적용하지 않고, resync 를 요청하고, 브라우저 오류로 보고한다(§C8).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aircraftStates, getData, resetData, shipStates, subscribeData } from "@/lib/store";
import { ac, diff, resyncs, setup, snap, TS, welcomed } from "./helpers/fake-ws";

beforeEach(() => { resetData(); vi.useFakeTimers(); vi.setSystemTime(Date.parse(TS)); });
afterEach(() => { vi.useRealTimers(); });

describe("R-93: lastSeq advances only after a diff was applied", () => {
  it("a diff that throws while being applied is not counted as applied — resync, the error is reported, and later diffs wait for the snapshot", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv(snap([ac("aaa001")]));
    t.worker.fail = (m) => m.type === "diff";
    // 이전 코드: lastSeq 를 먼저 2 로 올리고 워커 전달에서 예외가 새어 나갔다 → 다음 diff(3)가 반쯤 적용된 상태 위에 그대로 적용됐다
    try { t.ws().recv(diff(2, [ac("bbb002")])); } catch { /* 이전 코드는 여기로 */ }
    t.worker.fail = null;
    t.ws().recv(diff(3, [ac("ccc003")]));
    expect(aircraftStates.has("ccc003")).toBe(false);
    expect(t.worker.msgs.filter((m) => m.type === "diff")).toHaveLength(0);
    expect(resyncs(t)).toBe(1);
    expect(t.reports.map((r) => r.message).join("\n")).toMatch(/ws: .*diff.*worker postMessage failed/);
    expect(getData().wsInvalid.errors).toBe(1);
    // 재동기 스냅샷으로 주 스레드와 워커가 다시 같아진다
    t.ws().recv(snap([ac("ccc003")]));
    t.ws().recv(diff(2, [ac("ddd004")]));
    expect([...aircraftStates.keys()].sort()).toEqual(["ccc003", "ddd004"]);
    expect(t.worker.msgs.at(-1)).toMatchObject({ type: "diff", upsert: [{ hex: "ddd004" }] });
  });

  it("the same for ships_diff: sseq advances only after the diff was applied", () => {
    const t = setup();
    welcomed(t, true);
    const ship = (mmsi: string) => ({ mmsi, lat: 35, lon: 129, seen_at: TS });
    t.ws().recv({ type: "ships_snapshot", sseq: 1, ts: TS, ships: [ship("440000001")] });
    // 적용 중 예외: 스토어 구독자(화면)가 한 번 던진다 — setData 는 적용의 마지막 단계다
    let throwOnce = true;
    const off = subscribeData(() => { if (throwOnce) { throwOnce = false; throw new Error("listener failed"); } });
    try { t.ws().recv({ type: "ships_diff", sseq: 2, ts: TS, upsert: [ship("440000002")], remove: [] }); } catch { /* 이전 코드는 여기로 */ } finally { off(); }
    t.ws().recv({ type: "ships_diff", sseq: 3, ts: TS, upsert: [ship("440000003")], remove: [] });
    expect(shipStates.has("440000003")).toBe(false);
    expect(resyncs(t)).toBe(1);
    expect(getData().wsInvalid.errors).toBe(1);
    t.ws().recv({ type: "ships_snapshot", sseq: 1, ts: TS, ships: [ship("440000003")] });
    t.ws().recv({ type: "ships_diff", sseq: 2, ts: TS, upsert: [ship("440000004")], remove: [] });
    expect([...shipStates.keys()].sort()).toEqual(["440000003", "440000004"]);
  });
});

