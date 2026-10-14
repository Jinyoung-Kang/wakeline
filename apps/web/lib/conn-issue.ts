/**
 * 실시간 연결(WS)이 이어지지 않는 까닭 중 브라우저가 알 수 있는 것(React 없음) — 상태 바의 연결 칩과 알림 패널이 함께 적는다.
 * - locked · unreachable(QA-1300): 브라우저 WebSocket API 는 업그레이드 응답을 보여 주지 않아(실패 = close 1006) 앞단(AWS 데모 — ADR-039)의 잠금 만료(401)나
 *   오프라인 페이지(503 HTML)를 WS 로는 알 수 없다. 열린 적 없는 실패가 거듭되면 lib/ws 가 같은 출처 GET 하나(lib/endpoints/status)를 보내
 *   lib/front-answer 의 분류(ACCESS_LOCKED · ORIGIN_UNREACHABLE)로 가린다. 모르면 null — 짐작해 적지 않는다.
 * - limit(QA-1462): 서버가 연결 수 상한으로 닫음(close 1013 "connection limit" — api 의 IP 당 · 전체 WS 상한, 계약의 닫힘 코드). 같은 주소(IP)에서
 *   연 탭이 많으면(공개 데모는 IPv4 만 받아 NAT 뒤 방문자들이 한 주소를 나눈다 — ADR-039) 다른 탭을 닫아야 이어진다. 상한 수는 서버 설정이라 적지 않는다.
 * 연결이 다시 열리면(welcome) 지운다.
 */
import { ACCESS_LOCKED, FRONT_LOCKED_TEXT, FRONT_UNREACHABLE_TEXT, ORIGIN_UNREACHABLE } from "./front-answer";

export type ConnIssue = "locked" | "unreachable" | "limit";

/** 칩에 붙는 짧은 낱말과 까닭 문장(칩 title · 알림 패널) */
export const CONN_ISSUE: Record<ConnIssue, { word: string; why: string }> = {
  locked: { word: "접근 코드 만료", why: `${FRONT_LOCKED_TEXT}(실시간 연결은 앞단 잠금에 막혀 다시 이어지지 않음)` },
  unreachable: { word: "서버에 닿지 못함", why: FRONT_UNREACHABLE_TEXT },
  limit: {
    word: "연결 수 상한",
    why: "서버가 연결 수 상한으로 실시간 연결을 닫음(1013) — 같은 주소(IP)에서 연 상황판 탭이 많거나 서버 전체 연결이 가득 참 · 다른 탭을 닫으면 다음 재연결(최대 30 s 뒤)에 이어집니다",
  },
};

/** 서버가 연결 수 상한으로 닫을 때의 코드(api WakelineWsHandler — CloseStatus.SERVICE_OVERLOAD "connection limit") */
export const CLOSE_CONNECTION_LIMIT = 1013;

/** 같은 출처 확인 요청의 실패 → 까닭(앞단이 답한 오류만). 그 밖(망 오류 · api 의 오류)은 null */
export function connIssueOf(e: unknown): ConnIssue | null {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : null;
  return code === ACCESS_LOCKED ? "locked" : code === ORIGIN_UNREACHABLE ? "unreachable" : null;
}
