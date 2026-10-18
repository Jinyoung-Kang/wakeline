"use client";
import { useRef } from "react";
import { watchedAirports, type AirportFeature } from "@/lib/endpoints/weather";
import { useApiResource } from "@/lib/use-api-resource";
import { useRetryAfterOnce, type AutoRetry } from "@/lib/use-retry-after";
import { RetryNote } from "./RetryNote";
import { useServerNow } from "@/lib/clock";
import { panIfOutside } from "@/lib/focus";
import { airportListRows } from "@/lib/airport-list";
import { useUi } from "@/lib/ui-store";
import { frontNotice } from "@/lib/front-answer";

/** 공항 탭(선택 없음): 감시 공항 목록 — 지도 클릭 없이 키보드로 고른다(R-40). 카테고리는 글자로도 쓴다(색만으로 구분하지 않음). */
export function AirportList() {
  // 탭을 열 때 한 번(lib/use-api-resource — 탭을 닫으면 떠 있는 요청을 끊는다). 일시적 실패(503 + Retry-After — 공개 조회 허가 고갈)는 그 뒤 한 번
  // 다시 받고, 다시 해 볼 만한 실패에는 '다시 시도'(lib/use-retry-after · RetryNote — QA-1463 · IM-22: 전에는 탭을 다시 열어야 받았다)
  const res = useApiResource("watched", (signal) => watchedAirports({ signal }));
  const auto = useRetryAfterOnce("watched", res.status, res.error, res.retry);
  const now = useServerNow(60_000);
  const state = res.status === "loaded" ? "done" : res.status === "failed" ? "error" : "loading";
  return <AirportListView state={state} features={res.data ?? []} now={now} notice={state === "error" ? frontNotice(res.error) : null}
    retry={state === "error" ? { error: res.error, auto, onRetry: res.retry } : null} />;
}

/**
 * 표시 부분(목록을 인자로 — 서버 렌더 시험용). notice = 앞단(AWS 데모)이 답한 실패의 안내(잠금 만료 · 원본에 닿지 못함 — QA-1301):
 * 그때는 지도 클릭도 같은 앞단에 막히므로 '지도에서 클릭'을 권하지 않고 그 안내를 보인다.
 * retry = 실패 줄 아래의 자동 다시 받기 상태와 '다시 시도'(RetryNote) — 없으면 그리지 않는다.
 */
export function AirportListView({ state, features, now, notice = null, retry = null }: {
  state: "loading" | "error" | "done"; features: AirportFeature[]; now: number; notice?: string | null;
  retry?: { error: unknown; auto: AutoRetry; onRetry: () => void } | null;
}) {
  const selectAirport = useUi((s) => s.selectAirport);
  /** '다시 시도'를 누르면 단추가 사라진다(실패 줄 → 불러오는 중) — 초점을 목록으로 */
  const list = useRef<HTMLUListElement>(null);
  const items = airportListRows(features, now);
  return (
    <div className="flex h-full flex-col" data-testid="airport-list">
      <div className="row"><span className="label">감시 공항 {state === "done" ? items.length : ""}</span><span className="text-[10px] text-fg-3">지도에서 클릭(줌 5.5 이상)하거나 아래에서 고르세요</span></div>
      <ul ref={list} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto text-[12px] outline-none">
        {items.map((r) => (
          <li key={r.icao} className="border-b border-line">
            <button className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-bg-2" data-testid="airport-list-item" data-icao={r.icao}
              onClick={() => { selectAirport(r.icao); panIfOutside(r.lonLat); }}>
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full!" style={{ background: r.color }} aria-hidden />
              <span className="mono w-12 shrink-0 font-semibold">{r.icao}</span>
              <span className="min-w-0 flex-1 truncate text-fg-2">{r.name}</span>
              <span className={`mono shrink-0 text-[11px] ${r.stale ? "text-warn" : ""}`}>{r.cat}</span>
            </button>
          </li>
        ))}
        {state === "loading" ? <li className="px-2 py-2 text-[11px] text-fg-3">공항 목록 불러오는 중…</li> : null}
        {state === "error" ? <li className="px-2 py-2 text-[11px] text-warn">공항 목록을 불러오지 못했습니다 — {notice ?? "지도에서 공항을 클릭하세요."}
          {retry ? <RetryNote error={retry.error} auto={retry.auto} onRetry={() => { list.current?.focus(); retry.onRetry(); }} /> : null}</li> : null}
        {state === "done" && items.length === 0 ? <li className="px-2 py-2 text-[11px] text-fg-3">감시 공항이 없습니다.</li> : null}
      </ul>
    </div>
  );
}
