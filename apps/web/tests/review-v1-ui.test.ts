/**
 * 리뷰 v1(docs/review/REVIEW-v1.md) 웹 UI 갈래 회귀 시험. 각 describe 는 한 발견 사항(R-xx)이다.
 * 수정 전 코드에서 실패하는 것을 먼저 확인한 뒤 고쳤다(커밋 메시지·검증 기록 참고).
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { subscriptionBbox } from "@/lib/viewport";
import { fmtReplayBbox, REPLAY_MAX_AREA_SQDEG, replayQueryBbox, replayReduce, type ReplayFrame } from "@/lib/replay";

const area = (b: number[]) => (b[2] - b[0]) * (b[3] - b[1]);
/** 서버(Bbox.parse)와 같은 방식: 문자열 네 숫자 → 면적 */
const serverArea = (s: string) => area(s.split(",").map(Number));

describe("R-05 replay request area and stale frame", () => {
  it("a zoomed-out screen (the review's 90,10,170,60 = 4000 sq°) is cut to the server cap around the map centre, keeping the aspect", () => {
    const view = subscriptionBbox(90, 10, 170, 60, Infinity, 127.8); // 수정 전 ReplayMap 이 그대로 보내던 값
    expect(area(view)).toBe(4000);
    const q = replayQueryBbox(view, [127.8, 36.5]);
    expect(q.clamped).toBe(true);
    expect(serverArea(fmtReplayBbox(q.bbox))).toBeLessThanOrEqual(REPLAY_MAX_AREA_SQDEG);
    const [w, s, e, n] = q.bbox;
    expect(w).toBeLessThan(127.8); expect(e).toBeGreaterThan(127.8); expect(s).toBeLessThan(36.5); expect(n).toBeGreaterThan(36.5);
    expect((e - w) / (n - s)).toBeCloseTo(80 / 50, 6);
    // 화면 안에 머문다
    expect(w).toBeGreaterThanOrEqual(90); expect(e).toBeLessThanOrEqual(170); expect(s).toBeGreaterThanOrEqual(10); expect(n).toBeLessThanOrEqual(60);
  });
  it("a small screen is sent unchanged; the formatted bbox never grows past the cap through rounding", () => {
    const small = replayQueryBbox([124, 33, 132, 39], [128, 36]);
    expect(small).toEqual({ bbox: [124, 33, 132, 39], clamped: false });
    expect(fmtReplayBbox([124, 33, 132, 39])).toBe("124.000,33.000,132.000,39.000");
    const world = replayQueryBbox([-180, -85, 180, 85], [0, 0]);
    expect(world.clamped).toBe(true);
    expect(serverArea(fmtReplayBbox(world.bbox))).toBeLessThanOrEqual(REPLAY_MAX_AREA_SQDEG);
    // 가운데가 화면 끝이면 상자를 안쪽으로 민다(범위 밖 좌표를 보내지 않는다)
    const edge = replayQueryBbox([-180, -85, 180, 85], [179.9, 84.9]);
    expect(edge.bbox[2]).toBeLessThanOrEqual(180); expect(edge.bbox[3]).toBeLessThanOrEqual(85);
  });
  it("a failed request clears the previous frame instead of leaving it under the new time label, with a Korean hint", () => {
    const frame: ReplayFrame = { at: "2026-09-28T05:00:00Z", aircraft: [{ hex: "abc123", lat: 36, lon: 127 }], sigmets: [], source: "track_point" };
    const loaded = replayReduce({ frame: null, err: null, latencyMs: null }, { type: "loaded", frame, latencyMs: 40 });
    expect(loaded.frame).toBe(frame);
    const failed = replayReduce(loaded, { type: "failed", error: new ApiError(422, "bbox area 4000 sq° exceeds 2500") });
    expect(failed.frame).toBeNull();
    expect(failed.err).toContain("확대");
    expect(failed.err).not.toContain("exceeds");
    expect(replayReduce(loaded, { type: "failed", error: new TypeError("Failed to fetch") }).err).toContain("연결");
  });
});
