/**
 * 이력 재생 REST(web-review §3.1 · FR-23) — 재생 화면(app/replay)의 ReplayLoader 가 부른다. 경로는 lib/replay replayApiPath(시각은 UTC ISO, bbox 는 인코딩).
 * { signal } 은 그대로 넘긴다 — 화면을 떠나면(ReplayLoader.dispose) 브라우저가 기다림을 멈춘다.
 */
import { apiGet } from "@/lib/api";
import { replayApiPath, type ReplayFrame, type ReplayReq } from "@/lib/replay";

export function replayFrame(r: ReplayReq, o?: { signal?: AbortSignal }): Promise<ReplayFrame> {
  return apiGet<ReplayFrame>(replayApiPath(r), o);
}
