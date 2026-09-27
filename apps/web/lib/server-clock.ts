/**
 * 서버 시계 오프셋 추정(WS-3 · DH-1) — 순수 클래스(테스트 가능). 화면의 모든 "경과·stale·외삽·ETA·만료" 계산이 같은 기준을 쓰도록
 * 오프셋 하나만 둔다(store.ts 의 serverNowMs, 워커의 "clock" 메시지).
 *
 * 표본 = 서버 메시지의 시각 − 수신 시각 = (실제 오프셋) − (전송 지연). 지연은 항상 ≥ 0 이므로 표본은 실제보다 작게만 틀린다
 * → 최근 표본 중 최댓값이 가장 나은 추정(NTP 가 지연이 가장 작은 표본을 고르는 것과 같은 원리). 평균을 내면 느린 메시지가 오프셋을 끌어내린다.
 * - 큰 메시지(스냅샷)는 전송에 수 초가 걸릴 수 있어 표본으로 쓰지 않는다 — 호출부(ws.ts)가 작은 메시지만 넘긴다.
 * - 창: 최근 `window` 개. 브라우저 벽시계가 바뀌면(Date.now − performance.now 가 `jumpMs` 넘게 변함: 수동 조정·NTP 계단 보정·절전 복귀)
 *   이전 표본은 다른 시계 기준이므로 버린다.
 */
export interface ClockSample { est: number; wallMinusMono: number | null }

export class ServerClock {
  private samples: ClockSample[] = [];
  private offset: number | null = null;

  constructor(private readonly window = 8, private readonly jumpMs = 2000) {}

  /** 표본 하나를 넣는다. 오프셋이 바뀌었으면 true. serverIso 를 해석할 수 없으면 무시(false). */
  observe(serverIso: unknown, receivedAtMs: number, monoMs?: number | null): boolean {
    if (typeof serverIso !== "string" || !Number.isFinite(receivedAtMs)) return false;
    const t = Date.parse(serverIso);
    if (Number.isNaN(t)) return false;
    const wm = typeof monoMs === "number" && Number.isFinite(monoMs) ? receivedAtMs - monoMs : null;
    const last = this.samples[this.samples.length - 1];
    if (last && last.wallMinusMono != null && wm != null && Math.abs(wm - last.wallMinusMono) > this.jumpMs) this.samples = [];
    this.samples.push({ est: t - receivedAtMs, wallMinusMono: wm });
    if (this.samples.length > this.window) this.samples.splice(0, this.samples.length - this.window);
    let max = -Infinity;
    for (const s of this.samples) if (s.est > max) max = s.est;
    const changed = this.offset !== max;
    this.offset = max;
    return changed;
  }

  /** 서버 − 브라우저(ms). 표본이 없으면 null(모름 — 호출부는 0 으로 다룬다). */
  get offsetMs(): number | null { return this.offset; }

  reset() { this.samples = []; this.offset = null; }
}
