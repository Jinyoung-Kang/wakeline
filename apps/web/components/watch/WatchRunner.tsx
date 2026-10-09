"use client";
import { useEffect, useRef, useState } from "react";
import { watchNow } from "@/lib/endpoints/watch";
import { errorLine } from "@/lib/api";
import { showNotification } from "@/lib/notify";
import { getData, subscribeData } from "@/lib/store";
import { fmtKst } from "@/lib/time";
import { useUi } from "@/lib/ui-store";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { diffWatch, label, openEvent, pollWhileHidden, suppress, WATCH_POLL_MS, type WatchAlert, type WatchEvent, type WatchState, type WatchTarget } from "@/lib/watch";
import { useWatch } from "@/lib/watch-store";
import type { Alert } from "@/lib/types";

/**
 * 관심 대상 실행기(SPEC F4 · ADR-037): 첫 화면이 다 그려진 뒤 미리 받기(components/DashboardParts)가 받으면 그때부터 그린다(SidePanel — 받기 전에는 그리지 않아
 *   받기를 앞당기지 않는다). 첫 화면 JS 에 들지 않는다.
 * - 조회: 보이는 동안 30 s 마다(useVisibleInterval) + 목록이 바뀌면 곧바로. 숨은 탭은 멈추되, 하나뿐인 예외(lib/watch pollWhileHidden — 관심 대상이 있고
 *   알림을 허락함)일 때만 숨은 동안에도 30 s 에 한 번.
 * - WS 알림(이미 모두 받는다): 관심 항공기에 새 알림 id 가 오면 곧바로 사건(조회와 같은 열쇠 — 두 번 알리지 않는다). 시작할 때 있던 알림은 기준.
 * - 사건 → 억제(같은 열쇠 한 번 · 10분 반복 없음) → 화면 배너(늘) + 브라우저 알림(허락했을 때만). 누르면 그 대상의 카드.
 */
export function openTarget(t: WatchTarget): void {
  const ui = useUi.getState();
  if (t.kind === "aircraft") ui.select(t.id);
  else if (t.kind === "ship") ui.selectShip(t.id);
  else ui.selectAirport(t.id);
}

/** WS 알림 → 조회 답과 같은 모양의 요약 */
export function wsAlert(a: Alert): WatchAlert {
  return {
    id: a.id, kind: a.kind, zone_type: a.zone_type ?? "sigmet", entered_at: a.entered_at,
    ...(a.level ? { level: a.level } : {}), ...(a.sigmet_id ? { sigmet_id: a.sigmet_id } : {}), ...(a.hazard ? { hazard: a.hazard } : {}),
    ...(a.airspace ? { zone_name: a.airspace.label } : {}), ...(a.eta_at ? { eta_at: a.eta_at } : {}),
  };
}

export function WatchRunner() {
  const targets = useWatch((s) => s.targets);
  const permission = useWatch((s) => s.permission);
  const prev = useRef<WatchState | null>(null);
  const fired = useRef(new Map<string, number>());
  const seenAlerts = useRef<Set<number> | null>(null);
  const busy = useRef(false);
  const [hidden, setHidden] = useState(false);

  const fire = (evs: readonly WatchEvent[]) => {
    const now = Date.now();
    const r = suppress(evs, fired.current, now);
    fired.current = r.fired;
    if (!r.pass.length) return;
    useWatch.getState().pushEvents(r.pass, now);
    for (const e of r.pass) showNotification(e.title, e.body, e.key, () => openTarget(e.target));
  };

  const poll = () => {
    const list = useWatch.getState().targets;
    if (!list.length || busy.current) return;
    busy.current = true;
    watchNow(list).then((next) => {
      if (!next) { useWatch.getState().setResult(null, "답의 모양이 틀림", Date.now()); return; }
      fire(diffWatch(prev.current, next, useWatch.getState().targets));
      prev.current = next;
      useWatch.getState().setResult(next, null, Date.now());
    }, (e: unknown) => useWatch.getState().setResult(null, errorLine(e), Date.now())).finally(() => { busy.current = false; });
  };

  useVisibleInterval(poll, targets.length ? WATCH_POLL_MS : null);
  // 목록이 바뀌면 곧바로 한 번(새 대상의 기준) — 숨은 탭이면 다음에 보일 때
  const key = targets.map((t) => `${t.kind}:${t.id}`).join(",");
  useEffect(() => { if (key && !document.hidden) poll(); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- poll 은 저장소에서 지금 값을 읽는다

  useEffect(() => {
    const on = () => setHidden(document.hidden);
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  // 숨은 탭 예외(ADR-037) — 조건이 풀리면(목록 비움 · 허락 취소 · 다시 보임) 곧바로 멈춘다
  const hiddenPoll = hidden && pollWhileHidden(targets.length, permission);
  useEffect(() => {
    if (!hiddenPoll) return;
    const t = setInterval(() => { if (document.hidden) poll(); }, WATCH_POLL_MS);
    return () => clearInterval(t);
  }, [hiddenPoll]); // eslint-disable-line react-hooks/exhaustive-deps -- 위와 같다

  // WS 알림: 새 알림 id 만(시작할 때 있던 것은 기준)
  useEffect(() => {
    const check = () => {
      const all = getData().alerts;
      if (!seenAlerts.current) { seenAlerts.current = new Set(all.keys()); return; }
      const list = useWatch.getState().targets;
      const evs: WatchEvent[] = [];
      for (const [id, a] of all) {
        if (seenAlerts.current.has(id)) continue;
        seenAlerts.current.add(id);
        const t = list.find((x) => x.kind === "aircraft" && x.id === a.hex);
        if (t && !a.left_at) evs.push(openEvent(t, wsAlert(a)));
      }
      if (evs.length) fire(evs);
    };
    check();
    return subscribeData(check);
  }, []);

  return <WatchBanner />;
}

/** 화면 안 배너(늘 — 브라우저 알림을 허락하지 않아도). 닫기 · 카드로 */
export function WatchBanner() {
  const banner = useWatch((s) => s.banner);
  const dismiss = useWatch((s) => s.dismiss);
  if (!banner.length) return null;
  return (
    <div role="status" aria-live="polite" aria-label="관심 대상 알림" className="fixed bottom-14 left-2 z-50 flex w-[min(360px,calc(100vw-16px))] flex-col gap-1" data-testid="watch-banner">
      {banner.map((e) => (
        <div key={e.key} className={`border bg-bg-1 px-2 py-1.5 text-[11px] shadow ${e.tone === "alert" ? "border-[#e5484d]" : "border-line"}`} data-testid="watch-event">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-fg-1">{e.title}</span>
            <span className="ml-auto mono text-fg-3">{fmtKst(e.at)}</span>
          </div>
          <div className="text-fg-2">{e.body}</div>
          <div className="mt-1 flex gap-1">
            <button className="btn" onClick={() => { openTarget(e.target); dismiss(e.key); }}>{label(e.target)} 카드</button>
            <button className="btn" onClick={() => dismiss(e.key)} aria-label={`${e.title} 알림 닫기`}>닫기</button>
          </div>
        </div>
      ))}
    </div>
  );
}
