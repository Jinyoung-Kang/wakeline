/**
 * 계약 v5 §E2 · ADR-020 · R-93: WS 수신 검증(lib/ws-validate.ts)과 lib/ws.ts 의 처리.
 * - api 시험(WsSchemaContractTest)이 실제 빌더로 만들어 schemas/ws/server.v1.json 으로 검증한 표본(fixtures/ws-samples.v1.json)을 웹 검증기가 모두 받는다.
 * - 틀린 표본(시험용 검사기로 스키마 위반임을 먼저 확인)은 메시지를 통째로 버리거나(봉투) 틀린 원소만 버리고 센다.
 * - diff 의 lastSeq 는 적용이 끝난 뒤에만 오른다 — 처리 중 예외는 resync + 브라우저 오류 보고(§C8).
 * - 웹이 실제로 보낸 클라이언트 메시지는 schemas/ws/client.v1.json 을 만족한다.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "@/components/StatusBar";
import { aircraftStates, getData, resetData, shipStates } from "@/lib/store";
import { validateServerMessage } from "@/lib/ws-validate";
import { ac, BBOX, diff, resyncs, setup, snap, TS, welcomed } from "./helpers/fake-ws";
import { validate } from "./helpers/mini-schema";

type Json = Record<string, unknown>;
interface Sample { name: string; message: Json }
const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const fixture = read("./fixtures/ws-samples.v1.json") as { server: Sample[]; client: Sample[] };
const serverSchema = read("../../../schemas/ws/server.v1.json") as Json;
const clientSchema = read("../../../schemas/ws/client.v1.json") as Json;
const SERVER_TYPES = (serverSchema.properties as { type: { enum: string[] } }).type.enum;
const CLIENT_TYPES = (clientSchema.properties as { type: { enum: string[] } }).type.enum;
const sample = (name: string): Json => {
  const s = fixture.server.find((x) => x.name === name);
  if (!s) throw new Error(`no fixture sample ${name}`);
  return structuredClone(s.message);
};

// ---------------------------------------------------------------- 표본 ↔ 웹 검증기

describe("fixture samples from the api builders (tests/fixtures/ws-samples.v1.json)", () => {
  it("cover all 17 server message types and all 10 client message types of the schemas", () => {
    expect(SERVER_TYPES).toHaveLength(17);
    expect(CLIENT_TYPES).toHaveLength(10);
    expect(new Set(fixture.server.map((s) => s.message.type))).toEqual(new Set(SERVER_TYPES));
    expect(new Set(fixture.client.map((s) => s.message.type))).toEqual(new Set(CLIENT_TYPES));
  });

  it("satisfy the schemas (the test helper agrees with networknt and Python jsonschema)", () => {
    for (const s of fixture.server) expect(validate(serverSchema, s.message), s.name).toEqual([]);
    for (const s of fixture.client) expect(validate(clientSchema, s.message), s.name).toEqual([]);
  });

  it.each(fixture.server.map((s) => [s.name, s.message] as const))("%s passes the web validator whole (nothing dropped)", (_name, message) => {
    const r = validateServerMessage(structuredClone(message));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.dropped).toBe(0);
    expect(r.msg.type).toBe(message.type);
  });

  it("keeps valid elements as the same objects (no copy on the hot path)", () => {
    const snap = sample("snapshot.lite");
    const r = validateServerMessage(snap);
    expect(r.kind === "ok" && r.msg.type === "snapshot" && r.msg.aircraft).toBe(snap.aircraft);
  });
});

// ---------------------------------------------------------------- 틀린 표본

type Expect = "invalid" | { dropped: number };
type Mutation = [label: string, sampleName: string, mutate: (m: Json) => unknown, expected: Expect];
const at = (m: Json, ...path: (string | number)[]): Json => path.reduce<unknown>((o, k) => (o as Record<string | number, unknown>)[k], m) as Json;

const MUTATIONS: Mutation[] = [
  ["snapshot seq as string", "snapshot.lite", (m) => { m.seq = "1"; }, "invalid"],
  ["snapshot without seq", "snapshot.lite", (m) => { delete m.seq; }, "invalid"],
  ["snapshot aircraft not an array", "snapshot.lite", (m) => { m.aircraft = { hex: "71c0a1" }; }, "invalid"],
  ["snapshot sources.region a string", "snapshot.lite", (m) => { at(m, "sources").region = "adsb_lol"; }, "invalid"],
  ["snapshot aircraft element with a bad hex", "snapshot.lite", (m) => { at(m, "aircraft", 0).hex = "XYZ123"; }, { dropped: 1 }],
  ["snapshot aircraft element with lat 91", "snapshot.lite", (m) => { at(m, "aircraft", 0).lat = 91; }, { dropped: 1 }],
  ["snapshot aircraft element with alt_ft as a string", "snapshot.lite", (m) => { at(m, "aircraft", 0).alt_ft = "35000"; }, { dropped: 1 }],
  ["snapshot aircraft element null", "snapshot.lite", (m) => { (m.aircraft as unknown[]).push(null); }, { dropped: 1 }],
  ["diff without seq", "diff", (m) => { delete m.seq; }, "invalid"],
  ["diff upsert not an array", "diff", (m) => { m.upsert = "71c0a1"; }, "invalid"],
  ["diff remove not an array", "diff", (m) => { m.remove = "71c0a2"; }, "invalid"],
  ["diff ts not a time", "diff", (m) => { m.ts = 1790000000; }, "invalid"],
  ["diff upsert element with a bad squawk", "diff", (m) => { at(m, "upsert", 0).squawk = "9999"; }, { dropped: 1 }],
  ["diff remove element not a hex", "diff", (m) => { (m.remove as unknown[]).push(42); }, { dropped: 1 }],
  ["alerts not an array", "alerts", (m) => { m.alerts = {}; }, "invalid"],
  ["alerts version as string", "alerts", (m) => { m.version = "3"; }, "invalid"],
  ["alerts element without evidence", "alerts", (m) => { delete at(m, "alerts", 0).evidence; }, { dropped: 1 }],
  ["alerts element with an unknown kind", "alerts", (m) => { at(m, "alerts", 1).kind = "GUESSED"; }, { dropped: 1 }],
  ["alerts_batch item with an unknown event", "alerts_batch", (m) => { at(m, "items", 0).event = "MAYBE"; }, { dropped: 1 }],
  ["alerts_batch item alert without id", "alerts_batch", (m) => { delete at(m, "items", 1, "alert").id; }, { dropped: 1 }],
  ["selected hex not a hex", "selected.route_found", (m) => { m.hex = "zz"; }, "invalid"],
  ["selected prediction not an object", "selected.route_found", (m) => { m.prediction = "yes"; }, "invalid"],
  ["selected state with a bad lat (state dropped)", "selected.route_found", (m) => { at(m, "state").lat = "north"; }, { dropped: 1 }],
  ["selected route with an unknown status (route dropped)", "selected.route_found", (m) => { at(m, "route").status = "guessed"; }, { dropped: 1 }],
  ["error code not a string", "error.bad_bbox", (m) => { m.code = 42; }, "invalid"],
  ["demand hot with an unknown state", "demand.hot_active", (m) => { at(m, "hot").state = "guessing"; }, { dropped: 1 }],
  ["demand focus not an object", "demand.focus_active", (m) => { m.focus = "71c0a1"; }, { dropped: 1 }],
  ["sigmets without collection", "sigmets", (m) => { delete m.collection; }, "invalid"],
  ["sigmets features not an array", "sigmets", (m) => { at(m, "collection").features = {}; }, "invalid"],
  ["sigmets feature with a Polygon geometry", "sigmets", (m) => { at(m, "collection", "features", 0, "geometry").type = "Polygon"; }, { dropped: 1 }],
  ["sigmets feature with a bad coordinate", "sigmets", (m) => { (at(m, "collection", "features", 0, "geometry", "coordinates", 0, 0) as unknown as unknown[][])[1] = ["x", 35]; }, { dropped: 1 }],
  ["sigmets feature valid_to not a time", "sigmets", (m) => { at(m, "collection", "features", 1, "properties").valid_to = 42; }, { dropped: 1 }],
  ["radar past not an array", "radar", (m) => { m.past = "none"; }, "invalid"],
  ["radar host not a string", "radar", (m) => { m.host = 42; }, "invalid"],
  ["radar frame without path", "radar", (m) => { delete at(m, "past", 0).path; }, { dropped: 1 }],
  ["status not an object", "status", (m) => { m.status = "ok"; }, "invalid"],
  ["status sigmet.active as string", "status", (m) => { at(m, "status", "sigmet").active = "two"; }, "invalid"],
  ["status engine not an object", "status", (m) => { at(m, "status").engine = 5; }, "invalid"],
  ["status region.center as a string", "status", (m) => { at(m, "status", "region").center = "36.5,127.8"; }, "invalid"],
  ["ships_snapshot sseq 0", "ships_snapshot", (m) => { m.sseq = 0; }, "invalid"],
  ["ships_snapshot ships not an array", "ships_snapshot", (m) => { m.ships = null; }, "invalid"],
  ["ships_snapshot ship with a short mmsi", "ships_snapshot", (m) => { at(m, "ships", 0).mmsi = "12345"; }, { dropped: 1 }],
  ["ships_diff remove element not a mmsi", "ships_diff", (m) => { (m.remove as unknown[]).push("12345"); }, { dropped: 1 }],
  ["ships_diff upsert ship with lat 200", "ships_diff", (m) => { at(m, "upsert", 0).lat = 200; }, { dropped: 1 }],
  ["ships_grid cells not an array", "ships_grid", (m) => { m.cells = "x"; }, "invalid"],
  ["ships_grid cell_deg negative", "ships_grid", (m) => { m.cell_deg = -2; }, "invalid"],
  ["ships_grid cell with a bad latitude", "ships_grid", (m) => { (at(m, "cells") as unknown as unknown[][])[0][0] = "35"; }, { dropped: 1 }],
  ["ships_grid cell with count 0", "ships_grid", (m) => { (at(m, "cells") as unknown as unknown[][])[1][2] = 0; }, { dropped: 1 }],
  ["ships_grid cell with 10 category counts (breakdown dropped, cell kept)", "ships_grid", (m) => { ((at(m, "cells") as unknown as unknown[][])[0][4] as number[]).pop(); }, { dropped: 1 }],
  ["ship_selected mmsi not 9 digits", "ship_selected", (m) => { m.mmsi = "1"; }, "invalid"],
  ["ship_selected state with lat 999 (state dropped)", "ship_selected", (m) => { at(m, "state").lat = 999; }, { dropped: 1 }],
  ["ship_selected destination_info with an unknown kind", "ship_selected", (m) => { at(m, "destination_info").kind = "guess"; }, { dropped: 1 }],
  ["welcome server_time not a time", "welcome", (m) => { m.server_time = 42; }, "invalid"],
  ["welcome limits not an object", "welcome", (m) => { m.limits = "none"; }, "invalid"],
  ["no type", "ping", (m) => { delete m.type; }, "invalid"],
];

describe("malformed messages (each mutation is first confirmed to violate schemas/ws/server.v1.json)", () => {
  it.each(MUTATIONS)("%s", (_label, name, mutate, expected) => {
    const m = sample(name);
    mutate(m);
    expect(validate(serverSchema, m).length, "the mutation must violate the schema").toBeGreaterThan(0);
    const r = validateServerMessage(m);
    if (expected === "invalid") {
      expect(r.kind).toBe("invalid");
    } else {
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect(r.dropped).toBe(expected.dropped);
    }
  });

  it("drops the bad element but keeps the rest (snapshot)", () => {
    const m = sample("snapshot.world");
    const n = (m.aircraft as unknown[]).length;
    (m.aircraft as unknown[]).splice(1, 0, { hex: "nothex", lat: 1, lon: 1 }, "string", null);
    const r = validateServerMessage(m);
    expect(r.kind === "ok" && r.msg.type === "snapshot" ? [r.msg.aircraft.length, r.dropped] : null).toEqual([n, 3]);
  });

  it("an unknown type is ignored (not malformed — a newer server may add types); a non-object is malformed", () => {
    expect(validateServerMessage({ type: "surprise", x: 1 }).kind).toBe("unknown");
    expect(validateServerMessage([{ type: "ping" }]).kind).toBe("invalid");
    expect(validateServerMessage("ping").kind).toBe("invalid");
    expect(validateServerMessage(null).kind).toBe("invalid");
  });

  it("is more lenient than the schema only where the value is unknown, never wrong: missing optional keys, null values, unknown keys, 4-element grid cells", () => {
    expect(validateServerMessage({ type: "welcome" }).kind).toBe("ok");
    expect(validateServerMessage({ type: "diff", seq: 2, upsert: [{ hex: "abc123", lat: 1, lon: 2, alt_ft: null }], remove: [] })).toMatchObject({ kind: "ok", dropped: 0 });
    expect(validateServerMessage({ type: "ping", extra: true }).kind).toBe("ok");
    const g = validateServerMessage({ type: "ships_grid", ts: "2026-09-29T00:00:00Z", cell_deg: 2, cells: [[35, 129, 3, "cargo"]] });
    expect(g.kind === "ok" && g.msg.type === "ships_grid" ? [g.dropped, g.msg.cells[0].counts] : null).toEqual([0, null]);
  });
});

// ---------------------------------------------------------------- lib/ws.ts

beforeEach(() => { resetData(); vi.useFakeTimers(); vi.setSystemTime(Date.parse(TS)); });
afterEach(() => { vi.useRealTimers(); });

describe("malformed input in lib/ws.ts", () => {
  it("drops malformed aircraft from both the main-thread copy and the worker copy, and counts them", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv(snap([ac("aaa001"), { hex: "XYZ", lat: 1, lon: 1 }, null, { ...ac("aaa002"), alt_ft: "high" }]));
    expect([...aircraftStates.keys()]).toEqual(["aaa001"]);
    const w = t.worker.msgs.find((m) => m.type === "snapshot")!;
    expect(w.aircraft!.map((a) => a.hex)).toEqual(["aaa001"]);
    expect(w.aircraft![0]).toBe(aircraftStates.get("aaa001"));
    expect(getData().wsInvalid).toMatchObject({ elements: 3, messages: 0, errors: 0 });
    expect(getData().aircraftCount).toBe(1);
    // diff 도 같은 규칙 — 워커에 가는 것은 주 스레드가 적용한 것과 같다
    t.ws().recv(diff(2, [ac("aaa003"), { hex: "aaa004" }], ["aaa001", 7]));
    const d = t.worker.msgs.at(-1)!;
    expect(d).toMatchObject({ type: "diff", upsert: [{ hex: "aaa003" }], remove: ["aaa001"] });
    expect([...aircraftStates.keys()]).toEqual(["aaa003"]);
    expect(getData().wsInvalid.elements).toBe(5);
    expect(resyncs(t)).toBe(0); // 원소만 틀렸다 — 메시지는 적용한다
  });

  it("drops a malformed diff envelope, requests resync once, reports it, and ignores later diffs until the snapshot", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv(snap([ac("aaa001")]));
    t.ws().recv({ type: "diff", seq: 2, v: 2, ts: TS, upsert: "aaa002", remove: [] });
    expect(resyncs(t)).toBe(1);
    t.ws().recv(diff(3, [ac("aaa003")]));
    t.ws().recv(diff(4, [ac("aaa004")]));
    expect([...aircraftStates.keys()]).toEqual(["aaa001"]);
    expect(resyncs(t)).toBe(1); // 스냅샷을 기다리는 동안 한 번만
    expect(getData().wsInvalid).toMatchObject({ messages: 1 });
    expect(getData().wsInvalid.last).toMatch(/^diff: /);
    expect(t.reports.some((r) => /malformed diff/.test(r.message))).toBe(true);
    t.ws().recv(snap([ac("aaa005")]));
    t.ws().recv(diff(2, [ac("aaa006")]));
    expect([...aircraftStates.keys()].sort()).toEqual(["aaa005", "aaa006"]);
  });

  it("a malformed ships_diff resets the ships stream and asks for a resync", () => {
    const t = setup();
    welcomed(t, true);
    t.ws().recv({ type: "ships_snapshot", sseq: 1, ts: TS, ships: [{ mmsi: "440000001", lat: 35, lon: 129 }] });
    t.ws().recv({ type: "ships_diff", sseq: 2, ts: TS, upsert: {}, remove: [] });
    t.ws().recv({ type: "ships_diff", sseq: 3, ts: TS, upsert: [{ mmsi: "440000003", lat: 35, lon: 129 }], remove: [] });
    expect(shipStates.has("440000003")).toBe(false);
    expect(resyncs(t)).toBe(1);
    expect(getData().wsInvalid.messages).toBe(1);
  });

  it("a frame that is not JSON is counted and triggers a resync", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv(snap([ac("aaa001")]));
    t.ws().recv("{not json");
    expect(getData().wsInvalid.messages).toBe(1);
    expect(resyncs(t)).toBe(1);
  });

  it("an unknown message type is ignored: not counted, no resync", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv({ type: "surprise" });
    expect(getData().wsInvalid).toMatchObject({ elements: 0, messages: 0, errors: 0 });
    expect(resyncs(t)).toBe(0);
  });

  it("a malformed welcome closes the connection and reconnects with backoff (no subscription on a broken handshake)", () => {
    const t = setup();
    t.client.subscribe(BBOX, 7);
    t.client.connect();
    t.ws().open();
    t.ws().recv({ type: "welcome", server_time: 42 });
    expect(t.ws().types()).toEqual(["hello"]);
    expect(t.ws().closedWith).toBeGreaterThanOrEqual(4000);
    expect(getData().conn).toBe("closed");
    expect(getData().wsInvalid.messages).toBe(1);
    vi.advanceTimersByTime(31_000);
    expect(t.sockets).toHaveLength(2);
  });

  it("an exception in any handler is caught: counted, reported with the message type, and followed by a resync", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv(snap([ac("aaa001")]));
    t.worker.fail = (m) => m.type === "snapshot";
    expect(() => t.ws().recv(snap([ac("aaa002")]))).not.toThrow();
    expect(getData().wsInvalid.errors).toBe(1);
    expect(t.reports.at(-1)?.message).toMatch(/snapshot/);
    expect(t.reports.at(-1)?.component).toBe("lib/ws.ts");
    expect(resyncs(t)).toBe(1);
    // 스냅샷이 반쯤 적용됐을 수 있다 — 다음 diff 는 적용하지 않는다
    t.worker.fail = null;
    t.ws().recv(diff(2, [ac("aaa003")]));
    expect(aircraftStates.has("aaa003")).toBe(false);
  });
});

describe("status UI shows the count (store wsInvalid → StatusBar)", () => {
  const html = () => renderToStaticMarkup(createElement(StatusBar));
  it("no badge while nothing was dropped", () => {
    expect(html()).not.toContain('data-testid="ws-invalid"');
  });
  it("a badge with the total and a tooltip that names elements · messages · exceptions and the last reason; the connection badge tooltip says the same", () => {
    const t = setup();
    welcomed(t);
    t.ws().recv(snap([ac("aaa001"), { hex: "XYZ", lat: 1, lon: 1 }]));
    t.ws().recv({ type: "diff", seq: 2, upsert: 5, remove: [] });
    const out = html();
    const badge = /<span class="badge warn"[^>]*data-testid="ws-invalid"[^>]*title="([^"]*)"[^>]*>([^<]*)</.exec(out);
    expect(badge).not.toBeNull();
    expect(badge![2]).toContain("2");
    expect(badge![1]).toContain("원소 1");
    expect(badge![1]).toContain("메시지 1");
    expect(badge![1]).toContain("예외 0");
    expect(badge![1]).toContain("diff");
    expect(/data-testid="conn"[^>]*title="([^"]*)"/.exec(out)?.[1] ?? /title="([^"]*)"[^>]*data-testid="conn"/.exec(out)?.[1]).toMatch(/형식 오류/);
  });
});

// ---------------------------------------------------------------- 클라이언트 메시지

describe("client messages the web actually sends satisfy schemas/ws/client.v1.json", () => {
  it("hello · layers · select · select_ship · subscribe · pause · resume · resync · pong", () => {
    const t = setup();
    t.client.subscribe([124.25, 33.5, 131.75, 38.9], 7);
    t.client.select("71c0a1");
    t.client.selectShip("440000001");
    t.client.setLayers(true, true);
    t.client.connect();
    t.ws().open();
    t.ws().recv({ type: "welcome", server_time: TS });
    t.ws().recv({ type: "ping" });
    t.ws().recv(snap([]));
    t.ws().recv(diff(5, [])); // 틈 → resync
    t.client.pause();
    vi.advanceTimersByTime(11_000);
    t.client.resume();
    t.client.select(null);
    t.client.selectShip(null);
    t.client.setLayers(false, false);
    vi.advanceTimersByTime(11_000);
    const sent = t.ws().sent;
    for (const m of sent) expect(validate(clientSchema, m), JSON.stringify(m)).toEqual([]);
    expect(new Set(sent.map((m) => m.type))).toEqual(new Set(["hello", "layers", "select", "select_ship", "subscribe", "pong", "resync", "pause", "resume"]));
    expect(sent.every((m) => CLIENT_TYPES.includes(m.type as string))).toBe(true);
  });
});

// ---------------------------------------------------------------- 워커

describe("the interpolation worker ignores elements without a hex (defence in depth — lib/ws.ts already validates)", () => {
  it("snapshot / diff with null or hex-less elements do not throw and are skipped", () => {
    const src = readFileSync(new URL("../public/interpolate.worker.js", import.meta.url), "utf8");
    const posted: { type: string; states: { hex: string }[] }[] = [];
    const self: Record<string, unknown> = { postMessage: (m: (typeof posted)[number]) => posted.push(m) };
    vm.runInNewContext(src, { self, Map, Set, Math, Date, setTimeout: () => 1, clearTimeout: () => {} });
    const send = (m: unknown) => (self.onmessage as (ev: { data: unknown }) => void)({ data: m });
    send({ type: "start" });
    expect(() => send({ type: "snapshot", aircraft: [null, { lat: 1 }, ac("aaa001")] })).not.toThrow();
    expect(() => send({ type: "diff", upsert: [undefined, ac("aaa002")], remove: [null, "aaa001"] })).not.toThrow();
    expect(() => send({ type: "snapshot", aircraft: "nope" })).not.toThrow();
    expect(posted.at(-1)?.states.map((s) => s.hex) ?? []).toEqual([]);
    send({ type: "snapshot", aircraft: [ac("aaa003")] });
    expect(posted.at(-1)?.states.map((s) => s.hex)).toEqual(["aaa003"]);
  });
});
