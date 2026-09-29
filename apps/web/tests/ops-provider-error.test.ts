/**
 * 공급자 LAST ERROR 칸의 해결 상태(lib/ops providerLastError — 계약 v5 §G14): 해결됨은 api 의 last_error_resolved 가 정하고,
 * "재발"은 이 오류의 시각이 해결의 upto 뒤라고 화면이 보인 값으로 확인될 때만 말한다. 시각을 모르면 재발이라고 하지 않는다(지어내지 않는다).
 */
import { describe, expect, it } from "vitest";
import { providerLastError } from "@/lib/ops";
import { compareInstants } from "@/lib/resolutions";

const RES = { id: 5, upto: "2026-09-28T23:00:00Z", resolved_by: "op" };
const p = (o: Record<string, unknown>) => ({ name: "adsb_lol", last_error: "rate limited (429)", last_error_at: "2026-09-28T23:40:21.631Z", last_error_resolution: RES, last_error_resolved: false, ...o });

describe("providerLastError: resolved · recurred · undecided", () => {
  it("the api's last_error_resolved (with a readable resolution) is 해결됨", () => {
    const le = providerLastError(p({ last_error_at: "2026-09-28T22:00:00Z", last_error_resolved: true }));
    expect([le.resolved, le.recurred, le.undecided]).toEqual([true, false, false]);
  });
  it("an error time after the upto is a recurrence", () => {
    const le = providerLastError(p({}));
    expect([le.resolved, le.recurred, le.undecided]).toEqual([false, true, false]);
  });
  it("an error time the web cannot read (missing · malformed) is not called a recurrence — the api could not decide either", () => {
    for (const at of [undefined, null, "", "yesterday", "2026-09-28T23:40:21"]) {
      const le = providerLastError(p({ last_error_at: at }));
      expect([le.resolved, le.recurred, le.undecided], String(at)).toEqual([false, false, true]);
    }
  });
  it("sub-millisecond digits count (the api compares whole instants): .631500 is after .631", () => {
    expect(providerLastError(p({ last_error_at: "2026-09-28T23:40:21.631500Z", last_error_resolution: { ...RES, upto: "2026-09-28T23:40:21.631Z" } })).recurred).toBe(true);
  });
  it("no resolution → neither; no error → nothing to say", () => {
    expect(providerLastError(p({ last_error_resolution: null }))).toMatchObject({ resolved: false, recurred: false, undecided: false });
    expect(providerLastError(p({ last_error: "", last_error_at: null }))).toMatchObject({ hasError: false, recurred: false, undecided: false });
  });
});

describe("compareInstants: whole ISO instants, zone and sub-millisecond digits included", () => {
  it("orders across zones and below a millisecond; unreadable → null", () => {
    expect(compareInstants("2026-09-29T08:40:21+09:00", "2026-09-28T23:40:21Z")).toBe(0);
    expect(compareInstants("2026-09-28T23:40:21.631500Z", "2026-09-28T23:40:21.631Z")).toBeGreaterThan(0);
    expect(compareInstants("2026-09-28T23:40:21.6315Z", "2026-09-28T23:40:21.631500Z")).toBe(0);
    expect(compareInstants("2026-09-28T23:40:21.630999Z", "2026-09-28T23:40:21.631Z")).toBeLessThan(0);
    expect(compareInstants("yesterday", "2026-09-28T23:40:21Z")).toBeNull();
    expect(compareInstants("2026-09-28T23:40:21Z", null)).toBeNull();
  });
});
