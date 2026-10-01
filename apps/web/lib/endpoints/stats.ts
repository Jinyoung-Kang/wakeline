/**
 * 통계 REST(web-review §3.1 · FR-24) — 통계 화면(app/stats)만 부른다. 경로는 api 그대로(tests/stats-states 가 본다), 날짜는 인코딩한다.
 * 본문의 KST 날짜 여부(day_zone) · 집계 여부(aggregated)는 화면이 lib/stats 로 읽는다 — 여기서는 모양만 적는다. { signal } 은 그대로 넘긴다.
 */
import { apiGet } from "@/lib/api";
import type { TrafficRegion } from "@/lib/chart";

type Opts = { signal?: AbortSignal };

export type StatsRow = { day: string; dim: string; value: number; metric?: string; hour?: string };
export type StatsItems = { items: StatsRow[]; aggregated?: unknown; day_zone?: unknown };
export type TrafficStats = StatsItems & { scope?: string | null; region?: TrafficRegion | null };

/** 최근 7일 SIGMET 발표 수 — FIR 별 · 위험 유형별 */
export function sigmetStats(group: "fir" | "hazard", o?: Opts): Promise<StatsItems> {
  return apiGet<StatsItems>(`/api/v1/stats/sigmet?group=${group}`, o);
}

/** 최근 7일 알림 건수 · 평균 체류 */
export function alertStats(o?: Opts): Promise<StatsItems> {
  return apiGet<StatsItems>("/api/v1/stats/alerts", o);
}

/** 그 KST 날짜(yyyy-mm-dd)의 시각별 고유 항공기 수와 범위(scope · region) */
export function trafficStats(day: string, o?: Opts): Promise<TrafficStats> {
  return apiGet<TrafficStats>(`/api/v1/stats/traffic?day=${encodeURIComponent(day)}`, o);
}
