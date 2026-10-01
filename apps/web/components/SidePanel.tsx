"use client";
import { AlertPanel } from "./AlertPanel";
import { AircraftCardPart, AirportCardPart, AirportListPart, ShipPanelPart, SigmetCardPart, SigmetListPart } from "./DashboardParts";
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
 * 알림 목록은 다른 탭을 보는 동안에도 숨긴 채 남겨 둔다(R-08) — 항공기를 골라도 펼친 근거·스크롤·범위 선택이 사라지지 않는다. 숨긴 동안은 다시 그리지 않는다
 * (AlertPanel active — React Activity).
 * 알림 밖의 탭 내용(카드 · 목록)은 처음 열 때 받는다(DashboardParts — 첫 화면 JS 에서 뺐다, ADR-026). 받는 동안 진행 표시 · 실패하면 다시 시도.
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
        <div className="h-full" hidden={panel !== "alerts"}><AlertPanel active={panel === "alerts"} /></div>
        {panel === "aircraft" ? (hex ? <AircraftCardPart hex={hex} /> : <div className="p-3 text-[11px] text-fg-3">지도에서 항공기를 클릭하거나, 상단 검색(/ 키)·알림 목록에서 고르세요.</div>) : null}
        {panel === "ship" ? <ShipPanelPart /> : null}
        {/* 선택이 없으면 목록 — 지도 클릭 없이 키보드로 고른다(R-40) */}
        {panel === "sigmet" ? (sigmet ? <SigmetCardPart id={sigmet} /> : <SigmetListPart />) : null}
        {panel === "airport" ? (airport ? <AirportCardPart icao={airport} /> : <AirportListPart />) : null}
      </div>
    </>
  );
}
