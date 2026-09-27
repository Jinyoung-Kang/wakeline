"use client";
import { useEffect, useState } from "react";
import { useServerData } from "@/lib/store";
import { fmtAgo, fmtTime } from "@/lib/format";

/** 상단 상태 바(FR-11): 출처·수집 시각·지연 배지·공급자·연결 상태. lag > 60 s(지역) 이면 배지. */
export function StatusBar() {
  // useSyncExternalStore 의 getSnapshot 은 안정된 참조를 돌려줘야 한다 — 객체를 새로 만들지 않고 스토어 객체 자체를 선택한다.
  const s = useServerData((x) => x);
  const d = { conn: s.conn, attempt: s.reconnectAttempt, provider: s.provider, at: s.snapshotAt, lag: s.lagS, stale: s.stale, n: s.aircraftCount, scope: s.scope, v: s.snapshotVersion, status: s.status, sigAt: s.sigmetsFetchedAt, sigProv: s.sigmetsProvider, radar: s.radar };
  const [now, setNow] = useState(0);
  useEffect(() => { const tick = () => setNow(Date.now()); const t = setInterval(tick, 1000); const raf = requestAnimationFrame(tick); return () => { clearInterval(t); cancelAnimationFrame(raf); }; }, []);
  const regionLag = d.status?.region.lag_s ?? d.lag;
  const lagBad = regionLag == null || regionLag > 60;
  const fixture = d.status?.fixture_mode;
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 overflow-x-auto border-b border-line bg-bg-1 px-3 text-[11px] whitespace-nowrap" data-testid="statusbar">
      <span className={`badge ${d.conn === "open" ? "ok" : d.conn === "paused" ? "warn" : "bad"}`} data-testid="conn">
        WS {d.conn}{d.conn !== "open" && d.attempt > 0 ? ` · retry ${d.attempt}` : ""}
      </span>
      {fixture ? <span className="badge warn" data-testid="fixture-badge">FIXTURE MODE · 외부 호출 없음</span> : null}
      <span className="mono"><span className="label mr-1">aircraft</span>{d.n}<span className="text-fg-3"> · {d.scope}</span></span>
      <span className="mono"><span className="label mr-1">source</span>{d.provider}</span>
      <span className="mono"><span className="label mr-1">fetched</span>{fmtTime(d.status?.region.fetched_at ?? d.at)}</span>
      <span className={`badge ${lagBad ? "bad" : "ok"}`} data-testid="lag-badge">
        {regionLag == null ? "NO DATA" : `lag ${Math.round(regionLag)}s`}{d.stale && regionLag != null ? " · STALE" : ""}
      </span>
      <span className="mono text-fg-2"><span className="label mr-1">sigmet</span>{d.sigProv} · {d.status?.sigmet.active ?? "—"} active · {fmtAgo(d.sigAt, now)}</span>
      <span className="mono text-fg-2"><span className="label mr-1">radar</span>{d.radar?.past.length ?? 0} frames · {fmtAgo(d.radar?.fetched_at, now)}</span>
      <span className="mono text-fg-3"><span className="label mr-1">engine</span>{d.status?.engine.index_polygons ?? "—"} polys · {d.status?.engine.last_cycle_ms ?? "—"} ms</span>
      <span className="mono text-fg-3">v{d.v}</span>
      <span className="ml-auto text-fg-3" data-testid="attribution">
        Aircraft © adsb.lol (ODbL) · adsb.fi · OpenSky · Weather © AviationWeather.gov · Radar © RainViewer · Map © OpenFreeMap · OpenMapTiles · OpenStreetMap contributors
      </span>
    </div>
  );
}
