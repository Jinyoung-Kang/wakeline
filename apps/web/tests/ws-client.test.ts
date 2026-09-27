import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkyWsClient, type SocketLike } from "@/lib/ws";
import { aircraftStates, getData, resetData } from "@/lib/store";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; this.onclose?.({}); }
  open() { this.readyState = 1; this.onopen?.({}); }
  recv(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
  types() { return this.sent.map((m) => m.type); }
}

function setup(opts: { hidden?: boolean } = {}) {
  const sockets: FakeSocket[] = [];
  const worker = { msgs: [] as { type: string }[], postMessage(m: unknown) { this.msgs.push(m as { type: string }); } };
  const hidden = { v: opts.hidden ?? false };
  const client = new SkyWsClient(worker, { url: "ws://test/ws/v1", isHidden: () => hidden.v, createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; } });
  return { client, worker, sockets, hidden, ws: () => sockets[sockets.length - 1] };
}

const BBOX: [number, number, number, number] = [124, 33, 131, 39];
const snap = (seq: number, aircraft: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  type: "snapshot", seq, v: 100 + seq, ts: "2026-09-27T05:10:00Z",
  sources: { region: { provider: "adsb_fi", fetched_at: "2026-09-27T05:09:55Z", lag_s: 5, stale: false }, global: null }, sigmets_version: 3, aircraft, ...extra,
});

