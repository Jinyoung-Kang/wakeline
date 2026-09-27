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
