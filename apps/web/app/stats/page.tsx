"use client";
import { useRef, useState, type ReactNode } from "react";
import { useApiResource } from "@/lib/use-api-resource";
import { alertStats, sigmetStats, trafficStats, type StatsItems, type StatsRow, type TrafficStats } from "@/lib/endpoints/stats";
import { AlertStatsTable } from "@/components/AlertStatsTable";
import { BarChart } from "@/components/BarChart";
import { ErrorNote } from "@/components/logs/ErrorNote";
import { HYSTERESIS_FIX_AT, HYSTERESIS_FIX_DAY, hourlyRowsKst, topDims, trafficScopeLabel } from "@/lib/chart";
import {
  alertStatsRows, flagOf, STATS_FAILED_NOTE, STATS_FAILED_TEXT, STATS_LOADING_TEXT, STATS_RUN_KST, STATS_ZONE_ERROR, STATS_ZONE_PANEL, statsEmptyText, statsPanelState,
  statsZoneOk, todayKst, TRAFFIC_SOURCE, yesterdayKst, zoneBad, type StatsLoad, type StatsPanelState,
} from "@/lib/stats";
import { serverNowMs } from "@/lib/store";
import { KstTime } from "@/components/KstTime";

/**
 * 통계(FR-24): FIR별 SIGMET · 시간대별 트래픽 · 알림 건수. api 가 매일 03:30 KST 에 전날(KST 날짜)을 센다(계약 v5 §G20 — stats_daily 의 날 = KST 날짜).
 * 날짜 · 시각은 모두 KST(lib/time) — 응답이 day_zone "Asia/Seoul" 로 KST 날짜라고 밝혀야 그린다(아니면 그리지 않고 그렇다고 말한다: 옛 api 의
 * UTC 날짜 집계를 KST 날짜로 보이지 않는다). 시간대별 막대는 그 KST 날짜의 00시 → 23시.
 * 행이 없는 시간대는 "자료 없음"(0 대로 그리지 않는다 — 수집 중단과 0 대를 구분할 수 없으므로).
 * 트래픽 제목은 서버가 준 범위(scope·region)를 그대로 — 범위 기록이 없는 날은 "범위 미확인"(DH-10).
 * 수정 전 히스테리시스로 판정된 관측 알림(≤ 2026-09-27)은 † 로 표시하고 비교할 수 없다고 밝힌다.
 * 알림 표는 날짜·종류마다 건수와 평균 체류(단위 포함)를 따로 보이고, 빈 상태는 집계 전·집계됨(자료 없음)·모름을 구분한다(R-32 · R-45 aggregated).
 * 패널마다 받기 상태를 따로 안다(lib/stats StatsLoad — 2026-09-30 22:49 KST 배포 직후 캡처가 받는 중 · 실패를 '자료 없음'으로 찍었다):
 * 받는 중 = 공유 진행 표시('불러오는 중' — lib/busy 의 나타남 지연 뒤), 받지 못함 = 그 패널만 '조회 실패' + HTTP 상태 · 요청 id + 다시 시도(그 패널만 다시 받는다),
 * 빈 상태 문구는 받은 응답에만. 패널마다 data-state(loading · ready · empty · error). SIGMET · 알림(최근 7일)은 한 번, 교통량은 날짜마다 받는다.
 */
