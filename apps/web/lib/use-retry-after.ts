"use client";
import { useEffect, useState } from "react";
import { ApiError } from "./api";
import { watchVisible } from "./etag-poller";

/** 자동 다시 받기의 상태 — none = 하지 않음 · scheduled = Retry-After 뒤 한 번 다시 받음 · retried = 다시 받았으나 또 실패(더 부르지 않는다) */
export type AutoRetry = "none" | "scheduled" | "retried";

/** Retry-After 를 받은 503(저장소 · 공개 조회 허가를 잠시 쓸 수 없음 — '잠시 뒤 다시')이면 기다릴 ms, 아니면 null — lib/replay ReplayLoader 와 같은 규칙 */
export function retryAfterMs(e: unknown): number | null {
  return e instanceof ApiError && e.status === 503 && e.retryAfterS != null ? e.retryAfterS * 1000 : null;
}

/**
 * 503 + Retry-After 에 한 번 다시 받는다(QA-1463 — 공개 데모의 공개 조회 허가 고갈은 1 s 뒤 503 + Retry-After 10, 곧 풀린다). 지금 열쇠의 실패에만,
 * Retry-After 뒤 retry() 한 번 — 탭이 숨었으면 다시 보일 때. 다시 받은 요청도 실패하면 더 부르지 않는다(경합 중에 부하를 더하지 않는다 — 화면의
 * '다시 시도' 단추는 그대로). 열쇠가 바뀌면 처음부터. 돌려주는 값은 문구용(AutoRetry).
 * status · error · retry = lib/use-api-resource 의 값(retry 는 바뀌지 않는 함수) — 자기 효과로 받는 곳(선박 카드 상세)은 같은 뜻의 값을 넘긴다.
 */
export function useRetryAfterOnce(key: string | null, status: string, error: unknown, retry: () => void): AutoRetry {
  /** 이미 한 번 다시 받은 열쇠 */
  const [retriedKey, setRetriedKey] = useState<string | null>(null);
  const wait = status === "failed" ? retryAfterMs(error) : null;
  const retried = key != null && retriedKey === key;
  const armed = key != null && wait != null && !retried;
  useEffect(() => {
    if (!armed || key == null || wait == null) return;
    let unwatch: (() => void) | null = null;
    const fire = () => {
      if (typeof document !== "undefined" && document.hidden) { unwatch ??= watchVisible(fire); return; }
      unwatch?.();
      unwatch = null;
      setRetriedKey(key);
      retry();
    };
    const t = setTimeout(fire, wait);
    return () => { clearTimeout(t); unwatch?.(); };
  }, [armed, key, wait, retry]);
  if (status !== "failed") return "none";
  return retried ? "retried" : wait != null ? "scheduled" : "none";
}
