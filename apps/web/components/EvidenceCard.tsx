import type { Alert } from "@/lib/types";
import { band, fmtAlt, fmtEta, fmtTime, hazardColor } from "@/lib/format";

/** 근거 카드(11.3절): 어느 경보·고도대·항공기 고도·유효시간·판정 시각·관측/추정·예측이면 ETA·방법. */
export function EvidenceCard({ a }: { a: Alert }) {
  const ev = a.evidence as Record<string, unknown>;
  const bandFt = ev.band_ft as number[] | undefined;
  const rows: [string, React.ReactNode][] = [
    ["경보", `${a.fir_id} · ${a.hazard}${a.qualifier ? ` ${a.qualifier}` : ""}`],
    ["SIGMET id", <span key="id" className="mono text-fg-2">{a.sigmet_id}</span>],
    ["고도대", bandFt ? band(bandFt[0], bandFt[1] === -1 ? null : bandFt[1]) : "—"],
    [a.kind === "PREDICTED" ? "진입 시 고도(추정)" : "항공기 고도", fmtAlt(a.alt_ft)],
    ["유효시간 종료", fmtTime(String(ev.valid_to ?? ""))],
    ["판정 시각", fmtTime(String(ev.judged_at ?? a.entered_at))],
    ["방법", String(ev.method ?? "—")],
  ];
  if (a.kind === "PREDICTED") {
    rows.push(["ETA", <span key="eta" className="mono">{fmtEta(a.eta_s)}</span>]);
    rows.push(["거리", `${String(ev.distance_nm ?? "—")} NM`]);
  } else {
    rows.push(["연속 확인", `${String(ev.confirmations ?? 2)}회`]);
    rows.push(["출처 / 관측", `${String(ev.provider ?? "—")} · ${fmtTime(String(ev.seen_at ?? ""))}`]);
  }
  return (
    <div className="border border-line bg-bg px-2 py-1 text-[11px]" data-testid="evidence">
      <div className="mb-1 flex items-center gap-2">
        <span className="inline-block h-2 w-2" style={{ background: hazardColor(a.hazard) }} />
        <span className="label">{a.kind === "PREDICTED" ? "예상 진입 · 추정" : "관측 · 경보 안"}</span>
        {a.estimated ? <span className="badge est">추정</span> : <span className="badge ok">관측</span>}
      </div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-2 border-t border-line py-0.5"><span className="text-fg-3">{k}</span><span className="text-right">{v}</span></div>
      ))}
    </div>
  );
}
