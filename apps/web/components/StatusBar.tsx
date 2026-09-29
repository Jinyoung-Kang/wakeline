"use client";
import { serverNowMs, useServerData } from "@/lib/store";
import { useNow } from "@/lib/clock";
import { fmtAgo, fmtClockKst, fmtTimeKstLabel, fmtUtcTitle, isKrRadarStale, KR_RADAR_STALE_S } from "@/lib/format";
import { aisBadge, aisGapBadge } from "@/lib/ships";
import { connTone, feedLag, GLOBAL_STALE_S, isRxFresh, lagTone, REGION_STALE_S, RX_FRESH_MS } from "@/lib/ws-protocol";
import { WsInvalidBadge } from "./WsInvalidBadge";

/** "12 frames" · 모르면 "frames —"(단위를 "—" 뒤에 붙이면 잰 값처럼 읽힌다 — /ops · /logs 와 같은 규칙). label 을 주면 모를 때 그 이름으로 */
const qty = (n: number | null | undefined, unit: string, label = unit) => (n == null ? `${label} —` : `${n} ${unit}`);
/** 기상청 tm(KST "YYYYMMDDHHMM" — 기상청이 한국 표준시로 준다) → "HH:MM KST". 형식이 아니면 "—" */
const kmaTmClock = (tm: string | null | undefined) => (tm && /^\d{12}$/.test(tm) ? `${tm.slice(8, 10)}:${tm.slice(10, 12)} KST` : "—");

/**
 * 상단 상태 바(FR-11): 연결 상태·지역/전세계 피드별 출처·수집 시각·지연 배지(지역 > 60 s, 전세계 > 300 s 면 경고)·SIGMET·레이더.
 * 지연은 서버가 보고한 값(스냅샷 sources·30 s status). "실시간"은 연결이 열려 있고 45 s 안에 무엇이든(ping 포함) 받은 경우만(WS-2) —
 * 끊김·일시정지·반쯤 열린 연결이면 받은 뒤 경과 시간을 더한다(화면 데이터가 멈췄으므로).
 * SIGMET·레이더 경과는 서버 시각끼리의 차이라 서버 기준 현재 시각으로 계산한다(WS-3).
 * AIS 구역이 여럿이면(계약 v4 §D) 일부 구역만 끊기거나 공백일 때 "n/m 구역"으로 말한다(전체 끊김처럼 보이지 않게).
 * 시각은 한국 표준시(" KST" — 사용자 요청 2026-09-29, title 에 원본 UTC). 기상청 tm 은 원래 KST 다.
 * 출처 표기는 가로 스크롤되는 이 줄이 아니라 모든 화면 하단의 고정 줄(AttributionFooter)에 있다(FR-20).
 * KMA STALE 처럼 따로 붙는 경고 배지는 연결 상태 바로 뒤에 둔다(R-31) — 1280 px 에서도 이 줄은 가로로 스크롤된다.
 * WS 형식 오류 배지(계약 v5 §E2): 받은 메시지에서 버린 원소·값 · 메시지 · 처리 예외의 누적 수를 단위별로 — 0 이면 없다. 단추라서 키보드 · 터치로
 * 상세(무엇을 버렸고 어떻게 다시 받는지 · 마지막 사유 · 복사)를 연다(WsInvalidBadge).
 */
