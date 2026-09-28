/**
 * 공유 시계 훅: 주기마다 하나의 타이머만 두고 구독 컴포넌트만 다시 그린다(ETA 카운트다운·경과 시간 표시).
 * 렌더 중 Date.now() 를 부르지 않는다(react-hooks/purity). 서버 렌더·첫 렌더는 0 → 호출부는 0 이면 "아직 모름"으로 다룬다.
 * subscribe/getSnapshot 은 주기별로 한 번 만든 함수를 재사용한다(렌더마다 재구독하지 않도록 참조가 안정적).
 */
import { useSyncExternalStore } from "react";
import { getData, serverNowMs, subscribeData } from "./store";
import { isRxFresh } from "./ws-protocol";

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

/**
 * 서버 기준 현재 시각(ms) — 서버가 준 절대 시각(seen_at·eta_at·valid_to·fetched_at)과 비교할 때는 이것을 쓴다(WS-3 · DH-1).
 * 첫 렌더(0)는 0 그대로(호출부는 "아직 모름"으로 다룬다).
 */
export function useServerNow(periodMs = 1000): number {
  const now = useNow(periodMs);
  return now ? serverNowMs(now) : 0;
}

// ---- 수신 신선도(R-58): 상태 바·지도 칩과 같은 규칙(isRxFresh)을 알림 목록·근거 카드도 쓴다 ----
// 값(참/거짓)이 바뀔 때만 다시 그린다 — 1 s 시계와 스토어 둘 다 구독하지만 useSyncExternalStore 는 같은 값이면 렌더하지 않는다.
function subscribeRx(listener: () => void) {
  const offClock = clockFor(1000).subscribe(listener);
  const offData = subscribeData(listener);
  return () => { offClock(); offData(); };
}
function readRx(): boolean {
  const d = getData();
  return isRxFresh(d.conn, d.lastRxAt, clockFor(1000).now || Date.now());
}
/** 연결이 열려 있고 RX_FRESH_MS 안에 무엇이든(ping 포함) 받았는가 */
export function useRxFresh(): boolean {
  return useSyncExternalStore(subscribeRx, readRx, readRx);
}
