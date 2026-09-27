/**
 * 공유 시계 훅: 주기마다 하나의 타이머만 두고 구독 컴포넌트만 다시 그린다(ETA 카운트다운·경과 시간 표시).
 * 렌더 중 Date.now() 를 부르지 않는다(react-hooks/purity). 서버 렌더·첫 렌더는 0 → 호출부는 0 이면 "아직 모름"으로 다룬다.
 * subscribe/getSnapshot 은 주기별로 한 번 만든 함수를 재사용한다(렌더마다 재구독하지 않도록 참조가 안정적).
 */
import { useSyncExternalStore } from "react";

interface Clock {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  subscribe: (listener: () => void) => () => void;
  read: () => number;
}
const clocks = new Map<number, Clock>();

function clockFor(periodMs: number): Clock {
  const existing = clocks.get(periodMs);
  if (existing) return existing;
  const c: Clock = {
    now: 0,
    listeners: new Set(),
    timer: null,
    subscribe: (listener) => {
      c.listeners.add(listener);
      if (!c.timer) {
        c.now = Date.now();
        c.timer = setInterval(() => { c.now = Date.now(); for (const l of c.listeners) l(); }, periodMs);
      }
      return () => {
        c.listeners.delete(listener);
        if (c.listeners.size === 0 && c.timer) { clearInterval(c.timer); c.timer = null; }
      };
    },
    read: () => c.now,
  };
  clocks.set(periodMs, c);
  return c;
}

const serverSnapshot = () => 0;

export function useNow(periodMs = 1000): number {
  const c = clockFor(periodMs);
  return useSyncExternalStore(c.subscribe, c.read, serverSnapshot);
}