export default function StatsPage() {
  const fir = useLoad("fir", (signal) => sigmetStats("fir", { signal }));
  const haz = useLoad("hazard", (signal) => sigmetStats("hazard", { signal }));
  const alerts = useLoad("alerts", (signal) => alertStats({ signal }));
  /** 화면을 연 시각(서버 기준 추정) — 오늘·어제(KST 날짜 — 집계 단위) 계산용 */
  const [openedAt] = useState(() => serverNowMs(Date.now()));
  // 오늘은 아직 집계되지 않는다(매일 03:30 KST 에 전날을 집계) — 기본·최대는 어제(KST 날짜)
  const [day, setDay] = useState(() => yesterdayKst(openedAt));
  // 날짜를 빨리 바꾸면 늦게 온 이전 날짜 응답은 버린다(useLoad — 열쇠가 바뀌면 그 응답을 쓰지 않는다)
  const traffic = useLoad<TrafficStats>(`traffic|${day}`, (signal) => trafficStats(day, { signal }));
  // KST 날짜라고 밝힌 응답의 행만 — 밝히지 않은 응답은 그리지 않고 집계 여부도 모름으로 둔다(빈 상태가 "자료 없음" 으로 단정하지 않게)
  const rowsOf = (l: StatsLoad<StatsItems>): StatsRow[] => (l.status === "loaded" && statsZoneOk(l.resp) ? l.resp.items : []);
  const agg = { fir: flagOf(fir.load), haz: flagOf(haz.load), traffic: flagOf(traffic.load), alerts: flagOf(alerts.load) };
  /** KST 날짜로 셌다고 밝히지 않은 응답(옛 api)이 있었는가 — 있으면 그 패널을 그리지 않고 위에서 한 번 말한다 */
  const zoneErr = [fir, haz, traffic, alerts].some((p) => zoneBad(p.load));
  const firRows = rowsOf(fir.load), hazRows = rowsOf(haz.load), trafficRows = rowsOf(traffic.load);
  const hours = hourlyRowsKst(trafficRows, day);
  const t = traffic.load.status === "loaded" ? traffic.load.resp : null;
  const scope = trafficScopeLabel(t?.scope ?? null, t?.region ?? null);
  const alertRows = alertStatsRows(rowsOf(alerts.load));
  const caveat = alertRows.some((r) => r.preFix);
  const today = todayKst(openedAt);
  const maxDay = yesterdayKst(openedAt);
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-3"><h1 className="label">Statistics</h1><span className="text-[11px] text-fg-3" title="api 집계 작업은 매일 03:30 KST 에 돈다 — 날짜는 한국 표준시 날짜(00:00–24:00 KST)">매일 {STATS_RUN_KST} 에 전날(KST 날짜) 집계 · 최근 7일 · 빈 칸은 집계 전·자료 없음을 구분해 표시</span></div>
      {zoneErr ? <div className="mb-3 text-[11px] text-warn" role="alert" data-testid="stats-zone-error">{STATS_ZONE_ERROR}</div> : null}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel id="fir" head={<h2 className="label mb-2">SIGMET by FIR (7d, top 24)</h2>} p={fir} drawable={firRows.length > 0} empty={statsEmptyText(agg.fir, null, today)}>
          <BarChart id="chart-fir" title="최근 7일 FIR별 SIGMET 발표 건수(상위 24)" rows={topDims(firRows)} />
        </Panel>
        <Panel id="hazard" head={<h2 className="label mb-2">SIGMET by hazard (7d)</h2>} p={haz} drawable={hazRows.length > 0} empty={statsEmptyText(agg.haz, null, today)}>
          <BarChart id="chart-hazard" title="최근 7일 위험 유형별 SIGMET 발표 건수" rows={topDims(hazRows)} color="#f59e0b" />
        </Panel>
        <Panel id="traffic" p={traffic} drawable={trafficRows.length > 0} empty={statsEmptyText(agg.traffic, day, today, { ...TRAFFIC_SOURCE, nowMs: openedAt })}
          head={<div className="mb-2 flex items-center justify-between gap-2"><h2 className="label">Distinct aircraft by hour (KST)</h2><input type="date" value={day} max={maxDay} onChange={(e) => { if (e.target.value) setDay(e.target.value); }} aria-label="집계 날짜(KST)" title="집계 날짜 = 한국 표준시 날짜(00:00–24:00 KST)" /></div>}>
          <div className={`mb-1 text-[11px] ${scope.known ? "text-fg-2" : "text-warn"}`} data-testid="traffic-scope">범위: {scope.text}</div>
          <BarChart id="chart-traffic" title={`${day}(KST 날짜) 시각별(KST) 고유 항공기 수 — ${scope.text}`} rows={hours} color="#3ec98f" />
          <div className="mt-1 text-[10px] text-fg-2" data-testid="traffic-hours-note">KST 날짜 {day}(00:00–24:00 KST) · 눈금 = KST 시</div>
          <div className="mt-1 text-[10px] text-fg-3">점선 “—” = 그 시간 자료 없음(수집 중단 또는 집계 전 — 0 대와 구분 불가)</div>
        </Panel>
        <Panel id="alerts" head={<h2 className="label mb-2">Alerts by kind (7d) · avg dwell</h2>} p={alerts} drawable={alertRows.length > 0} empty={statsEmptyText(agg.alerts, null, today)}>
          <AlertStatsTable rows={alertRows} />
          {caveat ? <div className="mt-1 text-[10px] text-warn" data-testid="hysteresis-caveat">
            † <KstTime v={HYSTERESIS_FIX_AT} /> 이전에 생성된 관측(OBSERVED) 알림은 수정 전 히스테리시스(엔진 주기를 관측으로 셈 — 위치 보고 1건으로 진입·이탈 확정 가능)로 판정됐습니다.
            † 표시 행(KST 날짜 {HYSTERESIS_FIX_DAY} 까지)의 관측 알림 건수는 부풀려졌을 수 있고, 건수·평균 체류 모두 이후 날짜와 같은 기준으로 비교할 수 없습니다.
          </div> : null}
        </Panel>
      </div>
    </div>
  );
}

