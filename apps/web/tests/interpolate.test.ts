import { describe, expect, it } from "vitest";
import { applyDiff, deadReckon, ease, predict, wrap180 } from "@/lib/interpolate";
import type { AircraftState } from "@/lib/types";

const T0 = Date.parse("2026-09-27T05:10:00Z");
const base: AircraftState = { hex: "abc123", lat: 36, lon: 127, alt_ft: 30000, gs_kt: 450, track_deg: 90, vrate_fpm: 0, on_ground: false, seen_at: "2026-09-27T05:10:00Z" };

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
    const r = predict({ ...base, vrate_fpm: 600 }, T0 + 60_000);
    expect(r.estimated).toBe(true);
    expect(r.lon).toBeGreaterThan(127);
    expect(r.alt_ft).toBe(30600);
    expect(r.stale).toBe(false);
  });
  it("flags stale after 60 s", () => {
    expect(predict(base, T0 + 61_000).stale).toBe(true);
    expect(predict(base, T0 + 59_000).stale).toBe(false);
  });
  it("emergency squawk detected", () => {
    expect(predict({ ...base, squawk: "7700" }, T0).emergency).toBe(true);
    expect(predict({ ...base, squawk: "1200" }, T0).emergency).toBe(false);
  });
});

describe("ease and diff", () => {
  it("ease reaches the target and handles the antimeridian", () => {
    expect(ease([0, 179], [0, -179], 1)).toEqual([0, -179]);
    const [, mid] = ease([0, 179], [0, -179], 0.5);
    expect(Math.abs(mid) > 179 || Math.abs(mid) < -179 || Math.abs(mid) >= 179).toBe(true);
  });
  it("applyDiff upserts and removes", () => {
    const m = new Map<string, AircraftState>([["a", base]]);
    applyDiff(m, [{ ...base, hex: "b" }], ["a"]);
    expect([...m.keys()]).toEqual(["b"]);
  });
});
