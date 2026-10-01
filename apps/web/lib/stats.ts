/**
 * 통계 화면 표시 규칙(순수 함수, R-32 · R-45).
 * - day: api 는 KST 날짜 "YYYY-MM-DD" 를 준다(계약 v5 §G20 — 응답 day_zone "Asia/Seoul", ADR-017 R-45 의 날짜 문자열). 날짜 문자열이 아닌 값
 *   (옛 응답의 "UTC 자정 시각" 문자열 — UTC 날짜였다 · 다른 시간대 JVM 의 자정)은 날짜를 단정하지 않는다("—") — 다른 하루를 KST 날짜로 보이지 않는다.
 * - day_zone: KST 날짜로 셌다고 밝힌 응답만 그린다(statsZoneOk) — 밝히지 않은 응답(옛 api — UTC 날짜 집계)은 그리지 않고 그렇다고 말한다.
 * - aggregated: 집계 전(false)·집계됨(true)·모름(필드 없음). 빈 목록을 "자료 없음"으로 단정하지 않는다. 하루 응답(교통량)은 최상위 aggregated,
 *   최근 7일 응답(SIGMET · 알림)은 날짜별 days[].aggregated(api StatsRepository.days — 최상위 aggregated 는 없다, QA-308)로 읽는다(statsDays).
 */
import { preFixHysteresis } from "./chart";
import { fmtDuration } from "./format";
import { addDays, DISPLAY_TZ, isCalendarDay, kstDayOf, kstDayStartMs } from "./time";

/**
 * 일 집계 시각(api MaintenanceJobs.aggregateDaily — @Scheduled(cron = "0 30 3 * * *", zone = "Asia/Seoul"), 매일 03:30 KST 에 전날(KST 날짜)을 센다).
 */
export const STATS_RUN_KST = "03:30 KST";
/** api MaintenanceJobs.CATCH_UP_DAYS — 놓친 날의 집계를 3시간마다 다시 시도하는 범위(최근 n일) */
export const STATS_CATCH_UP_DAYS = 7;
/** api MaintenanceJobs.catchUp 주기(fixedDelay 3 h) — 놓친 날의 다음 집계 시도는 늦어도 이만큼 뒤(api 가 돌고 있을 때) */
export const STATS_CATCH_UP_EVERY_H = 3;
/**
 * 교통량(traffic_by_hour)의 원본: 원해상도 항적(track_point) — api application.yml wakeline.track-retention-hours(72).
 * 항적은 UTC 날 파티션에 있고 파티션째 지워진다(api V2 · V9 — 파티션 끝 ≤ now − 72 h). KST 날짜 하루는 두 파티션에 걸치고 앞 파티션(00:00–08:59 KST)이
 * 먼저 지워지므로, 재집계는 그날 첫 순간이 든 파티션의 끝이 now − 72 h 보다 뒤일 때만 교통량을 다시 센다(MaintenanceJobs.families, R-46). 그 뒤로는 채워지지 않는다.
 */
export const TRAFFIC_SOURCE = { name: "원본 항적", retentionH: 72 } as const;
/** 순간 t(epoch ms)가 든 항적 파티션(UTC 날 [d, d+1))의 끝 = 다음 UTC 날 00:00(epoch ms) — api MaintenanceJobs.trackPartitionEnd 와 같은 셈 */
export const trackPartitionEndMs = (t: number): number => Math.floor(t / 86_400_000) * 86_400_000 + 86_400_000;

/** 통계 행의 날짜(KST 날짜 — 집계 단위). "YYYY-MM-DD" 로 달력에 있는 날만, 그 밖은 null(날짜를 단정하지 않는다) */
export function statsDay(v: unknown): string | null {
  return typeof v === "string" && isCalendarDay(v) ? v : null;
}

/** 응답의 aggregated(boolean 만). 없거나 형식이 틀리면 undefined(모름) */
export function aggregatedFlag(resp: unknown): boolean | undefined {
  const v = typeof resp === "object" && resp !== null ? (resp as { aggregated?: unknown }).aggregated : undefined;
  return typeof v === "boolean" ? v : undefined;
}

