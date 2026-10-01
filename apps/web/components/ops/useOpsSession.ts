"use client";
import { useCallback, useEffect, useState } from "react";
import { opsSession, type OpsUser } from "@/lib/endpoints/ops";
import { isAuthMiss } from "@/lib/ops";
import { useFocusRescue } from "@/lib/use-focus-rescue";

export type { OpsUser };

/**
 * 운영 세션(R-12) — 운영 화면(/ops)과 시스템 로그 화면(/logs)이 같은 세션을 같은 규칙으로 본다.
 * checked = 세션 확인이 답했는가(그 전에는 화면이 "…"), me = 로그인한 운영자, notice = 로그인 화면으로 돌아온 까닭(세션 만료 등).
 * 세션 확인의 401 · 404(익명 ops 호출의 답)만 '로그인 안 됨'(같은 자리에 로그인 폼)이다. 그 밖의 실패(500 · 망)는 error — 로그인 여부를 모르므로
 * 로그인 폼을 보이지 않고 까닭과 retry 를 보인다(web-review B15). 화면을 떠나면 확인 요청을 끊는다.
 * leave(note) = 대시보드를 떠나 로그인으로 · login(u) = 로그인 성공 · retry() = 다시 확인.
 * 로그인 · 로그아웃(만료 포함)으로 화면이 바뀌면 누른 단추('Sign in' · 'sign out')가 사라져 초점이 body 로 떨어졌다(QA-304) — 그때만 새 화면이
 * [data-session-focus] 로 표시한 요소(로그인 폼의 아이디 칸 · 대시보드의 지금 탭 단추)로 옮긴다. 처음 세션 확인 뒤에는 옮기지 않는다(첫 Tab = 건너뛰기 링크).
 */
export function useOpsSession() {
  const [me, setMe] = useState<OpsUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    opsSession({ signal: ctl.signal }).then(
      (u) => { if (!ctl.signal.aborted) { setMe(u); setChecked(true); } },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        if (isAuthMiss(e)) setMe(null); else setError(e);
        setChecked(true);
      });
    return () => ctl.abort();
  }, [attempt]);
  const rescue = useFocusRescue();
  const sessionFocus = useCallback(() => rescue(() => [document.body.querySelectorAll("[data-session-focus]")[0]]), [rescue]);
  const leave = useCallback((note: string | null) => { setNotice(note); setMe(null); sessionFocus(); }, [sessionFocus]);
  const login = useCallback((u: OpsUser) => { setNotice(null); setMe(u); sessionFocus(); }, [sessionFocus]);
  const retry = useCallback(() => { setError(null); setChecked(false); setAttempt((n) => n + 1); }, []);
  return { me, checked, notice, error, leave, login, retry };
}
