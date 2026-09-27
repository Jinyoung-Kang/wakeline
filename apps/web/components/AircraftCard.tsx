"use client";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { aircraftStates, useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { useNow } from "@/lib/clock";
import { predict, seenAtMs } from "@/lib/interpolate";
import type { AircraftState, Alert, PredictionReason } from "@/lib/types";
import { fmtAlt, fmtBool, fmtDuration, fmtIso, fmtNum, fmtTime } from "@/lib/format";
import { EvidenceCard } from "./EvidenceCard";

interface Detail {
  hex: string;
  state: AircraftState | null;
  static: { registration?: string | null; type_code?: string | null; category?: string | null; first_seen?: string | null; last_seen?: string | null } | null;
  active_alerts?: Alert[];
  inside_sigmets?: string[];
  emergency?: boolean;
  meta?: { provider?: string | null; fetched_at?: string | null; lag_s?: number | null; stale?: boolean; db_unavailable?: boolean };
}

/** 등록 정보(static)·SIGMET 포함 여부 등 REST 상세 갱신 주기. 위치·속도는 WS selected 스트림이 실시간으로 준다. */
const DETAIL_REFRESH_MS = 30_000;
const EMERGENCY_SQUAWKS: ReadonlySet<string> = new Set(["7500", "7600", "7700"]);
const REASON_LABEL: Record<PredictionReason, string> = {
  turning: "선회 중(최근 트랙 변화 > 15°)", slow: "저속", on_ground: "지상", no_track: "속도/방위 없음", stale: "수신 지연",
};

/** 관측 시각(seen_at)이 더 새로운 상태. 같거나 비교할 수 없으면 앞의 것(REST full). */
function newerState(a: AircraftState | null, b: AircraftState | null): AircraftState | null {
  if (!a || !b) return a ?? b;
  const ta = seenAtMs(a.seen_at), tb = seenAtMs(b.seen_at);
  return tb != null && (ta == null || tb > ta) ? b : a;
}

function qualityLabel(q: number | null | undefined) {
  if (q == null) return "—";
  if (q === 0) return "0 · 통과";
  if (q === 1) return "1 · 경고(속도/방위 없음 → 보간 안 함)";
  return String(q);
}

/** 항공기 상세(FR-05): 호출부호·등록·기종·고도·속도·수직속도·squawk·출처·수신 시각. 값이 없으면 "—"(기본값으로 채우지 않는다). */
export function AircraftCard({ hex }: { hex: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<{ hex: string; msg: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const select = useUi((s) => s.select);
  const selected = useServerData((x) => (x.selected && x.selected.hex === hex ? x.selected : null));
  const alertsMap = useServerData((x) => x.alerts);
  const now = useNow(1000);
  useEffect(() => {
    const t = setInterval(() => setRefresh((n) => n + 1), DETAIL_REFRESH_MS);
    return () => clearInterval(t);
  }, [hex]);
  useEffect(() => {
    let live = true;
    apiGet<Detail>(`/api/v1/aircraft/${encodeURIComponent(hex)}`)
      .then((x) => { if (live) { setDetail(x); setError(null); } })
      .catch((e: Error) => { if (live) setError({ hex, msg: String(e.message) }); });
    return () => { live = false; };
  }, [hex, refresh]);
  // 다른 항공기로 바뀐 직후 이전 응답을 보여주지 않는다
  const d = detail && detail.hex?.toLowerCase() === hex.toLowerCase() ? detail : null;
  const err = error && error.hex === hex ? error.msg : null;
  // 상태: WS selected(변할 때마다 오는 full 상태)가 있으면 그것. selected.state=null 이면 스냅샷에 더 이상 없다.
  // 아직 selected 가 없으면 REST 상세와 지도 스냅샷 사본 중 관측 시각이 더 새로운 것.
  const s: AircraftState | null = selected ? selected.state : newerState(d?.state ?? null, aircraftStates.get(hex) ?? null);
  const gone = selected != null && selected.state == null;
  const r = s && now ? predict(s, now) : null;
  const age = r?.age_s == null ? null : Math.round(r.age_s);
  const seen = seenAtMs(s?.seen_at);
  const emergency = s?.squawk != null ? EMERGENCY_SQUAWKS.has(s.squawk) : d?.emergency === true;
  const activeAlerts = useMemo(() => [...alertsMap.values()].filter((a) => a.hex === hex), [alertsMap, hex]);
  const pred = selected?.prediction ?? null;
  const rows: [string, React.ReactNode][] = [
    ["Callsign", <span key="cs" className="mono">{s?.callsign ?? "—"}</span>],
    ["ICAO24", <span key="hex" className="mono">{hex}</span>],
    ["등록번호", <span key="reg" className="mono">{d?.static?.registration ?? s?.registration ?? "—"}</span>],
    ["기종 코드", <span key="type" className="mono">{d?.static?.type_code ?? s?.type_code ?? "—"}</span>],
    ["카테고리", d?.static?.category ?? s?.category ?? "—"],
    ["고도", <span key="alt" className="mono">{fmtAlt(s?.alt_ft)}</span>],
    ["지상속도", <span key="gs" className="mono">{fmtNum(s?.gs_kt, " kt")}</span>],
    ["방위", <span key="trk" className="mono">{fmtNum(s?.track_deg, "°")}</span>],
    ["수직속도", <span key="vr" className="mono">{fmtNum(s?.vrate_fpm, " ft/min")}</span>],
    ["Squawk", <span key="sq" className={`mono ${emergency ? "text-bad" : ""}`}>{s?.squawk ?? "—"}{emergency ? " EMERGENCY" : ""}</span>],
    ["지상", fmtBool(s?.on_ground)],
    ["출처", s?.provider ?? "—"],
    ["관측 시각", <span key="seen" className="mono" title={fmtIso(seen)}>{fmtTime(seen)}{age != null ? ` (${fmtDuration(age)} 전)` : ""}</span>],
    ["수신 시각", <span key="fetched" className="mono">{fmtTime(s?.fetched_at ?? d?.meta?.fetched_at)}</span>],
    ["품질", qualityLabel(s?.quality)],
    ["10분 예측", pred == null ? "—" : pred.available ? "가능 · 지도 점선(추정)" : `안 함 · ${pred.reason ? REASON_LABEL[pred.reason] : "—"}`],
  ];
  return (
    <div className="flex h-full flex-col" data-testid="aircraft-card">
      <div className="row">
        <span className="label">Aircraft</span>
        <div className="flex items-center gap-2">
          {gone ? <span className="badge warn" data-testid="aircraft-gone">스냅샷에 없음 · 수신 중단</span> : null}
          {r?.estimated ? <span className="badge est">{r.capped ? "위치 추정 상한 도달 · STALE" : "지도 위치 추정 · dead reckoning"}</span> : null}
          {r && r.stale && !r.capped ? <span className="badge warn">STALE · 수신 지연</span> : null}
          <button className="btn" onClick={() => select(null)}>닫기</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1 text-[12px]">
        {err ? <div className="text-[11px] text-bad" data-testid="aircraft-detail-error">상세(REST) 조회 실패 — 마지막으로 받은 값만 표시 ({err})</div> : null}
        {d?.meta?.db_unavailable ? <div className="text-[11px] text-warn">등록 정보 DB 일시 사용 불가 — 등록번호·기종은 “—”</div> : null}
        {rows.map(([k, val]) => (
          <div key={k} className="flex justify-between gap-2 border-b border-line py-1"><span className="text-fg-3">{k}</span><span className="text-right">{val}</span></div>
        ))}
        {activeAlerts.length ? (
          <div className="mt-2 space-y-1">
            <div className="label">Active alerts</div>
            {activeAlerts.map((a) => <EvidenceCard key={a.id} a={a} />)}
          </div>
        ) : <div className="mt-2 text-[11px] text-fg-3">활성 알림 없음</div>}
        <div className="mt-2 text-[10px] text-fg-3">항적 선은 DB 기록(최근 2 h)에 실시간 관측을 이어 붙인 것이고, 점선 궤적은 서버가 예측 가능하다고 판단할 때만 그리는 10분 dead reckoning 추정입니다.</div>
      </div>
    </div>
  );
}
