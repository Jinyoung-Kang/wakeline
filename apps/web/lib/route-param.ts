/**
 * 동적 경로 조각(params)의 값 → 사람이 친 글자(QA-1424). 이 Next(16.3.8)는 사용자 코드에 넘기는 params 를 encodeURIComponent 로 인코딩한다
 * (node_modules/next/dist/shared/lib/router/utils/get-dynamic-param.js getParamValue — "The value that is passed to user code"). 그대로 쓰면
 * 한글 · 전각 · 공백이 든 공유 링크의 머리가 "%EA%B9%80…"로 보이고, 경로 조각으로 다시 인코딩하면 api 에 "%25EA…"(다른 값)를 묻는다.
 * 한 번만 디코딩한다(잘못된 % 표기면 받은 그대로 — 던지지 않는다).
 */
export function routeParam(v: string): string {
  try { return decodeURIComponent(v); } catch { return v; }
}
