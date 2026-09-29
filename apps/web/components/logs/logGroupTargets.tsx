import { RESOLVE_EFFECT, type ResolvedRef } from "@/lib/resolutions";
import { DualTime } from "../DualTime";
import type { ResolveTarget } from "../ResolveConfirm";

/**
 * 지문(fp) 묶음 해결의 확인 대상(ADR-022 — 해결은 지문 묶음 단위) — 묶음 표 · 항목 상세 · 목록 줄이 같은 문구로 말한다.
 * resolve: upto = 서버가 준 시각 그대로(why = 그 시각이 무엇인지), revoke: 그 해결 하나.
 */
export function resolveLogGroup(fp: string, upto: string, why: string): ResolveTarget {
  return {
    op: "resolve", drafts: [{ kind: "log_group", key: fp, upto }], effect: RESOLVE_EFFECT.log_group,
    subject: <>지문 묶음 <span className="mono">{fp}</span> · upto <DualTime v={upto} /> <span className="text-fg-3">({why})</span></>,
  };
}

export function revokeLogGroup(res: ResolvedRef, fp: string | null): ResolveTarget {
  return {
    op: "revoke", ref: res, effect: RESOLVE_EFFECT.revoke,
    subject: <>해결 #{res.id} · 지문 묶음 <span className="mono">{fp ?? "—"}</span> · upto <DualTime v={res.upto} /> · {res.resolved_by}</>,
  };
}
