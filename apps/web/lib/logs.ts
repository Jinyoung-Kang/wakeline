/**
 * 시스템 로그 화면 보조(계약 v5 §C7) — 순수 함수. 항목 형식은 schemas/log_event.v1.json, 조회 API 는 §C4(`/api/v1/ops/logs*`, 운영 세션 전용).
 * 모르는 값은 null/"—"(0·빈 값으로 채우지 않는다). 시각은 UTC.
 */

/** 복사 텍스트 첫 줄: `[시각 수준 서비스/로거] rid=…` — 요청 id 가 없으면 rid=— */
export function logHeaderLine(ts: string, level: string, service: string, logger: string, rid: string | null): string {
  return `[${ts} ${level} ${service}/${logger}] rid=${rid ?? "—"}`;
}
