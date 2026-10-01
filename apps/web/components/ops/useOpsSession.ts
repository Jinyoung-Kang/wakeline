"use client";
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { isAuthMiss, OPS_SESSION_PATH } from "@/lib/ops";

export interface OpsUser { username: string }

/**
 * 운영 세션(R-12) — 운영 화면(/ops)과 시스템 로그 화면(/logs)이 같은 세션을 같은 규칙으로 본다.
 * checked = 세션 확인이 답했는가(그 전에는 화면이 "…"), me = 로그인한 운영자, notice = 로그인 화면으로 돌아온 까닭(세션 만료 등).
 * 세션 확인의 401 · 404(익명 ops 호출의 답)만 '로그인 안 됨'(같은 자리에 로그인 폼)이다. 그 밖의 실패(500 · 망)는 error — 로그인 여부를 모르므로
 * 로그인 폼을 보이지 않고 까닭과 retry 를 보인다(web-review B15). 화면을 떠나면 확인 요청을 끊는다.
 * leave(note) = 대시보드를 떠나 로그인으로 · login(u) = 로그인 성공 · retry() = 다시 확인.
 */
export function useOpsSession() {
  const [me, setMe] = useState<OpsUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    apiGet<OpsUser>(OPS_SESSION_PATH, { signal: ctl.signal }).then(
      (u) => { if (!ctl.signal.aborted) { setMe(u); setChecked(true); } },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        if (isAuthMiss(e)) setMe(null); else setError(e);
        setChecked(true);
      });
    return () => ctl.abort();
  }, [attempt]);
  const leave = useCallback((note: string | null) => { setNotice(note); setMe(null); }, []);
  const login = useCallback((u: OpsUser) => { setNotice(null); setMe(u); }, []);
  const retry = useCallback(() => { setError(null); setChecked(false); setAttempt((n) => n + 1); }, []);
  return { me, checked, notice, error, leave, login, retry };
}
