"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { logGroups, logsPage } from "@/lib/endpoints/logs";
import { opsSession } from "@/lib/endpoints/ops";
import { appendLogPage, applyPending, logGroupsSig, LOGS_PAGE, pendingEntries, type LogEntry, type LogFilter, type LogPage, type parseLogGroups } from "@/lib/logs";
import { classifyOpsError, isAuthMiss, SESSION_EXPIRED_NOTE } from "@/lib/ops";
import { useVisibleInterval } from "@/lib/use-visible-interval";

export type LogView = "list" | "groups";
export type LogGroups = ReturnType<typeof parseLogGroups>;
/** 자동 새로고침(§C7) — 새 항목은 단추로만 반영한다 */
export const LOG_REFRESH_MS = 15_000;
const NO_PENDING = { items: [] as LogEntry[], more: false };

/**
 * 시스템 로그 화면의 목록 · 묶음 불러오기(web-review §3.2) — 지금 보기(view)와 필터의 쪽(page) · 묶음(groups), 자동 확인이 찾은 새 항목(pending) ·
 * 바뀐 묶음(freshGroups), '이전 항목 더 보기', 마지막 성공 시각 · 오류.
 * - 보기 · 필터가 바뀌면(active 일 때) 다시 불러온다 — 첫 요청은 다음 틱(개발 모드 이중 실행에서 한 번만). 불러올 때마다 번호를 올려 늦게 온 이전 필터의
 *   응답(그 사이의 자동 확인 · 더 보기 포함)을 버린다.
 * - 자동 확인(active 일 때 15 s · 탭이 보일 때만 · 다시 보이면 곧바로 — lib/use-visible-interval): 첫 쪽을 다시 받아 보이는 맨 위보다 새 항목만 대기열에
 *   (목록은 그대로 — 보이는 줄이 없으면 바로 보인다). 묶음 보기는 바뀌었는지만(logGroupsSig). 불러오는 동안 · 앞 확인이 떠 있는 동안은 건너뛰고(쌓지 않는다), 답은 받을 때 그려져 있는 쪽 · 묶음과 견준다.
 * - 더 보기는 커서 하나에 한 번만(받는 동안 다시 누르면 같은 쪽이 두 번 붙었다 — web-review B1), 붙일 때도 그 커서의 쪽일 때만.
 * - ops 호출 실패: err 로 보이고, 401/404 면 세션을 확인해 만료일 때만 onLeave(SESSION_EXPIRED_NOTE). 성공하면 err 를 지운다.
 * onList(p) = 목록 쪽을 새로 받았을 때(고른 줄을 그 목록에 맞추는 자리) — 바뀌지 않는 함수를 넘긴다.
 */
