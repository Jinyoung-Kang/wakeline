"use client";
import { AlertPanel } from "./AlertPanel";
import { AircraftCard } from "./AircraftCard";
import { AirportCard } from "./AirportCard";
import { ShipPanel } from "./ShipCard";
import { SigmetCard } from "./SigmetCard";
import { useUi, type UiPanel } from "@/lib/ui-store";

/** 상황판 오른쪽 패널(탭 + 내용) */
export function SidePanel() {
  const panel = useUi((s) => s.panel);
  const hex = useUi((s) => s.selectedHex);
  const sigmet = useUi((s) => s.selectedSigmet);
  const airport = useUi((s) => s.selectedAirport);
  return <SidePanelView panel={panel} hex={hex} sigmet={sigmet} airport={airport} />;
}

/**
 * 표시 부분(선택·탭을 인자로 — 서버 렌더 시험용).
 * 알림 목록은 다른 탭을 보는 동안에도 숨긴 채 남겨 둔다(R-08) — 항공기를 골라도 펼친 근거·스크롤·범위 선택이 사라지지 않는다.
 */
export function SidePanelView({ panel, hex, sigmet, airport }: { panel: UiPanel; hex: string | null; sigmet: string | null; airport: string | null }) {
  const setPanel = useUi((s) => s.setPanel);
  return (
    <>
      <div className="flex border-b border-line">
        {(["alerts", "aircraft", "ship", "sigmet", "airport"] as const).map((p) => (
          <button key={p} className="btn flex-1 border-0 border-r border-line" aria-pressed={panel === p} onClick={() => setPanel(p)} data-testid={`tab-${p}`}>{p}</button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <div className="h-full" hidden={panel !== "alerts"}><AlertPanel /></div>
        {panel === "aircraft" ? (hex ? <AircraftCard hex={hex} /> : <div className="p-3 text-[11px] text-fg-3">지도에서 항공기를 클릭하세요.</div>) : null}
        {panel === "ship" ? <ShipPanel /> : null}
        {panel === "sigmet" ? (sigmet ? <SigmetCard id={sigmet} /> : <div className="p-3 text-[11px] text-fg-3">지도에서 SIGMET 폴리곤을 클릭하세요.</div>) : null}
        {panel === "airport" ? (airport ? <AirportCard icao={airport} /> : <div className="p-3 text-[11px] text-fg-3">지도에서 공항을 클릭하세요(줌 6 이상).</div>) : null}
      </div>
    </>
  );
}
