/**
 * 로그 항목 텍스트의 첫 줄(머리) — 로그 화면(lib/logs)과 오류 화면(ErrorScreen)이 같은 틀을 쓴다.
 * 오류 경계 청크는 첫 로드에 받으므로 여기에는 의존성 없는 작은 함수만 둔다(PERF §8 · tests/error-chunk-graph.test.ts — lib/kst 도 의존성 없음).
 */
import { isoKst } from "./kst";

/**
 * `[시각 수준 서비스/로거] rid=…` — 시각은 한국 표준시, 오프셋을 붙인 ISO 8601("2026-09-29T08:41:14.906+09:00", ms 유지 — 운영·로그 화면이 KST).
 * at 은 ISO 문자열 또는 epoch ms. 읽을 수 없으면 "—", 요청 id 가 없으면 rid=—.
 */
export function logHeaderLine(at: string | number, level: string, service: string, logger: string, rid: string | null): string {
  return `[${isoKst(at) ?? "—"} ${level} ${service}/${logger}] rid=${rid ?? "—"}`;
}
