"use client";
import { useEffect, useRef, useState } from "react";
import { opsAuditPage } from "@/lib/endpoints/ops";
import { isAuthMiss } from "@/lib/ops";
import { auditCursor, auditView, mergeAuditRows, type AuditPage, type AuditPaged } from "@/lib/ops-audit";

/**
 * 운영 감사 탭의 '더 보기'(QA-307 — 전에는 첫 쪽 50건만 그리고 next_cursor 를 버렸다).
 * head = 운영 화면의 15 s 주기가 받는 첫 쪽(./useOpsTabs). '더 보기'로 받은 앞 기록을 쌓고, 그릴 목록은 머리와 합친 것(lib/ops-audit auditView —
 * 새 머리가 쌓은 행과 겹치지 않으면 머리만 보이고 reset 으로 알린다).
 * - 커서 하나에 한 번만 보낸다: 받는 동안 다시 누르면 같은 쪽이 두 번 붙는다(로그 목록 '더 보기' — web-review B1 과 같은 규칙). 단추는 그동안 disabled · aria-busy.
 * - 실패는 받은 행을 그대로 두고 따로 보인다(지우지 않는다). 401/404 는 onAuthMiss(세션 확인 — 만료면 로그인으로).
 * - 대시보드가 떠나면 떠 있는 요청을 끊는다(ADR-029 — 효과의 정리는 끊기).
 */
export function useAuditPages(head: AuditPage | null, onAuthMiss: (e: unknown) => void) {
  const [paged, setPaged] = useState<AuditPaged | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  /** 받는 중인 커서(같은 프레임의 두 번째 누름도 막는다 — 상태는 다음 렌더에야 보인다) */
  const moreFor = useRef<number | null>(null);
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);
  const view = auditView(head, paged);
  const more = async () => {
    const cursor = view.next;
    if (cursor == null || moreFor.current != null) return;
    moreFor.current = cursor;
    setBusy(true);
    setErr(null);
    // 지금 그린 목록 위에 쌓는다 — 머리가 그 사이에 바뀌어도 auditView 가 다시 합친다(겹치지 않으면 머리만)
    const base = view.rows;
    const c = new AbortController();
    ctl.current = c;
    try {
      const p = await opsAuditPage(cursor, { signal: c.signal });
      if (c.signal.aborted) return;
      setPaged({ rows: mergeAuditRows(base, Array.isArray(p.items) ? p.items : []), next: auditCursor(p.next_cursor) });
    } catch (e) {
      if (c.signal.aborted) return;
      setErr(e);
      if (isAuthMiss(e)) onAuthMiss(e);
    } finally {
      if (moreFor.current === cursor) moreFor.current = null;
      if (!c.signal.aborted) setBusy(false);
    }
  };
  return { rows: view.rows, next: view.next, reset: view.reset, more, busy, err };
}
