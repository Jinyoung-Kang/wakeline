/** 통계 차트 보조(순수 함수). value=null = 자료 없음(0 이 아니다 — GAP-17). */
export interface ChartRow { label: string; value: number | null }

/** 스크린리더용 한 줄 요약: 항목 수·최댓값·자료 없는 항목 수 */
export function chartSummary(rows: ChartRow[], unit = ""): string {
  const known = rows.filter((r): r is { label: string; value: number } => r.value != null);
  if (known.length === 0) return `${rows.length}개 항목 모두 자료 없음`;
  const top = known.reduce((a, b) => (b.value > a.value ? b : a));
  const missing = rows.length - known.length;
  return `${rows.length}개 항목 · 최댓값 ${top.label} ${top.value}${unit}${missing ? ` · 자료 없음 ${missing}개` : ""}`;
}

/**
 * 시간대별(00–23 UTC) 행: 서버에 행이 없는 시간은 null(자료 없음) — 0 으로 채우지 않는다.
 * 서버 행의 시간 키는 hour 또는 dim("00".."23").
 */
export function hourlyRows(items: { hour?: string | null; dim?: string | null; value: unknown }[]): ChartRow[] {
  const byHour = new Map<string, number>();
  for (const r of items) {
    const h = String(r.hour ?? r.dim ?? "").padStart(2, "0");
    const v = Number(r.value);
    if (/^\d{2}$/.test(h) && Number.isFinite(v)) byHour.set(h, v);
  }
  return Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map((h) => ({ label: h, value: byHour.get(h) ?? null }));
}

// ---- 트래픽 범위(DH-10) ----

export interface TrafficRegion { center?: unknown; radius_nm?: unknown }

/**
 * 시간대별 트래픽이 센 범위. 서버는 그날 집계가 센 관심 지역(중심·반경, 계수는 그 원의 외접 bbox 안)을 함께 준다.
 * scope/region 이 없으면(지역 기록 전의 옛 집계 — 전세계 표본이 섞였을 수 있음) 범위를 단정하지 않는다.
 */
export function trafficScopeLabel(scope: unknown, region: TrafficRegion | null | undefined): { known: boolean; text: string } {
  const c = Array.isArray(region?.center) ? (region!.center as unknown[]) : null;
  const lat = typeof c?.[0] === "number" ? c[0] : null;
  const lon = typeof c?.[1] === "number" ? c[1] : null;
  const r = typeof region?.radius_nm === "number" ? region.radius_nm : null;
  if (scope !== "region" || lat == null || lon == null || r == null) return { known: false, text: "범위 미확인(전세계 표본 포함 가능)" };
  return { known: true, text: `관심 지역 · 중심 ${lat.toFixed(2)}, ${lon.toFixed(2)} · 반경 ${r} NM 원의 외접 bbox` };
}

// ---- 알림 통계 주의(수정 전 히스테리시스) ----

/**
 * 관측(OBSERVED) 알림 판정이 "엔진 주기"가 아니라 "서로 다른 관측"을 세도록 고쳐진 시각(api-engine 수정 배포, 오케스트레이터 기록).
 * 그 전에는 위치 보고 1건으로도 진입·이탈이 확정될 수 있었다(감사 COR-1·REL-5·PERF-5) — 그날까지의 관측 알림 건수·체류 시간은 이후와 비교할 수 없다.
 */
export const HYSTERESIS_FIX_AT = "2026-09-27T15:10:00Z";
const HYSTERESIS_FIX_DAY = HYSTERESIS_FIX_AT.slice(0, 10);

/** 이 통계 행이 수정 전 판정의 관측 알림을 (일부라도) 포함하는가 — UTC 날짜 ≤ 수정일인 OBSERVED 건수·체류 */
export function preFixHysteresis(r: { day?: unknown; metric?: unknown; dim?: unknown }): boolean {
  if (r.dim !== "OBSERVED") return false;
  if (r.metric !== "alerts_by_kind" && r.metric !== "alert_dwell_avg_s") return false;
  const d = typeof r.day === "string" ? r.day.slice(0, 10) : null;
  return d != null && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= HYSTERESIS_FIX_DAY;
}
