/**
 * 로그 항목 텍스트의 첫 줄(머리) — 로그 화면(lib/logs)과 오류 화면(ErrorScreen)이 같은 틀을 쓴다.
 * 오류 경계 청크는 첫 로드에 받으므로 여기에는 의존성 없는 작은 함수만 둔다(PERF §8 · tests/error-chunk-graph.test.ts).
 */
export function logHeaderLine(ts: string, level: string, service: string, logger: string, rid: string | null): string {
  return `[${ts} ${level} ${service}/${logger}] rid=${rid ?? "—"}`;
}
