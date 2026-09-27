import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { deadReckon, ease, predict, seenAtMs, thresholds, tickIntervalMs, wrap180 } from "@/lib/interpolate";
import type { AircraftState, RenderState } from "@/lib/types";

/** public/interpolate.worker.js(순수 JS)와 lib/interpolate.ts 가 같은 결과를 내야 한다(두 구현의 드리프트 방지). */
interface WorkerApi {
  deadReckon: typeof deadReckon; predict: typeof predict; ease: typeof ease; wrap180: typeof wrap180;
  seenAtMs: typeof seenAtMs; thresholds: typeof thresholds; tickIntervalMs: typeof tickIntervalMs; tick: () => boolean;
}
interface Loaded { api: WorkerApi; posted: { type: string; states: RenderState[] }[]; send: (m: unknown) => void; clock: { now: number } }

function loadWorker(startMs = Date.parse("2026-09-27T05:10:00Z")): Loaded {
  const src = readFileSync(new URL("../public/interpolate.worker.js", import.meta.url), "utf8");
  const clock = { now: startMs };
  const posted: Loaded["posted"] = [];
  const fakeDate = { now: () => clock.now, parse: Date.parse };
  // 타이머는 돌리지 않는다 — 테스트가 tick 을 직접 부른다
  const timers = { setTimeout: () => 1, clearTimeout: () => {} };
  const self: Record<string, unknown> = { postMessage: (m: Loaded["posted"][number]) => posted.push(m) };
  vm.runInNewContext(src, { self, Map, Set, Math, Date: fakeDate, ...timers });
  const onmessage = self.onmessage as (ev: { data: unknown }) => void;
  return { api: self.__wakeline as WorkerApi, posted, send: (m) => onmessage({ data: m }), clock };
}

const T0 = Date.parse("2026-09-27T05:10:00Z");

describe("worker ↔ ts parity", () => {
  const w = loadWorker().api;
  it("deadReckon / wrap180 match", () => {
    for (const [lat, lon, trk, gs, dt] of [[36, 127, 90, 450, 60], [-33, 179.9, 45, 600, 3600], [60, -170, 300, 250, 600]]) {
      const a = deadReckon(lat, lon, trk, gs, dt), b = w.deadReckon(lat, lon, trk, gs, dt);
      expect(b[0]).toBeCloseTo(a[0], 9); expect(b[1]).toBeCloseTo(a[1], 9);
    }
    expect(w.wrap180(190)).toBe(wrap180(190));
  });
  it("predict matches including stale/cap/opensky/unknown-key rules", () => {
    const cases: AircraftState[] = [
      { hex: "a", lat: 36, lon: 127, alt_ft: 30000, gs_kt: 450, track_deg: 90, vrate_fpm: 600, seen_at: "2026-09-27T05:10:00Z", squawk: "7700", provider: "adsb_lol" },
      { hex: "b", lat: 36, lon: 127, alt_ft: 0, gs_kt: 5, track_deg: 10, on_ground: true, seen_at: "2026-09-27T05:10:00Z" },
      { hex: "c", lat: 36, lon: 127, alt_ft: 1000, gs_kt: null, track_deg: null, seen_at: "2026-09-27T05:08:00Z" },
      { hex: "d", lat: 50, lon: 8, alt_ft: 36000, gs_kt: 480, track_deg: 270, seen_at: "2026-09-27T05:09:00Z", provider: "opensky" },
      { hex: "e", lat: 50, lon: 8, alt_ft: 36000, gs_kt: 480, track_deg: 270, provider: "opensky" }, // seen_at 없음
      { hex: "f", lat: 36, lon: 127, gs_kt: 300, track_deg: 45, seen_at: T0 / 1000 - 30 }, // epoch 초, alt/vrate/on_ground 없음
    ];
    for (const c of cases) for (const dt of [0, 12_000, 61_000, 181_000, 301_000, 900_000]) expect(w.predict(c, T0 + dt)).toEqual(predict(c, T0 + dt));
  });
  it("helpers match", () => {
    expect(w.ease([0, 179], [0, -179], 0.5)).toEqual(ease([0, 179], [0, -179], 0.5));
    for (const v of ["2026-09-27T05:10:00Z", 1_790_000_000, "x", null, undefined]) expect(w.seenAtMs(v)).toEqual(seenAtMs(v));
    for (const p of ["opensky", "adsb_fi", null]) expect(w.thresholds(p)).toEqual(thresholds(p));
    for (const [z, lat, n] of [[3, 37, 10], [6, 37, 10], [6, 70, 10], [10, 37, 3000], [null, null, 10]] as const) expect(w.tickIntervalMs(z, lat, n)).toBe(tickIntervalMs(z, lat, n));
  });
});