/** 응답이 KST 날짜로 셌다고 밝혔는가(day_zone === "Asia/Seoul" — 계약 v5 §G20). 아니면 그 날짜 · 시를 KST 로 그리지 않는다 */
export function statsZoneOk(resp: unknown): boolean {
  return typeof resp === "object" && resp !== null && (resp as { day_zone?: unknown }).day_zone === DISPLAY_TZ.iana;
}
/** KST 날짜로 셌다고 밝히지 않은 응답을 그리지 않을 때의 문구 */
export const STATS_ZONE_ERROR = "통계 응답이 KST 날짜로 센 응답이 아님(day_zone 없음 — api 가 이 화면보다 옛 판일 수 있음) — 다른 하루를 KST 날짜로 보이지 않도록 그리지 않음";

/** 오늘(KST 날짜) "YYYY-MM-DD". 지금을 모르면(0 · NaN) "" */
export function todayKst(nowMs: number): string {
  return kstDayOf(nowMs) ?? "";
}
/** 어제(KST 날짜) — 통계 날짜 고르기의 기본 · 최대(오늘은 아직 끝나지 않아 집계 전) */
export function yesterdayKst(nowMs: number): string {
  return addDays(todayKst(nowMs), -1) ?? "";
}

/**
 * 통계 날짜 칸에 넣은 값 → 조회할 날짜(QA-309 — 칸은 max = 어제(KST)인데 입력을 검사하지 않아, ↑ 키나 직접 입력으로 한 달 뒤 날짜를 넣으면 그 날로
 * 조회하고 "다음 03:30 KST 집계 뒤 채워집니다"라고 약속했다). 달력 날짜가 아니면 null(바꾸지 않는다), max 보다 뒤면 max(가장 최근 집계 날짜).
 */
export function statsPickDay(value: string, max: string): { day: string; clamped: boolean } | null {
  if (!isCalendarDay(value)) return null;
  return max && value > max ? { day: max, clamped: true } : { day: value, clamped: false };
}
/** 날짜 칸이 미래 날짜를 받아 최근 집계 날짜로 되돌렸을 때의 안내 */
export const STATS_FUTURE_DAY_NOTE = "아직 오지 않았거나 끝나지 않은 날짜는 고를 수 없습니다 — 가장 최근 집계 날짜(어제 · KST)로 맞춤";

/**
 * 빈 상태 문구. day = 조회한 날짜(KST — 이 화면에서는 교통량만 날짜로 묻는다, 최근 7일 묶음이면 null), today = 오늘(KST 날짜).
 * (따라잡기 창 밖의 SIGMET · 알림 날은 api 가 원본이 남은 만큼 채운다 — MaintenanceJobs.backfillStats. 이 화면은 그 계열을 최근 7일 묶음으로만 묻는다.)
 * 집계 전이면 채워질 때를 말하되, 따라잡기 범위 밖의 지난 날짜에는 "다음 집계"를 약속하지 않는다.
 * source = 원본이 UTC 날 파티션째 지워지는 계열의 보존(TRAFFIC_SOURCE — 원해상도 항적)과 지금 시각 — 주면 그날 첫 파티션이 다음 집계 시도(늦어도
 * STATS_CATCH_UP_EVERY_H 뒤)까지 남아 있을 때만 채워진다고 말한다(R-32). 이미 지워졌으면 채워지지 않는다고, 그 사이면 채워지지 않을 수 있다고 말한다.
 * "집계되지 않은 날짜" 의 이유에는 KST 날짜 집계로 바꾸기 전 날짜(계약 v5 §G20 — 원본이 남은 만큼만 다시 셌다)도 든다.
 */
