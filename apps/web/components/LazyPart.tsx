"use client";
import { Component, createRef, lazy, Suspense, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { checkChunk, chunkCheckText, chunkUrlOf, type ChunkCheck } from "@/lib/chunk-probe";
import { describeThrown, reportClientError } from "@/lib/errorReport";

/**
 * 나중에 받는 화면 조각(ADR-026 — 첫 화면 JS NFR-04). 상황판을 처음 열 때 받는 코드에서 클릭 · 탭 · 펼치기 뒤에만 보이는 화면을 빼고,
 * 처음 쓸 때 import() 로 받는다(Turbopack 이 조각마다 청크를 따로 만든다 — next/dynamic 이 아니라 React.lazy: 빌드 결과 검사
 * scripts/check-first-screen-js.mjs 는 `/` 의 next/dynamic 을 첫 그리기에 받는 JS 로 센다).
 * - 받는 동안: 진행 표시 규칙(lib/busy · globals.css .busy-appear · .busy-bar · .skeleton) 그대로 — 글자(role=status)는 처음부터 DOM 에,
 *   막대 · 자리 표시는 BUSY_APPEAR_DELAY_MS 뒤에 보인다. 자리 표시는 값처럼 보이지 않는 무늬 없는 막대(aria-hidden).
 * - 받은 뒤: 조각을 같은 그리기에서 바로 그린다 — 이미 받은 모듈이면 lazy 에 동기 thenable 을 넘겨 기다리지 않는다(번쩍임 없음).
 * - 받지 못함: 까닭(role=alert)을 보이고, 서버에 그 청크가 있는지 한 번 확인해(lib/chunk-probe — HEAD) 그 결과와 함께 시스템 로그에 보고한다
 *   (lib/errorReport — 같은 메시지 60 s 에 1번). 청크가 서버에 없으면(404 · 410 — 페이지를 연 뒤 새 판이 배포되어 옛 청크가 사라짐) '다시 시도'로는 받을 수
 *   없으므로 '페이지 새로고침'만, 그 밖에는 '다시 시도'(새 lazy 로 다시 받는다)를 보인다. 다시 시도가 또 실패하면 두 단추를 함께 보인다.
 *   받은 조각 자신의 그리기 오류는 삼키지 않는다 — 경계가 다시 던져 위(app/error.tsx)가 받는다.
 * - 다시 시도 뒤의 초점: 누른 단추가 사라지므로, 초점이 문서로 떨어졌으면 불러온 조각의 첫 요소(또 실패하면 새 오류의 첫 단추)로 옮긴다 —
 *   키보드 · 화면 읽기 사용자가 패널 안의 자리를 잃지 않게. 사용자가 이미 다른 곳으로 옮겼으면 건드리지 않는다.
 */

/** 조각의 모듈을 받지 못함(경계가 이것만 잡는다) */
export class LazyLoadError extends Error {
  readonly part: string;
  readonly reason: unknown;
  constructor(part: string, reason: unknown) {
    super(`${part} — 화면 코드를 받지 못함: ${describeThrown(reason).message}`);
    this.name = "LazyLoadError";
    this.part = part;
    this.reason = reason;
  }
}

type Module<P> = { default: ComponentType<P> };

/**
 * 이미 받은 모듈을 lazy 에 동기로 넘긴다 — React.lazy 는 then 만 부르고, then 이 곧바로 값을 주면 그 자리에서 Resolved 로 본다(react 19 lazyInitializer).
 * 형식은 lazy 가 요구하는 Promise 로 적지만 쓰는 것은 then 하나뿐이다.
 */
function settled<T>(value: T): Promise<T> {
  const thenable = { then: (onFulfilled?: (v: T) => unknown) => { onFulfilled?.(value); return thenable; } };
  return thenable as unknown as Promise<T>;
}

export interface LazyPartComponent<P extends object> {
  (props: P): ReactNode;
  /** 모듈을 미리 받는다(한 번만 — 실패하면 다음 호출이 다시 받는다). 시험 · 의도가 보일 때 미리 받기에 쓴다 */
  preload(): Promise<void>;
  readonly label: string;
}

/** 받는 동안 · 실패 표시의 틀(기본은 패널 안 여백). 조각이 제 자리를 스스로 잡는 경우(떠 있는 패널)에 같은 자리 · 크기를 준다 */
export interface LazyPartOptions { frameClassName?: string }
const DEFAULT_FRAME = "p-3 text-[11px]";

/**
 * label: 화면에 보이는 조각 이름(한국어 — "항공기 카드" 등). load: 조각의 모듈을 받아 컴포넌트를 돌려준다
 * (예: `() => import("./AircraftCard").then((m) => m.AircraftCard)` — import() 안의 경로는 문자열 그대로 둔다, 번들러가 청크를 찾는 표시다).
 */
export function lazyPart<P extends object>(label: string, load: () => Promise<ComponentType<P>>, opts: LazyPartOptions = {}): LazyPartComponent<P> {
  const frame = opts.frameClassName ?? DEFAULT_FRAME;
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const fetchOnce = (): Promise<ComponentType<P>> => (pending ??= load().then(
    (C) => { loaded = C; return C; },
    (e: unknown) => { pending = null; throw new LazyLoadError(label, e); },
  ));
  const makeLazy = () => lazy<ComponentType<P>>(() => (loaded ? settled<Module<P>>({ default: loaded }) : fetchOnce().then((C) => ({ default: C }))));
  // 조각마다 lazy 하나(다시 시도하면 새것 — 실패한 lazy 는 실패를 기억한다). 그리기에서 만들지 않는다(같은 형식이어야 상태가 유지된다)
  const slot = { current: makeLazy() };
  const retry = () => { slot.current = makeLazy(); };

  function Part(props: P) {
    const [attempt, setAttempt] = useState(0);
    const Lazy = slot.current;
    return (
      <LoadBoundary key={attempt} label={label} frame={frame} attempt={attempt} onRetry={() => { retry(); setAttempt((n) => n + 1); }}>
        <Suspense fallback={<PartLoading label={label} frame={frame} />}>
          {attempt > 0 ? <FocusAfterRetry /> : null}
          <Lazy {...props} />
        </Suspense>
      </LoadBoundary>
    );
  }
  return Object.assign(Part, { preload: () => fetchOnce().then(() => undefined), label });
}

/** 초점이 문서로 떨어졌는가(누른 단추가 사라지면 브라우저는 body 로 옮긴다 — 떼어 낸 요소를 가리키는 환경도 같게 본다) */
function focusLost(): boolean {
  const a = document.activeElement;
  return a == null || a === document.body || a === document.documentElement || !document.contains(a);
}

/** 다시 시도로 조각을 받은 뒤: 조각의 첫 요소로 초점을 옮긴다(그 순간만 tabindex=-1 — 초점이 떠나면 뗀다). 자리 표시는 보이지 않는 빈 span */
function FocusAfterRetry() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!ref.current || !focusLost()) return;
    let n = ref.current.nextSibling;
    while (n && n.nodeType !== 1) n = n.nextSibling;
    const el = n as HTMLElement | null;
    if (!el) return;
    if (!el.hasAttribute("tabindex")) {
      el.setAttribute("tabindex", "-1");
      el.addEventListener("blur", () => el.removeAttribute("tabindex"), { once: true });
    }
    el.focus();
  }, []);
  return <span ref={ref} hidden />;
}

