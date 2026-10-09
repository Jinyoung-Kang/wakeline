"use client";
import { REL_MARK, REL_WORD, reliabilityText, type RelPart } from "@/lib/reliability";

const TONE = { ok: "text-fg-2", warn: "text-warn", bad: "text-bad", unknown: "text-fg-3" } as const;

/** 신뢰도 한 줄(SPEC F6) — 구성 요소마다 등급 표시(■ ▲ ✕ □ — 상태 바와 같다) · 글. 합친 점수는 없다. 카드 · 근거 화면 전용 */
export function ReliabilityLine({ parts, label = "신뢰도" }: { parts: readonly RelPart[]; label?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 border-b border-line px-2 py-0.5 text-[10px]" data-testid="reliability" title={`${label} — 구성 요소별(합친 점수 아님): ${reliabilityText(parts)}`}>
      <span className="text-fg-3">{label}</span>
      {parts.map((p) => (
        <span key={p.key} className={TONE[p.grade]} data-grade={p.grade}><span aria-hidden>{REL_MARK[p.grade]} </span>{p.text}<span className="sr-only"> ({REL_WORD[p.grade]})</span></span>
      ))}
    </div>
  );
}