export function statsEmptyText(aggregated: boolean | undefined, day: string | null, today: string, source?: { name: string; retentionH: number; nowMs: number }): string {
  if (aggregated === true) return day ? "이 날짜에 자료가 없습니다(집계됨 · 해당 기록 없음)." : "최근 7일 자료가 없습니다(집계됨 · 해당 기록 없음).";
  // 오늘(KST)보다 뒤 — 집계할 날이 아직 오지 않았다: '다음 집계 뒤 채워집니다'를 약속하지 않는다(QA-309)
  if (day != null && today && day > today) return "아직 오지 않은 날짜입니다 — 집계할 기록이 없습니다(통계 날짜는 어제(KST)까지).";
  const why = "서비스 기록 전 · 집계가 빠진 날 · KST 날짜 집계로 바꾸기 전 날짜";
  if (aggregated === false) {
    const oldest = addDays(today, -STATS_CATCH_UP_DAYS);
    if (day != null && oldest != null && day < oldest) return `집계되지 않은 날짜입니다 — 따라잡기 범위(최근 ${STATS_CATCH_UP_DAYS}일) 밖이라 채워지지 않습니다(${why}).`;
    const dayStart = kstDayStartMs(day);
    if (source && dayStart != null) {
      // 재집계가 그날을 다시 세는 마지막 시각 = 그날 첫 순간(00:00 KST)이 든 UTC 파티션의 끝 + 원본 보존(그날 끝이 아니다 — 앞 파티션이 먼저 지워진다)
      const keptUntil = trackPartitionEndMs(dayStart) + source.retentionH * 3600_000;
      if (keptUntil <= source.nowMs) return `집계되지 않은 날짜입니다 — ${source.name} 보존(${source.retentionH} h)이 지나 다시 셀 수 없어 채워지지 않습니다(${why}).`;
      if (keptUntil <= source.nowMs + STATS_CATCH_UP_EVERY_H * 3600_000) return `아직 집계되지 않았습니다 — ${source.name} 보존(${source.retentionH} h)이 곧 끝나 다음 집계 전에 지워지면 채워지지 않을 수 있습니다.`;
    }
    return `아직 집계되지 않았습니다 — 다음 ${STATS_RUN_KST} 집계 뒤 채워집니다(놓친 최근 ${STATS_CATCH_UP_DAYS}일은 3시간마다 따라잡기).`;
  }
  return `자료 없음 — 집계 전인지 기록이 없는지 이 응답으로는 구분할 수 없습니다(집계는 매일 ${STATS_RUN_KST}).`;
}

/** 최근 7일 응답의 날짜별 집계 여부 — 지난 날(오늘 KST 전)만: done = 집계됨, pending = 집계 전(날짜순, KST 날짜 "YYYY-MM-DD") */
export interface StatsDays { done: string[]; pending: string[] }

/**
 * 최근 7일 응답(/stats/sigmet · /stats/alerts)의 days[] — api StatsRepository.days: 범위 [오늘−7, 오늘](KST 날짜)의 날마다 {day, aggregated}(날짜순,
 * REST 계약 STATS_DAYS). 오늘은 끝나지 않아 늘 집계 전이라 빼고 지난 7일만 본다. days 가 없거나 한 줄이라도 모양이 틀리면 null(모름 — 짐작하지 않는다).
 * (전에는 최상위 aggregated 만 읽었는데 7일 응답에는 그 필드가 없어, 지난 7일이 모두 집계됐어도 '구분할 수 없습니다'라고 했다 — QA-308)
 */
export function statsDays(resp: unknown, today: string): StatsDays | null {
  const days = typeof resp === "object" && resp !== null ? (resp as { days?: unknown }).days : undefined;
  if (!Array.isArray(days)) return null;
  const out: StatsDays = { done: [], pending: [] };
  for (const d of days) {
    const day = typeof d === "object" && d !== null ? statsDay((d as { day?: unknown }).day) : null;
    const agg = typeof d === "object" && d !== null ? (d as { aggregated?: unknown }).aggregated : undefined;
    if (day == null || typeof agg !== "boolean") return null;
    if (today && day >= today) continue;
    (agg ? out.done : out.pending).push(day);
  }
  return out.done.length + out.pending.length ? out : null;
}

