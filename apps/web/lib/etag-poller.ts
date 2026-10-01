/**
 * 레이어가 켜져 있는 동안만 도는 ETag 조회기 — 연안 교통량(ADR-023 · lib/traffic-grid)과 관측 수신 범위(ADR-027 · lib/reception)가 같이 쓴다.
 * - 지도는 version 이 바뀔 때만 다시 그린다: 304 · 같은 ETag 면 version 을 올리지 않는다(같은 ETag 면 받은 본문도 앞 값 그대로).
 * - 숨긴 탭에서는 부르지 않고, 다시 보이면 곧바로 부른다(마지막 확인이 visibleMinGapMs 안이면 빼고 — 탭을 빨리 오갈 때 몰아 부르지 않게).
 * - 동시에 두 번 부르지 않는다. 실패(HTTP · 망 · 형식)는 마지막 값을 두고 error 에 적는다 — 지난 값을 조용히 지금처럼 두지 않는다.
 * - stop() 은 진행 중인 요청을 끊고, 그 뒤에 도착한 답은 발행하지 않는다(세대 번호) — 레이어를 껐다 켜면 옛 폴러의 늦은 답이 새 상태를 덮지 않는다.
 */

export interface PollState<T> { data: T | null; etag: string | null; error: string | null; version: number; checkedAt: number | null }
export const POLL_NONE: PollState<never> = { data: null, etag: null, error: null, version: 0, checkedAt: null };

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type WatchVisible = (onVisible: () => void) => () => void;

/** 탭이 다시 보일 때(visibilitychange → 보임) 알린다. 되돌리는 함수로 듣기를 멈춘다 */
export const watchVisible: WatchVisible = (onVisible) => {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return () => {};
  const h = () => { if (!document.hidden) onVisible(); };
  document.addEventListener("visibilitychange", h);
  return () => document.removeEventListener("visibilitychange", h);
};

export interface EtagPollerSpec<T> {
  url: string;
  /** 응답 → 화면 값. 모양이 틀리면 null(마지막 값을 둔다) */
  parse: (x: unknown) => T | null;
  intervalMs: number;
  visibleMinGapMs: number;
}

export class EtagPoller<T> {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unwatch: (() => void) | null = null;
  private inflight = false;
  /** stop() 마다 오른다 — 앞 세대의 요청은 끝나도 발행하지 않는다 */
  private gen = 0;
  private ctl: AbortController | null = null;
  private state: PollState<T>;

  constructor(
    private readonly spec: EtagPollerSpec<T>,
    private readonly publish: (s: PollState<T>) => void,
    initial: PollState<T> = POLL_NONE,
    private readonly fetcher: Fetcher = (u, i) => fetch(u, i),
    private readonly hidden: () => boolean = () => typeof document !== "undefined" && document.hidden,
    private readonly now: () => number = () => Date.now(),
    private readonly watch: WatchVisible = watchVisible,
  ) {
    this.state = initial;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => { if (!this.hidden()) void this.poll(); }, this.spec.intervalMs);
    this.unwatch = this.watch(() => {
      const last = this.state.checkedAt;
      if (last == null || this.now() - last >= this.spec.visibleMinGapMs) void this.poll();
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unwatch?.();
    this.unwatch = null;
    this.gen++;
    this.ctl?.abort();
    this.ctl = null;
    this.inflight = false;
  }

  async poll(): Promise<void> {
    if (this.inflight) return;
    this.inflight = true;
    const gen = this.gen;
    const ctl = new AbortController();
    this.ctl = ctl;
    const current = () => gen === this.gen;
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.state.etag && this.state.data) headers["If-None-Match"] = this.state.etag;
      const res = await this.fetcher(this.spec.url, { headers, credentials: "same-origin", signal: ctl.signal });
      if (!current()) return;
      if (res.status === 304) { this.set({ error: null, checkedAt: this.now() }, false); return; }
      if (!res.ok) { this.set({ error: `HTTP ${res.status}`, checkedAt: this.now() }, false); return; }
      const etag = res.headers.get("ETag");
      const body: unknown = await res.json();
      if (!current()) return;
      const parsed = this.spec.parse(body);
      if (!parsed) { this.set({ error: "응답 형식 오류", checkedAt: this.now() }, false); return; }
      const same = etag != null && etag === this.state.etag;
      this.set({ data: same ? this.state.data : parsed, etag, error: null, checkedAt: this.now() }, !same);
    } catch (e) {
      if (current()) this.set({ error: e instanceof Error ? e.message : String(e), checkedAt: this.now() }, false);
    } finally {
      // 멈춘 뒤 다시 켠 폴러의 요청이 진행 중일 수 있다 — 옛 세대의 끝이 그 잠금을 풀면 겹쳐 부른다
      if (current()) { this.inflight = false; this.ctl = null; }
    }
  }

  private set(patch: Partial<PollState<T>>, changed: boolean): void {
    this.state = { ...this.state, ...patch, version: this.state.version + (changed ? 1 : 0) };
    this.publish(this.state);
  }
}
