/**
 * 한국 표준시(KST, UTC+09:00) 변환의 핵심 — 모든 화면(상황판 · 재생 · 통계 · 공항 · 운영 · 로그)과 로그 복사 텍스트가 쓴다.
 * 의존성 없음: 오류 경계 청크가 lib/log-line 을 거쳐 첫 로드에 싣는다(PERF §8 · tests/error-chunk-graph.test.ts). 화면 표시 형식은 lib/time(계약 v5 §G20 — KST 만).
 * 오프셋은 +09:00 고정 — tz 데이터베이스(Asia/Seoul)에서 +09:00 이 아닌 때는 1987·1988 여름(일광 절약)뿐이고
 * tests/kst-format.test.ts 가 2000–2040 을 Intl(Asia/Seoul)과 대조한다. 고정이라 보는 사람의 컴퓨터 시간대·ICU 자료와 상관없이 같은 글자가 나온다.
 */
export const KST_OFFSET_MS = 9 * 3_600_000;

/** 시각(ISO 문자열 · 숫자는 epoch ms) → KST ISO 8601 "YYYY-MM-DDTHH:MM:SS.mmm+09:00"(ms 유지). 읽을 수 없으면 null */
export function isoKst(v: string | number | null | undefined): string | null {
  if (v == null || v === "") return null;
  const t = new Date(v).getTime();
  if (!Number.isFinite(t)) return null;
  const shifted = new Date(t + KST_OFFSET_MS);
  if (!Number.isFinite(shifted.getTime())) return null; // Date 범위 끝(±8.64e15 ms)을 넘으면 toISOString 이 던진다
  const s = shifted.toISOString();
  // 0000–9999 년만 "YYYY-…Z"(24자) — 그 밖은 확장 연도("+012345-…")라 자리로 자를 수 없다
  return s.length === 24 ? `${s.slice(0, 23)}+09:00` : null;
}
