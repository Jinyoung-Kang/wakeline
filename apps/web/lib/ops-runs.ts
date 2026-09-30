/**
 * 운영 RUNS 요약 행 열기(errors F1 — 운영 2026-09-30: region adsb_fi error 13 중 공급자 해시에 남은 마지막 하나의 까닭만 보였다).
 * GET /api/v1/ops/runs(계약 v5 §G14 개정 2026-10-01): summary_24h 행마다 last_error_text · last_http_status(ok 가 아닌 행은 가장 최근 실행의 원문 · http,
 * 없으면 null · ok 행은 늘 null — 키가 없으면 옛 api), 응답의 summary_since(요약 창의 시작 — UTC ISO), 목록 필터 job · provider · status · since · cursor.
 */

/** 요약 행 하나를 가리키는 열쇠 */
export interface RunKey { job: string; provider: string; status: string }

/** 한 번에 받는 실행 수(api 상한 200 안) */
export const RUNS_DRILL_LIMIT = 50;

/** 요약 행 → 열쇠. 세 값이 모두 글자일 때만(그 밖은 열 수 없다 — null) */
export function runKeyOf(row: Record<string, unknown>): RunKey | null {
  const { job, provider, status } = row;
  return typeof job === "string" && typeof provider === "string" && typeof status === "string" ? { job, provider, status } : null;
}

/** 열쇠를 한 글자로(열린 행 찾기 · React key) */
export const runKeyId = (k: RunKey): string => JSON.stringify([k.job, k.provider, k.status]);

/**
 * 그 행의 실행 목록 경로. since = 응답의 summary_since 그대로(요약과 같은 창 — 브라우저 시계로 만들지 않는다), 모르면 빼고(기간 제한 없음 — 화면이 그렇게 말한다).
 * cursor = 앞 쪽의 next_cursor(더 보기).
 */
export function runsDrillPath(k: RunKey, since: string | null, cursor: number | null): string {
  const q = new URLSearchParams({ job: k.job, provider: k.provider, status: k.status });
  if (since) q.set("since", since);
  q.set("limit", String(RUNS_DRILL_LIMIT));
  if (cursor != null) q.set("cursor", String(cursor));
  return `/api/v1/ops/runs?${q.toString()}`;
}

/** 응답의 summary_since — 시간대가 있는 ISO 순간일 때만(그 밖은 모름 — null) */
export function summarySince(resp: unknown): string | null {
  const v = typeof resp === "object" && resp !== null ? (resp as Record<string, unknown>).summary_since : undefined;
  return typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
}

/**
 * 요약 행의 마지막 오류: known = api 가 last_error_text 키를 실었다(옛 api 는 없다 — 그때는 '모름', '글자 없음' 이 아니다),
 * text = 원문(글자가 아니면 null) · http = 정수 http(아니면 null).
 */
export function summaryLastError(row: Record<string, unknown>): { known: boolean; text: string | null; http: number | null } {
  const known = "last_error_text" in row;
  const text = typeof row.last_error_text === "string" && row.last_error_text !== "" ? row.last_error_text : null;
  const http = typeof row.last_http_status === "number" && Number.isInteger(row.last_http_status) ? row.last_http_status : null;
  return { known, text, http };
}

/** 다음 쪽을 뒤에 붙인다 — 이미 보인 id 는 다시 넣지 않는다(쪽 사이에 새 실행이 들어와도 id 커서라 겹치지 않지만, 겹쳐도 한 번만) */
export function appendRunsPage<T extends { id?: unknown }>(prev: readonly T[], next: readonly T[]): T[] {
  const seen = new Set(prev.map((r) => String(r.id)));
  return [...prev, ...next.filter((r) => !seen.has(String(r.id)))];
}
