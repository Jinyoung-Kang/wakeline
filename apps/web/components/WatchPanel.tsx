"use client";
import { useRef } from "react";
import { requestNotify } from "@/lib/notify";
import { useFocusRescue } from "@/lib/use-focus-rescue";
import { fmtKstMinute } from "@/lib/time";
import { label, SHIP_LOST_S, WATCH_MAX, type WatchState, type WatchTarget } from "@/lib/watch";
import { useWatch } from "@/lib/watch-store";
import { openTarget } from "./watch/WatchRunner";

export { WatchRunner } from "./watch/WatchRunner";

const PERMISSION_TEXT = {
  granted: "브라우저 알림 켜짐 — 탭이 숨어 있어도 30초마다 확인합니다(관심 대상이 있을 때만)",
  denied: "브라우저 알림이 막혀 있음 — 화면 안 배너만(브라우저 설정에서 이 사이트 알림을 허용하면 켜집니다)",
  default: "브라우저 알림 꺼짐 — 화면 안 배너만",
  unsupported: "이 브라우저는 알림을 지원하지 않음 — 화면 안 배너만",
} as const;

/**
 * 관심 탭(SPEC F4-1 · F4-6 · ADR-037) — 목록 · 지금 상태 · 지우기 · 알림 허락 단추 · 한계. 탭을 볼 때 받는 조각. 조회는 실행기(components/watch/WatchRunner)가 한다.
 */
export function WatchPanel() {
  const targets = useWatch((s) => s.targets);
  const storage = useWatch((s) => s.storage);
  const state = useWatch((s) => s.state);
  const error = useWatch((s) => s.error);
  const checkedAt = useWatch((s) => s.checkedAt);
  const permission = useWatch((s) => s.permission);
  const remove = useWatch((s) => s.remove);
  const setPermission = useWatch((s) => s.setPermission);
  // '지우기'는 누른 줄을 없앤다 — 초점을 같은 자리의 다음 줄 '지우기'(없으면 앞 줄) → 이 탭으로 옮긴다(QA-801 · lib/focus-rescue)
  const root = useRef<HTMLDivElement>(null);
  const rescue = useFocusRescue();
  const removeAt = (t: WatchTarget, i: number) => {
    rescue(() => { const b = root.current?.querySelectorAll<HTMLElement>("[data-watch-remove]") ?? []; return [b[i], b[i - 1], root.current]; });
    remove(t);
  };
  return (
    <div ref={root} tabIndex={-1} className="flex h-full flex-col text-[11px] outline-none" data-testid="watch-panel">
      <div className="row"><span className="label">Watchlist</span><span className="text-fg-3">{targets.length}/{WATCH_MAX} · 이 브라우저에만</span></div>
      {storage === "unavailable" ? <div className="border-b border-line px-2.5 py-1 text-warn" role="status">이 브라우저에 저장할 수 없음 — 이번 접속 동안만 유지합니다</div> : null}
      {storage === "corrupt" ? <div className="border-b border-line px-2.5 py-1 text-warn" role="status">저장된 목록 일부가 깨져 버렸습니다</div> : null}
      <div className="flex items-center gap-2 border-b border-line px-2.5 py-1">
        <span className={permission === "granted" ? "text-fg-2" : "text-fg-3"} data-testid="watch-permission">{PERMISSION_TEXT[permission]}</span>
        {permission === "default" ? <button className="btn ml-auto shrink-0" onClick={() => void requestNotify().then(setPermission)}>알림 켜기</button> : null}
      </div>
      <div className="border-b border-line px-2.5 py-1 text-fg-3" role="status" aria-live="polite" data-testid="watch-status">
        {!targets.length ? "관심 대상이 없습니다 — 항공기 · 선박 · 공항 카드의 '관심 대상' 단추로 더합니다."
          : error ? `조회 실패 — ${error}` : checkedAt ? `확인 ${fmtKstMinute(checkedAt)} · 30초마다` : "확인 중…"}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {targets.map((t, i) => (
          <li key={`${t.kind}:${t.id}`} className="flex items-center gap-2 border-b border-line px-2 py-1" data-testid="watch-item" data-id={t.id}>
            <button className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => openTarget(t)}>{label(t)}</button>
            <span className="shrink-0 text-fg-3">{statusOf(t, state)}</span>
            <button className="btn shrink-0" onClick={() => removeAt(t, i)} aria-label={`${label(t)} 관심 해제`} data-watch-remove>지우기</button>
          </li>
        ))}
      </ul>
      <div className="px-2 py-1 text-[10px] text-fg-3">
        지금 받는 범위(관심 지역 · 전세계 120초 · 핫 리전) 밖의 대상은 판정되지 않습니다 — 관심 대상이라고 집중 추적을 자동으로 잡지 않습니다(공급자 예산).
        같은 사건은 한 번만, 10분 안에는 되풀이하지 않습니다.
      </div>
    </div>
  );
}

/** 목록 줄의 짧은 상태 — 답이 없으면 "—" */
export function statusOf(t: WatchTarget, s: WatchState | null): string {
  if (!s) return "—";
  if (t.kind === "aircraft") {
    const a = s.aircraft.find((x) => x.hex === t.id);
    if (!a) return "—";
    if (!a.found) return "지금 받지 못함";
    const open = a.open_alerts.length;
    return `${open ? `알림 ${open}건 · ` : ""}관측 ${fmtKstMinute(a.seen_at ?? null)}`;
  }
  if (t.kind === "ship") {
    const x = s.ships.find((y) => y.mmsi === t.id);
    if (!x) return "—";
    if (!x.found || (x.age_s ?? 0) >= SHIP_LOST_S) return "30분 넘게 위치 없음";
    return `위치 ${Math.round((x.age_s ?? 0) / 60)}분 전`;
  }
  const a = s.airports.find((y) => y.icao === t.id);
  if (!a) return "—";
  if (!a.found) return "공항 목록에 없음";
  return `${a.flight_cat ?? "등급 모름"}${a.stale ? " (관측 2시간 넘음)" : ""}`;
}