export function StatusBar() {
  // useSyncExternalStore 의 getSnapshot 은 안정된 참조를 돌려줘야 한다 — 객체를 새로 만들지 않고 스토어 객체 자체를 선택한다.
  const s = useServerData((x) => x);
  const now = useNow(1000);
  const srvNow = now ? serverNowMs(now) : 0;
  const live = isRxFresh(s.conn, s.lastRxAt, now);
  const silent = s.conn === "open" && !live;
  const krStale = s.radarKr?.available ? isKrRadarStale(s.radarKr, srvNow) : false;
  const region = feedLag(s.feeds.region, now, live, REGION_STALE_S);
  const world = s.feeds.global ? feedLag(s.feeds.global, now, live, GLOBAL_STALE_S) : null;
  const fixture = s.status?.fixture_mode;
  // AIS(계약 v2 §B4): 연결·초당 메시지·지연 — 연결이 실시간이 아니면 받은 뒤 경과를 지연에 더한다(피드 지연과 같은 규칙)
  const ais = aisBadge(s.ais, now, live);
  const gap = aisGapBadge(s.ais, srvNow);
  // WS 수신 검증(계약 v5 §E2): 버린 원소·값 · 메시지 · 처리 예외(페이지를 연 뒤 누적). 0 이면 보이지 않는다
  const inv = s.wsInvalid;
  const invAny = inv.elements + inv.messages + inv.errors > 0;
  const connTitle = silent ? `연결은 열려 있지만 ${RX_FRESH_MS / 1000} s 넘게 아무것도 받지 못함 — 75 s 가 되면 다시 연결` : undefined;
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 overflow-x-auto border-b border-line bg-bg-1 px-3 text-[11px] whitespace-nowrap" data-testid="statusbar" role="group" aria-label="수집·연결 상태">
      <span className={`badge ${connTone(s.conn, silent, s.reconnectAttempt)}`} data-testid="conn" title={connTitle}>
        WS {s.conn}{silent ? " · 수신 없음" : ""}{s.conn !== "open" && s.reconnectAttempt > 0 ? ` · retry ${s.reconnectAttempt}` : ""}
      </span>
      {invAny ? <WsInvalidBadge inv={inv} /> : null}
      {fixture ? <span className="badge warn" data-testid="fixture-badge">FIXTURE MODE · 외부 호출 없음</span> : null}
      {/* 경고 배지는 앞쪽에 — 가로 스크롤 끝으로 밀려 보이지 않게 두지 않는다(R-31) */}
      {krStale ? <span className="badge bad" data-testid="kr-radar-stale" title={`기상청 레이더 수집이 ${KR_RADAR_STALE_S / 60}분 넘게 갱신되지 않음(마지막 수집 ${fmtTimeKstLabel(s.radarKr?.meta?.fetched_at)})`}>KMA STALE</span> : null}
      <span className="mono" data-testid="aircraft-count"
        title={s.aircraftCount == null ? "항공기 수 모름 — 항공기 레이어가 꺼져 있거나 아직 스냅샷을 받지 않음" : "현재 지도 영역(구독 bbox) 안의 항공기 수 — 수신이 끊긴 항공기도 stale(반투명)로 남는다"}>
        <span className="label mr-1">aircraft</span>{s.aircraftCount ?? "—"}
      </span>
      <span className="mono" data-testid="region-source"><span className="label mr-1">region</span>{s.feeds.region?.provider ?? "—"} · <span title={fmtUtcTitle(s.feeds.region?.fetched_at)}>{fmtClockKst(s.feeds.region?.fetched_at)}</span></span>
      <span className={`badge ${lagTone(region, s.conn, s.reconnectAttempt)}`} data-testid="lag-badge" title={`지역 피드 지연(경고 > ${REGION_STALE_S} s)`}>
        {region.lag == null ? "NO DATA" : `lag ${Math.round(region.lag)}s`}{region.lag != null && region.stale ? " · STALE" : ""}
      </span>
      <span className="mono" data-testid="global-source"><span className="label mr-1">world</span>{s.feeds.global?.provider ?? "—"}</span>
      <span className={`badge ${world == null ? "" : world.stale ? "bad" : "ok"}`} data-testid="global-lag-badge" title={world == null ? "전세계 피드 없음" : `전세계 피드 지연(경고 > ${GLOBAL_STALE_S} s)`}>
        {world == null ? "—" : world.lag == null ? "NO DATA" : `lag ${Math.round(world.lag)}s`}{world?.lag != null && world.stale ? " · STALE" : ""}
      </span>
      {ais ? <span className={`badge normal-case! ${ais.tone === "muted" ? "" : ais.tone}`} data-testid="ais-badge" data-tone={ais.tone} title={ais.title}>{ais.text}</span> : null}
      {gap ? <span className={`badge normal-case! ${gap.open && !gap.partial ? "bad" : "warn"}`} data-testid="ais-gap-badge" data-partial={gap.partial ? "true" : undefined} title={gap.title}>{gap.text}</span> : null}
      <span className="mono text-fg-2"><span className="label mr-1">sigmet</span>{s.sigmetsProvider} · {qty(s.status?.sigmet?.active, "active")} · {srvNow ? fmtAgo(s.sigmetsFetchedAt, srvNow) : "—"}</span>
      <span className="mono text-fg-2"><span className="label mr-1">radar</span>{qty(s.radar?.past.length, "frames")} · {srvNow ? fmtAgo(s.radar?.fetched_at, srvNow) : "—"}{s.radarKr?.available ? ` · KMA ${s.radarKr.frames.length}f ${kmaTmClock(s.radarKr.latest_tm)}` : ""}</span>
      <span className="mono text-fg-3"><span className="label mr-1">engine</span>{qty(s.status?.engine?.index_polygons, "polys")} · {qty(s.status?.engine?.last_cycle_ms, "ms", "cycle")}</span>
      <span className="mono text-fg-3">v{s.snapshotVersion}</span>
    </div>
  );
}
