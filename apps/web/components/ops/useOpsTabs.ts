"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { opsSession, opsTab, type OpsTab } from "@/lib/endpoints/ops";
import { classifyOpsError, isAuthMiss, RequestOrder, SESSION_EXPIRED_NOTE } from "@/lib/ops";
import type { AuditPage } from "@/lib/ops-audit";
import type { SwitchState } from "@/lib/provider-switch";
import type { ResolvedMode } from "@/lib/resolutions";
import { useVisibleInterval } from "@/lib/use-visible-interval";

type Any = Record<string, unknown>;
/** provider_switch: 켜고 끄기의 원본(DB)과 수집기가 따르는 Redis 미러(R-94) — providers[].disabled 는 미러 값 */
/** resolution_state = 해결 기록의 상태(ok | stale | unavailable — ADR-024). providers[] 마다 last_error_resolution · last_error_resolved */
/** error = 수집기 자동 전환(switches — wakeline:events)을 api 가 읽지 못함(리뷰 cto-2026-10 A4 — 그때 switches 는 빈 목록, lib/ops switchHistoryError) */
export interface Providers {
  providers: Any[]; active: Record<string, string>; collector: Record<string, string>; switches: Any[]; error?: unknown; budget_days: Any[]; budget_day_zone?: unknown; provider_switch?: SwitchState[]; resolution_state?: unknown;
  /** 응답을 만든 서버 시각(UTC ISO) — '파일 없음' 줄의 '확인 멈춤'을 서버 기준 지금으로 판정한다(providersNowMs) */
  generated_at?: unknown;
}
/**
 * hidden_resolved_errors = 해결 처리로 요약에서 뺀 오류 실행 수(ADR-024). mode = 이 응답을 요청한 해결 표시(화면 문구는 받은 응답의 것을 말한다).
 * summary_since = 요약 창의 시작(UTC ISO — 계약 v5 §G14 개정 2026-10-01): 행을 열면 그 값을 since 로 보낸다(연 때의 요약 창)
 */
export interface Runs { items: Any[]; summary_24h: Any[]; hidden_resolved_errors?: unknown; summary_since?: unknown; mode: ResolvedMode }
/** counted_since = V16 이 격리 수를 KST 날짜로 세기 시작한 순간(UTC ISO) — 그 KST 날짜는 부분 값(lib/ops qualityPartialDay) */
export interface Quality { rule_counts: Any[]; recent: Any[]; day_zone?: unknown; counted_since?: unknown }
export interface Settings { items: { key: string; value: unknown; version: number; updated_by?: string; updated_at?: string }[] }
/** error = api 가 DLQ(wakeline:dlq)를 읽지 못함(그때 items 는 빈 목록 — lib/ops dlqReadError) */
export interface Dlq { items: Any[]; error?: unknown }
/** 탭 = 엔드포인트 하나(경로는 lib/endpoints/ops — 실행 요약은 해결 표시를 늘 명시한다). 화면의 탭 단추도 이 순서 */
export const OPS_TABS: readonly OpsTab[] = ["providers", "runs", "quality", "settings", "audit", "dlq", "pipeline"];
/** 탭마다 요청 순서(lib/ops RequestOrder) — 대시보드마다 하나 */
const newOrders = () => Object.fromEntries(OPS_TABS.map((t) => [t, new RequestOrder()])) as Record<OpsTab, RequestOrder>;

/**
 * 운영 화면의 탭 불러오기(web-review §3.2) — 탭 일곱(엔드포인트 하나씩)의 값 · 마지막 성공 시각 · 탭마다의 실패, 실행 요약의 해결 표시, 15 s 주기.
 * - 탭마다 요청 순서(lib/ops RequestOrder): 기준 요청(쓰기 뒤 · 해결 표시 토글 · 새로고침 단추) 전에 떠난 요청의 응답은 버리고 — 해결 쓰기 뒤 다시 읽은 값을
 *   그 전에 떠난 주기 요청이 덮지 않게, 토글 전 해결 표시의 요약이 표에 오지 않게 — 새로고침보다 느린 응답(실패 포함)은 더 새 응답이 없으면 반영한다.
 * - 15 s 주기는 탭이 보일 때만, 다시 보이면 곧바로(PLAN §5 결정 2 · lib/use-visible-interval). 주기 요청은 기준 요청이 아니고, 요청이 떠 있는 탭은 건너뛴다.
 * - 탭의 401/404: 한 번의 새로고침에서 세션 확인은 한 번만 — 세션도 없으면(만료) onLeave(SESSION_EXPIRED_NOTE). 실패는 그 탭에 붙는다(값은 마지막 성공 기준).
 * - err = 탭 밖의 마지막 오류(fail — 설정 저장의 401/404 등). 전체 새로고침(주기 · 단추)이 지운다.
 * onRuns(v, mode) = 실행 요약을 표에 넣은 뒤(연 행이 새 요약에서 빠졌는지 보는 자리) — 바뀌지 않는 함수를 넘긴다(새로고침 콜백이 그대로 남게).
 */
