"use client";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { fmtDuration } from "@/lib/format";
import { aisGapRows, LOG_PERIOD_LABEL, LOG_PERIODS, type LogPeriod } from "@/lib/logs";
import { ErrorNote } from "./ErrorNote";
import { KstRange, KstTime } from "../KstTime";

const PERIODS = Object.keys(LOG_PERIODS) as LogPeriod[];

/**
 * "AIS 수신 공백" 탭(계약 v5 §C7): 이미 있는 공개 `GET /api/v1/ais/gaps` 를 표로 — 구역 · 시작 · 끝 · 길이 · 사유(+ 공급자).
 * 길이는 끝 − 시작(정확한 계산), 열린 공백은 응답 시각(to)까지. 구역이 없는 끝난 공백은 옛 기록(모든 구역에 적용). 값은 api 가 준 그대로.
 * 시각은 KST 만(계약 v5 §G20 · lib/time — 표 칸 "(KST)", title 에 연도 · ms 까지의 KST).
 * onFilterRid = 조회 실패의 요청 id 로 로그 탭을 거른다(같은 화면 — /logs#rid= 링크는 hashchange 를 내지 않는다).
 */
export function AisGapsTable({ initialPeriod, onFilterRid }: { initialPeriod: LogPeriod; onFilterRid?: (rid: string) => void }) {
  const [period, setPeriod] = useState<LogPeriod>(initialPeriod);
  const [data, setData] = useState<ReturnType<typeof aisGapRows> | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const from = new Date(Date.now() - LOG_PERIODS[period]).toISOString();
    apiGet<unknown>(`/api/v1/ais/gaps?${new URLSearchParams({ from })}`)
      .then((v) => { if (live) { setData(aisGapRows(v)); setErr(null); } })
      .catch((e: unknown) => { if (live) setErr(e); });
    return () => { live = false; };
  }, [period, tick]);
  const closed = data ? data.rows.filter((r) => !r.open).length : null;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3 text-[12px]" data-testid="ais-gaps">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="label">AIS 수신 공백</span>
        <div className="flex gap-1" role="group" aria-label="기간">
          {PERIODS.map((p) => <button key={p} type="button" className="btn normal-case!" aria-pressed={period === p} onClick={() => setPeriod(p)}>{LOG_PERIOD_LABEL[p]}</button>)}
        </div>
        <button type="button" className="btn" onClick={() => setTick((t) => t + 1)}>새로고침</button>
        {data ? (
          <span className="text-fg-3">
            기간 <KstRange a={data.from} b={data.to} /> · 끝난 공백 <span className="mono">{closed}</span>건
            {data.truncated ? <span className="ml-1 text-warn">· 최신 500건만(잘림 — 더 오래된 공백이 있음)</span> : null}
            {data.invalid ? <span className="ml-1 text-warn">· 형식 오류 {data.invalid}건 건너뜀</span> : null}
          </span>
        ) : null}
        {err ? <span className="text-bad" role="alert"><ErrorNote error={err} onFilterRid={onFilterRid} /></span> : null}
      </div>
      <div className="mb-2 text-[11px] text-fg-3">
        수신 공백 = ais 수집기가 AIS 메시지를 받지 못한 구간(이 동안 그 구역의 선박 위치 없음) · 출처 <span className="mono">GET /api/v1/ais/gaps</span> · 길이 = 끝 − 시작, 진행 중은 응답 시각까지
      </div>
      {data && !data.rows.length ? <div className="text-fg-3">이 기간에 기록된 수신 공백 없음</div> : null}
      {data && data.rows.length ? (
        <table>
          <thead><tr><th scope="col">구역</th><th scope="col">시작(KST)</th><th scope="col">끝(KST)</th><th scope="col">길이</th><th scope="col">사유</th><th scope="col">공급자</th></tr></thead>
          <tbody>{data.rows.map((r) => (
            <tr key={r.key} data-testid="ais-gap-row" data-open={r.open ? "true" : undefined}>
              <td className={r.scope ? "mono" : "text-fg-3"}>{r.open ? "합계(가장 이른 열린 공백)" : r.scope ?? "구역 없음(옛 기록 — 모든 구역)"}</td>
              <td className="whitespace-nowrap"><KstTime v={r.startedAt} variant="cell" /></td>
              <td className={`whitespace-nowrap ${r.open ? "mono text-warn" : ""}`}>{r.open ? "진행 중" : <KstTime v={r.endedAt} variant="cell" />}</td>
              <td className="mono whitespace-nowrap" title={r.durationS != null ? `${r.durationS} s` : undefined}>{r.durationS == null ? "—" : `${fmtDuration(r.durationS)}${r.open ? "(응답 시각까지)" : ""}`}</td>
              <td>{r.reason ?? "—"}</td>
              <td className="mono">{r.provider ?? "—"}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : null}
    </div>
  );
}
