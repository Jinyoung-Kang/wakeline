/**
 * 서버가 준 값을 URL 경로 조각 하나로 쓴다(web-review B11): 인코딩하고('/' · '?' · '#' 가 경로를 바꾸지 않게), 정확히 "." · ".." 이면 거절한다 —
 * 그 둘은 인코딩해도 그대로 남는 점 조각이라(WHATWG URL 은 "%2e%2e" 도 '..' 로 읽는다) 경로가 제자리나 한 칸 위로 바뀌어 다른 자원 · 화면으로 간다
 * (예: /api/v1/ops/settings/.. → /api/v1/ops). 거절은 던짐 — 엔드포인트 함수는 async 라 요청을 보내지 않고 거절된 약속이 된다(부른 쪽이 오류로 보인다).
 */
export const isDotSegment = (v: string) => v === "." || v === "..";

export function pathSegment(v: string): string {
  if (isDotSegment(v)) throw new Error(`경로 조각으로 쓸 수 없는 값 "${v}" — 요청하지 않음`);
  return encodeURIComponent(v);
}
