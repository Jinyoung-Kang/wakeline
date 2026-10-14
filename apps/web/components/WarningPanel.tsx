"use client";
import { useEffect, useMemo, useState } from "react";
import { useNow } from "@/lib/clock";
import { fmtKstMinute, fmtKstTitle } from "@/lib/time";
import { effectiveText, groupWarnings, warningsPoller, warningsStatus, WARNINGS_POLL_NONE, type Warning, type WarningsPollState } from "@/lib/warnings";
import { usePublicDemo } from "./PublicDemo";

const TONE = { ok: "text-fg-2", warn: "text-warn", bad: "text-bad", muted: "text-fg-3" } as const;

/**
 * 기상특보 탭(ADR-036 · SPEC F3) — 탭을 볼 때만 받는 조각. 해상 특보를 상위 구역별로 먼저, 육상은 접어 둔다. 줄마다 구역 · 종류 · 수준 · 명령 · 발효(예비면 때) ·
 * 발표 시각 · 해제예고(원문), 원문 줄은 title. 선박 위치와 구역을 잇지 않는다(구역 경계 자료 없음).
 */
export function WarningPanel() {
  const [poll, setPoll] = useState<WarningsPollState>(WARNINGS_POLL_NONE);
  useEffect(() => {
    const p = warningsPoller(setPoll);
    p.start();
    return () => p.stop();
  }, []);
  const now = useNow(30_000);
  return <WarningPanelView poll={poll} nowMs={now} />;
}

export function WarningPanelView({ poll, nowMs }: { poll: WarningsPollState; nowMs: number }) {
  const w = poll.data;
  const groups = useMemo(() => groupWarnings(w?.items ?? []), [w]);
  const line = warningsStatus(w, poll.error, nowMs, usePublicDemo());
  return (
    <div className="flex h-full flex-col text-[11px]" data-testid="warning-panel">
      <div className="row"><span className="label" lang="en">Weather warnings</span><span className="text-fg-3">기상청 · KST</span></div>
      <div className={`border-b border-line px-2.5 py-1 ${TONE[line.tone]}`} role="status" aria-live="polite" data-testid="warnings-status">{line.text}</div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {w?.received && w.items.length === 0 ? <div className="p-3 text-fg-3" data-testid="warnings-empty">지금 발효 중인 기상특보가 없습니다(마지막 목록 기준).</div> : null}
        {groups.sea.map((g) => (
          <section key={g.parent} className="border-b border-line" data-testid="warnings-sea-group">
            <div className="label px-2 pt-1 normal-case!">해상 · {g.parent}</div>
            {g.items.map((x) => <Row key={x.zone_code + x.kind + x.level + x.issued_at} w={x} />)}
          </section>
        ))}
        {groups.land.length ? (
          <details className="border-b border-line" data-testid="warnings-land">
            <summary className="cursor-pointer px-2 py-1 text-fg-2">육상 특보 {groups.land.length}건</summary>
            {groups.land.map((x) => <Row key={x.zone_code + x.kind + x.level + x.issued_at} w={x} />)}
          </details>
        ) : null}
        <div className="px-2 py-1 text-[10px] text-fg-3">구역 단위 특보입니다 — 선박 · 항공기 위치와 구역을 잇지 않습니다(특보 구역 경계 자료 없음). 종류 · 수준 · 명령은 원문 그대로.</div>
      </div>
    </div>
  );
}

function Row({ w }: { w: Warning }) {
  const strong = w.level.includes("경보");
  return (
    <div className="flex items-baseline justify-between gap-2 px-2 py-0.5" title={w.raw} data-testid="warning-row" data-zone={w.zone_code}>
      <span className="min-w-0 truncate">{w.zone_name}</span>
      <span className="shrink-0 text-right">
        <span className={strong ? "text-bad" : w.preliminary ? "text-est" : "text-warn"}>{w.kind} {w.level}</span>
        <span className="text-fg-3"> · {w.command} · {effectiveText(w)}</span>
        <span className="text-fg-3" title={fmtKstTitle(w.issued_at)}> · 발표 {fmtKstMinute(w.issued_at, { date: true })}</span>
        {w.end_notice ? <span className="text-fg-3"> · 해제예고 {w.end_notice}</span> : null}
      </span>
    </div>
  );
}
