"use client";
import type { Alert } from "@/lib/types";
import { band, fmtAltDual, fmtEta, fmtGsDual, fmtNum, hazardColor } from "@/lib/format";
import { alertListState, closeReasonLabel, etaRemainingS, evidenceBand, evidenceBandSource } from "@/lib/alerts";
import { useServerData } from "@/lib/store";
import { useRxFresh, useServerNow } from "@/lib/clock";
import { DualRange, DualTime } from "./DualTime";

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * 근거 카드(11.3절): 어느 경보·고도대·항공기 고도·유효시간·판정 시각·관측/추정·예측이면 ETA·방법.
 * 시각은 KST 먼저 · UTC 함께(lib/time — "09-29 14:02:54 KST · 05:02:54 UTC", title 에 원본 UTC ISO). 근거에 없는 값은 "—"(기본값으로 채우지 않는다). 판정에 쓴 가정(하한 SFC·상한 무제한·수직속도 0)은 가정이라고 밝힌다.
 * 예측 ETA 는 eta_at 에서 1 s 마다 카운트다운한다(추정). 알림 목록이 갱신되지 않는 동안(끊김·수신 대기·일시정지)은 "—"(DH-9).
 */
export function EvidenceCard({ a }: { a: Alert }) {
  const now = useServerNow(1000);
  const rxFresh = useRxFresh();
  const live = useServerData((d) => alertListState(d.conn, d.alertsVersion, rxFresh) === "live");
  const ev = (a.evidence ?? {}) as Record<string, unknown>;
  const sigmet = useServerData((d) => d.sigmets?.features.find((f) => f.properties.id === a.sigmet_id)?.properties ?? null);
  const bandFt = evidenceBand(ev);
  const src = bandFt ? evidenceBandSource(ev, sigmet, bandFt.top) : null;
  const confirmations = num(ev.confirmations);
  const distance = num(ev.distance_nm);
  const posAge = num(ev.position_age_s);
  const eta = !live ? null : now ? etaRemainingS(a, now) : a.eta_s ?? null;
  const rows: [string, React.ReactNode][] = [
    ["경보", `${a.fir_id} · ${a.hazard}${a.qualifier ? ` ${a.qualifier}` : ""}`],
    ["SIGMET id", <span key="id" className="mono text-fg-2">{a.sigmet_id}</span>],
    ["고도대", bandFt ? band(bandFt.base, bandFt.top, src, { metric: true }) : "—"],
    [a.kind === "PREDICTED" ? "진입 시 고도(추정)" : "항공기 고도", <span key="alt" className="mono">{fmtAltDual(a.alt_ft)}</span>],
    ["유효시간", <DualRange key="v" a={str(ev.valid_from)} b={str(ev.valid_to)} />],
    ["판정 시각", <DualTime key="j" v={str(ev.judged_at)} />],
    ["방법", str(ev.method) ?? "—"],
  ];
  if (a.kind === "PREDICTED") {
    rows.push(["ETA(추정)", <span key="eta" className="mono">{fmtEta(eta)}</span>]);
    rows.push(["거리", distance == null ? "—" : `${fmtNum(distance, "", 1)} NM`]);
    rows.push(["판정 입력", `${fmtGsDual(num(ev.gs_kt))} · ${fmtNum(num(ev.track_deg), "°")}`]);
    if (ev.vrate_assumed_zero === true) rows.push(["가정", "수직속도 미상 → 0 ft/min 가정"]);
  } else {
    rows.push(["연속 확인", confirmations == null ? "—" : `${confirmations}회`]);
    rows.push(["출처 / 관측", <span key="seen">{str(ev.provider) ?? "—"} · <DualTime v={str(ev.seen_at)} /></span>]);
  }
  if (posAge != null) rows.push(["판정 시 위치 경과", `${fmtNum(posAge, " s", 0)}`]);
  if (a.left_at) rows.push(["종료", <span key="left"><DualTime v={a.left_at} /> · {closeReasonLabel(a.close_reason)}</span>]);
  const assumptions: string[] = [];
  if (src?.base_source === "assumed_surface") assumptions.push("하한 미발표 → 지상(SFC)부터로 가정");
  if (bandFt && (bandFt.top == null || src?.top_source === "unknown")) assumptions.push("상한 미발표 → 무제한으로 가정");
  return (
    <div className="border border-line bg-bg px-2 py-1 text-[11px]" data-testid="evidence">
      <div className="mb-1 flex items-center gap-2">
        <span className="inline-block h-2 w-2" style={{ background: hazardColor(a.hazard) }} />
        <span className="label">{a.kind === "PREDICTED" ? "예상 진입 · 추정" : "관측 · 경보 안"}</span>
        {a.estimated ? <span className="badge est">추정</span> : <span className="badge ok">관측</span>}
      </div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-2 border-t border-line py-0.5"><span className="shrink-0 text-fg-3">{k}</span><span className="text-right">{v}</span></div>
      ))}
      {assumptions.length ? <div className="border-t border-line pt-0.5 text-[10px] text-warn" data-testid="evidence-assumptions">판정 가정: {assumptions.join(" · ")}</div> : null}
    </div>
  );
}
