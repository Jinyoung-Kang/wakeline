# ADR-008 WebSocket 은 원시 JSON + 단조 증가 버전(STOMP 미사용)

`hello → welcome → subscribe(bbox, zoom, detail) → snapshot → diff(v)…`. 연결당 구독 1개, 클라이언트 메시지 ≤ 4 KB, hello 5 s, ping 30 s(2회 무응답 종료), 전체 200 · IP당 5 연결. 세션마다 "마지막으로 보낸 상태" 를 두고 뷰포트 안에서만 diff 를 계산한다(위치 1e-4°, 고도 25 ft, 속도 1 kt, 방위 1°). 30 s 마다 전체 스냅샷으로 누적 오차를 지운다. 백프레셔는 `ConcurrentWebSocketSessionDecorator(5 s, 256 KB, DROP)` + 버퍼 절반 초과 시 diff 폐기·재동기, 2회 연속이면 1008 종료. 세션별 diff 계산·전송은 가상 스레드 풀에서 병렬.

## 이후 변경(R-50, 리뷰 v1 — 현재 값)
- "단조 증가 버전 v" 대신 **세션별 `seq`**(계약 v1 §1): 세션에 보낸 `snapshot` · `diff` 마다 `seq` 가 붙고 스냅샷마다 1 로 다시 시작한다. 클라이언트는 `seq` 가 이어지지 않으면 `resync` 를 보낸다. 선박은 따로 `sseq`.
- 주기 전체 스냅샷은 30 s(`ws-resync-interval-s`), 줌 ≤ 5(전세계) 세션은 120 s(`ws-resync-world-interval-s`).
