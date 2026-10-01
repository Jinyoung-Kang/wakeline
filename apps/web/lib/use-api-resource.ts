"use client";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useVisibleInterval } from "./use-visible-interval";

/** idle = 열쇠 없음(보내지 않음) · loading = 지금 열쇠의 답을 아직 받지 못함 · loaded · failed(마지막 요청이 실패 — data 는 그 전에 받은 값일 수 있다) */
export type ApiStatus = "idle" | "loading" | "loaded" | "failed";
export interface ApiResource<T> {
  status: ApiStatus;
  /** 지금 열쇠로 마지막에 받은 값(없으면 null) — 다른 열쇠 · 다른 시도의 값은 돌려주지 않는다 */
  data: T | null;
  /** 지금 열쇠로 보낸 마지막 요청의 실패(성공하면 null) */
  error: unknown;
  /** 같은 열쇠로 다시 받는다 — 그동안은 loading(받던 값 · 오류를 보이지 않는다) */
  retry: () => void;
}

/**
 * REST 자원 하나(web-review §3.2 — 통계 화면의 useLoad 를 일반화). load(signal) 은 lib/endpoints 의 함수를 부른다.
 * - 열쇠별 결과: 끝난 결과를 그 요청의 열쇠(시도 번호 · key)와 함께 두고, 지금 열쇠의 결과만 돌려준다 — 열쇠가 바뀌면 그 즉시 loading(앞 열쇠의 값 · 오류 ·
 *   요청 id 를 보이지 않는다, web-review B5 · B17). 효과 안에서 상태를 곧바로 바꾸지 않는다(react-hooks set-state-in-effect).
 * - 열쇠가 바뀌거나(retry 포함) 화면을 떠나면 떠 있는 요청을 끊고(AbortSignal) 그 답을 버린다.
 * - refreshMs: 그 주기로 같은 열쇠를 다시 받는다 — 받는 동안 값을 둔다. 실패하면 값을 둔 채 failed + error. 요청이 떠 있으면 그 주기는 건너뛴다(겹쳐
 *   보내지 않는다 — 주기보다 느린 답도 버리지 않고 반영한다, web-review B9). 숨긴 탭에서는 보내지 않고 다시 보이면 곧바로(lib/use-visible-interval).
 * - load 는 렌더마다 새 함수여도 된다 — 열쇠가 같으면 다시 받지 않는다(요청은 늘 지금의 load 로).
 */
export function useApiResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, opts: { refreshMs?: number | null } = {}): ApiResource<T> {
  const [attempt, setAttempt] = useState(0);
  const full = key == null ? null : `${attempt}|${key}`;
  const [res, setRes] = useState<{ key: string; data: T | null; error: unknown; failed: boolean } | null>(null);
  /** 요청 번호(seq — 끊었거나 뒤에 다른 요청이 떠난 답은 버린다)와 떠 있는 요청(한 번에 하나). 객체 하나는 바뀌지 않는다 */
  const live = useRef<{ seq: number; inflight: { my: number; ctl: AbortController } | null }>({ seq: 0, inflight: null });

  const send = useCallback((k: string, request: (signal: AbortSignal) => Promise<T>) => {
    const l = live.current;
    const ctl = new AbortController();
    const my = ++l.seq;
    l.inflight = { my, ctl };
    const done = () => { if (l.inflight?.my === my) l.inflight = null; };
    request(ctl.signal).then(
      (data) => { if (l.seq !== my) return; done(); setRes({ key: k, data, error: null, failed: false }); },
      (error: unknown) => { if (l.seq !== my) return; done(); setRes((r) => ({ key: k, data: r?.key === k ? r.data : null, error, failed: true })); },
    );
  }, []);
  const first = useEffectEvent((k: string) => send(k, load));
  useEffect(() => {
    if (full == null) return;
    const l = live.current;
    first(full);
    return () => {
      l.inflight?.ctl.abort();
      l.inflight = null;
      l.seq++;
    };
  }, [full]);

  // 다시 받기: 떠 있는 요청이 있으면 건너뛴다(겹쳐 보내지 않는다)
  useVisibleInterval(() => { if (full != null && !live.current.inflight) send(full, load); }, full != null && opts.refreshMs ? opts.refreshMs : null);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const cur = full != null && res?.key === full ? res : null;
  return {
    status: full == null ? "idle" : !cur ? "loading" : cur.failed ? "failed" : "loaded",
    data: cur?.data ?? null,
    error: cur?.failed ? cur.error : null,
    retry,
  };
}
