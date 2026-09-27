import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WakelineWsClient, type SocketLike } from "@/lib/ws";
import { aircraftStates, clockOffsetMs, getData, resetData, serverNowMs } from "@/lib/store";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closedWith: number | undefined;
  /** true 면 close() 가 onclose 를 부르지 않는다(반쯤 열린 연결의 닫기 핸드셰이크가 끝나지 않는 상황) */
  hang = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close(code?: number) { this.closedWith = code; this.readyState = 3; if (!this.hang) this.onclose?.({ code: code ?? 1005 }); }
  /** 서버가 닫음(업그레이드 뒤 1013 등) */
  serverClose(code: number) { this.readyState = 3; this.onclose?.({ code }); }
  open() { this.readyState = 1; this.onopen?.({}); }
  recv(m: unknown) { this.onmessage?.({ data: typeof m === "string" ? m : JSON.stringify(m) }); }
  types() { return this.sent.map((m) => m.type); }
}

function setup(opts: { hidden?: boolean } = {}) {
  const sockets: FakeSocket[] = [];
  const worker = { msgs: [] as { type: string; offsetMs?: number }[], postMessage(m: unknown) { this.msgs.push(m as { type: string }); } };
  const hidden = { v: opts.hidden ?? false };
  const client = new WakelineWsClient(worker, {
    url: "ws://test/ws/v1", isHidden: () => hidden.v, mono: () => Date.now() - Date.parse("2026-09-27T00:00:00Z"),
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
  });
  return { client, worker, sockets, hidden, ws: () => sockets[sockets.length - 1] };
}

/** 다음 소켓이 만들어질 때까지 걸린 ms(100 ms 단위) */
function nextConnectDelay(t: ReturnType<typeof setup>, limitMs = 60_000): number {
  const n = t.sockets.length;
  let waited = 0;
  while (t.sockets.length === n && waited < limitMs) { vi.advanceTimersByTime(100); waited += 100; }
  return waited;
}

const BBOX: [number, number, number, number] = [124, 33, 131, 39];
const snap = (seq: number, aircraft: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  type: "snapshot", seq, v: 100 + seq, ts: "2026-09-27T05:10:00Z",
  sources: { region: { provider: "adsb_fi", fetched_at: "2026-09-27T05:09:55Z", lag_s: 5, stale: false }, global: null }, sigmets_version: 3, aircraft, ...extra,
});

