# ADR-008 WebSocket 은 원시 JSON + 단조 증가 버전(STOMP 미사용)

`hello → welcome → subscribe(bbox, zoom, detail) → snapshot → diff(v)…`. 연결당 구독 1개, 클라이언트 메시지 ≤ 4 KB, hello 5 s, ping 30 s(2회 무응답 종료), 전체 200 · IP당 5 연결. 세션마다 "마지막으로 보낸 상태" 를 두고 뷰포트 안에서만 diff 를 계산한다(위치 1e-4°, 고도 25 ft, 속도 1 kt, 방위 1°). 30 s 마다 전체 스냅샷으로 누적 오차를 지운다. 백프레셔는 `ConcurrentWebSocketSessionDecorator(5 s, 256 KB, DROP)` + 버퍼 절반 초과 시 diff 폐기·재동기, 2회 연속이면 1008 종료. 세션별 diff 계산·전송은 가상 스레드 풀에서 병렬.

## 이후 변경(R-50, 리뷰 v1 — 현재 값)
- "단조 증가 버전 v" 대신 **세션별 `seq`**(계약 v1 §1): 세션에 보낸 `snapshot` · `diff` 마다 `seq` 가 붙고 스냅샷마다 1 로 다시 시작한다. 클라이언트는 `seq` 가 이어지지 않으면 `resync` 를 보낸다. 선박은 따로 `sseq`.
- 주기 전체 스냅샷은 30 s(`ws-resync-interval-s`), 줌 ≤ 5(전세계) 세션은 120 s(`ws-resync-world-interval-s`).
- 백프레셔(REL-2 · R-73 — 위 첫 단락의 `ConcurrentWebSocketSessionDecorator`(5 s · 256 KB · DROP) · 버퍼 절반 폐기 · 2회 연속 1008 규칙은 코드에 없다, IM-36 확인):
  세션 우편함(`SerialOutbox`)이 한 번에 하나씩 보내고, 작업은 종류별 단일 비행(실행 1 + 대기 1 — 버리지 않고 합치며 실행할 때 최신 상태로 계산)이다.
  전송은 Tomcat 블로킹 전송 상한 5 s(`WsSession.SEND_TIME_LIMIT_MS` → `BLOCKING_SEND_TIMEOUT`)이고, 전송이 실패하면 곧바로 닫는다 —
  IOException · IllegalStateException(닫힌 세션 등)은 4500(`SESSION_NOT_RELIABLE`), 그 밖의 런타임 예외는 1008 'slow consumer'. 우편함 작업이 예외로 끝나면 다음 팬아웃이 전체 초기 세트를 보낸다.
