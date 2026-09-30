/**
 * 재생의 503(errors F4 — 운영 2026-09-30 22:55 KST: 배포 뒤 재생 조회가 공개 조회 상한에 걸려 503 UNAVAILABLE + Retry-After 10 이었는데 화면은 '서버 오류'):
 * - 503 은 '데이터 저장소를 잠시 사용할 수 없음(HTTP 503) — N초 뒤 다시 시도' — N 은 Retry-After 가 있을 때만(없으면 '잠시 뒤'). 까닭(시간 초과 · DB 다운)을 짓지 않는다:
 *   api 의 code UNAVAILABLE 은 저장소(DB · Redis)의 연결 실패 · 풀 대기 · 잠금 · 문장 취소를 모두 싣고 본문도 'data store temporarily unavailable' 뿐이다.
 *   code 가 UNAVAILABLE 이 아닌 503 은 저장소라고 말하지 않는다.
 * - Retry-After 뒤 한 번만 다시 부른다 — 실패한 요청이 아직 지금 요청이고(그 뒤 시각 · 영역이 바뀌지 않았고 다른 요청이 없음) 탭이 보일 때.
 *   숨은 탭이면 다시 보일 때. 다시 부른 요청도 실패하면 더 부르지 않고 그렇다고 적는다(경합 중에 부하를 더하지 않는다).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import * as R from "@/lib/replay";

const unavailable = (retryAfterS: number | null, code: string | null = "UNAVAILABLE") =>
  new ApiError(503, "data store temporarily unavailable; retry later", retryAfterS, code, "5030503050305030");

describe("replayErrorText: a 503 says the data store is briefly unavailable and when to retry — from Retry-After only", () => {
  it("503 UNAVAILABLE with Retry-After 10", () => {
    expect(R.replayErrorText(unavailable(10))).toBe("데이터 저장소를 잠시 사용할 수 없음(HTTP 503) — 10초 뒤 다시 시도");
    expect(R.replayErrorText(unavailable(10), "scheduled")).toBe("데이터 저장소를 잠시 사용할 수 없음(HTTP 503) — 10초 뒤 다시 시도");
  });
  it("no Retry-After: '잠시 뒤' — no number is made up", () => {
    expect(R.replayErrorText(unavailable(null))).toBe("데이터 저장소를 잠시 사용할 수 없음(HTTP 503) — 잠시 뒤 다시 시도");
  });
  it("a 503 that is not the api's data-store problem is not called the data store", () => {
    expect(R.replayErrorText(unavailable(10, null))).toBe("서버를 잠시 사용할 수 없음(HTTP 503) — 10초 뒤 다시 시도");
    expect(R.replayErrorText(unavailable(null, "LOG_SINK_DISABLED"))).toBe("서버를 잠시 사용할 수 없음(HTTP 503) — 잠시 뒤 다시 시도");
  });
  it("after the one automatic retry also failed, it says so and does not promise another", () => {
    expect(R.replayErrorText(unavailable(10), "retried"))
      .toBe("데이터 저장소를 잠시 사용할 수 없음(HTTP 503) — 자동으로 한 번 다시 불렀으나 또 실패 · 시각이나 영역을 바꾸면 다시 불러옴");
  });
  it("does not guess a cause (timeout, DB down) and other statuses are unchanged", () => {
    for (const t of [R.replayErrorText(unavailable(10)), R.replayErrorText(unavailable(null)), R.replayErrorText(unavailable(10), "retried")]) {
      expect(t).not.toMatch(/시간 초과|제한 시간|응답하지|다운|꺼짐|서버 오류/);
    }
    expect(R.replayErrorText(new ApiError(500, "x"))).toBe("서버 오류(HTTP 500) — 기록을 불러오지 못함");
    expect(R.replayErrorText(new ApiError(502, "x"))).toBe("서버 오류(HTTP 502) — 기록을 불러오지 못함");
    expect(R.replayErrorText(new ApiError(429, "x", 5))).toBe("요청이 많아 잠시 제한됨 — 잠시 뒤 다시");
  });
  it("replayReduce carries the retry state into the text and keeps the request id", () => {
    const v = R.replayReduce({ frame: null, err: null, latencyMs: null }, { type: "failed", error: unavailable(10), retry: "scheduled" });
    expect(v.err).toBe("데이터 저장소를 잠시 사용할 수 없음(HTTP 503) — 10초 뒤 다시 시도");
    expect(v.rid).toBe("5030503050305030");
    expect(R.replayReduce(v, { type: "failed", error: unavailable(10), retry: "retried" }).err).toContain("자동으로 한 번 다시 불렀으나 또 실패");
  });
});

describe("ReplayLoader: one retry after Retry-After when the failed request is still current and the tab is visible", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function harness(visibleAtStart = true) {
    const calls: R.ReplayReq[] = [];
    const pending: { resolve: (f: R.ReplayFrame) => void; reject: (e: unknown) => void }[] = [];
    const events: { type: string; retry?: string; at?: string }[] = [];
    let visible = visibleAtStart;
    const listeners = new Set<() => void>();
    const visibility = {
      visible: () => visible,
      onVisible: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    };
    const loader = new R.ReplayLoader(
      (r) => { calls.push(r); return new Promise<R.ReplayFrame>((resolve, reject) => pending.push({ resolve, reject })); },
      (e) => events.push(e.type === "loaded" ? { type: e.type, at: e.frame.at } : { type: e.type, retry: e.retry }),
      undefined, undefined, undefined, visibility,
    );
    const frame = (r: R.ReplayReq): R.ReplayFrame => ({ at: new Date(r.at).toISOString(), aircraft: [], sigmets: [], source: "track_point" });
    return {
      calls, pending, events, loader, frame, listeners,
      show: () => { visible = true; for (const f of [...listeners]) f(); },
      hide: () => { visible = false; },
    };
  }
  const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
  const A = { at: 60_000, bbox: "124,33,132,39" };
  const B = { at: 120_000, bbox: "124,33,132,39" };

  it("re-requests the same (at, bbox) once after Retry-After and draws it", async () => {
    const h = harness();
    h.loader.request(A, { supersede: true });
    h.pending[0].reject(unavailable(10));
    await flush();
    expect(h.events).toEqual([{ type: "failed", retry: "scheduled" }]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual([A, A]);
    h.pending[1].resolve(h.frame(A));
    await flush();
    expect(h.events.at(-1)).toEqual({ type: "loaded", at: new Date(A.at).toISOString() });
  });

  it("retries only once: a second 503 is reported as 'retried' and nothing more is sent", async () => {
    const h = harness();
    h.loader.request(A);
    h.pending[0].reject(unavailable(10));
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    h.pending[1].reject(unavailable(10));
    await flush();
    expect(h.events).toEqual([{ type: "failed", retry: "scheduled" }, { type: "failed", retry: "retried" }]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.calls).toHaveLength(2);
  });

  it("does not retry when something changed before Retry-After (the user moved the time)", async () => {
    const h = harness();
    h.loader.request(A, { supersede: true });
    h.pending[0].reject(unavailable(10));
    await flush();
    h.loader.schedule(B, { supersede: true });
    await vi.advanceTimersByTimeAsync(R.REPLAY_DEBOUNCE_MS);
    expect(h.calls).toEqual([A, B]);
    h.pending[1].resolve(h.frame(B));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.calls).toEqual([A, B]); // A 를 다시 부르지 않는다
  });

  it("a hidden tab waits until it is visible again, then retries once if still current", async () => {
    const h = harness();
    h.loader.request(A);
    h.pending[0].reject(unavailable(10));
    await flush();
    h.hide();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(1); // 숨은 탭 — 부르지 않는다
    expect(h.listeners.size).toBe(1);
    h.show();
    await flush();
    expect(h.calls).toEqual([A, A]);
    expect(h.listeners.size).toBe(0);
    h.show(); // 다시 보여도 두 번 부르지 않는다
    await flush();
    expect(h.calls).toHaveLength(2);
  });

  it("a hidden tab where the user changed the time meanwhile does not retry the old request", async () => {
    const h = harness();
    h.loader.request(A);
    h.pending[0].reject(unavailable(10));
    await flush();
    h.hide();
    await vi.advanceTimersByTimeAsync(10_000);
    h.loader.request(B);
    h.show();
    await flush();
    expect(h.calls).toEqual([A, B]);
    expect(h.listeners.size).toBe(0);
  });

  it("no retry without Retry-After, for other statuses, or after the page is left", async () => {
    const h = harness();
    h.loader.request(A);
    h.pending[0].reject(unavailable(null));
    await flush();
    expect(h.events).toEqual([{ type: "failed", retry: "none" }]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.calls).toHaveLength(1);

    h.loader.request(B);
    h.pending[1].reject(new ApiError(500, "boom", 10));
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.calls).toHaveLength(2);

    h.loader.request(A);
    h.pending[2].reject(unavailable(10));
    await flush();
    h.loader.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.calls).toHaveLength(3);
  });

  it("the default visibility works without a document (server render · node tests)", async () => {
    const calls: R.ReplayReq[] = [];
    let n = 0;
    const loader = new R.ReplayLoader(async (r) => { calls.push(r); if (n++ === 0) throw unavailable(1); return { at: new Date(r.at).toISOString(), aircraft: [], sigmets: [], source: "track_point" }; }, () => {});
    loader.request(A);
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual([A, A]);
    loader.dispose();
  });
});
