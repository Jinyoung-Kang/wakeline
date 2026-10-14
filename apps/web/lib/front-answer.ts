/**
 * 앱 밖의 앞단(AWS 데모 — ADR-039: CloudFront · gate)이 api 대신 답한 응답을 알아보는 규칙(React · 전송 없음).
 * REST(lib/api apiError)와 ETag 조회기(lib/etag-poller)가 함께 쓴다 — 조회기는 전송(lib/api)을 거치지 않으므로 규칙을 여기에 둔다.
 * 알아본 오류에는 브라우저가 code 를 붙인다(서버가 준 code 가 아니다): ACCESS_LOCKED · ORIGIN_UNREACHABLE.
 */

const LOCKED_TEXT = "접근 코드가 만료됨 — 새로고침하면 접근 코드를 다시 묻습니다";
const UNREACHABLE_TEXT = "서버에 닿지 못함 — 서버가 꺼져 있거나(운영 시간 밖) 다시 시작하는 중일 수 있습니다 · 잠시 뒤 다시 시도하세요";

/** 앞단 잠금 만료(gateLockedText)로 분류한 오류의 code */
export const ACCESS_LOCKED = "ACCESS_LOCKED";
/** 앞단이 원본에 닿지 못함(frontUnreachableText)으로 분류한 오류의 code */
export const ORIGIN_UNREACHABLE = "ORIGIN_UNREACHABLE";

/**
 * AWS 데모의 앞단 잠금(ADR-039 — 앱 밖의 gate): 접근 코드 쿠키가 만료되면 모든 요청이 401 {"error":"locked"} 다 — 무엇을 할지 알리는 글.
 * 그 밖의 응답이면 null.
 */
export function gateLockedText(status: number, body: unknown): string | null {
  return status === 401 && (body as { error?: unknown } | null)?.error === "locked" ? LOCKED_TEXT : null;
}

/**
 * 앞단(AWS 데모의 CloudFront)이 원본에 닿지 못했다(QA-1302): 정지 시간(평일 18:00 뒤 · 주말)이나 재시작 중에는 원본 502 · 504 가 오프라인 안내 HTML
 * (503 text/html)로 바뀌어 온다. api 와 edge 는 /api 오류를 언제나 JSON(problem+json)으로 주므로(infra/edge/problem_pages.conf) /api 요청에 온
 * HTML 5xx 는 앞단의 페이지뿐이다 — 숫자("503") 대신 무엇이 일어났는지와 할 일을 알리는 글. 그 밖의 응답이면 null(본문 없는 5xx 는 까닭을 모른다).
 */
export function frontUnreachableText(status: number, contentType: string | null | undefined): string | null {
  return status >= 500 && /^\s*text\/html\b/i.test(contentType ?? "") ? UNREACHABLE_TEXT : null;
}

/**
 * 앞단이 답한 것으로 분류한 오류(code ACCESS_LOCKED · ORIGIN_UNREACHABLE — lib/api ApiError)의 안내 글, 그 밖이면 null.
 * status 만 보고 자기 문구를 고르는 화면(공항 기상 이력 · 재생 · 알림 근거 · 공항 탭 목록)이 먼저 본다(QA-1301) — 그러지 않으면 "HTTP 401" 만 남는다.
 */
export function frontNotice(e: unknown): string | null {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : null;
  return code === ACCESS_LOCKED ? LOCKED_TEXT : code === ORIGIN_UNREACHABLE ? UNREACHABLE_TEXT : null;
}
