/**
 * 통계 화면 표시 규칙(순수 함수, R-32 · R-45).
 * - day: api 는 "YYYY-MM-DD"(UTC 날짜)를 준다(ADR-017 R-45). 옛 응답의 "UTC 자정 시각" 문자열은 그 날짜로 읽고, 자정이 아닌 시각(다른 시간대 JVM)은
 *   날짜를 단정하지 않는다("—") — 하루 밀린 날짜를 보이지 않는다.
 * - aggregated: 집계 전(false)·집계됨(true)·모름(필드 없음). 빈 목록을 "자료 없음"으로 단정하지 않는다.
 */
import { preFixHysteresis } from "./chart";
import { fmtDuration } from "./format";

/** api MaintenanceJobs.CATCH_UP_DAYS — 놓친 날의 집계를 3시간마다 다시 시도하는 범위(최근 n일) */
export const STATS_CATCH_UP_DAYS = 7;
/** api MaintenanceJobs.catchUp 주기(fixedDelay 3 h) — 놓친 날의 다음 집계 시도는 늦어도 이만큼 뒤(api 가 돌고 있을 때) */
export const STATS_CATCH_UP_EVERY_H = 3;
/**
 * 교통량(traffic_by_hour)의 원본: 원해상도 항적(track_point) — api application.yml wakeline.track-retention-hours(72).
 * 재집계는 그날 끝이 now − 72 h 보다 뒤일 때만 교통량을 다시 센다(MaintenanceJobs.families, R-46). 그 뒤로는 채워지지 않는다.
 */
export const TRAFFIC_SOURCE = { name: "원본 항적", retentionH: 72 } as const;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function validDate(d: string): boolean {
  const m = DATE.exec(d);
  if (!m) return false;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return t.toISOString().slice(0, 10) === d;
}

/** 통계 행의 날짜(UTC). 모르면 null */
export function statsDay(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (validDate(v)) return v;
  const m = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?Z$/.exec(v);
  return m && validDate(m[1]) ? m[1] : null;
}

/** 응답의 aggregated(boolean 만). 없거나 형식이 틀리면 undefined(모름) */
export function aggregatedFlag(resp: unknown): boolean | undefined {
  const v = typeof resp === "object" && resp !== null ? (resp as { aggregated?: unknown }).aggregated : undefined;
  return typeof v === "boolean" ? v : undefined;
}

export function yesterdayUtc(nowMs: number): string {
  return new Date(nowMs - 86_400_000).toISOString().slice(0, 10);
}

/**
 * 빈 상태 문구. day = 조회한 날짜(최근 7일 묶음이면 null), today = 오늘(UTC 날짜).
 * 집계 전이면 채워질 때를 말하되, 따라잡기 범위 밖의 지난 날짜에는 "다음 집계"를 약속하지 않는다.
 * source = 그 계열의 원본 보존(예: TRAFFIC_SOURCE)과 지금 시각 — 주면 원본이 다음 집계 시도(늦어도 STATS_CATCH_UP_EVERY_H 뒤)까지
 * 남아 있을 때만 채워진다고 말한다(R-32). 원본이 이미 지워졌으면 채워지지 않는다고, 그 사이면 채워지지 않을 수 있다고 말한다.
 */
