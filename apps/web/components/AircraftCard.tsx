"use client";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { aircraftStates, useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import type { AircraftState, Alert } from "@/lib/types";
import { fmtAlt, fmtNum, fmtTime } from "@/lib/format";
import { EvidenceCard } from "./EvidenceCard";

interface Detail {
  hex: string;
  state: AircraftState | null;
  static: { registration?: string; type_code?: string; category?: string; first_seen?: string; last_seen?: string } | null;
  active_alerts: Alert[];
  inside_sigmets: string[];
  emergency: boolean;
  meta: { provider: string; fetched_at: string | null; lag_s: number | null; stale: boolean };
}

/** 항공기 상세(FR-05): 호출부호·등록·기종·고도·속도·수직속도·squawk·출처·수신 시각. 값이 없으면 "—". */
export function AircraftCard({ hex }: { hex: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const v = useServerData((s) => s.snapshotVersion);
  const select = useUi((s) => s.select);
  const [now, setNow] = useState(0);
  useEffect(() => { const tick = () => setNow(Date.now()); const t = setInterval(tick, 1000); const raf = requestAnimationFrame(tick); return () => { clearInterval(t); cancelAnimationFrame(raf); }; }, []);
  useEffect(() => {
    let live = true;
    apiGet<Detail>(`/api/v1/aircraft/${hex}`).then((x) => live && setD(x)).catch((e) => live && setErr(String(e.message)));
    return () => { live = false; };
  }, [hex, v]);
  const s = d?.state ?? aircraftStates.get(hex) ?? null;
  const age = s?.seen_at ? Math.max(0, Math.round((now - Date.parse(s.seen_at)) / 1000)) : null;
  const rows: [string, React.ReactNode][] = [
    ["Callsign", <span key="cs" className="mono">{s?.callsign ?? "—"}</span>],
    ["ICAO24", <span key="hex" className="mono">{hex}</span>],
    ["등록번호", d?.static?.registration ?? s?.registration ?? "—"],
    ["기종 코드", d?.static?.type_code ?? s?.type_code ?? "—"],
    ["카테고리", d?.static?.category ?? s?.category ?? "—"],
    ["고도", fmtAlt(s?.alt_ft)],
    ["지상속도", fmtNum(s?.gs_kt, " kt")],
    ["방위", fmtNum(s?.track_deg, "°")],
    ["수직속도", fmtNum(s?.vrate_fpm, " ft/min")],
    ["Squawk", <span key="sq" className={`mono ${d?.emergency ? "text-bad" : ""}`}>{s?.squawk ?? "—"}{d?.emergency ? " EMERGENCY" : ""}</span>],
    ["지상", s?.on_ground ? "yes" : "no"],
    ["출처", s?.provider ?? d?.meta.provider ?? "—"],
    ["관측 시각", `${fmtTime(s?.seen_at)}${age != null ? ` (${age}s 전)` : ""}`],
    ["수신 시각", fmtTime(s?.fetched_at ?? d?.meta.fetched_at)],
    ["품질", s?.quality === 1 ? "1 · 경고(속도/방위 없음 → 보간 안 함)" : "0 · 통과"],
  ];
  return (
    <div className="flex h-full flex-col" data-testid="aircraft-card">
      <div className="row">
        <span className="label">Aircraft</span>
        <div className="flex items-center gap-2">
          {age != null && age > 0 ? <span className="badge est">지도 위치 추정 · dead reckoning</span> : null}
          <button className="btn" onClick={() => select(null)}>닫기</button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1 text-[12px]">
        {err ? <div className="text-bad">{err}</div> : null}
        {rows.map(([k, val]) => (
          <div key={k} className="flex justify-between gap-2 border-b border-line py-1"><span className="text-fg-3">{k}</span><span className="text-right">{val}</span></div>
        ))}
        {d?.active_alerts?.length ? (
          <div className="mt-2 space-y-1">
            <div className="label">Active alerts</div>
            {d.active_alerts.map((a) => <EvidenceCard key={a.id} a={a} />)}
          </div>
        ) : <div className="mt-2 text-[11px] text-fg-3">활성 알림 없음</div>}
        <div className="mt-2 text-[10px] text-fg-3">항적 선(최근 2 h)은 DB 기록, 점선 궤적은 10분 dead reckoning 추정입니다.</div>
      </div>
    </div>
  );
}