/** 받는 동안의 자리: 글자는 곧바로(화면 읽기), 막대 · 자리 표시 두 줄은 180 ms 뒤(lib/busy — 선택값) */
function PartLoading({ label, frame }: { label: string; frame: string }) {
  return (
    <div className={frame} data-testid="lazy-loading" data-part={label}>
      <div role="status" className="text-fg-3">{label} 불러오는 중</div>
      <div className="busy-appear" data-testid="lazy-progress">
        <span className="busy-bar mt-1" aria-hidden="true" />
        <div className="mt-2 flex flex-col gap-1.5" aria-busy="true" aria-hidden="true">
          <span className="skeleton h-3 w-40" />
          <span className="skeleton h-2.5 w-56" />
        </div>
      </div>
    </div>
  );
}

interface BoundaryProps { label: string; frame: string; attempt: number; onRetry: () => void; children: ReactNode }

/** 페이지 새로고침(새 판의 HTML · 청크를 받는다) */
function reloadPage() { window.location.reload(); }

class LoadBoundary extends Component<BoundaryProps, { error: unknown; check: ChunkCheck | null }> {
  state = { error: null as unknown, check: null as ChunkCheck | null };
  private mounted = false;
  private alertRef = createRef<HTMLDivElement>();
  static getDerivedStateFromError(error: unknown) { return { error }; }
  componentDidMount() { this.mounted = true; }
  /** 다시 시도가 또 실패해 오류가 다시 보일 때(또는 확인 결과로 단추가 바뀔 때) 초점이 떨어졌으면 첫 단추로 */
  componentDidUpdate() {
    if (this.props.attempt === 0 || this.state.error == null || !focusLost()) return;
    this.alertRef.current?.querySelectorAll<HTMLButtonElement>("[data-lazy-action]")[0]?.focus();
  }
  componentWillUnmount() { this.mounted = false; }
  componentDidCatch(error: unknown) {
    if (!(error instanceof LazyLoadError)) return; // 그리기 오류는 위 경계가 보고한다
    const origin = typeof location !== "undefined" && typeof location.origin === "string" ? location.origin : null;
    // 확인이 끝나면 결과와 함께 한 번 보고한다(경계가 이미 사라졌어도 보고는 한다). 확인은 던지지 않지만, 혹시 던져도 보고는 빠지지 않는다
    const done = (check: ChunkCheck) => {
      const d = describeThrown(error.reason);
      reportClientError({ message: `화면 조각을 받지 못함(${error.part}): ${d.message} — 청크 확인: ${chunkCheckText(check)}`, stack: d.stack, component: `lazy:${error.part}` });
      if (this.mounted) this.setState({ check });
    };
    checkChunk(chunkUrlOf(error.reason, origin)).then(done, (e: unknown) => done({ kind: "unknown", why: describeThrown(e).message, url: null }));
  }
  render() {
    const { error, check } = this.state;
    if (error == null) return this.props.children;
    if (!(error instanceof LazyLoadError)) throw error; // 받은 조각의 그리기 오류 — 삼키지 않는다
    const missing = check?.kind === "missing";
    const retried = this.props.attempt > 0;
    const advice = missing
      ? " — 이 페이지를 연 뒤 새 판이 배포되면 이렇게 됩니다. 다시 시도로는 받을 수 없으니 페이지를 새로고침하세요."
      : retried ? " — 다시 시도도 실패했습니다. 계속되면 페이지를 새로고침하세요." : "";
    return (
      <div ref={this.alertRef} className={this.props.frame} role="alert" data-testid="lazy-error" data-part={this.props.label} data-check={check?.kind ?? "pending"}>
        <div className="text-bad">{this.props.label} — 화면 코드를 받지 못했습니다</div>
        <div className="mono mt-0.5 break-all text-fg-3">{describeThrown(error.reason).message}</div>
        <div className="mt-0.5 text-fg-2" data-testid="lazy-check">{chunkCheckText(check)}{advice}</div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {missing ? null : <button type="button" className="btn" onClick={this.props.onRetry} data-testid="lazy-retry" data-lazy-action="">다시 시도</button>}
          {missing || retried ? <button type="button" className="btn" onClick={reloadPage} data-testid="lazy-reload" data-lazy-action="">페이지 새로고침</button> : null}
        </div>
      </div>
    );
  }
}
