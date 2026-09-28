"use client";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { AlertStatsTable } from "@/components/AlertStatsTable";
import { BarChart } from "@/components/BarChart";
import { HYSTERESIS_FIX_AT, hourlyRows, trafficScopeLabel, type TrafficRegion } from "@/lib/chart";
import { fmtTime } from "@/lib/format";
import { aggregatedFlag, alertStatsRows, statsEmptyText, TRAFFIC_SOURCE, yesterdayUtc } from "@/lib/stats";
import { serverNowMs } from "@/lib/store";

type Row = { day: string; dim: string; value: number; metric?: string; hour?: string };
type ItemsResp = { items: Row[]; aggregated?: unknown };
type TrafficResp = ItemsResp & { scope?: string | null; region?: TrafficRegion | null };
/** 응답마다의 집계 여부(R-45 aggregated) — undefined = 모름 */
type Agg = { fir?: boolean; haz?: boolean; traffic?: boolean; alerts?: boolean };

/**
 * 통계(FR-24): FIR별 SIGMET · 시간대별 트래픽 · 알림 건수. stats_daily 는 매일 03:30 UTC 집계.
 * 행이 없는 시간대는 "자료 없음"(0 대로 그리지 않는다 — 수집 중단과 0 대를 구분할 수 없으므로).
 * 트래픽 제목은 서버가 준 범위(scope·region)를 그대로 — 범위 기록이 없는 날은 "범위 미확인"(DH-10).
 * 수정 전 히스테리시스로 판정된 관측 알림(≤ 2026-09-27)은 † 로 표시하고 비교할 수 없다고 밝힌다.
 * 알림 표는 날짜·종류마다 건수와 평균 체류(단위 포함)를 따로 보이고, 빈 상태는 집계 전·집계됨(자료 없음)·모름을 구분한다(R-32 · R-45 aggregated).
 */
export default function StatsPage() {
  const [fir, setFir] = useState<Row[]>([]);
  const [haz, setHaz] = useState<Row[]>([]);
  const [traffic, setTraffic] = useState<Row[]>([]);
  const [trafficScope, setTrafficScope] = useState<{ scope: unknown; region: TrafficRegion | null }>({ scope: null, region: null });
  const [alerts, setAlerts] = useState<Row[]>([]);
  const [agg, setAgg] = useState<Agg>({});
  /** 화면을 연 시각(서버 기준 추정) — 오늘·어제(UTC) 계산용 */
  const [openedAt] = useState(() => serverNowMs(Date.now()));
  // 오늘은 아직 집계되지 않는다(매일 03:30 UTC 에 전날을 집계) — 기본·최대는 어제(UTC)
  const [day, setDay] = useState(() => yesterdayUtc(openedAt));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true; // 날짜를 빨리 바꾸면 늦게 온 이전 날짜 응답이 새 날짜 제목 아래 그려지지 않게
    Promise.all([
      apiGet<ItemsResp>("/api/v1/stats/sigmet?group=fir"), apiGet<ItemsResp>("/api/v1/stats/sigmet?group=hazard"),
      apiGet<TrafficResp>(`/api/v1/stats/traffic?day=${encodeURIComponent(day)}`), apiGet<ItemsResp>("/api/v1/stats/alerts"),
    ]).then(([f, h, t, a]) => {
      if (!live) return;
      setFir(f.items); setHaz(h.items); setTraffic(t.items); setTrafficScope({ scope: t.scope ?? null, region: t.region ?? null }); setAlerts(a.items); setErr(null);
      setAgg({ fir: aggregatedFlag(f), haz: aggregatedFlag(h), traffic: aggregatedFlag(t), alerts: aggregatedFlag(a) });
    }).catch((e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [day]);
  const top = (rows: Row[]) => { const m = new Map<string, number>(); for (const r of rows) m.set(r.dim, (m.get(r.dim) ?? 0) + Number(r.value)); return [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 24); };
  const hours = hourlyRows(traffic);
  const scope = trafficScopeLabel(trafficScope.scope, trafficScope.region);
  const alertRows = alertStatsRows(alerts);
  const caveat = alertRows.some((r) => r.preFix);
  const today = new Date(openedAt).toISOString().slice(0, 10);
  const maxDay = yesterdayUtc(openedAt);
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-3"><h1 className="label">Statistics</h1><span className="text-[11px] text-fg-3">일 1회(03:30 UTC) 전날 집계 · 최근 7일 · 빈 칸은 집계 전·자료 없음을 구분해 표시</span>{err ? <span className="text-bad text-[11px]">{err}</span> : null}</div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <section className="panel p-3"><h2 className="label mb-2">SIGMET by FIR (7d, top 24)</h2>{fir.length ? <BarChart id="chart-fir" title="최근 7일 FIR별 SIGMET 발표 건수(상위 24)" rows={top(fir)} /> : <Empty text={statsEmptyText(agg.fir, null, today)} />}</section>
        <section className="panel p-3"><h2 className="label mb-2">SIGMET by hazard (7d)</h2>{haz.length ? <BarChart id="chart-hazard" title="최근 7일 위험 유형별 SIGMET 발표 건수" rows={top(haz)} color="#f59e0b" /> : <Empty text={statsEmptyText(agg.haz, null, today)} />}</section>
        <section className="panel p-3">
          <div className="mb-2 flex items-center justify-between gap-2"><h2 className="label">Distinct aircraft by hour (UTC)</h2><input type="date" value={day} max={maxDay} onChange={(e) => { if (e.target.value) setDay(e.target.value); }} aria-label="집계 날짜(UTC)" /></div>
          {traffic.length ? <div className={`mb-1 text-[11px] ${scope.known ? "text-fg-2" : "text-warn"}`} data-testid="traffic-scope">범위: {scope.text}</div> : null}
          {traffic.length ? <BarChart id="chart-traffic" title={`${day} UTC 시간대별 고유 항공기 수 — ${scope.text}`} rows={hours} color="#3ec98f" /> : <Empty text={statsEmptyText(agg.traffic, day, today, { ...TRAFFIC_SOURCE, nowMs: openedAt })} />}
          {traffic.length ? <div className="mt-1 text-[10px] text-fg-3">점선 “—” = 그 시간 자료 없음(수집 중단 또는 집계 전 — 0 대와 구분 불가)</div> : null}
        </section>
        <section className="panel p-3"><h2 className="label mb-2">Alerts by kind (7d) · avg dwell</h2>
          {alertRows.length ? <AlertStatsTable rows={alertRows} /> : <Empty text={statsEmptyText(agg.alerts, null, today)} />}
          {caveat ? <div className="mt-1 text-[10px] text-warn" data-testid="hysteresis-caveat">
            † {fmtTime(HYSTERESIS_FIX_AT)} 이전에 생성된 관측(OBSERVED) 알림은 수정 전 히스테리시스(엔진 주기를 관측으로 셈 — 위치 보고 1건으로 진입·이탈 확정 가능)로 판정됐습니다.
            그날까지의 관측 알림 건수는 부풀려졌을 수 있고, 건수·평균 체류 모두 이후 날짜와 같은 기준으로 비교할 수 없습니다.
          </div> : null}
        </section>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) { return <div className="py-6 text-center text-[11px] text-fg-3" data-testid="stats-empty">{text}</div>; }
