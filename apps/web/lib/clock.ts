/**
 * 공유 시계 훅: 주기마다 하나의 타이머만 두고 구독 컴포넌트만 다시 그린다(ETA 카운트다운·경과 시간 표시).
 * 렌더 중 Date.now() 를 부르지 않는다(react-hooks/purity). 서버 렌더·첫 렌더는 0 → 호출부는 0 이면 "아직 모름"으로 다룬다.
 * subscribe/getSnapshot 은 주기별로 한 번 만든 함수를 재사용한다(렌더마다 재구독하지 않도록 참조가 안정적).
 */
import { useState, useSyncExternalStore } from "react";
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
 * key 가 처음 보인 때부터 지난 시간(초). key 가 null 이면(끝남) null, 시계를 아직 모르면(nowMs 0) null — 0 으로 채우지 않는다.
 * key 가 바뀌면(다른 항공기 · 콜사인) 그때부터 다시 잰다. 렌더 중 상태 조정(이전 렌더의 key 를 기억) — 이펙트 없이 같은 렌더에서 맞는 값.
 * 예: 항공기 카드의 "노선 조회 중" 경과(ROUTE_SLOW_AFTER_S 를 넘으면 "보통 경로 계산값(10 s)보다 오래 걸림").
 */
export function useElapsedSince(key: string | null, nowMs: number): number | null {
  const [since, setSince] = useState<{ key: string | null; at: number }>({ key: null, at: 0 });
  if (key == null) {
    if (since.key != null) setSince({ key: null, at: 0 });
    return null;
  }
  if (!(nowMs > 0)) return null;
  if (since.key !== key) { setSince({ key, at: nowMs }); return 0; }
  return Math.max(0, (nowMs - since.at) / 1000);
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
