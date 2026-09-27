"use client";
import { useServerData } from "@/lib/store";
import { useNow } from "@/lib/clock";
import { fmtAgo, fmtClock, fmtIso } from "@/lib/format";
import { feedLag, GLOBAL_STALE_S, REGION_STALE_S } from "@/lib/ws-protocol";

/**
 * 상단 상태 바(FR-11): 연결 상태·지역/전세계 피드별 출처·수집 시각·지연 배지(지역 > 60 s, 전세계 > 300 s 면 경고)·SIGMET·레이더.
 * 지연은 서버가 보고한 값(스냅샷 sources·30 s status). 연결이 끊겼거나 일시정지면 받은 뒤 경과 시간을 더한다(화면 데이터가 멈췄으므로).
 * 출처 표기는 가로 스크롤되는 이 줄이 아니라 모든 화면 하단의 고정 줄(AttributionFooter)에 있다(FR-20).
 */
export function StatusBar() {
  // useSyncExternalStore 의 getSnapshot 은 안정된 참조를 돌려줘야 한다 — 객체를 새로 만들지 않고 스토어 객체 자체를 선택한다.
  const s = useServerData((x) => x);
  const now = useNow(1000);
  const live = s.conn === "open";
  const region = feedLag(s.feeds.region, now, live, REGION_STALE_S);
  const world = s.feeds.global ? feedLag(s.feeds.global, now, live, GLOBAL_STALE_S) : null;
  const fixture = s.status?.fixture_mode;
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 overflow-x-auto border-b border-line bg-bg-1 px-3 text-[11px] whitespace-nowrap" data-testid="statusbar" role="group" aria-label="수집·연결 상태">
      <span className={`badge ${s.conn === "open" ? "ok" : s.conn === "paused" ? "warn" : "bad"}`} data-testid="conn">
        WS {s.conn}{s.conn !== "open" && s.reconnectAttempt > 0 ? ` · retry ${s.reconnectAttempt}` : ""}
      </span>
      {fixture ? <span className="badge warn" data-testid="fixture-badge">FIXTURE MODE · 외부 호출 없음</span> : null}
      <span className="mono" title="현재 지도 영역(구독 bbox) 안의 항공기 수 — 수신이 끊긴 항공기도 stale(반투명)로 남는다">
        <span className="label mr-1">aircraft</span>{s.aircraftCount}
      </span>
      <span className="mono" data-testid="region-source"><span className="label mr-1">region</span>{s.feeds.region?.provider ?? "—"} · <span title={fmtIso(s.feeds.region?.fetched_at)}>{fmtClock(s.feeds.region?.fetched_at)}</span></span>
      <span className={`badge ${region.stale ? "bad" : "ok"}`} data-testid="lag-badge" title={`지역 피드 지연(경고 > ${REGION_STALE_S} s)`}>
        {region.lag == null ? "NO DATA" : `lag ${Math.round(region.lag)}s`}{region.lag != null && region.stale ? " · STALE" : ""}
      </span>
      <span className="mono" data-testid="global-source"><span className="label mr-1">world</span>{s.feeds.global?.provider ?? "—"}</span>
      <span className={`badge ${world == null ? "" : world.stale ? "bad" : "ok"}`} data-testid="global-lag-badge" title={world == null ? "전세계 피드 없음" : `전세계 피드 지연(경고 > ${GLOBAL_STALE_S} s)`}>
        {world == null ? "—" : world.lag == null ? "NO DATA" : `lag ${Math.round(world.lag)}s`}{world?.lag != null && world.stale ? " · STALE" : ""}
      </span>
      <span className="mono text-fg-2"><span className="label mr-1">sigmet</span>{s.sigmetsProvider} · {s.status?.sigmet.active ?? "—"} active · {now ? fmtAgo(s.sigmetsFetchedAt, now) : "—"}</span>
      <span className="mono text-fg-2"><span className="label mr-1">radar</span>{s.radar?.past.length ?? "—"} frames · {now ? fmtAgo(s.radar?.fetched_at, now) : "—"}{s.radarKr?.available ? ` · KMA ${s.radarKr.frames.length}f ${s.radarKr.latest_tm?.slice(8, 10)}:${s.radarKr.latest_tm?.slice(10, 12)}K` : ""}</span>
      <span className="mono text-fg-3"><span className="label mr-1">engine</span>{s.status?.engine.index_polygons ?? "—"} polys · {s.status?.engine.last_cycle_ms ?? "—"} ms</span>
      <span className="mono text-fg-3">v{s.snapshotVersion}</span>
    </div>
  );
}
