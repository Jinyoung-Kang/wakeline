import { fmtRangeKst, fmtUtcRangeTitle } from "@/lib/format";
import { isSummaryRow, replayAircraftRows, replayRecRowName, replayRecTitle, replaySigmetBand, SUMMARY_FLAG, type ReplayAircraft, type ReplaySigmet } from "@/lib/replay";

/** 원문 칸의 설명 — 발표된 글자 그대로, 화면의 KST 로 바꾸지 않는다(SIGMET 카드 · 공항 화면과 같은 이름표) */
const RAW_TITLE = "발표된 원문 그대로 — 안의 시각(…Z)은 UTC";

/**
 * 재생 상세(inspector) — 그 시각의 항공기 기록. 시각은 한국 표준시(KST), 기록 시각 행에 마우스를 올리면 원본 UTC.
 * 1분 요약 행은 "1분 평균"이라고 먼저 밝힌다(DH-11).
 */
export function ReplayAircraftDetail({ ac, at }: { ac: ReplayAircraft; at: string }) {
  const rec = replayRecRowName(ac);
  return <>
    {isSummaryRow(ac) ? <div className="py-1 text-[11px] text-warn" data-testid="replay-summary-row">{SUMMARY_FLAG}</div> : null}
    {replayAircraftRows(ac, at).map(([k, v]) => (
      <div key={k} className="flex justify-between gap-2 border-b border-line py-1"><span className="text-fg-3">{k}</span><span className="mono text-right" title={k === rec ? replayRecTitle(ac) : undefined}>{v}</span></div>
    ))}
  </>;
}

/**
 * 재생 상세 — 그 시각의 SIGMET. 유효시간은 KST(마우스를 올리면 원본 UTC), 원문은 발표된 그대로 — 보이는 이름표 "Raw (원문 · UTC)" 를 달아
 * KST 로 적은 유효시간 바로 아래의 "…Z" 가 UTC 라는 것이 툴팁 없이도 읽히게 한다(SIGMET 카드와 같게).
 */
export function ReplaySigmetDetail({ sg }: { sg: ReplaySigmet }) {
  const rows: [string, React.ReactNode][] = [
    ["유형", `${sg.hazard}${sg.qualifier ? ` ${sg.qualifier}` : ""}`],
    ["FIR", sg.fir_name ?? sg.fir_id],
    ["고도대", replaySigmetBand(sg)],
    ["유효", <span key="v" className="mono" title={fmtUtcRangeTitle(sg.valid_from, sg.valid_to)}>{fmtRangeKst(sg.valid_from, sg.valid_to)}</span>],
    ["판정", sg.excluded_reason ? `제외 (${sg.excluded_reason})` : "폴리곤·고도대·유효시간 검사"],
  ];
  return <>
    {rows.map(([k, v]) => <div key={k} className="flex justify-between gap-2 border-b border-line py-1"><span className="text-fg-3">{k}</span><span className="text-right">{v}</span></div>)}
    <div className="mt-2 label" title={RAW_TITLE}>Raw (원문 · UTC)</div>
    <pre className="mono whitespace-pre-wrap border border-line bg-bg p-2 text-[10px] text-fg-2" title={RAW_TITLE}>{sg.raw_text}</pre>
  </>;
}
