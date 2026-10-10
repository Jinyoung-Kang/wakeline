"use client";
import { useEffect, useRef, useState } from "react";
import { watchNow } from "@/lib/endpoints/watch";
import { errorLine } from "@/lib/api";
import { notifyPermission, showNotification } from "@/lib/notify";
import { getData, subscribeData } from "@/lib/store";
import { fmtKst } from "@/lib/time";
import { useUi } from "@/lib/ui-store";
import { useFocusRescue } from "@/lib/use-focus-rescue";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { diffWatch, label, onlyTargets, openEvent, pollWhileHidden, suppress, WATCH_POLL_MS, type WatchAlert, type WatchEvent, type WatchState, type WatchTarget } from "@/lib/watch";
import { useWatch } from "@/lib/watch-store";
import type { Alert } from "@/lib/types";

/**
 * 관심 대상 실행기(SPEC F4 · ADR-037): 첫 화면이 다 그려진 뒤 미리 받기(components/DashboardParts)가 받으면 그때부터 그린다(SidePanel — 받기 전에는 그리지 않아
 *   받기를 앞당기지 않는다). 첫 화면 JS 에 들지 않는다.
 * - 조회: 보이는 동안 30 s 마다(useVisibleInterval) + 목록이 바뀌면 곧바로. 숨은 탭은 멈추되, 하나뿐인 예외(lib/watch pollWhileHidden — 관심 대상이 있고
 *   알림을 허락함)일 때만 숨은 동안에도 30 s 에 한 번.
 * - 이전 답은 목록에 있는 대상의 줄만 둔다 — 지웠다가 다시 더한 대상은 다음 답이 기준(QA-704 — 전에는 옛 답과 비교해 그사이 열린 알림을 '진입'으로 알렸다).
 * - WS 알림(이미 모두 받는다): 관심 항공기에 새 알림 id 가 오면 곧바로 사건(조회와 같은 열쇠 — 두 번 알리지 않는다). 첫 전체 목록(alertsVersion)에 있던
 *   알림은 기준(QA-705 — 전체 목록 전에 잡으면 이미 열린 알림이 모두 '새 알림'이 됐다).
 * - 숨은 탭 예외는 주기마다 브라우저의 알림 허락을 다시 읽는다 — 브라우저 설정에서 거두면 곧바로 멈춘다(QA-706).
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

export function WatchRunner({ open = (e: WatchEvent) => openTarget(e.target), openName }: { open?: (e: WatchEvent) => void; openName?: (e: WatchEvent) => string | null } = {}) {
  const targets = useWatch((s) => s.targets);
  const permission = useWatch((s) => s.permission);
  const prev = useRef<WatchState | null>(null);
  const fired = useRef(new Map<string, number>());
  const seenAlerts = useRef<Set<number> | null>(null);
  const busy = useRef(false);
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; });
  const [hidden, setHidden] = useState(false);

  const fire = (evs: readonly WatchEvent[]) => {
    const now = Date.now();
    const r = suppress(evs, fired.current, now);
    fired.current = r.fired;
    if (!r.pass.length) return;
    useWatch.getState().pushEvents(r.pass, now);
    for (const e of r.pass) showNotification(e.title, e.body, e.key, () => openRef.current(e));
  };

  const poll = () => {
    const list = useWatch.getState().targets;
    if (!list.length || busy.current) return;
    busy.current = true;
    watchNow(list).then((next) => {
      if (!next) { useWatch.getState().setResult(null, "답의 모양이 틀림", Date.now()); return; }
      const list = useWatch.getState().targets;
      fire(diffWatch(prev.current, next, list));
      prev.current = onlyTargets(next, list);
      useWatch.getState().setResult(next, null, Date.now());
    }, (e: unknown) => useWatch.getState().setResult(null, errorLine(e), Date.now())).finally(() => { busy.current = false; });
  };

  useVisibleInterval(poll, targets.length ? WATCH_POLL_MS : null);
  // 목록이 바뀌면 곧바로 한 번(새 대상의 기준) — 숨은 탭이면 다음에 보일 때
  const key = targets.map((t) => `${t.kind}:${t.id}`).join(",");
  useEffect(() => {
    if (prev.current) prev.current = onlyTargets(prev.current, useWatch.getState().targets); // 지운 대상의 옛 줄을 버린다(QA-704)
    if (key && !document.hidden) poll();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps -- poll 은 저장소에서 지금 값을 읽는다

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
    const t = setInterval(() => {
      if (!document.hidden) return;
      const p = notifyPermission(); // 브라우저 설정에서 거둔 허락은 이벤트가 없다 — 주기마다 읽는다(QA-706)
      if (p !== useWatch.getState().permission) useWatch.getState().setPermission(p);
      if (pollWhileHidden(useWatch.getState().targets.length, p)) poll();
    }, WATCH_POLL_MS);
    return () => clearInterval(t);
  }, [hiddenPoll]); // eslint-disable-line react-hooks/exhaustive-deps -- 위와 같다

  // WS 알림: 새 알림 id 만(시작할 때 있던 것은 기준)
  useEffect(() => {
    const check = () => {
      const all = getData().alerts;
      if (!seenAlerts.current) {
        if (getData().alertsVersion == null) return; // 첫 전체 목록 전 — 기준을 아직 잡지 않는다(QA-705)
        seenAlerts.current = new Set(all.keys());
        return;
      }
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
