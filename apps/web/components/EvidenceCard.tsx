"use client";
import type { Alert } from "@/lib/types";
import { band, fmtAltDual, fmtEta, fmtGsDual, fmtNum, hazardColor } from "@/lib/format";
import { alertListState, alertZone, closeReasonLabel, etaRemainingS } from "@/lib/alerts";
import { evidenceBand, evidenceBandSource } from "@/lib/evidence-band";
import { bandText } from "@/lib/airspace";
import { useServerData } from "@/lib/store";
import { useRxFresh, useServerNow } from "@/lib/clock";
import { KstRange, KstTime } from "./KstTime";
import { alertReplayLink } from "@/lib/alert-detail";
import { gapsPart, lagPart, positionPart } from "@/lib/reliability";
import { ReliabilityLine } from "./ReliabilityLine";

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * 근거 카드(11.3절): 어느 경보·고도대·항공기 고도·유효시간·판정 시각·관측/추정·예측이면 ETA·방법.
 * 시각은 KST(계약 v5 §G20 · lib/time — "09-29 14:02:54 KST", title 에 연도 · ms 까지의 KST). 근거에 없는 값은 "—"(기본값으로 채우지 않는다). 판정에 쓴 가정(하한 SFC·상한 무제한·수직속도 0)은 가정이라고 밝힌다.
 * 예측 ETA 는 eta_at 에서 1 s 마다 카운트다운한다(추정). 알림 목록이 갱신되지 않는 동안(끊김·수신 대기·일시정지)은 "—"(DH-9).
 */
