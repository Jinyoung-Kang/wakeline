"use client";
import { useEffect, useState } from "react";
import { watchedAirports, type AirportFeature } from "@/lib/endpoints/weather";
import { useServerNow } from "@/lib/clock";
import { panIfOutside } from "@/lib/focus";
import { CAT_COLORS, CAT_UNKNOWN_COLOR, fmtDuration, isMetarStale, metarAgeS } from "@/lib/format";
import { useUi } from "@/lib/ui-store";

/** 공항 탭(선택 없음): 감시 공항 목록 — 지도 클릭 없이 키보드로 고른다(R-40). 카테고리는 글자로도 쓴다(색만으로 구분하지 않음). */
export function AirportList() {
  const [state, setState] = useState<"loading" | "error" | "done">("loading");
  const [features, setFeatures] = useState<AirportFeature[]>([]);
  const now = useServerNow(60_000);
  useEffect(() => {
    let live = true;
    watchedAirports()
      .then((list) => { if (!live) return; setFeatures(list); setState("done"); })
      .catch(() => { if (live) setState("error"); });
    return () => { live = false; };
  }, []);
  return <AirportListView state={state} features={features} now={now} />;
}

/** 표시 부분(목록을 인자로 — 서버 렌더 시험용) */
export function AirportListView({ state, features, now }: { state: "loading" | "error" | "done"; features: AirportFeature[]; now: number }) {
  const selectAirport = useUi((s) => s.selectAirport);
  const items = [...features].sort((a, b) => a.properties.icao.localeCompare(b.properties.icao));
  return (
    <div className="flex h-full flex-col" data-testid="airport-list">
      <div className="row"><span className="label">감시 공항 {state === "done" ? items.length : ""}</span><span className="text-[10px] text-fg-3">지도에서 클릭(줌 5.5 이상)하거나 아래에서 고르세요</span></div>
      <ul className="min-h-0 flex-1 overflow-y-auto text-[12px]">
        {items.map((f) => {
          const p = f.properties;
          const age = now ? metarAgeS(p, now) : null;
          const hasMetar = p.obs_time != null || age != null;
          const stale = hasMetar && now > 0 && isMetarStale(p, now);
          const cat = !hasMetar ? "METAR 없음" : stale ? `METAR 오래됨${age != null ? `(${fmtDuration(age)} 전)` : ""}` : p.flight_cat ?? "—";
          const color = !hasMetar || stale || !p.flight_cat ? CAT_UNKNOWN_COLOR : CAT_COLORS[p.flight_cat] ?? CAT_UNKNOWN_COLOR;
          const [lon, lat] = f.geometry?.coordinates ?? [];
          return (
            <li key={p.icao} className="border-b border-line">
              <button className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-bg-2" data-testid="airport-list-item" data-icao={p.icao}
                onClick={() => { selectAirport(p.icao); panIfOutside(Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null); }}>
                <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full!" style={{ background: color }} aria-hidden />
                <span className="mono w-12 shrink-0 font-semibold">{p.icao}</span>
                <span className="min-w-0 flex-1 truncate text-fg-2">{p.name ?? ""}</span>
                <span className={`mono shrink-0 text-[11px] ${stale ? "text-warn" : ""}`}>{cat}</span>
              </button>
            </li>
          );
        })}
        {state === "loading" ? <li className="px-2 py-2 text-[11px] text-fg-3">공항 목록 불러오는 중…</li> : null}
        {state === "error" ? <li className="px-2 py-2 text-[11px] text-warn">공항 목록을 불러오지 못했습니다 — 지도에서 공항을 클릭하세요.</li> : null}
        {state === "done" && items.length === 0 ? <li className="px-2 py-2 text-[11px] text-fg-3">감시 공항이 없습니다.</li> : null}
      </ul>
    </div>
  );
}
