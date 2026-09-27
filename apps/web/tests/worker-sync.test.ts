import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { deadReckon, ease, predict, wrap180 } from "@/lib/interpolate";

/** public/interpolate.worker.js(순수 JS)와 lib/interpolate.ts 가 같은 결과를 내야 한다(두 구현의 드리프트 방지). */
function loadWorker() {
  const src = readFileSync(new URL("../public/interpolate.worker.js", import.meta.url), "utf8");
  const self: Record<string, unknown> = { postMessage: () => {}, setInterval, clearInterval, Date, Math, Map };
  vm.runInNewContext(src, { self, Map, Math, Date, setInterval, clearInterval });
  return self.__skywx as { deadReckon: typeof deadReckon; predict: typeof predict; ease: typeof ease; wrap180: typeof wrap180 };
}

describe("worker ↔ ts parity", () => {
  const w = loadWorker();
  it("deadReckon / wrap180 match", () => {
    for (const [lat, lon, trk, gs, dt] of [[36, 127, 90, 450, 60], [-33, 179.9, 45, 600, 3600], [60, -170, 300, 250, 600]]) {
      const a = deadReckon(lat, lon, trk, gs, dt), b = w.deadReckon(lat, lon, trk, gs, dt);
      expect(b[0]).toBeCloseTo(a[0], 9); expect(b[1]).toBeCloseTo(a[1], 9);
    }
    expect(w.wrap180(190)).toBe(wrap180(190));
  });
  it("predict matches including stale/emergency/on_ground rules", () => {
    const t0 = Date.parse("2026-09-27T05:10:00Z");
    const cases = [
      { hex: "a", lat: 36, lon: 127, alt_ft: 30000, gs_kt: 450, track_deg: 90, vrate_fpm: 600, seen_at: "2026-09-27T05:10:00Z", squawk: "7700" },
      { hex: "b", lat: 36, lon: 127, alt_ft: 0, gs_kt: 5, track_deg: 10, on_ground: true, seen_at: "2026-09-27T05:10:00Z" },
      { hex: "c", lat: 36, lon: 127, alt_ft: 1000, gs_kt: null, track_deg: null, seen_at: "2026-09-27T05:08:00Z" },
    ];
    for (const c of cases) for (const dt of [0, 12_000, 61_000, 301_000]) expect(w.predict(c, t0 + dt)).toEqual(predict(c, t0 + dt));
  });
  it("ease matches", () => {
    expect(w.ease([0, 179], [0, -179], 0.5)).toEqual(ease([0, 179], [0, -179], 0.5));
  });
});