beforeEach(() => { resetData(); vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-09-27T05:10:00Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("WakelineWsClient", () => {
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
    // welcome 의 server_time 으로 시계 오프셋(여기서는 0)을 먼저 워커에 알린다
    expect(t.worker.msgs.map((m) => m.type)).toEqual(["clock", "snapshot"]);
    expect(t.worker.msgs[0].offsetMs).toBe(0);
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

describe("reconnect backoff (WS-1)", () => {
  beforeEach(() => { vi.spyOn(Math, "random").mockReturnValue(0.5); }); // 지터 없음(×1.0)
  afterEach(() => { vi.restoreAllMocks(); });

  it("open → immediate close, repeated, backs off 1 → 2 → 4 s (open alone does not reset the attempt)", () => {
    const t = setup();
    t.client.connect();
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      t.ws().open();
      t.ws().serverClose(1006);
      delays.push(nextConnectDelay(t));
    }
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(getData().reconnectAttempt).toBe(3);
  });

  it("1013 (connection limit) after the upgrade waits the 30 s ceiling instead of ~1 s", () => {
    const t = setup();
    t.client.connect();
    t.ws().open();
    t.ws().serverClose(1013);
    expect(nextConnectDelay(t)).toBe(30_000);
    t.ws().open();
    t.ws().serverClose(1008);
    expect(nextConnectDelay(t)).toBe(30_000);
  });

  it("the attempt resets only after a healthy connection: first snapshot, or welcome + 30 s open", () => {
    const t = setup();
    t.client.subscribe(BBOX, 7);
    t.client.connect();
    t.ws().open(); t.ws().serverClose(1006); nextConnectDelay(t); // attempt 1
    t.ws().open(); t.ws().serverClose(1006); nextConnectDelay(t); // attempt 2
    t.ws().open();
    t.ws().recv({ type: "welcome", server_time: new Date().toISOString() });
    t.ws().recv(snap(1));
    expect(getData().reconnectAttempt).toBe(0);
    t.ws().serverClose(1006);
    expect(nextConnectDelay(t)).toBe(1000);
    // 숨긴 탭: 스냅샷 없이 welcome 뒤 30 s 열려 있으면 건강
    t.hidden.v = true;
    t.ws().open();
    t.ws().recv({ type: "welcome", server_time: new Date().toISOString() });
    vi.advanceTimersByTime(29_000);
    t.ws().recv({ type: "ping" });
    vi.advanceTimersByTime(1_000);
    t.ws().serverClose(1006);
    expect(nextConnectDelay(t)).toBe(1000);
  });

  it("a slow-consumer close right after welcome (no snapshot, < 30 s) keeps backing off", () => {
    const t = setup();
    t.client.subscribe(BBOX, 7);
    t.client.connect();
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      t.ws().open();
      t.ws().recv({ type: "welcome", server_time: new Date().toISOString() });
      vi.advanceTimersByTime(5_000); // 서버의 5 s 송신 제한 초과
      t.ws().serverClose(1006);
      delays.push(nextConnectDelay(t));
    }
    expect(delays).toEqual([1000, 2000, 4000]);
  });
});

describe("receive watchdog (WS-2)", () => {
  beforeEach(() => { vi.spyOn(Math, "random").mockReturnValue(0.5); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("pings every 30 s keep a quiet connection open", () => {
    const t = setup();
    t.client.connect();
    t.ws().open();
    t.ws().recv({ type: "welcome", server_time: new Date().toISOString() });
    for (let i = 0; i < 6; i++) { vi.advanceTimersByTime(30_000); t.ws().recv({ type: "ping" }); }
    expect(getData().conn).toBe("open");
    expect(t.sockets).toHaveLength(1);
  });

  it("no message for 75 s → treated as dead without waiting for onclose: conn closed, socket closed(4000), reconnect scheduled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    t.client.connect();
    const first = t.ws();
    first.hang = true; // 반쯤 열린 연결: 닫기 핸드셰이크가 끝나지 않는다
    first.open();
    first.recv({ type: "welcome", server_time: new Date().toISOString() });
    vi.advanceTimersByTime(70_000);
    expect(getData().conn).toBe("open");
    vi.advanceTimersByTime(10_000); // 75 s 를 넘긴 뒤 첫 점검(10 s 주기 → 80 s)
    expect(getData().conn).toBe("closed");
    expect(first.closedWith).toBe(4000);
    expect(warn).toHaveBeenCalled();
    expect(nextConnectDelay(t)).toBe(1000);
    expect(t.sockets).toHaveLength(2);
    // 죽은 소켓의 늦은 이벤트는 무시된다
    first.onclose?.({ code: 1006 });
    first.recv({ type: "welcome" });
    expect(getData().conn).toBe("connecting");
  });

  it("a socket that never opens is also abandoned after 75 s", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    t.client.connect();
    vi.advanceTimersByTime(80_000);
    expect(getData().conn).toBe("closed");
    expect(t.sockets[0].closedWith).toBe(4000);
  });

  it("records lastRxAt in the store (throttled) so the status bar can tell a silent connection", () => {
    const t = setup();
    t.client.connect();
    t.ws().open();
    t.ws().recv({ type: "welcome", server_time: new Date().toISOString() });
    const at0 = getData().lastRxAt!;
    expect(at0).toBe(Date.now());
    vi.advanceTimersByTime(1_000);
    t.ws().recv({ type: "ping" });
    expect(getData().lastRxAt).toBe(at0); // 5 s 안에는 스토어를 다시 쓰지 않는다
    vi.advanceTimersByTime(5_000);
    t.ws().recv({ type: "ping" });
    expect(getData().lastRxAt).toBe(at0 + 6_000);
  });

  it("close() by the user stops the watchdog and never reconnects", () => {
    const t = setup();
    t.client.connect();
    t.ws().open();
    t.client.close();
    vi.advanceTimersByTime(200_000);
    expect(t.sockets).toHaveLength(1);
    expect(getData().conn).toBe("closed");
  });
});

describe("server clock (WS-3 / DH-1)", () => {
  it("welcome server_time sets one offset used by serverNowMs and posted to the worker", () => {
    const t = setup();
    t.client.connect();
    t.ws().open();
    // 브라우저 시계가 70 s 빠르다 = 서버 시각이 브라우저보다 70 s 뒤
    t.ws().recv({ type: "welcome", server_time: new Date(Date.now() - 70_000).toISOString() });
    expect(clockOffsetMs()).toBe(-70_000);
    expect(serverNowMs(Date.now())).toBe(Date.now() - 70_000);
    expect(t.worker.msgs.filter((m) => m.type === "clock").map((m) => m.offsetMs)).toEqual([-70_000]);
  });

  it("large snapshots are not clock samples; small ones and small diffs are; delayed messages never lower the offset", () => {
    const t = setup();
    t.client.subscribe(BBOX, 7);
    t.client.connect();
    t.ws().open();
    t.ws().recv({ type: "welcome", server_time: new Date(Date.now() + 2_000).toISOString() });
    expect(clockOffsetMs()).toBe(2_000);
    // 6 s 걸려 도착한 큰 스냅샷(ts 가 6 s 전): 오프셋에 영향 없음
    const big = Array.from({ length: 2000 }, (_, i) => ({ hex: (0x100000 + i).toString(16), lat: 1, lon: 1, provider: "adsb_fi" }));
    t.ws().recv(snap(1, big, { ts: new Date(Date.now() + 2_000 - 6_000).toISOString() }));
    expect(clockOffsetMs()).toBe(2_000);
    // 지연된 작은 diff(1.5 s 늦음)도 최댓값 필터 때문에 오프셋을 낮추지 않는다
    t.ws().recv({ type: "diff", seq: 2, ts: new Date(Date.now() + 500).toISOString(), upsert: [], remove: [] });
    expect(clockOffsetMs()).toBe(2_000);
    // 지연이 더 작은 표본(서버 시각이 더 앞선)은 바로 반영 — 0.25 s 이내 변화는 워커에 다시 보내지 않는다
    t.ws().recv({ type: "diff", seq: 3, ts: new Date(Date.now() + 2_200).toISOString(), upsert: [], remove: [] });
    expect(clockOffsetMs()).toBe(2_200);
    t.ws().recv({ type: "status", status: { server_time: new Date(Date.now() + 2_600).toISOString(), region: { provider: "adsb_fi", lag_s: 1 } } });
    expect(t.worker.msgs.filter((m) => m.type === "clock").map((m) => m.offsetMs)).toEqual([2_000, 2_600]);
  });
});
