import { describe, expect, it } from "vitest";
import { applyAlertsBatch, applyAlertsFull, feedLag, GLOBAL_STALE_S, needsResync, nextBackoffMs, REGION_STALE_S, ResyncGate, SendBudget, toFeed } from "@/lib/ws-protocol";
import type { Alert } from "@/lib/types";

const alert = (id: number, over: Partial<Alert> = {}): Alert => ({
  id, kind: "OBSERVED", hex: "abc123", sigmet_id: "RKRR-1", fir_id: "RKRR", hazard: "TS", entered_at: "2026-09-27T05:00:00Z", evidence: {}, estimated: false, ...over,
});

describe("ws protocol", () => {
  it("backoff grows 1 → 30 s with jitter", () => {
    expect(nextBackoffMs(0)).toBeGreaterThanOrEqual(800);
    expect(nextBackoffMs(0)).toBeLessThanOrEqual(1200);
    expect(nextBackoffMs(10)).toBeLessThanOrEqual(36000);
    expect(nextBackoffMs(10)).toBeGreaterThanOrEqual(24000);
  });
  it("per-session seq: only lastSeq+1 is applied; no snapshot yet or missing seq → resync", () => {
    expect(needsResync(1, 2)).toBe(false);
    expect(needsResync(7, 8)).toBe(false);
    expect(needsResync(7, 9)).toBe(true);
    expect(needsResync(7, 7)).toBe(true);
    expect(needsResync(7, 3)).toBe(true);
    expect(needsResync(null, 1)).toBe(true);
    expect(needsResync(3, undefined)).toBe(true);
    expect(needsResync(3, "4")).toBe(true);
  });
  it("resync is requested once until the snapshot arrives (or the request times out)", () => {
    const g = new ResyncGate(10_000);
    expect(g.request(0)).toBe(true);
    expect(g.request(100)).toBe(false);
    expect(g.request(9_999)).toBe(false);
    expect(g.request(10_000)).toBe(true);
    g.clear();
    expect(g.pending).toBe(false);
    expect(g.request(10_001)).toBe(true);
  });
  it("send budget stays under the server limit (20 msg / 10 s) in any window", () => {
    const b = new SendBudget(16, 10_000);
    for (let i = 0; i < 16; i++) expect(b.tryTake(i)).toBe(true);
    expect(b.tryTake(20)).toBe(false);
    expect(b.waitMs(20)).toBe(10_000 - 20);
    expect(b.tryTake(10_000)).toBe(true); // 첫 슬롯이 창 밖으로
  });
});

describe("alerts versioning and events", () => {
  it("full list replaces the map but an older version is ignored", () => {
    const cur = { alerts: new Map<number, Alert>(), version: 10 };
    expect(applyAlertsFull(cur, 9, [alert(1)])).toBeNull();
    const r = applyAlertsFull(cur, 12, [alert(1), alert(2, { left_at: "2026-09-27T05:01:00Z" })])!;
    expect([...r.alerts.keys()]).toEqual([1]);
    expect(r.version).toBe(12);
    // 버전 없는(구 서버) 목록은 항상 적용
    expect(applyAlertsFull(cur, undefined, [alert(3)])!.alerts.has(3)).toBe(true);
  });
  it("batch: stale versions ignored; LOST/LEFT/PREDICTION_CLEARED remove; banner skips prediction updates", () => {
    const cur = { alerts: new Map<number, Alert>([[1, alert(1)], [2, alert(2, { kind: "PREDICTED", estimated: true })]]), version: 5 };
    expect(applyAlertsBatch(cur, 5, [{ event: "ENTERED", alert: alert(9) }])).toBeNull();
    const r = applyAlertsBatch(cur, 6, [
      { event: "LOST", alert: alert(1, { left_at: "2026-09-27T05:02:00Z", close_reason: "signal_lost" }) },
      { event: "PREDICTION_UPDATED", alert: alert(2, { kind: "PREDICTED", estimated: true, eta_s: 120 }) },
    ])!;
    expect(r.alerts.has(1)).toBe(false);
    expect(r.alerts.get(2)!.eta_s).toBe(120);
    expect(r.last?.type).toBe("LOST");
    const r2 = applyAlertsBatch(r, 7, [{ event: "PREDICTION_CLEARED", alert: alert(2, { kind: "PREDICTED", left_at: "2026-09-27T05:03:00Z" }) }])!;
    expect(r2.alerts.size).toBe(0);
    expect(r2.last).toBeNull();
    const r3 = applyAlertsBatch(r2, 8, [{ event: "PREDICTION_UPDATED", alert: alert(4, { kind: "PREDICTED" }) }])!;
    expect(r3.last).toBeNull();
    expect(applyAlertsBatch(r3, 9, [{ event: "LEFT", alert: alert(4, { close_reason: "left", left_at: "2026-09-27T05:04:00Z" }) }])!.last?.type).toBe("LEFT");
  });
});

describe("feeds (region / global)", () => {
  it("normalises snapshot sources and status; missing global feed → null", () => {
    const f = toFeed({ provider: "adsb_fi", fetched_at: "2026-09-27T05:10:00Z", lag_s: 8.2, stale: false }, 1000, true)!;
    expect(f).toEqual({ provider: "adsb_fi", fetched_at: "2026-09-27T05:10:00Z", lag_s: 8.2, stale: false, received_at: 1000 });
    expect(toFeed(null, 0)).toBeNull();
    expect(toFeed({ provider: "-", fetched_at: "1970-01-01T00:00:00Z", lag_s: null, stale: true }, 0)).toBeNull();
    // 지역 피드는 수집 이력이 없어도 "NO DATA" 로 보이도록 남긴다
    expect(toFeed({ provider: "-", lag_s: null }, 0, true)).toEqual({ provider: null, fetched_at: null, lag_s: null, stale: null, received_at: 0 });
  });
  it("lag uses the reported value while live, and grows with elapsed time when disconnected", () => {
    const f = toFeed({ provider: "opensky", lag_s: 100, stale: false }, 0)!;
    expect(feedLag(f, 250_000, true, GLOBAL_STALE_S)).toEqual({ lag: 100, stale: false });
    const off = feedLag(f, 250_000, false, GLOBAL_STALE_S);
    expect(off.lag).toBe(350);
    expect(off.stale).toBe(true);
  });
  it("stale when the server says so or lag exceeds 60 s (region) / 300 s (global); unknown lag is stale", () => {
    expect(feedLag(toFeed({ provider: "adsb_fi", lag_s: 61 }, 0), 0, true, REGION_STALE_S).stale).toBe(true);
    expect(feedLag(toFeed({ provider: "adsb_fi", lag_s: 59 }, 0), 0, true, REGION_STALE_S).stale).toBe(false);
    expect(feedLag(toFeed({ provider: "opensky", lag_s: 200 }, 0), 0, true, GLOBAL_STALE_S).stale).toBe(false);
    expect(feedLag(toFeed({ provider: "opensky", lag_s: 20, stale: true }, 0), 0, true, GLOBAL_STALE_S).stale).toBe(true);
    expect(feedLag(null, 0, true, REGION_STALE_S)).toEqual({ lag: null, stale: true });
  });
});
