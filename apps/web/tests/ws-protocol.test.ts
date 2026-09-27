import { describe, expect, it } from "vitest";
import { needsResync, nextBackoffMs } from "@/lib/ws-protocol";

describe("ws protocol", () => {
  it("backoff grows 1 → 30 s with jitter", () => {
    expect(nextBackoffMs(0)).toBeGreaterThanOrEqual(800);
    expect(nextBackoffMs(0)).toBeLessThanOrEqual(1200);
    expect(nextBackoffMs(10)).toBeLessThanOrEqual(36000);
    expect(nextBackoffMs(10)).toBeGreaterThanOrEqual(24000);
  });
  it("detects skipped or stale versions", () => {
    expect(needsResync(0, 7)).toBe(false);
    expect(needsResync(7, 8)).toBe(false);
    expect(needsResync(7, 9)).toBe(true);
    expect(needsResync(7, 7)).toBe(true);
    expect(needsResync(7, 3)).toBe(true);
  });
});