export function statsEmptyText(aggregated: boolean | undefined, day: string | null, today: string, source?: { name: string; retentionH: number; nowMs: number }): string {
  if (aggregated === true) return day ? "이 날짜에 자료가 없습니다(집계됨 · 해당 기록 없음)." : "최근 7일 자료가 없습니다(집계됨 · 해당 기록 없음).";
  if (aggregated === false) {
    const oldest = new Date(Date.parse(`${today}T00:00:00Z`) - STATS_CATCH_UP_DAYS * 86_400_000).toISOString().slice(0, 10);
    if (day != null && day < oldest) return `집계되지 않은 날짜입니다 — 따라잡기 범위(최근 ${STATS_CATCH_UP_DAYS}일) 밖이라 채워지지 않습니다(서비스 기록 전이거나 집계가 빠진 날).`;
    const dayStart = day != null ? Date.parse(`${day}T00:00:00Z`) : NaN;
    if (source && Number.isFinite(dayStart)) {
      // 재집계가 그날을 다시 세는 마지막 시각 = 그날 끝 + 원본 보존
      const keptUntil = dayStart + 86_400_000 + source.retentionH * 3600_000;
      if (keptUntil <= source.nowMs) return `집계되지 않은 날짜입니다 — ${source.name} 보존(${source.retentionH} h)이 지나 다시 셀 수 없어 채워지지 않습니다(서비스 기록 전이거나 집계가 빠진 날).`;
      if (keptUntil <= source.nowMs + STATS_CATCH_UP_EVERY_H * 3600_000) return `아직 집계되지 않았습니다 — ${source.name} 보존(${source.retentionH} h)이 곧 끝나 다음 집계 전에 지워지면 채워지지 않을 수 있습니다.`;
    }
    return `아직 집계되지 않았습니다 — 다음 03:30 UTC 집계 뒤 채워집니다(놓친 최근 ${STATS_CATCH_UP_DAYS}일은 3시간마다 따라잡기).`;
  }
  return "자료 없음 — 집계 전인지 기록이 없는지 이 응답으로는 구분할 수 없습니다(집계는 매일 03:30 UTC).";
}

// ---- 알림 통계 표 ----

export interface AlertStatsInput { day?: unknown; metric?: unknown; dim?: unknown; value?: unknown }
export interface AlertStatsRow { key: string; day: string; kind: string; count: string; dwell: string; dwellTitle: string | undefined; preFix: boolean }

const KIND_LABEL: Record<string, string> = { OBSERVED: "관측(경보 안)", PREDICTED: "예측(추정)" };
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * stats_daily 의 alerts_by_kind(건수)·alert_dwell_avg_s(평균 체류, 초)를 날짜·종류마다 한 행으로. 단위가 다른 값을 한 열에 섞지 않는다.
 * 없는 값은 "—". 수정 전 히스테리시스 행(chart.preFixHysteresis)은 preFix.
 * 날짜를 읽을 수 없는 행(statsDay → null)은 날짜 "—"로 보이되 서로 묶지 않는다 — 원문 날짜 문자열이 같을 때만 한 행(같은 날의 다른 지표),
 * 문자열이 아니면 행마다 따로(R-32). 다른 날의 값이 한 칸에서 서로 덮어쓰지 않게.
 */
export function alertStatsRows(items: AlertStatsInput[]): AlertStatsRow[] {
  const by = new Map<string, { day: string; dim: string; count: number | null; dwell: number | null; preFix: boolean }>();
  items.forEach((r, i) => {
    const dim = typeof r.dim === "string" ? r.dim : "";
    const known = statsDay(r.day);
    const day = known ?? "—";
    const k = `${known ?? (typeof r.day === "string" ? `?s:${r.day}` : `?i:${i}`)}|${dim}`;
    const cur = by.get(k) ?? { day, dim, count: null, dwell: null, preFix: false };
    if (r.metric === "alerts_by_kind") cur.count = num(r.value);
    else if (r.metric === "alert_dwell_avg_s") cur.dwell = num(r.value);
    else return;
    cur.preFix ||= preFixHysteresis({ day: known ?? undefined, metric: r.metric, dim });
    by.set(k, cur);
  });
  return [...by.entries()]
    .sort(([, a], [, b]) => a.day.localeCompare(b.day) || a.dim.localeCompare(b.dim))
    .map(([key, x]) => ({
      key, day: x.day, kind: KIND_LABEL[x.dim] ?? (x.dim || "—"),
      count: x.count == null ? "—" : `${Math.round(x.count).toLocaleString("en-US")}건`,
      dwell: fmtDuration(x.dwell), dwellTitle: x.dwell == null ? undefined : `${Math.round(x.dwell)} 초`, preFix: x.preFix,
    }));
}
