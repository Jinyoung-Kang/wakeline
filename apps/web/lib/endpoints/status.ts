/**
 * 공개 상태 REST(계약 §2 GET /api/v1/status) — 실시간 연결(WS)의 업그레이드가 거듭 실패할 때 같은 출처 요청 하나로 앞단(AWS 데모의 잠금 gate ·
 * CloudFront 오프라인 페이지)이 막는지 가리는 데만 쓴다(lib/ws — QA-1300). 브라우저 WebSocket API 는 업그레이드 응답(401 · 503)을 보여 주지 않는다.
 * 본문은 보지 않는다(상태 바의 값은 WS status 가 준다).
 */
import { apiGet } from "@/lib/api";

export async function reachPublicStatus(o?: { signal?: AbortSignal }): Promise<void> {
  await apiGet<unknown>("/api/v1/status", o);
}
