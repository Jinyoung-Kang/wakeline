"use client";
import { useState } from "react";
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
  const list = [...alerts.values()].sort((a, b) => (a.kind === b.kind ? b.entered_at.localeCompare(a.entered_at) : a.kind === "OBSERVED" ? -1 : 1));
  const observed = list.filter((a) => a.kind === "OBSERVED").length;
  return (
    <div className="flex h-full flex-col" data-testid="alert-panel">
      <div className="row">
        <span className="label">Alerts</span>
        <span className="mono text-[11px]"><span className="text-bad">{observed}</span> inside · <span className="text-est">{list.length - observed}</span> predicted</span>
      </div>
      {lastEvent ? (
        <div key={lastEvent.at} className="flash border-b border-line px-2 py-1 text-[11px] text-fg-2">
          <span className="label mr-1">{lastEvent.type}</span>{lastEvent.alert.callsign ?? lastEvent.alert.hex} · {lastEvent.alert.hazard} {lastEvent.alert.fir_id}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 ? <div className="p-3 text-[11px] text-fg-3">현재 SIGMET 안에 있거나 10분 내 진입이 예상되는 항공기가 없습니다.</div> : null}
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
