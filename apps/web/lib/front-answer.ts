/**
 * 앱 밖의 앞단(AWS 데모 — ADR-039: CloudFront · gate)이 api 대신 답한 응답을 알아보는 규칙(React · 전송 없음).
 * REST(lib/api apiError)와 ETag 조회기(lib/etag-poller)가 함께 쓴다 — 조회기는 전송(lib/api)을 거치지 않으므로 규칙을 여기에 둔다.
 * 알아본 오류에는 브라우저가 code 를 붙인다(서버가 준 code 가 아니다): ACCESS_LOCKED.
 */

/** 앞단 잠금 만료(gateLockedText)로 분류한 오류의 code */
export const ACCESS_LOCKED = "ACCESS_LOCKED";

/**
 * AWS 데모의 앞단 잠금(ADR-039 — 앱 밖의 gate): 접근 코드 쿠키가 만료되면 모든 요청이 401 {"error":"locked"} 다 — 무엇을 할지 알리는 글.
 * 그 밖의 응답이면 null.
 */
export function gateLockedText(status: number, body: unknown): string | null {
  return status === 401 && (body as { error?: unknown } | null)?.error === "locked" ? "접근 코드가 만료됨 — 새로고침하면 접근 코드를 다시 묻습니다" : null;
}
