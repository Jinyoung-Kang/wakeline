/**
 * 첫 그리기 뒤로 미루기(PERF §15 · ADR-026 개정 2026-10-02): 화면의 첫 그리기(first-contentful-paint)가 **화면에 나온 뒤** 풀리는 약속.
 * 지도 화면(상황판 · 재생)은 지도 컴포넌트 청크 · MapLibre 를 이것 뒤에 받기 시작한다 — 서버가 그린 화면(상태 바 · 알림 목록 · 출처 줄 …)이 먼저 보이고,
 * 지도 라이브러리의 내려받기 · 해석 · WebGL 준비(셰이더 컴파일)가 첫 그리기를 붙잡지 않는다. 소프트웨어 GL(SwiftShader — QA-402 의 측정 환경)에서는 지도의
 * WebGL 준비가 주 스레드와 GPU 프로세스를 2–5 s 붙잡아 첫 그리기가 그 뒤로 밀렸다(PERF §15).
 * - 신호는 Paint Timing 의 'first-contentful-paint' 항목(화면에 나온 시각 — buffered 로 이미 지난 것도 받는다). 주 스레드의 다음 프레임(rAF)만 기다리면
 *   소프트웨어 GL 에서는 GPU 프로세스가 그 프레임을 아직 내보내지 못한 채 지도 준비가 시작되어 첫 그리기가 여전히 밀렸다(이 작업의 첫 시도 — PERF §15).
 * - Paint Timing 이 없는 브라우저: rAF(그리기 직전) → setTimeout 0(그 그리기 뒤의 작업).
 * - 숨은 탭(처음부터 백그라운드로 연 탭)은 그리지 않는다 → 기다리지 않는다(전과 같이 곧바로 받는다). 기다리는 동안 숨겨지면 그때 곧바로.
 * - 서버 · 시험 환경(창 없음)도 곧바로. 안전장치: MAX_WAIT_MS 가 지나면 그리기 신호가 없어도 풀린다(선택값 — 보이는 탭에서 첫 그리기 항목이 끝내 오지 않는 경우만).
 * React 를 쓰지 않는다(ADR-029 §6).
 */
export const MAX_WAIT_MS = 10_000;

interface EntryLike { name: string }
export interface PaintEnv {
  requestAnimationFrame?: (cb: () => void) => unknown;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
  document?: { visibilityState?: string; addEventListener?: (t: string, cb: () => void) => void; removeEventListener?: (t: string, cb: () => void) => void };
  performance?: { getEntriesByName?: (name: string) => unknown[] };
  PerformanceObserver?: {
    new (cb: (list: { getEntries(): EntryLike[] }) => void): { observe(o: { type: string; buffered?: boolean }): void; disconnect(): void };
    supportedEntryTypes?: readonly string[];
  };
}

const FCP = "first-contentful-paint";
const hidden = (env: PaintEnv) => env.document?.visibilityState === "hidden";

export function afterFirstPaint(env: PaintEnv | null = typeof window === "undefined" ? null : (window as unknown as PaintEnv)): Promise<void> {
  if (!env || hidden(env)) return Promise.resolve();
  if ((env.performance?.getEntriesByName?.(FCP)?.length ?? 0) > 0) return Promise.resolve(); // 이미 그렸다(스크립트가 늦게 온 경우 — 느린 망에서 흔하다)
  const paintTiming = !!env.PerformanceObserver?.supportedEntryTypes?.includes("paint");
  if (!paintTiming && typeof env.requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    let observer: { disconnect(): void } | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      observer?.disconnect();
      env.clearTimeout?.(cap);
      env.document?.removeEventListener?.("visibilitychange", onVisibility);
      resolve();
    };
    const onVisibility = () => { if (hidden(env)) finish(); };
    env.document?.addEventListener?.("visibilitychange", onVisibility);
    const cap = env.setTimeout(finish, MAX_WAIT_MS);
    if (paintTiming) {
      const o = new env.PerformanceObserver!((list) => { if (list.getEntries().some((e) => e.name === FCP)) env.setTimeout(finish, 0); });
      observer = o;
      o.observe({ type: "paint", buffered: true });
    } else {
      env.requestAnimationFrame!(() => { env.setTimeout(finish, 0); });
    }
  });
}
