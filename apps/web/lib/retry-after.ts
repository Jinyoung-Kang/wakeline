import { ApiError } from "./api";
import { watchVisible } from "./etag-poller";

// 503 + Retry-After 에 한 번 다시 받는 규칙 중 React 없는 부분 — 상황판 지도(첫 화면)의 선택 항적이 쓰고, 카드 Hook(lib/use-retry-after — 조각에서만)도 이것을 쓴다.
// 카드 Hook 을 첫 화면에 싣지 않으려고 따로 둔다(ADR-026).

/** Retry-After 를 받은 503(저장소 · 공개 조회 허가를 잠시 쓸 수 없음 — '잠시 뒤 다시')이면 기다릴 ms, 아니면 null — lib/replay ReplayLoader 와 같은 규칙 */
export function retryAfterMs(e: unknown): number | null {
  return e instanceof ApiError && e.status === 503 && e.retryAfterS != null ? e.retryAfterS * 1000 : null;
}

/**
 * Effect 안에서 직접 받는 곳(상황판 지도의 선택 항적 — components/map/useSelectionTracks, R12)의 같은 규칙: ms 뒤 fire 한 번 — 탭이 숨었으면 다시 보일 때.
 * signal 이 끊기면(다른 대상 · 지도 · 떠남) 부르지 않는다. 다시 받은 요청의 실패에 또 부르지 않는 것은 부르는 쪽이 정한다.
 */
export function onceAfterRetry(ms: number, signal: AbortSignal, fire: () => void): void {
  let unwatch: (() => void) | null = null;
  const go = () => {
    if (signal.aborted) return;
    if (typeof document !== "undefined" && document.hidden) { unwatch ??= watchVisible(go); return; }
    unwatch?.();
    unwatch = null;
    fire();
  };
  const t = setTimeout(go, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); unwatch?.(); }, { once: true });
}
