import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_MAP_BBOX, NO_MAP_ZOOM, WakelineWsClient, type SocketLike } from "@/lib/ws";
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
    t.ws().recv(snap(1, [{ hex: "00000a", lat: 1, lon: 1 }]));
    t.ws().recv({ type: "diff", seq: 2, v: 103, ts: "2026-09-27T05:10:10Z", upsert: [{ hex: "00000b", lat: 2, lon: 2 }], remove: [] });
    expect(aircraftStates.has("00000b")).toBe(true);
    t.ws().recv({ type: "diff", seq: 4, v: 105, upsert: [{ hex: "00000c", lat: 3, lon: 3 }], remove: ["00000a"] });
    t.ws().recv({ type: "diff", seq: 5, v: 106, upsert: [{ hex: "00000d", lat: 4, lon: 4 }], remove: [] });
    expect(aircraftStates.has("00000c")).toBe(false);
    expect(aircraftStates.has("00000a")).toBe(true);
    expect(t.ws().types().filter((x) => x === "resync")).toHaveLength(1);
    t.ws().recv(snap(1, [{ hex: "00000c", lat: 3, lon: 3 }]));
    t.ws().recv({ type: "diff", seq: 2, upsert: [], remove: ["00000c"] });
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
    t.ws().recv({ type: "diff", seq: 2, upsert: [{ hex: "0000f1", lat: 50.123, lon: 8.456, provider: "opensky" }], remove: [] });
    const w1 = aircraftStates.get("0000f1")!;
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

  it("a late onclose from a closed client does not overwrite the next client's connection state (R-75)", () => {
    // '/'를 떠났다 돌아올 때: 이전 클라이언트 A 를 닫았지만 닫기 핸드셰이크가 늦게 끝난다(반쯤 열린 연결)
    const a = setup();
    a.client.connect();
    a.ws().open();
    a.ws().recv({ type: "welcome" });
    const sockA = a.ws();
    sockA.hang = true;
    a.client.close();
    expect(getData().conn).toBe("closed"); // 닫은 즉시 한 번만 기록
    // 새 클라이언트 B 가 연결되고 수요 상태를 받는다
    const b = setup();
    b.client.select("71c123");
    b.client.connect();
    b.ws().open();
    b.ws().recv({ type: "welcome" });
    b.ws().recv({ type: "demand", hot: null, focus: { hex: "71c123", state: "active", interval_s: 5, since: "2026-09-27T05:10:00Z" } });
    expect(getData().conn).toBe("open");
    // A 의 닫기가 이제서야 끝난다 — B 의 상태를 'closed'·수요 없음으로 덮으면 안 된다
    sockA.onclose?.({ code: 1000 });
    expect(getData().conn).toBe("open");
    expect(getData().demand?.focus).toMatchObject({ hex: "71c123", state: "active" });
    vi.advanceTimersByTime(60_000);
    expect(a.sockets).toHaveLength(1); // A 는 다시 연결하지 않는다
  });

  it("a late close() from a client that no longer owns the store keeps the newer connection's state", () => {
    // 넘겨받기 순서가 엇갈린 경우: 클라이언트 A 를 닫기 전에 B 가 먼저 연결했다 — 스토어의 연결 상태는 마지막으로 connect 한 B 의 것이다
    const a = setup();
    a.client.connect();
    a.ws().open();
    a.ws().recv({ type: "welcome" });
    const b = setup();
    b.client.select("71c123");
    b.client.connect();
    b.ws().open();
    b.ws().recv({ type: "welcome" });
    b.ws().recv({ type: "demand", hot: null, focus: { hex: "71c123", state: "active", interval_s: 5, since: "2026-09-27T05:10:00Z" } });
    expect(getData().conn).toBe("open");
    // A 가 이제서야 닫힌다 — 자기 소켓은 닫지만 B 의 상태를 'closed'·수요 없음으로 덮으면 안 된다
    a.client.close();
    expect(a.ws().closedWith).toBe(1000);
    expect(getData().conn).toBe("open");
    expect(getData().demand?.focus).toMatchObject({ hex: "71c123", state: "active" });
    vi.advanceTimersByTime(60_000);
    expect(a.sockets).toHaveLength(1); // A 는 다시 연결하지 않는다
    // 주인인 B 가 닫으면 지금처럼 지운다
    b.client.close();
    expect(getData().conn).toBe("closed");
    expect(getData().demand).toBeNull();
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

describe("map-less subscription (Q4 — the dashboard could not draw the map)", () => {
  const alert = { id: 1, kind: "OBSERVED", hex: "abc123", sigmet_id: "S1", fir_id: "RKRR", hazard: "TS", entered_at: "2026-09-27T05:00:00Z", evidence: {}, estimated: false };
  const welcomeOf = () => ({ type: "welcome", server_time: new Date().toISOString() });

  it("called before connect: after welcome the client sends exactly layers{false,false} then subscribe{zoom 5} — select · select_ship never go out", () => {
    const t = setup();
    t.client.subscribeWithoutMap();
    t.client.select("abc123"); // 지도 없는 클라이언트의 선택은 서버에 알리지 않는다(집중 추적 수요 없음)
    t.client.selectShip("440123456");
    t.client.connect();
    t.ws().open();
    t.ws().recv(welcomeOf());
    expect(t.ws().sent).toEqual([
      { type: "hello", proto: 1, client: "web/0.4" },
      { type: "layers", aircraft: false, ships: false },
      { type: "subscribe", bbox: [127, 36, 128, 37], zoom: 5, detail: "lite" },
    ]);
    expect(NO_MAP_BBOX).toEqual([127, 36, 128, 37]);
    expect(NO_MAP_ZOOM).toBe(5);
    // 열린 뒤의 선택 · 선택 해제도 프레임을 늘리지 않는다
    t.client.select("def456");
    t.client.selectShip("440654321");
    t.client.select(null);
    t.client.selectShip(null);
    vi.advanceTimersByTime(10_000);
    expect(t.ws().types()).toEqual(["hello", "layers", "subscribe"]);
    expect(getData().conn).toBe("open");
  });

  it("a selection made before subscribeWithoutMap is dropped: neither connection nor the reconnect sends select · select_ship", () => {
    // 지도 없는 구독으로 바꾸기 전에 고른 항공기 · 선박이 클라이언트에 남으면 welcome 마다 서버에 알려 집중 추적 수요가 생긴다
    const t = setup();
    t.client.select("abc123");
    t.client.selectShip("440123456");
    t.client.subscribeWithoutMap();
    t.client.connect();
    t.ws().open();
    t.ws().recv(welcomeOf());
    const first = t.ws();
    expect(first.types()).toEqual(["hello", "layers", "subscribe"]);
    first.serverClose(1006);
    nextConnectDelay(t);
    expect(t.sockets).toHaveLength(2);
    t.ws().open();
    t.ws().recv(welcomeOf());
    expect(t.ws().types()).toEqual(["hello", "layers", "subscribe"]);
    for (const s of t.sockets) expect(s.types().filter((x) => x === "select" || x === "select_ship")).toEqual([]);
  });

  it("never writes the store viewport; a snapshot leaves the aircraft empty while alerts and status are applied", () => {
    const t = setup();
    t.client.subscribeWithoutMap();
    t.client.connect();
    t.ws().open();
    t.ws().recv(welcomeOf());
    expect(getData().viewport).toBeNull();
    t.ws().recv(snap(1, [{ hex: "abc123", lat: 36.5, lon: 127.5 }]));
    expect(aircraftStates.size).toBe(0);
    expect(getData().aircraftCount).toBeNull(); // 받지 않는 수는 모름(—)
    expect(t.worker.msgs.filter((m) => m.type === "snapshot")).toEqual([{ type: "snapshot", aircraft: [] }]); // 레이어를 끌 때의 빈 스냅샷뿐
    t.ws().recv({ type: "alerts", version: 10, alerts: [alert] });
    expect(getData().alerts.has(1)).toBe(true);
    expect(getData().alertsVersion).toBe(10);
    t.ws().recv({ type: "status", status: { server_time: new Date().toISOString(), region: { provider: "adsb_fi", lag_s: 1 } } });
    expect(getData().status).not.toBeNull();
    expect(getData().feeds.region?.provider).toBe("adsb_fi");
    expect(getData().viewport).toBeNull();
  });

  it("hidden at welcome → resume subscribes without writing the viewport; a reconnect does not write it either", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const t = setup({ hidden: true });
      t.client.subscribeWithoutMap();
      t.client.connect();
      t.ws().open();
      t.ws().recv(welcomeOf());
      expect(t.ws().types()).toEqual(["hello", "layers"]); // 숨김 — 구독은 resume 이 보낸다
      t.hidden.v = false;
      t.client.resume();
      expect(t.ws().sent.at(-1)).toEqual({ type: "subscribe", bbox: [127, 36, 128, 37], zoom: 5, detail: "lite" });
      t.client.pause();
      t.client.resume();
      expect(t.ws().types()).toEqual(["hello", "layers", "subscribe", "pause", "resume"]);
      expect(getData().viewport).toBeNull();
      t.ws().serverClose(1006);
      nextConnectDelay(t);
      t.ws().open();
      t.ws().recv(welcomeOf());
      expect(t.ws().sent).toEqual([
        { type: "hello", proto: 1, client: "web/0.4" },
        { type: "layers", aircraft: false, ships: false },
        { type: "subscribe", bbox: [127, 36, 128, 37], zoom: 5, detail: "lite" },
      ]);
      expect(getData().viewport).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a late close() of the map-less client does not overwrite the map client's conn · demand", () => {
    // (b1) 넘겨받기: 지도 없는 클라이언트 A 를 닫기 전에 지도 클라이언트 B 가 먼저 연결했다
    const a = setup();
    a.client.subscribeWithoutMap();
    a.client.connect();
    a.ws().open();
    a.ws().recv(welcomeOf());
    const b = setup();
    b.client.subscribe(BBOX, 7);
    b.client.select("71c123");
    b.client.connect();
    b.ws().open();
    b.ws().recv(welcomeOf());
    b.ws().recv({ type: "demand", hot: null, focus: { hex: "71c123", state: "active", interval_s: 5, since: "2026-09-27T05:10:00Z" } });
    expect(getData().viewport).toEqual({ bbox: BBOX, zoom: 7 }); // 지도 클라이언트는 지금처럼 화면을 쓴다
    a.client.close();
    expect(a.ws().closedWith).toBe(1000);
    expect(getData().conn).toBe("open");
    expect(getData().demand?.focus).toMatchObject({ hex: "71c123", state: "active" });
    expect(getData().viewport).toEqual({ bbox: BBOX, zoom: 7 });
  });
});

describe("map-less subscription constants are pinned to the server rules (read from the api code)", () => {
  const repo = new URL("../../../", import.meta.url);
  const src = (p: string) => readFileSync(new URL(p, repo), "utf8");
  it("NO_MAP_ZOOM is below the hot-region zoom (no hot demand) and within the world-view zoom; NO_MAP_BBOX passes the bbox area limit", () => {
    const demand = src("apps/api/src/main/java/dev/wakeline/ws/DemandService.java");
    const hotMinZoom = Number(/public static final int HOT_MIN_ZOOM = (\d+);/.exec(demand)?.[1]);
    expect(hotMinZoom).toBeGreaterThan(0);
    // 이 상수가 핫 리전 수요의 문턱이고, 항공기 레이어를 끈 세션에는 수요가 없다(두 겹)
    expect(demand).toContain("sub.zoom() < HOT_MIN_ZOOM || !s.layerAircraft");
    expect(NO_MAP_ZOOM).toBeLessThan(hotMinZoom);
    expect(NO_MAP_ZOOM).toBeLessThanOrEqual(5);
    // 면적 상한을 넘는 bbox 는 zoom ≤ 5 만 받는다 — 그 5 도 서버 코드에서 읽는다
    const handler = src("apps/api/src/main/java/dev/wakeline/ws/WakelineWsHandler.java");
    const worldZoom = Number(/bbox\.area\(\) > props\.maxBboxAreaSqdeg\(\) && zoom > (\d+)/.exec(handler)?.[1]);
    expect(worldZoom).toBe(5);
    expect(NO_MAP_ZOOM).toBeLessThanOrEqual(worldZoom);
    const yml = src("apps/api/src/main/resources/application.yml");
    const maxArea = Number(/^ {2}max-bbox-area-sqdeg: (\d+(?:\.\d+)?)$/m.exec(yml)?.[1]);
    expect(maxArea).toBeGreaterThan(0);
    const [lomin, lamin, lomax, lamax] = NO_MAP_BBOX;
    expect(lomin).toBeLessThan(lomax);
    expect(lamin).toBeLessThan(lamax);
    expect((lomax - lomin) * (lamax - lamin)).toBeLessThanOrEqual(maxArea);
  });
});
