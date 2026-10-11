"use client";
import { useEffect, useRef, useState } from "react";
import { watchNow } from "@/lib/endpoints/watch";
import { errorLine } from "@/lib/api";
import { keepBlocked, notifyPermission, showNotification } from "@/lib/notify";
import { getData, subscribeData } from "@/lib/store";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { diffWatch, onlyTargets, openEvent, pollWhileHidden, suppress, WATCH_POLL_MS, type WatchAlert, type WatchEvent, type WatchState } from "@/lib/watch";
import { useWatch } from "@/lib/watch-store";
import type { Alert } from "@/lib/types";

/** WS 알림 → 조회 답과 같은 모양의 요약 */
export function wsAlert(a: Alert): WatchAlert {
  return {
    id: a.id, kind: a.kind, zone_type: a.zone_type ?? "sigmet", entered_at: a.entered_at,
    ...(a.level ? { level: a.level } : {}), ...(a.sigmet_id ? { sigmet_id: a.sigmet_id } : {}), ...(a.hazard ? { hazard: a.hazard } : {}),
    ...(a.airspace ? { zone_name: a.airspace.label } : {}), ...(a.eta_at ? { eta_at: a.eta_at } : {}),
  };
}

/**
 * 관심 대상 실행기의 상태 · 부수효과(SPEC F4 · ADR-037 · ADR-029 — 화면은 components/watch/WatchRunner 의 배너만 그린다).
 * - 조회: 보이는 동안 30 s 마다(useVisibleInterval) + 목록이 바뀌면 곧바로. 숨은 탭은 멈추되, 하나뿐인 예외(lib/watch pollWhileHidden — 관심 대상이 있고
 *   알림을 허락함)일 때만 숨은 동안에도 30 s 에 한 번.
 * - 이전 답은 목록에 있는 대상의 줄만 둔다 — 지웠다가 다시 더한 대상은 다음 답이 기준(QA-704 — 전에는 옛 답과 비교해 그사이 열린 알림을 '진입'으로 알렸다).
 * - WS 알림(이미 모두 받는다): 관심 항공기에 새 알림 id 가 오면 곧바로 사건(조회와 같은 열쇠 — 두 번 알리지 않는다). 첫 전체 목록(alertsVersion)에 있던
 *   알림은 기준(QA-705 — 전체 목록 전에 잡으면 이미 열린 알림이 모두 '새 알림'이 됐다).
 * - 숨은 탭 예외는 주기마다 브라우저의 알림 허락을 다시 읽는다 — 브라우저 설정에서 거두면 곧바로 멈춘다(QA-706).
 * - 사건 → 억제(같은 열쇠 한 번 · 10분 반복 없음) → 화면 배너(늘) + 브라우저 알림(허락했을 때만). 누르면 open.
 * - 화면을 떠나면(언마운트) 떠 있는 조회를 끊고 늦은 답은 버린다 — 전에는 다른 화면에서 배너 · 브라우저 알림이 났다(AWS 리뷰 D-6).
 */
export function useWatchRunner(open: (e: WatchEvent) => void): void {
  const targets = useWatch((s) => s.targets);
  const permission = useWatch((s) => s.permission);
  const prev = useRef<WatchState | null>(null);
  const fired = useRef(new Map<string, number>());
  const seenAlerts = useRef<Set<number> | null>(null);
  const busy = useRef(false);
  const inflight = useRef<AbortController | null>(null);
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; });
  const [hidden, setHidden] = useState(false);

  const fire = (evs: readonly WatchEvent[]) => {
    const now = Date.now();
    const r = suppress(evs, fired.current, now);
    fired.current = r.fired;
    if (!r.pass.length) return;
    useWatch.getState().pushEvents(r.pass, now);
    if (useWatch.getState().permission === "blocked") return; // 띄울 수 없다고 이미 알았다 — 배너만
    for (const e of r.pass) {
      if (showNotification(e.title, e.body, e.key, () => openRef.current(e)) !== "blocked") continue;
      useWatch.getState().setPermission("blocked"); // 허락은 됐지만 생성자를 막는 브라우저(안드로이드 크롬 등)
      return;
    }
  };

  const poll = () => {
    const list = useWatch.getState().targets;
    if (!list.length || busy.current) return;
    busy.current = true;
    const ctl = new AbortController();
    inflight.current = ctl;
    watchNow(list, { signal: ctl.signal }).then((next) => {
      if (ctl.signal.aborted) return; // 화면을 떠났다 — 늦은 답으로 사건 · 상태를 바꾸지 않는다
      if (!next) { useWatch.getState().setResult(null, "답의 모양이 틀림", Date.now()); return; }
      const list = useWatch.getState().targets;
      fire(diffWatch(prev.current, next, list));
      prev.current = onlyTargets(next, list);
      useWatch.getState().setResult(next, null, Date.now());
    }, (e: unknown) => { if (!ctl.signal.aborted) useWatch.getState().setResult(null, errorLine(e), Date.now()); })
      .finally(() => { busy.current = false; if (inflight.current === ctl) inflight.current = null; });
  };
  useEffect(() => () => inflight.current?.abort(), []);

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
      const p = keepBlocked(useWatch.getState().permission, notifyPermission()); // 브라우저 설정에서 거둔 허락은 이벤트가 없다 — 주기마다 읽는다(QA-706)
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
}