describe("worker behaviour", () => {
  const moving: AircraftState = { hex: "m1", lat: 36, lon: 127, alt_ft: 30000, gs_kt: 450, track_deg: 90, seen_at: new Date(T0).toISOString(), provider: "adsb_fi" };
  const parked: AircraftState = { hex: "p1", lat: 37.46, lon: 126.44, alt_ft: null, on_ground: true, seen_at: new Date(T0).toISOString(), provider: "adsb_fi" };

  it("FR-19: never drops aircraft by age — they stay (stale) after a 10-minute outage", () => {
    const w = loadWorker(T0);
    w.send({ type: "start" });
    w.send({ type: "snapshot", aircraft: [moving, parked] });
    w.clock.now = T0 + 600_000;
    w.send({ type: "invalidate" });
    const last = w.posted[w.posted.length - 1];
    expect(last.states.map((s) => s.hex).sort()).toEqual(["m1", "p1"]);
    expect(last.states.every((s) => s.stale)).toBe(true);
    expect(last.states.find((s) => s.hex === "m1")!.capped).toBe(true);
  });

  it("removes only on a server remove", () => {
    const w = loadWorker(T0);
    w.send({ type: "start" });
    w.send({ type: "snapshot", aircraft: [moving, parked] });
    w.send({ type: "diff", upsert: [], remove: ["p1"] });
    expect(w.posted[w.posted.length - 1].states.map((s) => s.hex)).toEqual(["m1"]);
  });

  it("does not post when nothing changed (parked aircraft, same stale count)", () => {
    const w = loadWorker(T0);
    w.send({ type: "start" });
    w.send({ type: "snapshot", aircraft: [parked] });
    const n = w.posted.length;
    expect(w.posted[n - 1].states.map((s) => s.hex)).toEqual(["p1"]);
    w.clock.now = T0 + 20_000;
    expect(w.api.tick()).toBe(false);
    expect(w.posted.length).toBe(n);
  });

  it("posts again when an aircraft crosses the stale threshold", () => {
    const w = loadWorker(T0);
    w.send({ type: "start" });
    w.send({ type: "snapshot", aircraft: [parked] });
    w.clock.now = T0 + 61_000;
    expect(w.api.tick()).toBe(true);
    expect(w.posted[w.posted.length - 1].states[0].stale).toBe(true);
    // 이후 변화 없음 → 다시 보내지 않는다
    w.clock.now = T0 + 120_000;
    expect(w.api.tick()).toBe(false);
  });

  it("posts while estimated positions move, and stops once the extrapolation cap is reached", () => {
    const w = loadWorker(T0);
    w.send({ type: "start" });
    w.send({ type: "snapshot", aircraft: [moving] });
    w.clock.now = T0 + 5_000;
    expect(w.api.tick()).toBe(true);
    w.clock.now = T0 + 70_000; // 상한(60 s) 도달 — 위치 고정, stale 로 바뀜
    expect(w.api.tick()).toBe(true);
    w.clock.now = T0 + 90_000;
    expect(w.api.tick()).toBe(false);
  });

  it("does not post while stopped; posts on start", () => {
    const w = loadWorker(T0);
    w.send({ type: "snapshot", aircraft: [parked] });
    expect(w.posted.length).toBe(0);
    w.send({ type: "start" });
    expect(w.posted.length).toBe(1);
  });

  it("missing seen_at is rendered as age-unknown, not fresh", () => {
    const w = loadWorker(T0);
    w.send({ type: "start" });
    const { seen_at: _s, ...noSeen } = moving;
    void _s;
    w.send({ type: "snapshot", aircraft: [noSeen] });
    const r = w.posted[w.posted.length - 1].states[0];
    expect(r.age_unknown).toBe(true);
    expect(r.age_s).toBeNull();
    expect(r.estimated).toBe(false);
  });
});
