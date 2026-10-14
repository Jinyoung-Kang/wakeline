"use client";
import { ApiError } from "@/lib/api";
import type { AutoRetry } from "@/lib/use-retry-after";

/**
 * 한 자원 화면(공항 기상 이력 · 알림 근거)의 실패 아래: 자동 다시 받기(503 + Retry-After 에 한 번 — lib/use-retry-after)의 상태와 '다시 시도' 단추(QA-1463).
 * 다시 해도 같은 답인 실패(400 형식 · 404 없음)에는 단추를 두지 않는다. onRetry 는 단추가 사라지기 전에 초점을 옮길 곳을 정한다(부르는 쪽).
 */
export function RetryNote({ error, auto, onRetry }: { error: unknown; auto: AutoRetry; onRetry: () => void }) {
  const status = error instanceof ApiError ? error.status : null;
  if (status === 400 || status === 404) return null;
  const secs = error instanceof ApiError ? error.retryAfterS : null;
  const note = auto === "scheduled" ? `${secs != null ? `${secs}초` : "잠시"} 뒤 자동으로 한 번 다시 불러옵니다`
    : auto === "retried" ? "자동으로 한 번 다시 불렀으나 또 실패 — 잠시 뒤 다시 시도하세요" : null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-2" data-testid="retry-note">
      {note ? <span data-testid="retry-auto" data-state={auto}>{note}</span> : null}
      <button type="button" className="btn" onClick={onRetry} data-testid="retry-button">다시 시도</button>
    </div>
  );
}
