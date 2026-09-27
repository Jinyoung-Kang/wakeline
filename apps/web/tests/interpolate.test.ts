import { describe, expect, it } from "vitest";
import { applyDiff, deadReckon, ease, EXTRAPOLATE_CAP_OPENSKY_S, EXTRAPOLATE_CAP_S, predict, seenAtMs, tickIntervalMs, wrap180 } from "@/lib/interpolate";
import type { AircraftState } from "@/lib/types";

const T0 = Date.parse("2026-09-27T05:10:00Z");
const base: AircraftState = { hex: "abc123", lat: 36, lon: 127, alt_ft: 30000, gs_kt: 450, track_deg: 90, vrate_fpm: 0, on_ground: false, seen_at: "2026-09-27T05:10:00Z", provider: "adsb_lol" };

describe("dead reckoning", () => {
  it("moves east at the expected rate", () => {
    const [lat, lon] = deadReckon(0, 0, 90, 450, 3600);
    expect(lat).toBeCloseTo(0, 6);
    expect(lon).toBeCloseTo((450 * 1.852) / (2 * Math.PI * 6371) * 360, 2);
  });
  it("wraps longitude across ±180", () => {
    expect(wrap180(190)).toBe(-170);
    expect(wrap180(-190)).toBe(170);
    const [, lon] = deadReckon(10, 179.9, 90, 600, 3600);
    expect(lon).toBeLessThan(-169);
  });
  it("does not estimate when stationary, on ground, missing gs/track, or polar", () => {
    expect(predict({ ...base, gs_kt: 0 }, T0 + 10_000).estimated).toBe(false);
    expect(predict({ ...base, on_ground: true }, T0 + 10_000).estimated).toBe(false);
    expect(predict({ ...base, gs_kt: null }, T0 + 10_000).estimated).toBe(false);
    expect(predict({ ...base, track_deg: null }, T0 + 10_000).estimated).toBe(false);
    expect(predict({ ...base, lat: 86 }, T0 + 10_000).estimated).toBe(false);
  });
  it("estimates position and altitude after elapsed time", () => {
    const r = predict({ ...base, vrate_fpm: 600 }, T0 + 30_000);
    expect(r.estimated).toBe(true);
    expect(r.lon).toBeGreaterThan(127);
    expect(r.alt_ft).toBe(30300);
    expect(r.stale).toBe(false);
    expect(r.capped).toBe(false);
  });
  it("keeps the observed altitude when vertical rate is unknown (no 0 default)", () => {
    const { vrate_fpm: _omit, ...noVrate } = base;
    void _omit;
    expect(predict(noVrate, T0 + 30_000).alt_ft).toBe(30000);
  });
  it("flags stale after 60 s (regional providers)", () => {
    expect(predict(base, T0 + 61_000).stale).toBe(true);
    expect(predict(base, T0 + 59_000).stale).toBe(false);
  });
  it("emergency squawk detected; missing squawk is not an emergency", () => {
    expect(predict({ ...base, squawk: "7700" }, T0).emergency).toBe(true);
    expect(predict({ ...base, squawk: "1200" }, T0).emergency).toBe(false);
    expect(predict(base, T0).emergency).toBe(false);
  });
});