export function useOpsTabs({ onLeave, onRuns }: { onLeave: (note: string | null) => void; onRuns: (v: Omit<Runs, "mode">, mode: ResolvedMode) => void }) {
  const [prov, setProv] = useState<Providers | null>(null);
  const [runs, setRuns] = useState<Runs | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  /** 감사 첫 쪽(next_cursor 포함 — 다음 쪽은 ./useAuditPages 의 '더 보기') */
  const [audit, setAudit] = useState<AuditPage | null>(null);
  const [dlq, setDlq] = useState<Dlq | null>(null);
  const [pipeline, setPipeline] = useState<unknown>(null);
  /** 마지막 오류(문구 + ApiError 면 요청 id — 계약 v5 §C8) */
  const [err, setErr] = useState<unknown>(null);
  /** 탭(엔드포인트)마다 마지막 성공 시각과 마지막 요청의 실패(성공하면 지운다) — 한 탭만 계속 실패해도 드러난다(R-12) */
  const [lastOk, setLastOk] = useState<Partial<Record<OpsTab, number>>>({});
  const [tabErr, setTabErr] = useState<Partial<Record<OpsTab, unknown>>>({});
  /** 실행 요약의 해결 표시(ADR-024): hide(기본) = 해결 처리한 공급자 오류의 error 실행을 요약에서 뺀다 · show = 뺀 것 없이. ref 는 요청을 떠날 때의 값을 읽는다 */
  const [runsMode, setRunsMode] = useState<ResolvedMode>("hide");
  const runsModeRef = useRef<ResolvedMode>("hide");
  const order = useRef<Record<OpsTab, RequestOrder> | null>(null);
  /** 오류 처리: 세션 만료면 로그인으로(대시보드 상태는 언마운트로 사라진다), 아니면 오류 문구 */
  const fail = useCallback((e: unknown) => {
    if (!isAuthMiss(e)) { setErr(e); return; }
    void classifyOpsError(e, () => opsSession()).then((k) => (k === "expired" ? onLeave(SESSION_EXPIRED_NOTE) : setErr(e)));
  }, [onLeave]);
  /**
   * 탭 불러오기 — only 를 주면 그 탭만(해결 쓰기 뒤 · 해결 표시 토글), 없으면 모두(15 s 주기 · 새로고침 단추).
   * periodic = 15 s 주기: 기준 요청이 아니고, 요청이 아직 떠 있는 탭은 건너뛴다. 그 밖(처음 · 새로고침 단추 · 쓰기 뒤 · 토글)은 기준 요청이다.
   */
  const reload = useCallback((only?: readonly OpsTab[], periodic = false) => {
    if (!only) setErr(null);
    let authMiss = false; // 한 번의 새로고침에서 세션 확인은 한 번만
    const load = <T,>(t: OpsTab, set: (v: T, mode: ResolvedMode) => void) => {
      if (only && !only.includes(t)) return;
      const ord = (order.current ??= newOrders())[t];
      if (periodic && ord.busy) return;
      const mode = runsModeRef.current;
      const my = ord.begin(!periodic);
      void opsTab<T>(t, mode).then(
        (v) => { if (!ord.settle(my)) return; set(v, mode); setLastOk((o) => ({ ...o, [t]: Date.now() })); setTabErr((m) => { const c = { ...m }; delete c[t]; return c; }); },
        (e: unknown) => {
          if (!ord.settle(my)) return;
          // 이 탭의 값은 마지막 성공 시각 기준으로 남는다 — 실패를 탭에 붙인다. 세션 만료면 로그인으로(확인은 한 번만)
          setTabErr((m) => ({ ...m, [t]: e }));
          if (!isAuthMiss(e) || authMiss) return;
          authMiss = true;
          void classifyOpsError(e, () => opsSession()).then((k) => { if (k === "expired") onLeave(SESSION_EXPIRED_NOTE); });
        });
    };
    load<Providers>("providers", setProv);
    load<Omit<Runs, "mode">>("runs", (v, mode) => { setRuns({ ...v, mode }); onRuns(v, mode); });
    load<Quality>("quality", setQuality);
    load<Settings>("settings", setSettings);
    load<AuditPage>("audit", setAudit);
    load<Dlq>("dlq", setDlq);
    load<unknown>("pipeline", setPipeline);
  }, [onLeave, onRuns]);
  const refresh = useCallback(() => reload(), [reload]);
  useEffect(() => {
    const first = setTimeout(refresh, 0);
    return () => clearTimeout(first);
  }, [refresh]);
  // 15 s 주기는 탭이 보일 때만 — 숨긴 탭에서 엔드포인트 7개를 분당 28번 부르지 않는다. 다시 보이면 곧바로(PLAN §5 결정 2, web-review B12)
  useVisibleInterval(() => reload(undefined, true), 15_000);
  const toggleRunsMode = useCallback(() => {
    const next: ResolvedMode = runsModeRef.current === "show" ? "hide" : "show";
    runsModeRef.current = next;
    setRunsMode(next);
    reload(["runs"]);
  }, [reload]);
  return { providers: prov, setProviders: setProv, runs, quality, settings, audit, dlq, pipeline, err, fail, lastOk, tabErr, runsMode, toggleRunsMode, reload, refresh };
}