beforeEach(() => { resetData(); vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-09-27T05:10:00Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("SkyWsClient", () => {
  it("hello → welcome → subscribe (+select), snapshot sets feeds and state", () => {
    const t = setup();
    t.client.subscribe(BBOX, 7);
    t.client.select("abc123");
    t.client.connect();
    t.ws().open();
    expect(t.ws().types()).toEqual(["hello"]);
    t.ws().recv({ type: "welcome", server_time: "2026-09-27T05:10:00Z" });
    expect(t.ws().types()).toEqual(["hello", "select", "subscribe"]);
    expect(getData().conn).toBe("open");
    t.ws().recv(snap(1, [{ hex: "abc123", lat: 36, lon: 127 }]));
    expect(getData().feeds.region?.provider).toBe("adsb_fi");
    expect(getData().feeds.global).toBeNull();
    expect(aircraftStates.get("abc123")).toEqual({ hex: "abc123", lat: 36, lon: 127 });
    expect(t.worker.msgs.map((m) => m.type)).toEqual(["snapshot"]);
  });

  it("applies contiguous diffs, resyncs once on a gap and ignores diffs until the next snapshot", () => {
    const t = setup();
    t.client.subscribe(BBOX, 7);
    t.client.connect();
    t.ws().open();
    t.ws().recv({ type: "welcome" });
    t.ws().recv(snap(1, [{ hex: "a", lat: 1, lon: 1 }]));
    t.ws().recv({ type: "diff", seq: 2, v: 103, ts: "2026-09-27T05:10:10Z", upsert: [{ hex: "b", lat: 2, lon: 2 }], remove: [] });
    expect(aircraftStates.has("b")).toBe(true);
    t.ws().recv({ type: "diff", seq: 4, v: 105, upsert: [{ hex: "c", lat: 3, lon: 3 }], remove: ["a"] });
    t.ws().recv({ type: "diff", seq: 5, v: 106, upsert: [{ hex: "d", lat: 4, lon: 4 }], remove: [] });
    expect(aircraftStates.has("c")).toBe(false);
    expect(aircraftStates.has("a")).toBe(true);
    expect(t.ws().types().filter((x) => x === "resync")).toHaveLength(1);
    t.ws().recv(snap(1, [{ hex: "c", lat: 3, lon: 3 }]));
    t.ws().recv({ type: "diff", seq: 2, upsert: [], remove: ["c"] });
    expect(aircraftStates.size).toBe(0);
    // 다음 불연속에서는 다시 resync 를 요청할 수 있다
    t.ws().recv({ type: "diff", seq: 9, upsert: [], remove: [] });
    expect(t.ws().types().filter((x) => x === "resync")).toHaveLength(2);
  });

  it("never fills missing keys and never forces stale=false from a diff", () => {
    const t = setup();
    t.client.subscribe(BBOX, 4);
    t.client.connect();
    t.ws().open();
    t.ws().recv({ type: "welcome" });
    t.ws().recv(snap(1));
    t.ws().recv({ type: "diff", seq: 2, upsert: [{ hex: "w1", lat: 50.123, lon: 8.456, provider: "opensky" }], remove: [] });
    const w1 = aircraftStates.get("w1")!;
    expect(w1.on_ground).toBeUndefined();
    expect(w1.seen_at).toBeUndefined();
    expect(w1.quality).toBeUndefined();
    expect(getData().feeds.region?.lag_s).toBe(5); // diff 는 피드 지연·stale 을 건드리지 않는다
  });

  it("alerts: LOST removes the alert and is announced; PREDICTION_UPDATED updates silently", () => {
    const t = setup();
    t.client.connect();
    t.ws().open();
    t.ws().recv({ type: "welcome" });
    const a = { id: 1, kind: "OBSERVED", hex: "abc123", sigmet_id: "S1", fir_id: "RKRR", hazard: "TS", entered_at: "2026-09-27T05:00:00Z", evidence: {}, estimated: false };
    const p = { ...a, id: 2, kind: "PREDICTED", estimated: true, eta_s: 300, eta_at: "2026-09-27T05:15:00Z" };
    t.ws().recv({ type: "alerts", version: 10, alerts: [a, p] });
    t.ws().recv({ type: "alerts_batch", version: 11, items: [{ event: "PREDICTION_UPDATED", alert: { ...p, eta_s: 240 } }] });
    expect(getData().alerts.get(2)!.eta_s).toBe(240);
    expect(getData().lastEvent).toBeNull();
    t.ws().recv({ type: "alerts_batch", version: 12, items: [{ event: "LOST", alert: { ...a, left_at: "2026-09-27T05:11:00Z", close_reason: "signal_lost" } }] });
    expect(getData().alerts.has(1)).toBe(false);
    expect(getData().lastEvent?.type).toBe("LOST");
    // 재전송된 옛 배치는 무시
    t.ws().recv({ type: "alerts_batch", version: 12, items: [{ event: "ENTERED", alert: a }] });
    expect(getData().alerts.has(1)).toBe(false);
  });

  it("selected: keeps only the reply for the current selection", () => {
    const t = setup();
    t.client.connect();
    t.ws().open();
    t.ws().recv({ type: "welcome" });
    t.client.select("aaa111");
    t.client.select("bbb222");
    t.ws().recv({ type: "selected", hex: "aaa111", state: { hex: "aaa111", lat: 1, lon: 1 }, prediction: { available: true, reason: null } });
    expect(getData().selected).toBeNull();
    t.ws().recv({ type: "selected", hex: "bbb222", state: { hex: "bbb222", lat: 2, lon: 2 }, prediction: { available: false, reason: "turning" } });
    expect(getData().selected?.prediction).toEqual({ available: false, reason: "turning" });
    t.ws().recv({ type: "selected", hex: "bbb222", state: null, prediction: { available: false, reason: "stale" } });
    expect(getData().selected?.state).toBeNull();
    t.client.select(null);
    expect(getData().selected).toBeNull();
  });

  it("resume does not claim 'open' while the socket is down; a hidden tab defers subscribe until resume", () => {
    const t = setup();
    t.client.subscribe(BBOX, 7);
    t.client.connect();
    t.ws().open();
    t.ws().recv({ type: "welcome" });
    t.ws().close();
    expect(getData().conn).toBe("closed");
    t.client.pause();
    t.client.resume();
    expect(getData().conn).toBe("closed");
    // 숨긴 상태로 재접속 → 구독 미룸
    t.hidden.v = true;
    t.client.pause();
    vi.advanceTimersByTime(2000);
    t.ws().open();
    t.ws().recv({ type: "welcome" });
    expect(getData().conn).toBe("paused");
    expect(t.ws().types()).toEqual(["hello"]);
    t.hidden.v = false;
    t.client.resume();
    expect(getData().conn).toBe("open");
    expect(t.ws().types()).toEqual(["hello", "subscribe"]);
    // 구독된 상태에서 pause/resume 은 그대로 보낸다
    t.client.pause();
    t.client.resume();
    expect(t.ws().types()).toEqual(["hello", "subscribe", "pause", "resume"]);
  });

  it("stays within the send budget: bursts are deferred with the latest bbox winning", () => {
    const t = setup();
    t.client.connect();
    t.ws().open();
    t.ws().recv({ type: "welcome" });
    for (let i = 0; i < 30; i++) t.client.subscribe([124 + i * 0.01, 33, 131, 39], 7);
    const subs = () => t.ws().sent.filter((m) => m.type === "subscribe");
    expect(subs()).toHaveLength(16);
    vi.advanceTimersByTime(10_000);
    expect(subs()).toHaveLength(17);
    expect((subs()[16].bbox as number[])[0]).toBeCloseTo(124.29, 6);
    // ping 에 대한 pong 은 예산과 관계없이 바로
    t.ws().recv({ type: "ping" });
    expect(t.ws().types().at(-1)).toBe("pong");
  });
});
