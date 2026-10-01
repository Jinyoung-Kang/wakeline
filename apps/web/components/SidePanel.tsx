"use client";
import { useEffect, useRef } from "react";
import { AlertPanel } from "./AlertPanel";
import { AircraftCardPart, AirportCardPart, AirportListPart, ShipPanelPart, SigmetCardPart, SigmetListPart } from "./DashboardParts";
import { isAttached, isShown, rescueFocus } from "@/lib/focus-rescue";
import { useUi, type UiPanel } from "@/lib/ui-store";

/** 상황판 오른쪽 패널(탭 + 내용) */
export function SidePanel() {
  const panel = useUi((s) => s.panel);
  const hex = useUi((s) => s.selectedHex);
  const sigmet = useUi((s) => s.selectedSigmet);
  const airport = useUi((s) => s.selectedAirport);
  const ship = useUi((s) => s.selectedShip);
  const shipsOn = useUi((s) => s.layers.ships);
  return <SidePanelView panel={panel} hex={hex} sigmet={sigmet} airport={airport} ship={ship} shipsOn={shipsOn} />;
}

const PANEL_NAME: Record<UiPanel, string> = { alerts: "알림", aircraft: "항공기", ship: "선박", sigmet: "SIGMET", airport: "공항" };
/** 카드를 닫은 뒤 돌아갈 목록 줄(그 탭의 목록에서 닫은 항목): [목록 줄의 data-testid, 항목 id 를 단 속성] */
const LIST_ITEM: Partial<Record<UiPanel, readonly [string, string]>> = {
  sigmet: ["sigmet-list-item", "data-id"], airport: ["airport-list-item", "data-icao"], ship: ["ship-list-item", "data-mmsi"],
};
/** 닫은 항목의 목록 줄 — 줄 자체가 단추가 아니면(선박 표의 tr) 그 안의 첫 단추 */
function listItemOf(root: HTMLElement | null, panel: UiPanel, id: string | null): Element | null {
  const spec = LIST_ITEM[panel];
  if (!root || !spec || !id) return null;
  const row = [...root.querySelectorAll(`[data-testid="${spec[0]}"]`)].find((e) => e.getAttribute(spec[1]) === id) ?? null;
  return row && row.tagName !== "BUTTON" ? row.querySelector?.("button") ?? row : row;
}

/**
 * 표시 부분(선택·탭을 인자로 — 서버 렌더 시험용).
 * 알림 목록은 다른 탭을 보는 동안에도 숨긴 채 남겨 둔다(R-08) — 항공기를 골라도 펼친 근거·스크롤·범위 선택이 사라지지 않는다. 숨긴 동안은 다시 그리지 않는다
 * (AlertPanel active — React Activity).
 * 알림 밖의 탭 내용(카드 · 목록)은 처음 열 때 받는다(DashboardParts — 첫 화면 JS 에서 뺐다, ADR-026). 받는 동안 진행 표시 · 실패하면 다시 시도.
 * 키보드 초점(WCAG 2.4.3 — QA-304): 내용이 바뀌어(목록에서 카드 열기 · 카드 '닫기' · 알림 근거의 '항공기 카드' · '선박 켜기') 누른 단추가 사라지거나 숨겨지면
 * 초점이 body 로 떨어졌다. 그때만(lib/focus-rescue) — 카드를 열면 내용 영역으로, 닫으면 연 자리(아직 보이면) → 닫은 항목의 목록 줄 → 내용 영역으로 옮긴다.
 * 검색 · 지도에서 고르면 초점이 거기 남아 있으므로 옮기지 않는다(닫을 때 그 자리로 돌아간다).
 */
export function SidePanelView({ panel, hex, sigmet, airport, ship = null, shipsOn = false }: {
  panel: UiPanel; hex: string | null; sigmet: string | null; airport: string | null; ship?: string | null; shipsOn?: boolean;
}) {
  const setPanel = useUi((s) => s.setPanel);
  const id = panel === "aircraft" ? hex : panel === "sigmet" ? sigmet : panel === "airport" ? airport : panel === "ship" ? ship : null;
  const key = `${panel}:${id ?? ""}${panel === "ship" ? `:${shipsOn}` : ""}`;
  const content = useRef<HTMLDivElement>(null);
  /** 내용 안에서 마지막으로 초점을 받은 요소(누른 목록 줄 · 알림의 단추 — 바뀐 뒤에는 사라지거나 숨겨져 있다) */
  const lastFocus = useRef<Element | null>(null);
  /** 카드를 연 자리(검색 입력 · 지도 · 알림의 단추 · 목록 줄) — 닫을 때 돌아간다 */
  const opener = useRef<Element | null>(null);
  const shown = useRef<{ key: string; panel: UiPanel; id: string | null } | null>(null);
  useEffect(() => {
    const before = shown.current;
    shown.current = { key, panel, id };
    if (!before || before.key === key) return;
    if (id) { // 카드를 염 — 연 자리: 지금 초점(검색 입력 · 지도 · 숨겨진 알림 단추), 이미 body 로 떨어졌으면 내용 안에서 마지막으로 초점을 받은 요소(누른 목록 줄)
      const a = document.activeElement;
      opener.current = a && a !== document.body && isAttached(a) ? a : lastFocus.current;
      rescueFocus(content.current);
      return;
    }
    const item = () => listItemOf(content.current, before.panel, before.id);
    const moved = rescueFocus(opener.current, item(), content.current);
    opener.current = null;
    if (!before.id || !LIST_ITEM[before.panel] || moved !== content.current) return;
    // 목록을 다시 받는 중(공항 목록 등): 받은 뒤 닫은 항목의 줄로 — 그동안 초점이 내용 영역에 그대로 있을 때만(3 s 까지)
    let n = 0;
    const t = setInterval(() => {
      const el = item();
      if (document.activeElement !== content.current || ++n > 30) clearInterval(t);
      else if (isShown(el)) { el.focus(); clearInterval(t); }
    }, 100);
    return () => clearInterval(t);
  }, [key, panel, id]);
  return (
    <>
      <div className="flex border-b border-line">
        {(["alerts", "aircraft", "ship", "sigmet", "airport"] as const).map((p) => (
          <button key={p} className="btn flex-1 border-0 border-r border-line" aria-pressed={panel === p} onClick={() => setPanel(p)} data-testid={`tab-${p}`}>{p}</button>
        ))}
      </div>
      <div ref={content} className="min-h-0 flex-1 focus-visible:-outline-offset-2" role="region" aria-label={`${PANEL_NAME[panel]}${id ? " 상세" : ""}`} tabIndex={-1}
        onFocus={(e) => { lastFocus.current = e.target; }} data-testid="side-panel-content">
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
