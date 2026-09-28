"use client";
import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { OPS_SESSION_PATH } from "@/lib/ops";
import { OpsLogin } from "@/components/OpsLogin";
import { LogsDashboard } from "@/components/logs/LogsDashboard";

/**
 * 시스템 로그(계약 v5 §C7): 운영 세션 필요 — 없으면 같은 자리에 로그인 폼(운영 화면과 같은 세션 · 같은 만료 처리, R-12).
 * 로그에는 내부 경로·구성이 담기므로 조회 API(/api/v1/ops/logs*)도 운영 전용이다(익명 404).
 */
export default function LogsPage() {
  const [me, setMe] = useState<{ username: string } | null>(null);
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { apiGet<{ username: string }>(OPS_SESSION_PATH).then(setMe).catch(() => setMe(null)).finally(() => setChecked(true)); }, []);
  const leave = useCallback((note: string | null) => { setNotice(note); setMe(null); }, []);
  const login = useCallback((u: { username: string }) => { setNotice(null); setMe(u); }, []);
  if (!checked) return <div className="p-4 text-fg-3"><h1 className="sr-only">시스템 로그</h1>…</div>;
  return <><h1 className="sr-only">시스템 로그{me ? "" : " — 로그인"}</h1>{me ? <LogsDashboard me={me} onLeave={leave} /> : <OpsLogin onLogin={login} notice={notice} />}</>;
}
