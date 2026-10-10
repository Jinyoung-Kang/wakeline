/**
 * 관심 대상 상태(ADR-037): 목록(브라우저 저장소 `wakeline.watch` 와 같게) · 저장소 상태 · 마지막 조회 답 · 화면 배너 사건 · 알림 허락 상태.
 * 카드의 단추 · 관심 탭 · 실행기(components/watch/WatchRunner)가 함께 쓴다 — 모두 첫 화면 밖 조각이라 이 모듈도 첫 화면 JS 에 들지 않는다.
 */
import { create } from "zustand";
import { loadTargets, saveTargets, toggleTarget, WATCH_KEY, type StorageLike, type WatchEvent, type WatchState, type WatchStorageState, type WatchTarget } from "./watch";
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

/**
 * 바꾸기 직전의 목록 — 저장소를 다시 읽는다(QA-712: 다른 탭이 그사이 더한 대상을 이 탭의 옛 목록으로 덮어쓰지 않게). 저장소를 못 쓰거나 깨졌으면 이 탭의 목록.
 */
function latest(mine: WatchTarget[], state: WatchStorageState): WatchTarget[] {
  if (state !== "ok") return mine;
  const r = loadTargets(storage());
  return r.state === "ok" ? r.targets : mine;
}

export const useWatch = create<WatchStore>((set, get) => {
  const commit = (list: WatchTarget[], full: boolean) => {
    const ok = saveTargets(storage(), list);
    set({ targets: list, full, storage: ok ? "ok" : "unavailable" });
  };
  return {
    // 첫 상태는 서버와 같게(목록 없음 · 알림 모름) — zustand 는 이 값을 하이드레이션의 서버 스냅샷으로 쓴다(getInitialState). 저장소 값은 아래에서(QA-800)
    targets: [],
    storage: "ok",
    full: false,
    state: null,
    error: null,
    checkedAt: null,
    banner: [],
    permission: "unsupported",
    toggle: (t) => { const r = toggleTarget(latest(get().targets, get().storage), t); commit(r.list, r.full); },
    remove: (t) => commit(latest(get().targets, get().storage).filter((x) => !(x.kind === t.kind && x.id === t.id)), false),
    setPermission: (permission) => set({ permission }),
    pushEvents: (evs, at) => evs.length && set((s) => ({ banner: [...evs.map((e) => ({ ...e, at })), ...s.banner].slice(0, WATCH_BANNER_MAX) })),
    dismiss: (key) => set((s) => ({ banner: s.banner.filter((b) => b.key !== key) })),
    setResult: (state, error, at) => set((s) => ({ state: state ?? s.state, error, checkedAt: at })),
  };
});

if (typeof window !== "undefined") {
  // 브라우저: 저장소 · 알림 허락을 읽어 넣는다 — 하이드레이션은 위의 첫 상태로 하고, 그 뒤 이 값으로 다시 그린다(서버가 그린 /m 과 첫 그리기가 같다)
  const first = loadTargets(storage());
  useWatch.setState({ targets: first.targets, storage: first.state, permission: notifyPermission() });
  // 다른 탭에서 바꾼 목록을 따라간다(QA-712) — 화면에 보이는 목록 · 조회 대상이 저장소와 같게
  try {
    window.addEventListener("storage", (e: StorageEvent) => {
      if (e.key !== WATCH_KEY && e.key !== null) return;
      const r = loadTargets(storage());
      if (r.state === "ok") useWatch.setState({ targets: r.targets, storage: "ok", full: false });
    });
  } catch { /* 이벤트를 못 들으면 바꿀 때 다시 읽는 것(latest)만 */ }
}

export function isWatched(targets: readonly WatchTarget[], kind: WatchTarget["kind"], id: string): boolean {
  return targets.some((t) => t.kind === kind && t.id === id);
}
