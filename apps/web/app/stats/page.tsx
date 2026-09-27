"use client";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import { BarChart } from "@/components/BarChart";
import { hourlyRows } from "@/lib/chart";

type Row = { day: string; dim: string; value: number; metric?: string; hour?: string };

/**
 * 통계(FR-24): FIR별 SIGMET · 시간대별 트래픽 · 알림 건수. stats_daily 는 매일 03:30 UTC 집계.
 * 행이 없는 시간대는 "자료 없음"(0 대로 그리지 않는다 — 수집 중단과 0 대를 구분할 수 없으므로).
 */
export default function StatsPage() {
  const [fir, setFir] = useState<Row[]>([]);
  const [haz, setHaz] = useState<Row[]>([]);
  const [traffic, setTraffic] = useState<Row[]>([]);
  const [alerts, setAlerts] = useState<Row[]>([]);
  const [day, setDay] = useState(() => new Date(Date.now() - 86400_000).toISOString().slice(0, 10));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([
      apiGet<{ items: Row[] }>("/api/v1/stats/sigmet?group=fir"), apiGet<{ items: Row[] }>("/api/v1/stats/sigmet?group=hazard"),
      apiGet<{ items: Row[] }>(`/api/v1/stats/traffic?day=${day}`), apiGet<{ items: Row[] }>("/api/v1/stats/alerts"),
    ]).then(([f, h, t, a]) => { setFir(f.items); setHaz(h.items); setTraffic(t.items); setAlerts(a.items); }).catch((e) => setErr(e.message));
  }, [day]);
  const agg = (rows: Row[]) => { const m = new Map<string, number>(); for (const r of rows) m.set(r.dim, (m.get(r.dim) ?? 0) + Number(r.value)); return [...m].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 24); };
  const hours = hourlyRows(traffic);
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-3"><h1 className="label">Statistics</h1><span className="text-[11px] text-fg-3">일 1회(03:30 UTC) 집계 · 최근 7일 · 집계 전이면 비어 있음</span>{err ? <span className="text-bad text-[11px]">{err}</span> : null}</div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <section className="panel p-3"><h2 className="label mb-2">SIGMET by FIR (7d, top 24)</h2>{fir.length ? <BarChart id="chart-fir" title="최근 7일 FIR별 SIGMET 발표 건수(상위 24)" rows={agg(fir)} /> : <Empty />}</section>
        <section className="panel p-3"><h2 className="label mb-2">SIGMET by hazard (7d)</h2>{haz.length ? <BarChart id="chart-hazard" title="최근 7일 위험 유형별 SIGMET 발표 건수" rows={agg(haz)} color="#f59e0b" /> : <Empty />}</section>
        <section className="panel p-3">
          <div className="mb-2 flex items-center justify-between"><h2 className="label">Distinct aircraft by hour (UTC) · 관심 지역</h2><input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="집계 날짜(UTC)" /></div>
          {traffic.length ? <BarChart id="chart-traffic" title={`${day} UTC 시간대별 관심 지역 고유 항공기 수`} rows={hours} color="#3ec98f" /> : <Empty />}
          {traffic.length ? <div className="mt-1 text-[10px] text-fg-3">점선 “—” = 그 시간 자료 없음(수집 중단 또는 집계 전 — 0 대와 구분 불가)</div> : null}
        </section>
        <section className="panel p-3"><h2 className="label mb-2">Alerts by kind (7d) · avg dwell</h2>
          {alerts.length ? <table><thead><tr><th scope="col">day</th><th scope="col">metric</th><th scope="col">dim</th><th scope="col">value</th></tr></thead><tbody>{alerts.map((r, i) => <tr key={i}><td className="mono">{String(r.day).slice(0, 10)}</td><td>{r.metric}</td><td>{r.dim}</td><td className="mono">{Number(r.value).toFixed(0)}</td></tr>)}</tbody></table> : <Empty />}
        </section>
      </div>
    </div>
  );
}

function Empty() { return <div className="py-6 text-center text-[11px] text-fg-3">아직 집계된 데이터가 없습니다(첫 집계는 다음 03:30 UTC).</div>; }
