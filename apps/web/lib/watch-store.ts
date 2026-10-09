/**
 * 관심 대상 상태(ADR-037): 목록(브라우저 저장소 `wakeline.watch` 와 같게) · 저장소 상태 · 마지막 조회 답 · 화면 배너 사건 · 알림 허락 상태.
 * 카드의 단추 · 관심 탭 · 실행기(components/watch/WatchRunner)가 함께 쓴다 — 모두 첫 화면 밖 조각이라 이 모듈도 첫 화면 JS 에 들지 않는다.
 */
import { create } from "zustand";
import { loadTargets, saveTargets, toggleTarget, type StorageLike, type WatchEvent, type WatchState, type WatchStorageState, type WatchTarget } from "./watch";
import { notifyPermission, type NotifyPermission } from "./notify";

/** 배너에 남기는 사건 수(오래된 것부터 버린다) */
export const WATCH_BANNER_MAX = 5;

export interface WatchStore {
  targets: WatchTarget[];
  storage: WatchStorageState;
  /** 50개가 차서 더하지 못했다(다음 바꿈까지) */
  full: boolean;
  state: WatchState | null;
  error: string | null;
  checkedAt: number | null;
  banner: (WatchEvent & { at: number })[];
  permission: NotifyPermission;
  toggle(t: WatchTarget): void;
  remove(t: WatchTarget): void;
  setPermission(p: NotifyPermission): void;
  pushEvents(evs: readonly WatchEvent[], at: number): void;
  dismiss(key: string): void;
  setResult(state: WatchState | null, error: string | null, at: number): void;
}

function storage(): StorageLike | null {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

const first = typeof window !== "undefined" ? loadTargets(storage()) : { targets: [], state: "ok" as const };

export const useWatch = create<WatchStore>((set, get) => {
  const commit = (list: WatchTarget[], full: boolean) => {
    const ok = saveTargets(storage(), list);
    set({ targets: list, full, storage: ok ? "ok" : "unavailable" });
  };
  return {
    targets: first.targets,
    storage: first.state,
    full: false,
    state: null,
    error: null,
    checkedAt: null,
    banner: [],
    permission: typeof window !== "undefined" ? notifyPermission() : "unsupported",
    toggle: (t) => { const r = toggleTarget(get().targets, t); commit(r.list, r.full); },
    remove: (t) => commit(get().targets.filter((x) => !(x.kind === t.kind && x.id === t.id)), false),
    setPermission: (permission) => set({ permission }),
    pushEvents: (evs, at) => evs.length && set((s) => ({ banner: [...evs.map((e) => ({ ...e, at })), ...s.banner].slice(0, WATCH_BANNER_MAX) })),
    dismiss: (key) => set((s) => ({ banner: s.banner.filter((b) => b.key !== key) })),
    setResult: (state, error, at) => set((s) => ({ state: state ?? s.state, error, checkedAt: at })),
  };
});

export function isWatched(targets: readonly WatchTarget[], kind: WatchTarget["kind"], id: string): boolean {
  return targets.some((t) => t.kind === kind && t.id === id);
}
