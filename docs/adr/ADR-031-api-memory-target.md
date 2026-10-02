# ADR-031 api 메모리 목표(NFR-03)를 잰 값으로 다시 정한다 — 컨테이너 메모리 ≤ 768 MiB

**상태** 채택 · 2026-10-02 · 사용자 결정("메모리 목표는 실측값으로 다시 정해") · QA 2026-10 [QA-400](../qa/2026-10/DEFECTS.md) · 근거 [PERF](../PERF.md) §14.2 ·
[QA 성능 기록](../qa/2026-10/findings/performance.md) · 함께 보는 기록: [ADR-017](ADR-017-review-v1-contract-changes.md) R-25 · [VERIFICATION](../VERIFICATION.md) #26 · #103

## 맥락
- 설계서의 NFR-03 은 'api 메모리 ≤ 512 MB' 였다. 리뷰 v1 에서 힙 비율을 60 → 40 %로 낮추고(R-25) 스레드별 malloc 아레나를 묶어(`MALLOC_ARENA_MAX=2`, VERIFICATION #26)
  경합이 없는 k6 실행에서만 맞췄다.
- QA 2026-10 은 운영 규모 실시간 상태(전세계 항공기 1만 · 선박 1.5만 척)와 운영 규모 DB(8.8 GB)로 다시 쟀다(같은 VM — 4 CPU · 8 GB, 3번씩):

  | 상태 | 컨테이너 메모리(docker stats) | java RSS |
  |---|---|---|
  | 새 JVM · REST 100 rps(NFR-02) | 512–527 MiB | 512–537 MiB |
  | 새 JVM · WS 200 연결 | 551 MiB | 562 MiB |
  | 앞선 부하를 겪은 JVM · REST 100 rps | 576–581 MiB | 550–555 MiB |
  | 몰림(계단 600 rps · 공격) 중 · 뒤 | 최대 **750.5 MiB** | 최대 708 MiB |
  | 몰림 뒤 쉼(고원 — G1 이 커밋을 돌려주지 않는다) | 679–741 MiB | 617–693 MiB |

- 힙 밖 메모리(스레드 · GC 구조 · 코드 캐시 · malloc)가 설정과 상관없이 281–298 MiB 로 고정이라, 512 아래가 되려면 부하 중 힙 커밋이 220–230 MiB 이하여야 한다.
  JVM 설정 6가지 × 3번(PERF §14.2): 512 아래로 간 설정은 GC 일시정지 합이 2.4배, REST 임계값을 3번 중 2번 넘었고, WS 200 단계는 그래도 512 위였다. OOM · 재시작은 18번 모두 0.

## 결정
- **NFR-03 을 "api 컨테이너 메모리(docker stats — cgroup 사용량 − inactive_file) ≤ 768 MiB" 로 다시 정한다.** 정상 부하(REST 100 rps · WS 200 연결, 운영 규모 상태)와
  몰림 뒤 쉼을 모두 포함한다. 768 MiB 는 컨테이너 한도 1 GiB 의 75 %이고, 이번에 잰 최대(750.5 MiB)를 덮는다.
- 제품 설정은 그대로다: 컨테이너 한도 1 GiB · `-XX:MaxRAMPercentage=40`(힙 최대 약 410 MiB) · `MALLOC_ARENA_MAX=2` · `-XX:+ExitOnOutOfMemoryError`(재시작 정책).
- 확인: `tools/qa/perf_check_mem.py`(기본 한도 768 MiB) — `tools/qa/perf_sample.py` 가 남긴 CSV 의 컨테이너 메모리 · RSS 가 한도를 넘으면 종료 1.

## 버린 대안
- 512 MB 를 지키려고 JVM 을 줄이기(힙 30 % + 주기 GC + `MaxHeapFreeRatio` 30): 쉼 · 고원은 크게 줄지만(몰림 뒤 −236 MiB) GC 시간 2.4배 · REST 임계값 위반 · 몰림 실패 증가, WS 단계는 여전히 512 위.
- 힙 밖 메모리(약 290 MiB)를 줄이는 일: 이번 범위 밖이다. 필요해지면 NMT 로 나눠 재는 것부터.

## 결과
- QA-400 은 결함이 아니라 목표를 다시 정한 것으로 닫는다. 잰 값은 모두 새 목표 안이다(`perf_check_mem.py` — 성능 단계 · 고친 뒤 CSV 모두 종료 0).
- 컨테이너 한도까지 약 256 MiB 의 여유가 남는다. 운영 규모(전세계 항공기 · 선박 수)가 커지거나 768 을 넘는 측정이 나오면 다시 본다.