export function useLogFeed(view: LogView, filter: LogFilter, { active, onLeave, onList }: { active: boolean; onLeave: (note: string | null) => void; onList: (p: LogPage) => void }) {
  /** at = 이 목록을 요청한 시각(기간의 기준 — "더 보기"도 같은 기준) */
  const [page, setPage] = useState<(LogPage & { at: number }) | null>(null);
  const [pending, setPending] = useState(NO_PENDING);
  const [groups, setGroups] = useState<LogGroups | null>(null);
  const [freshGroups, setFreshGroups] = useState<LogGroups | null>(null);
  const [loading, setLoading] = useState(false);
  /** '이전 항목 더 보기'가 받는 중인 커서 — 단추를 바쁨으로 보인다 */
  const [moreCursor, setMoreCursor] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [lastOk, setLastOk] = useState<number | null>(null);
  /** 목록·묶음을 새로 불러올 때마다 올린다 — 늦게 온 이전 필터의 응답(또는 그 사이의 자동 확인)을 버린다 */
  const loadSeq = useRef(0);
  /** 끝난 마지막 불러오기의 번호 — loadSeq 와 다르면 불러오기가 떠 있다(자동 확인은 건너뛴다) */
  const loadDone = useRef(0);
  /** 떠 있는 자동 확인이 견줄 불러오기 번호 — 같은 번호의 확인이 떠 있으면 그 주기는 건너뛴다. 새로 불러온 뒤에는 앞 확인(답은 버려진다)이 막지 않는다 */
  const checkFor = useRef<number | null>(null);
  /** 받는 중인 '더 보기' 커서(같은 프레임의 두 번째 누름도 막는다 — 상태는 다음 렌더에야 보인다) */
  const moreFor = useRef<string | null>(null);
  /** 지금 그려진 쪽 · 묶음 — 자동 확인은 떠날 때가 아니라 답을 받을 때 보이는 것과 견준다(그 사이 '새 항목' · 바뀐 묶음을 반영했을 수 있다) */
  const shown = useRef({ page, groups });
  useEffect(() => { shown.current = { page, groups }; }, [page, groups]);

  /** ops 호출 실패: 문구로 보이고, 401/404 면 세션을 확인해 만료일 때만 로그인으로 */
  const fail = useCallback((e: unknown) => {
    setErr(e);
    if (!isAuthMiss(e)) return;
    void classifyOpsError(e, () => opsSession()).then((k) => { if (k === "expired") onLeave(SESSION_EXPIRED_NOTE); });
  }, [onLeave]);

  const load = useCallback(async (v: LogView, f: LogFilter) => {
    const my = ++loadSeq.current;
    const at = Date.now();
    setLoading(true);
    try {
      if (v === "list") {
        const p = await logsPage(f, at);
        if (my !== loadSeq.current) return;
        setPage({ ...p, at });
        setPending(NO_PENDING);
        onList(p);
      } else {
        const g = await logGroups(f, at);
        if (my !== loadSeq.current) return;
        setGroups(g);
        setFreshGroups(null);
      }
      setErr(null);
      setLastOk(Date.now());
    } catch (e) {
      if (my === loadSeq.current) fail(e);
    } finally {
      if (my === loadSeq.current) { loadDone.current = my; setLoading(false); }
    }
  }, [fail, onList]);

  // 필터·보기가 바뀌면 다시 불러온다(첫 요청은 다음 틱 — 개발 모드 이중 실행에서 한 번만)
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => void load(view, filter), 0);
    return () => clearTimeout(t);
  }, [active, view, filter, load]);

  /**
   * 자동 확인: 첫 쪽을 다시 받아 보이는 맨 위보다 새 항목만 대기열에(목록은 그대로). 묶음 보기는 바뀌었는지만.
   * 불러오는 동안은 건너뛴다(ADR-029 §5) — 그동안 보이는 것은 앞 조건(앞 필터 · 새로고침 전)의 쪽 · 묶음이라, 새로 불러온 목록의 줄을 '새 항목'으로 보였다.
   * 앞 확인이 떠 있어도 건너뛴다(§5 — 쌓지 않는다): api 가 멈추면 15 s 마다 요청이 쌓였고, 늦게 온 앞 확인이 더 새 확인의 대기열을 덮었다.
   * 답은 받을 때 그려져 있는 쪽 · 묶음(shown)과 견준다 — 떠날 때의 것과 견주면 그 사이 반영한 줄을 다시 '새 항목'으로 내놓았다.
   */
  const poll = useCallback(async () => {
    const my = loadSeq.current;
    if (loadDone.current !== my || checkFor.current === my) return;
    checkFor.current = my;
    try {
      if (view === "list") {
        const p = await logsPage(filter, Date.now());
        if (my !== loadSeq.current) return;
        const cur = shown.current.page;
        if (!cur?.items.length) {
          // 보이는 줄이 없으면 움직일 것도 없다 — 바로 보인다
          setPage({ ...p, at: Date.now() });
          setPending(NO_PENDING);
        } else {
          setPending(pendingEntries(cur.items, p.items, LOGS_PAGE));
        }
      } else {
        const g = await logGroups(filter, Date.now());
        if (my !== loadSeq.current) return;
        setFreshGroups(logGroupsSig(g) !== logGroupsSig(shown.current.groups) ? g : null);
      }
      setErr(null);
      setLastOk(Date.now());
    } catch (e) {
      if (my === loadSeq.current) fail(e);
    } finally {
      if (checkFor.current === my) checkFor.current = null;
    }
  }, [view, filter, fail]);
  // 탭이 보일 때만, 다시 보이면 곧바로(PLAN §5 결정 2, web-review B12). poll 이 바뀌어도(쪽을 넘김 · 새 항목 반영) 주기를 다시 걸지 않는다(B13)
  useVisibleInterval(() => void poll(), active ? LOG_REFRESH_MS : null);

  const showPending = () => {
    if (pending.more) { void load("list", filter); return; } // 새 항목이 한 쪽을 넘음 — 사이가 비지 않게 처음부터
    setPage((p) => (p ? { ...p, items: applyPending(p.items, pending.items) } : p));
    setPending(NO_PENDING);
  };
  const showFreshGroups = () => { setGroups(freshGroups); setFreshGroups(null); };
  /** 다음 쪽은 커서 하나에 한 번만 — 받는 동안 다시 누르면 같은 쪽이 두 번 붙어 숨김 · 건너뜀 합계가 부풀었다. 붙일 때도 그 커서의 쪽일 때만 */
  const loadMore = async () => {
    const cursor = page?.nextCursor;
    if (!page || !cursor || moreFor.current === cursor) return;
    moreFor.current = cursor;
    setMoreCursor(cursor);
    const my = loadSeq.current;
    try {
      const p = await logsPage(filter, page.at, { cursor });
      if (my !== loadSeq.current) return;
      setPage((prev) => (prev && prev.nextCursor === cursor ? { ...appendLogPage(prev, p), at: prev.at } : prev));
    } catch (e) {
      if (my === loadSeq.current) fail(e);
    } finally {
      if (moreFor.current === cursor) { moreFor.current = null; setMoreCursor(null); }
    }
  };
  return { page, pending, groups, setGroups, freshGroups, loading, moreCursor, err, lastOk, fail, load, loadMore, showPending, showFreshGroups };
}