export function EvidenceCard({ a, standalone = false }: { a: Alert; standalone?: boolean }) {
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
  const as = a.zone_type === "airspace" ? a.airspace ?? null : null;
  // 공역 알림(계약 v5 §G48): 구역 · 수준 · 고도 범위(기준 그대로) · 기준 차수. SIGMET 알림은 예전 행 그대로
  const rows: [string, React.ReactNode][] = as ? [
    ["공역", `${as.type_ko} · ${as.label}${as.name !== as.label ? ` ${as.name}` : ""}`],
    ["수준", a.level === "info" ? "정보(목록 · 카드에만 — 배너 없음)" : "알림"],
    ["고도 범위", as.lower && as.upper ? bandText({ ft: as.lower.ft ?? null, basis: as.lower.basis, raw: as.lower.raw }, { ft: as.upper.ft ?? null, basis: as.upper.basis, raw: as.upper.raw }).text : "—"],
    [a.kind === "PREDICTED" ? "진입 시 고도(추정)" : "항공기 고도", <span key="alt" className="mono">{fmtAltDual(a.alt_ft)}</span>],
    ["기준 차수", `${str(ev.edition) ?? as.edition} · 국토교통부`],
    ["판정 시각", <KstTime key="j" v={str(ev.judged_at)} />],
    ["방법", str(ev.method) ?? "—"],
  ] : [
    ["경보", `${a.fir_id} · ${a.hazard}${a.qualifier ? ` ${a.qualifier}` : ""}`],
    ["SIGMET id", <span key="id" className="mono text-fg-2">{a.sigmet_id}</span>],
    ["고도대", bandFt ? band(bandFt.base, bandFt.top, src, { metric: true }) : "—"],
    [a.kind === "PREDICTED" ? "진입 시 고도(추정)" : "항공기 고도", <span key="alt" className="mono">{fmtAltDual(a.alt_ft)}</span>],
    ["유효시간", <KstRange key="v" a={str(ev.valid_from)} b={str(ev.valid_to)} />],
    ["판정 시각", <KstTime key="j" v={str(ev.judged_at)} />],
    ["방법", str(ev.method) ?? "—"],
  ];
  if (a.kind === "PREDICTED") {
    rows.push(["ETA(추정)", <span key="eta" className="mono">{fmtEta(eta)}</span>]);
    rows.push(["거리", distance == null ? "—" : `${fmtNum(distance, "", 1)} NM`]);
    rows.push(["판정 입력", `${fmtGsDual(num(ev.gs_kt))} · ${fmtNum(num(ev.track_deg), "°")}`]);
    if (ev.vrate_assumed_zero === true) rows.push(["가정", "수직속도 미상 → 0 ft/min 가정"]);
  } else {
    rows.push(["연속 확인", confirmations == null ? "—" : `${confirmations}회`]);
    rows.push(["출처 / 관측", <span key="seen">{str(ev.provider) ?? "—"} · <KstTime v={str(ev.seen_at)} /></span>]);
  }
  if (posAge != null) rows.push(["판정 시 위치 경과", `${fmtNum(posAge, " s", 0)}`]);
  if (a.left_at) rows.push(["종료", <span key="left"><KstTime v={a.left_at} /> · {closeReasonLabel(a.close_reason)}
    {ev.end_cause === "edition_replaced" ? " · 새 차수에 없음" : ev.end_cause === "judging_off" ? " · 공역 판정을 끔" : ""}</span>]);
  const assumptions: string[] = [];
  if (as) {
    assumptions.push("기압고도(표준 기압)를 해면 고도로 봄 — QNH 보정 없음");
    if (ev.altitude_uncertain === true) assumptions.push("고도 경계 근처(500 ft 안) — 판정 불확실");
  } else {
    if (src?.base_source === "assumed_surface") assumptions.push("하한 미발표 → 지상(SFC)부터로 가정");
    if (bandFt && (bandFt.top == null || src?.top_source === "unknown")) assumptions.push("상한 미발표 → 무제한으로 가정");
  }
  return (
    <div className="border border-line bg-bg px-2 py-1 text-[11px]" data-testid="evidence">
      <div className="mb-1 flex items-center gap-2">
        <span className="inline-block h-2 w-2" style={{ background: as ? alertZone(a).color : hazardColor(a.hazard) }} />
        <span className="label">{a.kind === "PREDICTED" ? "예상 진입 · 추정" : as ? "관측 · 공역 안" : "관측 · 경보 안"}</span>
        {a.estimated ? <span className="badge est">추정</span> : <span className="badge ok">관측</span>}
      </div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-2 border-t border-line py-0.5"><span className="shrink-0 text-fg-3">{k}</span><span className="text-right">{v}</span></div>
      ))}
      {assumptions.length ? <div className="border-t border-line pt-0.5 text-[10px] text-warn" data-testid="evidence-assumptions">판정 가정: {assumptions.join(" · ")}</div> : null}
      {/* 신뢰도 한 줄(SPEC F6) — 판정 때의 값: 위치 나이는 근거에 있고, 공급자 지연 · 수신 공백은 근거에 남기지 않아 모름. 판정 때 위치는 관측 위치다 —
          a.estimated 는 '진입을 예측했다'(PREDICTED)는 뜻이라 '(추정 위치)'를 붙이지 않는다(QA-707) */}
      <div className="-mx-2 mt-0.5 border-t border-line [&>div]:border-b-0"><ReliabilityLine label="판정 때" parts={[positionPart("aircraft", posAge),
        lagPart(null, "공급자 지연 기록 없음"), gapsPart(null, "수신 공백 기록 없음")]} /></div>
      {/* 근거 공유(SPEC F5): 고정 링크(보존 기간 안) · 그 시각 재생 */}
      <div className="flex flex-wrap gap-1 border-t border-line pt-1 print:hidden" data-testid="evidence-links">
        {/* 보통 링크(next/link 아님): 새 화면으로 바로 간다 — 카드 조각에 라우터 코드를 더하지 않는다 */}
        {standalone ? null : <a className="btn" href={`/alerts/${a.id}`} data-testid="evidence-permalink">근거 링크</a>}
        <a className="btn" href={alertReplayLink(a)} data-testid="evidence-replay">그 시각 재생</a>
      </div>
    </div>
  );
}
