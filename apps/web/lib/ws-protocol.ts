/** WS 클라이언트의 순수 상태 로직(테스트 가능): 버전 불연속 감지·재접속 백오프. */
export function nextBackoffMs(attempt: number, min = 1000, max = 30000): number {
  const base = Math.min(max, min * Math.pow(2, Math.max(0, attempt)));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** diff 의 v 가 마지막 v 와 연속이 아니면 resync 가 필요하다. 첫 diff(lastV=0)는 허용. */
export function needsResync(lastV: number, incomingV: number): boolean {
  if (lastV === 0) return false;
  return incomingV > lastV + 1 || incomingV <= lastV;
}
