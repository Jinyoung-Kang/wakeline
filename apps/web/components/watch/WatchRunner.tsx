"use client";
import { useRef } from "react";
import { fmtKst } from "@/lib/time";
import { useUi } from "@/lib/ui-store";
import { useFocusRescue } from "@/lib/use-focus-rescue";
import { label, type WatchEvent, type WatchTarget } from "@/lib/watch";
import { useWatch } from "@/lib/watch-store";
import { useWatchRunner } from "./useWatchRunner";

export { wsAlert } from "./useWatchRunner";

/**
 * 관심 대상 실행기(SPEC F4 · ADR-037): 첫 화면이 다 그려진 뒤 미리 받기(components/DashboardParts)가 받으면 그때부터 그린다(SidePanel — 받기 전에는 그리지 않아
 *   받기를 앞당기지 않는다). 첫 화면 JS 에 들지 않는다. 조회 · 사건 · 알림은 ./useWatchRunner(상태 · 부수효과), 여기는 배너만 그린다(ADR-029).
 */
export function openTarget(t: WatchTarget): void {
  const ui = useUi.getState();
  if (t.kind === "aircraft") ui.select(t.id);
  else if (t.kind === "ship") ui.selectShip(t.id);
  else ui.selectAirport(t.id);
}

export function WatchRunner({ open = (e: WatchEvent) => openTarget(e.target), openName }: { open?: (e: WatchEvent) => void; openName?: (e: WatchEvent) => string | null } = {}) {
  useWatchRunner(open);
  return <WatchBanner open={open} openName={openName} />;
}

/**
 * 화면 안 배너(늘 — 브라우저 알림을 허락하지 않아도). 닫기 · 여는 단추. 여는 단추의 이름은 하는 일 — openName 이 없으면 "<대상> 카드"(상황판).
 * 단추를 누르면 그 사건이 사라진다 — 초점을 남은 사건의 '닫기' → 본문(#main)으로 옮긴다(QA-801 · lib/focus-rescue).
 */
export function WatchBanner({ open = (e: WatchEvent) => openTarget(e.target), openName }: { open?: (e: WatchEvent) => void; openName?: (e: WatchEvent) => string | null } = {}) {
  const banner = useWatch((s) => s.banner);
  const dismiss = useWatch((s) => s.dismiss);
  const root = useRef<HTMLDivElement>(null);
  const rescue = useFocusRescue();
  const close = (key: string) => {
    rescue(() => [root.current?.querySelectorAll<HTMLElement>("[data-watch-close]")[0], typeof document !== "undefined" ? document.getElementById?.("main") : null]);
    dismiss(key);
  };
  if (!banner.length) return null;
  return (
    <div ref={root} role="status" aria-live="polite" aria-label="관심 대상 알림" className="fixed bottom-14 left-2 z-50 flex w-[min(360px,calc(100vw-16px))] flex-col gap-1" data-testid="watch-banner">
      {banner.map((e) => {
        const name = openName ? openName(e) : `${label(e.target)} 카드`;
        return (
        <div key={e.key} className={`border bg-bg-1 px-2 py-1.5 text-[11px] shadow ${e.tone === "alert" ? "border-[#e5484d]" : "border-line"}`} data-testid="watch-event">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-fg-1">{e.title}</span>
            <span className="ml-auto mono text-fg-3">{fmtKst(e.at)}</span>
          </div>
          <div className="text-fg-2">{e.body}</div>
          <div className="mt-1 flex gap-1">
            {name ? <button className="btn" onClick={() => { open(e); close(e.key); }}>{name}</button> : null}
            <button className="btn" onClick={() => close(e.key)} aria-label={`${e.title} 알림 닫기`} data-watch-close>닫기</button>
          </div>
        </div>
        );
      })}
    </div>
  );
}