/**
 * 최근 7일 패널의 빈 상태 문구(행이 하나도 없을 때): 지난 날이 모두 집계됨 → '자료 없음(집계됨)', 모두 집계 전 → 다음 집계 뒤 채워짐,
 * 섞여 있으면 둘을 나눠 말한다(집계 전 날짜를 KST 날짜 MM-DD 로). 날짜별 집계를 모르면(null) '구분할 수 없음'.
 */
export function statsWeekEmptyText(s: StatsDays | null, today: string): string {
  if (!s) return statsEmptyText(undefined, null, today);
  if (!s.pending.length) return statsEmptyText(true, null, today);
  if (!s.done.length) return statsEmptyText(false, null, today);
  return `집계된 ${s.done.length}일에는 자료가 없습니다 · 집계 전 ${s.pending.length}일(KST ${s.pending.map((d) => d.slice(5)).join(" · ")})은 다음 ${STATS_RUN_KST} 집계 뒤 채워집니다(놓친 최근 ${STATS_CATCH_UP_DAYS}일은 3시간마다 따라잡기).`;
}

// ---- 패널마다의 받기 상태 ----

/**
 * 통계 패널 하나의 요청 상태(패널마다 따로 — 한 요청의 실패가 다른 패널을 비우지 않는다). 2026-09-30 22:49 KST 배포 직후 설명서 캡처: api 재시작 6분 뒤
 * DB 가 바쁠 때 네 패널이 모두 '자료 없음 — … 구분할 수 없습니다'로 찍혔다(받기 전 · 실패를 빈 응답처럼 보였다). 빈 상태 문구(statsEmptyText)는 loaded 에만 쓴다.
 */
export type StatsLoad<T = unknown> = { status: "loading" } | { status: "loaded"; resp: T } | { status: "failed"; error: unknown };
/** 패널의 data-state(시험 · 설명서 캡처가 읽는다): 받는 중 · 그릴 행이 있음 · 받았지만 그릴 것이 없음 · 받지 못함 */
/** 받은 응답의 집계 여부(R-45 aggregated) — KST 날짜로 셌다고 밝힌 응답만, 그 밖(받는 중 · 실패 · 옛 응답)은 undefined(모름) */
export function flagOf(l: StatsLoad): boolean | undefined {
  return l.status === "loaded" && statsZoneOk(l.resp) ? aggregatedFlag(l.resp) : undefined;
}
/** 받은 최근 7일 응답의 날짜별 집계(statsDays) — KST 날짜로 셌다고 밝힌 응답만, 그 밖은 null(모름) */
export function daysOf(l: StatsLoad, today: string): StatsDays | null {
  return l.status === "loaded" && statsZoneOk(l.resp) ? statsDays(l.resp, today) : null;
}
/** 받았지만 KST 날짜로 셌다고 밝히지 않은 응답(옛 api — UTC 날짜 집계) */
export function zoneBad(l: StatsLoad): boolean {
  return l.status === "loaded" && !statsZoneOk(l.resp);
}

export type StatsPanelState = "loading" | "ready" | "empty" | "error";
export function statsPanelState(load: StatsLoad, drawable: boolean): StatsPanelState {
  return load.status === "loading" ? "loading" : load.status === "failed" ? "error" : drawable ? "ready" : "empty";
}
/** 받는 동안의 글자(공유 진행 표시 — lib/busy) */
export const STATS_LOADING_TEXT = "불러오는 중";
/** 받지 못했을 때의 머리말 — 뒤에 서버 문구 · HTTP 상태 · 요청 id(ErrorNote) */
export const STATS_FAILED_TEXT = "조회 실패";
/** 받지 못했을 때 덧붙이는 뜻 — '자료 없음'이 아니다 */
export const STATS_FAILED_NOTE = "응답을 받지 못해 자료가 있는지 알 수 없습니다(‘자료 없음’이 아님).";
/** KST 날짜로 셌다고 밝히지 않은 응답(옛 api)의 패널 — 받았지만 그리지 않는다(위 알림 STATS_ZONE_ERROR 가 까닭을 말한다) */
export const STATS_ZONE_PANEL = "그리지 않음 — KST 날짜로 센 응답이 아님(위 알림)";

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
