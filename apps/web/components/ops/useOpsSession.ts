"use client";
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { OPS_SESSION_PATH } from "@/lib/ops";

export interface OpsUser { username: string }

/**
 * 운영 세션(R-12) — 운영 화면(/ops)과 시스템 로그 화면(/logs)이 같은 세션을 같은 규칙으로 본다.
 * checked = 세션 확인이 답했는가(그 전에는 화면이 "…"), me = 로그인한 운영자(없으면 같은 자리에 로그인 폼),
 * notice = 로그인 화면으로 돌아온 까닭(세션 만료 등). leave(note) = 대시보드를 떠나 로그인으로 · login(u) = 로그인 성공.
 */
export function useOpsSession() {
  const [me, setMe] = useState<OpsUser | null>(null);
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { apiGet<OpsUser>(OPS_SESSION_PATH).then(setMe).catch(() => setMe(null)).finally(() => setChecked(true)); }, []);
  const leave = useCallback((note: string | null) => { setNotice(note); setMe(null); }, []);
  const login = useCallback((u: OpsUser) => { setNotice(null); setMe(u); }, []);
  return { me, checked, notice, leave, login };
}
