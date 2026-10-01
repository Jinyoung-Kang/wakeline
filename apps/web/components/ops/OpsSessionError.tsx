"use client";
import { ErrorNote } from "../logs/ErrorNote";

/** 세션 확인이 401 · 404 가 아닌 까닭으로 실패했을 때(useOpsSession error) — 로그인 폼 대신 까닭(요청 id)과 다시 시도. /ops · /logs 가 같이 쓴다 */
export function OpsSessionError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  return (
    <div className="p-4 text-[12px]">
      <h1 className="sr-only">{title} — 세션 확인 실패</h1>
      <div className="mb-2 text-bad" role="alert" data-testid="ops-session-error">
        세션을 확인하지 못했습니다 — 로그인 여부를 알 수 없음 · <ErrorNote error={error} />
      </div>
      <button type="button" className="btn" onClick={onRetry}>다시 시도</button>
    </div>
  );
}
