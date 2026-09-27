"use client";
import { useMemo, useState } from "react";
import { useServerData } from "@/lib/store";
import { useUi } from "@/lib/ui-store";
import { EvidenceCard } from "./EvidenceCard";
import { fmtAlt, fmtEta, hazardColor } from "@/lib/format";

/** 알림 패널(FR-10): 관측(경보 안)·예측(추정)을 구분해 목록으로. 펼치면 근거 카드. */
export function AlertPanel() {
  const alerts = useServerData((d) => d.alerts);
  const lastEvent = useServerData((d) => d.lastEvent);
  const select = useUi((s) => s.select);
  const [open, setOpen] = useState<number | null>(null);
  const [scope, setScope] = useState<"region" | "world">("region");
  const status = useServerData((d) => d.status);
  const all = useMemo(() => [...alerts.values()], [alerts]);
  // 관심 지역 = 서버 설정의 중심·반경(설정값이 없으면 전체). 항공기 위치는 evidence.position([lat, lon]) 또는 없음 → 전세계 뷰에서만 표시
  const list = useMemo(() => {
    const center = status?.region.center, radius = status?.region.radius_nm;
    const inRegion = (a: (typeof all)[number]) => {
      if (!center || !radius) return true;
      const pos = (a.evidence as { position?: number[] }).position;
      if (!pos) return false;
      const dLat = (pos[0] - center[0]) * 60, dLon = (pos[1] - center[1]) * 60 * Math.cos((center[0] * Math.PI) / 180);
      return Math.hypot(dLat, dLon) <= radius;
    };
    return all.filter((a) => scope === "world" || inRegion(a))
      .sort((a, b) => (a.kind === b.kind ? b.entered_at.localeCompare(a.entered_at) : a.kind === "OBSERVED" ? -1 : 1));
  }, [all, scope, status]);
  const observed = list.filter((a) => a.kind === "OBSERVED").length;
  return (
    <div className="flex h-full flex-col" data-testid="alert-panel">
      <div className="row">
        <span className="label">Alerts</span>
        <div className="flex items-center gap-2">
          <button className="btn" aria-pressed={scope === "region"} onClick={() => setScope("region")} data-testid="alerts-scope-region">관심 지역</button>
          <button className="btn" aria-pressed={scope === "world"} onClick={() => setScope("world")} data-testid="alerts-scope-world">전세계 {all.length}</button>
          <span className="mono text-[11px]"><span className="text-bad">{observed}</span> inside · <span className="text-est">{list.length - observed}</span> predicted</span>
        </div>
      </div>
      {lastEvent ? (
        <div key={lastEvent.at} className="flash border-b border-line px-2 py-1 text-[11px] text-fg-2">
          <span className="label mr-1">{lastEvent.type}</span>{lastEvent.alert.callsign ?? lastEvent.alert.hex} · {lastEvent.alert.hazard} {lastEvent.alert.fir_id}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 ? <div className="p-3 text-[11px] text-fg-3">{scope === "region" ? "관심 지역(중심 " + (status?.region.center?.join(", ") ?? "—") + ", 반경 " + (status?.region.radius_nm ?? "—") + " NM)에서 " : ""}현재 SIGMET 안에 있거나 10분 내 진입이 예상되는 항공기가 없습니다.</div> : null}
        {list.map((a) => (
          <div key={a.id} className="border-b border-line" data-testid="alert-item" data-kind={a.kind}>
            <button className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-bg-2" onClick={() => { setOpen(open === a.id ? null : a.id); select(a.hex); }}>
              <span className="inline-block h-2 w-2 shrink-0" style={{ background: hazardColor(a.hazard) }} />
              <span className="mono w-16 shrink-0 text-[12px]">{a.callsign ?? a.hex}</span>
              <span className="w-14 shrink-0 text-[11px] text-fg-2">{a.hazard}{a.qualifier ? ` ${a.qualifier}` : ""}</span>
              <span className="w-12 shrink-0 text-[11px] text-fg-3">{a.fir_id}</span>
              <span className="mono w-14 shrink-0 text-[11px]">{fmtAlt(a.alt_ft)}</span>
              {a.kind === "PREDICTED" ? <span className="badge est ml-auto">ETA {fmtEta(a.eta_s)}</span> : <span className="badge bad ml-auto">INSIDE</span>}
            </button>
            {open === a.id ? <div className="px-2 pb-2"><EvidenceCard a={a} /></div> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
