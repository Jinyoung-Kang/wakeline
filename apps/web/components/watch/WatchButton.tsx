"use client";
import { isWatched, useWatch } from "@/lib/watch-store";
import { WATCH_MAX, type WatchKind } from "@/lib/watch";

/** 카드의 "관심 대상" 단추(SPEC F4-1) — 이 브라우저에만 저장한다(서버는 모른다). 50개가 차면 더하지 않고 까닭을 적는다 */
export function WatchButton({ kind, id, label }: { kind: WatchKind; id: string; label?: string | null }) {
  const on = useWatch((s) => isWatched(s.targets, kind, id));
  const full = useWatch((s) => s.full && !on && s.targets.length >= WATCH_MAX);
  const toggle = useWatch((s) => s.toggle);
  return (
    <button className="btn" aria-pressed={on} data-testid="watch-toggle" title={full ? `관심 대상은 ${WATCH_MAX}개까지 — 관심 탭에서 지운 뒤 더하세요` : "이 브라우저에만 저장 · 알림은 관심 탭에서 켭니다"}
      onClick={() => toggle({ kind, id, ...(label?.trim() ? { label: label.trim() } : {}) })}>
      {on ? "관심 해제" : full ? "관심 가득" : "관심 대상"}
    </button>
  );
}