describe("FR-19: no client-side removal; extrapolation is capped", () => {
  it("still renders an aircraft 10 minutes after its last report (marked stale, capped)", () => {
    const r = predict(base, T0 + 600_000);
    expect(r).not.toBeNull();
    expect(r.stale).toBe(true);
    expect(r.capped).toBe(true);
    expect(r.age_s).toBe(600);
  });
  it("caps dead reckoning at 60 s for regional providers — position frozen at the cap", () => {
    const atCap = predict(base, T0 + EXTRAPOLATE_CAP_S * 1000);
    const later = predict(base, T0 + 300_000);
    expect(later.lat).toBeCloseTo(atCap.lat, 9);
    expect(later.lon).toBeCloseTo(atCap.lon, 9);
    const [, lon60] = deadReckon(36, 127, 90, 450, 60);
    expect(later.lon).toBeCloseTo(lon60, 9);
  });
  it("opensky: stale after 300 s, extrapolation capped at 180 s (and shown stale beyond the cap)", () => {
    const os = { ...base, provider: "opensky" };
    expect(predict(os, T0 + 120_000).stale).toBe(false);
    expect(predict(os, T0 + 120_000).capped).toBe(false);
    const beyond = predict(os, T0 + 200_000);
    expect(beyond.capped).toBe(true);
    expect(beyond.stale).toBe(true);
    const [, lonCap] = deadReckon(36, 127, 90, 450, EXTRAPOLATE_CAP_OPENSKY_S);
    expect(beyond.lon).toBeCloseTo(lonCap, 9);
    // 외삽할 수 없는(방위 없음) opensky 기체는 300 s 기준만
    const noTrack = { ...os, track_deg: null };
    expect(predict(noTrack, T0 + 200_000).stale).toBe(false);
    expect(predict(noTrack, T0 + 301_000).stale).toBe(true);
  });
  it("unknown provider uses the stricter regional thresholds", () => {
    const { provider: _p, ...noProv } = base;
    void _p;
    expect(predict(noProv, T0 + 61_000).stale).toBe(true);
  });
});

describe("missing keys are unknown, never defaults", () => {
  it("missing seen_at → age unknown, no extrapolation, not claimed fresh", () => {
    const { seen_at: _s, ...noSeen } = base;
    void _s;
    const r = predict(noSeen, T0 + 120_000);
    expect(r.age_s).toBeNull();
    expect(r.age_unknown).toBe(true);
    expect(r.estimated).toBe(false);
    expect(r.lat).toBe(36);
    expect(r.lon).toBe(127);
  });
  it("missing on_ground stays null", () => {
    const { on_ground: _g, ...noGround } = base;
    void _g;
    expect(predict(noGround, T0).on_ground).toBeNull();
    expect(predict(base, T0).on_ground).toBe(false);
  });
  it("seen_at accepts ISO strings and epoch seconds; garbage is unknown", () => {
    expect(seenAtMs("2026-09-27T05:10:00Z")).toBe(T0);
    expect(seenAtMs(T0 / 1000)).toBe(T0);
    expect(seenAtMs("not a date")).toBeNull();
    expect(seenAtMs(undefined)).toBeNull();
    expect(predict({ ...base, seen_at: T0 / 1000 }, T0 + 30_000).estimated).toBe(true);
  });
});

describe("tick interval follows zoom (≈0.5 px of motion)", () => {
  it("is 250 ms at street zoom and up to 4 s at world zoom", () => {
    expect(tickIntervalMs(11, 37, 100)).toBe(250);
    expect(tickIntervalMs(3, 37, 100)).toBe(4000);
    const z6 = tickIntervalMs(6, 37, 100);
    expect(z6).toBeGreaterThan(250);
    expect(z6).toBeLessThan(4000);
  });
  it("never faster than 1 s with more than 2,000 aircraft; 250 ms when zoom unknown", () => {
    expect(tickIntervalMs(11, 37, 2500)).toBe(1000);
    expect(tickIntervalMs(null, null, 10)).toBe(250);
  });
});

describe("ease and diff", () => {
  it("ease reaches the target and handles the antimeridian", () => {
    expect(ease([0, 179], [0, -179], 1)).toEqual([0, -179]);
    const [, mid] = ease([0, 179], [0, -179], 0.5);
    expect(Math.abs(mid)).toBeGreaterThanOrEqual(179);
  });
  it("applyDiff upserts and removes", () => {
    const m = new Map<string, AircraftState>([["a", base]]);
    applyDiff(m, [{ ...base, hex: "b" }], ["a"]);
    expect([...m.keys()]).toEqual(["b"]);
  });
});
