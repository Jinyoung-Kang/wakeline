/** 관심 대상 지금 상태(계약 v5 §G50 · ADR-037) — 목록은 쿼리에만 실린다(서버는 저장하지 않는다). */
import { apiGet } from "@/lib/api";
import { parseWatch, watchQuery, type WatchState, type WatchTarget } from "@/lib/watch";

/** 본문이 화면이 읽는 모양이 아니면 null */
export async function watchNow(targets: readonly WatchTarget[], o?: { signal?: AbortSignal }): Promise<WatchState | null> {
  return apiGet<unknown>(`/api/v1/watch?${watchQuery(targets)}`, o).then((b) => parseWatch(b));
}