/**
 * 요청 하나의 받기 상태(패널마다 따로 — lib/use-api-resource). 열쇠(무엇을 받는가 — 패널 · 날짜)가 바뀌거나 다시 시도하면 새로 받고, 그동안은 곧바로
 * '받는 중'이다 — 이전 날짜 · 이전 시도의 결과는 쓰지 않고, 떠 있던 요청은 끊는다. request 는 그때의 열쇠로 부르는 lib/endpoints/stats 함수.
 */
function useLoad<T>(what: string, request: (signal: AbortSignal) => Promise<T>): { load: StatsLoad<T>; retry: () => void } {
  const r = useApiResource(what, request);
  const load: StatsLoad<T> = r.status === "loaded" ? { status: "loaded", resp: r.data as T } : r.status === "failed" ? { status: "failed", error: r.error } : { status: "loading" };
  return { load, retry: r.retry };
}

/**
 * 통계 패널 하나: 머리(제목 · 날짜 고르기 — 어느 상태에서도 그대로) + 상태별 본문. data-state = loading · ready · empty · error(lib/stats statsPanelState).
 * - 받는 중: 공유 진행 표시(PanelLoading). 받지 못함: '조회 실패' + HTTP 상태 · 요청 id + 다시 시도(PanelError). 받았는데 그릴 것이 없음: 빈 상태 문구(empty) —
 *   KST 날짜로 셌다고 밝히지 않은 응답이면 그리지 않는다고(STATS_ZONE_PANEL). 그 밖: children.
 * 다시 시도를 누르면 단추가 사라지므로 초점을 패널로 옮긴다(키보드 · 화면 읽기 사용자가 자리를 잃지 않게).
 */
function Panel<T>({ id, head, p, drawable, empty, children }: { id: string; head: ReactNode; p: { load: StatsLoad<T>; retry: () => void }; drawable: boolean; empty: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const state: StatsPanelState = statsPanelState(p.load, drawable);
  const zone = p.load.status === "loaded" && !statsZoneOk(p.load.resp);
  return (
    <section ref={ref} className="panel p-3" data-stats-panel={id} data-state={state} tabIndex={-1}>
      {head}
      {state === "loading" ? <PanelLoading />
        : p.load.status === "failed" ? <PanelError error={p.load.error} onRetry={() => { ref.current?.focus(); p.retry(); }} />
        : state === "empty" ? <Empty text={zone ? STATS_ZONE_PANEL : empty} />
        : children}
    </section>
  );
}

/**
 * 받는 동안(진행 표시 규칙 — lib/busy · globals.css .busy-appear · .busy-bar · .skeleton): 글자 · 막대 · 자리 표시 모두 BUSY_APPEAR_DELAY_MS(선택값) 뒤에 보인다 —
 * 그보다 빨리 끝나는 조회는 번쩍이지 않는다. 글자(role=status)는 처음부터 DOM 에 있어 바로 읽힌다(aria-busy 조상 밖 — 자리 표시만 aria-busy). 자리 표시는
 * 값처럼 보이지 않는 무늬 없는 막대(aria-hidden).
 */
function PanelLoading() {
  return (
    <div className="busy-appear py-3" data-testid="stats-loading">
      <div role="status" className="text-[11px] text-fg-3">{STATS_LOADING_TEXT}</div>
      <span className="busy-bar mt-1" aria-hidden="true" />
      <div className="mt-2 flex flex-col gap-1.5" aria-busy="true" aria-hidden="true">
        <span className="skeleton h-3 w-40" />
        <span className="skeleton h-3 w-56" />
        <span className="skeleton h-3 w-32" />
      </div>
    </div>
  );
}

/** 받지 못함(계약 v5 §C8): '조회 실패' + 서버 문구 · HTTP 상태 · code · 요청 id(복사 · /logs) + 뜻('자료 없음'이 아님) + 다시 시도(이 패널만) */
function PanelError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="py-3 text-[11px]" data-testid="stats-error">
      <ErrorNote className="text-bad" prefix={`${STATS_FAILED_TEXT} — `} error={error} />
      <div className="mt-1 text-fg-3">{STATS_FAILED_NOTE}</div>
      <button type="button" className="btn mt-1.5" onClick={onRetry} data-testid="stats-retry">다시 시도</button>
    </div>
  );
}

function Empty({ text }: { text: string }) { return <div className="py-6 text-center text-[11px] text-fg-3" data-testid="stats-empty">{text}</div>; }
