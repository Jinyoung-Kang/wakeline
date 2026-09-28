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
 */
export function statsEmptyText(aggregated: boolean | undefined, day: string | null, today: string): string {
  if (aggregated === true) return day ? "이 날짜에 자료가 없습니다(집계됨 · 해당 기록 없음)." : "최근 7일 자료가 없습니다(집계됨 · 해당 기록 없음).";
  if (aggregated === false) {
    const oldest = new Date(Date.parse(`${today}T00:00:00Z`) - STATS_CATCH_UP_DAYS * 86_400_000).toISOString().slice(0, 10);
    if (day != null && day < oldest) return `집계되지 않은 날짜입니다 — 따라잡기 범위(최근 ${STATS_CATCH_UP_DAYS}일) 밖이라 채워지지 않습니다(서비스 기록 전이거나 집계가 빠진 날).`;
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
 */
export function alertStatsRows(items: AlertStatsInput[]): AlertStatsRow[] {
  const by = new Map<string, { day: string; dim: string; count: number | null; dwell: number | null; preFix: boolean }>();
  for (const r of items) {
    const dim = typeof r.dim === "string" ? r.dim : "";
    const day = statsDay(r.day) ?? "—";
    const k = `${day}|${dim}`;
    const cur = by.get(k) ?? { day, dim, count: null, dwell: null, preFix: false };
    if (r.metric === "alerts_by_kind") cur.count = num(r.value);
    else if (r.metric === "alert_dwell_avg_s") cur.dwell = num(r.value);
    else continue;
    cur.preFix ||= preFixHysteresis({ day: statsDay(r.day) ?? undefined, metric: r.metric, dim });
    by.set(k, cur);
  }
  return [...by.entries()]
    .sort(([, a], [, b]) => a.day.localeCompare(b.day) || a.dim.localeCompare(b.dim))
    .map(([key, x]) => ({
      key, day: x.day, kind: KIND_LABEL[x.dim] ?? (x.dim || "—"),
      count: x.count == null ? "—" : `${Math.round(x.count).toLocaleString("en-US")}건`,
      dwell: fmtDuration(x.dwell), dwellTitle: x.dwell == null ? undefined : `${Math.round(x.dwell)} 초`, preFix: x.preFix,
    }));
}
