/**
 * WS 클라이언트 — 계약 v2 추가분: layers · ships_snapshot/diff(sseq) · ships_grid · select_ship/ship_selected · demand · status.sources.ais.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WakelineWsClient, type SocketLike } from "@/lib/ws";
import { aircraftStates, getData, resetData, shipStates } from "@/lib/store";
import { MAX_SHIPS } from "@/lib/ships";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close(code?: number) { this.readyState = 3; this.onclose?.({ code: code ?? 1005 }); }
  open() { this.readyState = 1; this.onopen?.({}); }
  recv(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
  types() { return this.sent.map((m) => m.type); }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const worker = { postMessage() {} };
  const client = new WakelineWsClient(worker, { url: "ws://test/ws/v1", isHidden: () => false, createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; } });
  return { client, ws: () => sockets[sockets.length - 1] };
}
const BBOX: [number, number, number, number] = [128, 34, 131, 36];
const TS = "2026-09-28T03:00:00Z";
const ship = (mmsi: string, over: Record<string, unknown> = {}) => ({ mmsi, lat: 35, lon: 129.5, heading_deg: 90, ship_type: 70, seen_at: TS, ...over });

function welcomed(t: ReturnType<typeof setup>) {
  t.client.connect();
  t.ws().open();
  t.ws().recv({ type: "welcome", server_time: TS });
}

beforeEach(() => { resetData(); vi.useFakeTimers(); vi.setSystemTime(Date.parse(TS)); });
afterEach(() => { vi.useRealTimers(); });

describe("layers message", () => {
  it("is not sent on welcome while the layers match the server default (aircraft on, ships off)", () => {
    const t = setup();
    t.client.subscribe(BBOX, 8);
    welcomed(t);
    expect(t.ws().types()).toEqual(["hello", "subscribe"]);
  });
  it("is sent before subscribe on welcome when ships are on, and on every change", () => {
    const t = setup();
    t.client.subscribe(BBOX, 8);
    t.client.setLayers(true, true);
    expect(getData().ships.mode).toBe("waiting");
    welcomed(t);
    expect(t.ws().types()).toEqual(["hello", "layers", "subscribe"]);
    expect(t.ws().sent[1]).toEqual({ type: "layers", aircraft: true, ships: true });
    t.client.setLayers(true, true); // 같은 값 — 보내지 않음
    t.client.setLayers(false, true);
    expect(t.ws().sent.at(-1)).toEqual({ type: "layers", aircraft: false, ships: true });
    expect(t.ws().sent.filter((m) => m.type === "layers")).toHaveLength(2);
  });
  it("turning ships off clears every received ship and ignores late ship messages", () => {
    const t = setup();
    t.client.setLayers(true, true);
    welcomed(t);
    t.ws().recv({ type: "ships_snapshot", sseq: 1, ts: TS, ships: [ship("111111111")] });
    expect(shipStates.size).toBe(1);
    t.client.setLayers(true, false);
    expect(shipStates.size).toBe(0);
    expect(getData().ships.mode).toBe("off");
    t.ws().recv({ type: "ships_snapshot", sseq: 1, ts: TS, ships: [ship("222222222")] });
    t.ws().recv({ type: "ships_grid", ts: TS, cell_deg: 2, cells: [[35, 129, 3, "cargo"]] });
    expect(shipStates.size).toBe(0);
    expect(getData().ships.mode).toBe("off");
  });
});

describe("ships_snapshot / ships_diff (own contiguous sseq)", () => {
  it("applies contiguous diffs, validates ships, and bumps the view version", () => {
    const t = setup();
    t.client.setLayers(true, true);
    welcomed(t);
    t.ws().recv({ type: "ships_snapshot", sseq: 1, ts: TS, ships: [ship("111111111"), ship("222222222"), { mmsi: "bad", lat: 1, lon: 1 }, ship("333333333", { lat: 95 })] });
    expect([...shipStates.keys()]).toEqual(["111111111", "222222222"]);
    const v1 = getData().ships.version;
    expect(getData().ships).toMatchObject({ mode: "points", count: 2 });
    t.ws().recv({ type: "ships_diff", sseq: 2, ts: TS, upsert: [ship("444444444"), ship("111111111", { lat: 35.1 })], remove: ["222222222", "nope"] });
    expect([...shipStates.keys()].sort()).toEqual(["111111111", "444444444"]);
    expect(shipStates.get("111111111")!.lat).toBe(35.1);
    expect(getData().ships.version).toBeGreaterThan(v1);
  });
  it("a gap in sseq is not applied and asks for one resync until the next snapshot", () => {
    const t = setup();
    t.client.setLayers(true, true);
    welcomed(t);
    t.ws().recv({ type: "ships_snapshot", sseq: 1, ts: TS, ships: [ship("111111111")] });
    t.ws().recv({ type: "ships_diff", sseq: 3, ts: TS, upsert: [ship("999999999")], remove: [] });
    t.ws().recv({ type: "ships_diff", sseq: 4, ts: TS, upsert: [ship("888888888")], remove: [] });
    expect(shipStates.has("999999999")).toBe(false);
    expect(t.ws().types().filter((x) => x === "resync")).toHaveLength(1);
    t.ws().recv({ type: "ships_snapshot", sseq: 1, ts: TS, ships: [ship("999999999")] });
    t.ws().recv({ type: "ships_diff", sseq: 2, ts: TS, upsert: [ship("888888888")], remove: [] });
    expect([...shipStates.keys()].sort()).toEqual(["888888888", "999999999"]);
  });
  it("a diff before any snapshot (or after a grid) is a gap", () => {
    const t = setup();
    t.client.setLayers(true, true);
    welcomed(t);
    t.ws().recv({ type: "ships_grid", ts: TS, cell_deg: 0.5, cells: [[35, 129.5, 3, "cargo"]] });
    t.ws().recv({ type: "ships_diff", sseq: 2, ts: TS, upsert: [ship("111111111")], remove: [] });
    expect(shipStates.size).toBe(0);
    expect(t.ws().types()).toContain("resync");
  });
  it("the client holds at most MAX_SHIPS ships", () => {
    const t = setup();
    t.client.setLayers(true, true);
    welcomed(t);
    const many = Array.from({ length: MAX_SHIPS + 5 }, (_, i) => ship(String(100000000 + i)));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    t.ws().recv({ type: "ships_snapshot", sseq: 1, ts: TS, ships: many });
    expect(shipStates.size).toBe(MAX_SHIPS);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("ships_grid", () => {
  it("replaces individual ships with validated cells and records cell size / capped", () => {
    const t = setup();
    t.client.setLayers(true, true);
    welcomed(t);
    t.ws().recv({ type: "ships_snapshot", sseq: 1, ts: TS, ships: [ship("111111111")] });
    t.ws().recv({ type: "ships_grid", ts: TS, cell_deg: 2, capped: true, cells: [[35, 129, 3, "cargo"], [36, 131, 5, "tanker"], ["x"]] });
    expect(shipStates.size).toBe(0);
    expect(getData().ships).toMatchObject({ mode: "grid", count: 2, total: 8, cell_deg: 2, capped: true });
  });
});

describe("select_ship / ship_selected", () => {
  it("sends select_ship (also on reconnect) and keeps only the reply for the current selection", () => {
    const t = setup();
    t.client.selectShip("431011305");
    welcomed(t);
    expect(t.ws().sent).toContainEqual({ type: "select_ship", mmsi: "431011305" });
    t.ws().recv({ type: "ship_selected", mmsi: "999999999", state: ship("999999999"), static: null });
    expect(getData().shipSelected).toBeNull();
    t.ws().recv({ type: "ship_selected", mmsi: "431011305", state: { lat: 35.4, lon: 139.8, seen_at: TS, class: "A" }, static: { name: "KIMITSU MARU" } });
    expect(getData().shipSelected).toMatchObject({ mmsi: "431011305", state: { mmsi: "431011305", class: "A" }, static: { name: "KIMITSU MARU", eta_month: null } });
    // 스키마 밖의 값(eta_month 0 — 1–12 만)이 있으면 그 정적 정보를 버리고 센다(계약 v5 §E2 — 틀린 값을 모름으로 바꿔 보이지 않는다)
    t.ws().recv({ type: "ship_selected", mmsi: "431011305", state: null, static: { name: "KIMITSU MARU", eta_month: 0 } });
    expect(getData().shipSelected?.static).toBeNull();
    expect(getData().wsInvalid.elements).toBe(1);
    // 상태 안의 MMSI 가 다르면 버린다
    t.ws().recv({ type: "ship_selected", mmsi: "431011305", state: { mmsi: "111111111", lat: 1, lon: 1 }, static: null });
    expect(getData().shipSelected?.state).toBeNull();
    t.client.selectShip("not-a-mmsi");
    expect(t.ws().sent.at(-1)).toEqual({ type: "select_ship", mmsi: null });
    expect(getData().shipSelected).toBeNull();
  });
});

describe("demand and AIS status", () => {
  it("stores the server's demand message and clears it when the connection drops", () => {
    const t = setup();
    t.client.select("71c123");
    welcomed(t);
    t.ws().recv({ type: "demand", hot: null, focus: { hex: "71c123", state: "active", interval_s: 5, since: TS } });
    expect(getData().demand?.focus).toMatchObject({ hex: "71c123", state: "active", interval_s: 5 });
    t.ws().close(1006);
    expect(getData().demand).toBeNull();
  });
  it("status.sources.ais becomes the AIS badge input", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv({ type: "status", status: { server_time: TS, region: {}, sources: { ais: { connected: true, lag_s: 2, msgs_per_s: 5.4, gap_open_since: null, last_gap: null } } } });
    expect(getData().ais).toMatchObject({ connected: true, lag_s: 2, msgs_per_s: 5.4, state: null, coverage: null });
    t.ws().recv({ type: "status", status: { server_time: TS, region: {}, sources: { ais: { connected: true, state: "receiving", coverage: [[46, 150, 18, 105]] } } } });
    expect(getData().ais).toMatchObject({ state: "receiving", coverage: [{ s: 18, w: 105, n: 46, e: 150 }] });
  });
});

describe("aircraft layer off (review 2026-09-28b #17)", () => {
  const ac = (hex: string) => ({ hex, lat: 35, lon: 129, seen_at: TS });
  function setupWithWorker() {
    const posted: Record<string, unknown>[] = [];
    const sockets: FakeSocket[] = [];
    const client = new WakelineWsClient({ postMessage: (m) => posted.push(m as Record<string, unknown>) }, {
      url: "ws://test/ws/v1", isHidden: () => false, createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    });
    return { client, posted, ws: () => sockets[sockets.length - 1] };
  }
  it("clears the aircraft copy, posts an empty snapshot to the worker and makes the count unknown; late aircraft messages are ignored", () => {
    const t = setupWithWorker();
    t.client.subscribe(BBOX, 8);
    welcomed(t);
    t.ws().recv({ type: "snapshot", seq: 1, v: 1, ts: TS, aircraft: [ac("71c001"), ac("71c002")] });
    expect(getData().aircraftCount).toBe(2);
    expect(aircraftStates.size).toBe(2);
    t.client.setLayers(false, false);
    expect(aircraftStates.size).toBe(0);
    expect(getData().aircraftCount).toBeNull();
    expect(t.posted.at(-1)).toEqual({ type: "snapshot", aircraft: [] });
    expect(t.ws().sent.at(-1)).toEqual({ type: "layers", aircraft: false, ships: false });
    // 끄기 전에 보낸 메시지가 늦게 와도 되살리지 않는다(resync 도 요청하지 않는다)
    t.ws().recv({ type: "diff", seq: 2, v: 2, ts: TS, upsert: [ac("71c003")], remove: [] });
    t.ws().recv({ type: "snapshot", seq: 1, v: 2, ts: TS, aircraft: [ac("71c009")] });
    expect(aircraftStates.size).toBe(0);
    expect(getData().aircraftCount).toBeNull();
    expect(t.ws().types()).not.toContain("resync");
    // 다시 켜면 서버의 seq 1 스냅샷부터
    t.client.setLayers(true, false);
    t.ws().recv({ type: "snapshot", seq: 1, v: 3, ts: TS, aircraft: [ac("71c004")] });
    expect(getData().aircraftCount).toBe(1);
    t.ws().recv({ type: "diff", seq: 2, v: 4, ts: TS, upsert: [ac("71c005")], remove: [] });
    expect(getData().aircraftCount).toBe(2);
  });
});
