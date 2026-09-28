# ADR-018 시스템 로그: 프로세스가 WARN·ERROR 를 가려서 Redis 스트림 하나로

**상태** 채택 · 2026-09-29 · 계약 v5 §C

## 배경
오류는 각 컨테이너의 표준 출력(docker json-file)에만 남는다. 어느 컨테이너도 다른 컨테이너의 로그를 읽을 수 없고(docker.sock 을 넘기지 않는다 — 보안), 화면에서 오류를 볼 방법이 없었다(설계 FR-25 미완).

## 결정
- api · collector · ais 가 WARN · ERROR 를 비밀값 가림 뒤 `wakeline:logs` 스트림(`MAXLEN ~ 3000`, 항목 ≤ 8 KiB)에 싣는다. 스키마 `schemas/log_event.v1.json`.
- 프로세스 안 대기열(500건 · 2 MiB)이 Redis 장애 동안 오류를 붙잡아 두었다가 복구 뒤 보낸다 — 장애의 원인이 되는 오류일수록 잃지 않게. 같은 지문은 10 s 에 1건(폭주 억제, 억제 수는 남긴다).
- 브라우저 오류는 api 공개 수집점(`POST /api/v1/client-errors`, 요청 제한 · 크기 상한)으로 받아 `untrusted` 로 싣는다.
- 조회는 운영 세션 전용(`/api/v1/ops/logs*`) — 로그에는 내부 경로·구성이 담긴다.

## 대안과 기각 이유
- docker.sock 을 api 에 넘겨 컨테이너 로그를 읽기: 호스트 루트와 같은 권한 — 거절.
- Loki/Promtail · ELK: 컨테이너 3–4개 · 메모리 수백 MB 추가, 로컬 1인 스택에 비해 무겁다. 스트림 형식을 유지하면 나중에 옮길 수 있다.
- DB 표: 오래 남길 수 있지만 DB 장애 때 그 오류를 싣지 못한다. 7일 · 3,000건이면 Redis(AOF)로 충분하다.

## 결과
- Redis 메모리: 최악 약 24 MiB(3,000 × 8 KiB). maxmemory 256 MiB · noeviction 안.
- edge(nginx) 오류 로그는 범위 밖(에이전트 없음). 화면에 그렇게 적는다.
- 되돌리기: 싱크 등록을 끄는 설정(`wakeline.logs.sink-enabled=false` · `LOG_SINK_ENABLED=0`) 또는 커밋 되돌리기. `DEL wakeline:logs`.
