"use client";
import { useEffect, useEffectEvent } from "react";
import { watchVisible } from "./etag-poller";

/**
 * 탭이 보일 때만 도는 주기 호출(PLAN §5 결정 2 — WS · 워커 · lib/etag-poller 와 같은 규칙).
 * - 숨긴 탭에서는 부르지 않는다. 숨긴 동안 한 번이라도 걸렀으면 다시 보이는 순간 곧바로 부른다(보이는 화면의 신선도는 그대로 —
 *   거른 것이 없으면 다음 주기를 기다린다: 탭을 빨리 오갈 때 몰아 부르지 않게).
 * - fn 은 useEffectEvent 로 부른다: fn 이 바뀌어도(렌더마다 새 함수) 주기를 다시 걸지 않는다 — 로그 자동 확인이 쪽을 넘길 때마다
 *   다시 걸려 15 s 확인이 밀렸다(web-review B13). ms 가 바뀌면 다시 걸고, null 이면 멈춘다.
 */
export function useVisibleInterval(fn: () => void, ms: number | null): void {
  const tick = useEffectEvent(fn);
  useEffect(() => {
    if (ms == null) return;
    let missed = false;
    const t = setInterval(() => { if (document.hidden) missed = true; else tick(); }, ms);
    const unwatch = watchVisible(() => { if (missed) { missed = false; tick(); } });
    return () => { clearInterval(t); unwatch(); };
  }, [ms]);
}
