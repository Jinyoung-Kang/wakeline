# ADR-033 Redis 장애 중 AIS 위치 — 분당 첫 위치를 모아 복구 뒤 보내고, 모으지 못한 구간은 공백으로 남긴다

**상태** 채택 · 2026-10-03 · 사용자 위임("권장 방안대로 진행") · 근거 [QA 신뢰성 기록](../qa/2026-10/findings/reliability.md) '개선 제안' 2 ·
[QA 결함 목록](../qa/2026-10/DEFECTS.md) · 계약 [v5 §G46](../audit/change-contract-v5.md) · 함께 보는 기록: [ADR-014](ADR-014-ais-ship-ingest.md)(선박 수집 · 신뢰 경계) ·
[ADR-032](ADR-032-redis-breaker-write-backlog.md)(Redis 장애의 api 쪽) · [VERIFICATION](../VERIFICATION.md) #116

## 맥락
- ais 프로세스에서 Redis 에 쓰는 곳은 발행 태스크(`ais/sink.py`) 하나다. XADD 가 실패하면 변경분을 쌓지 않고 '바뀜' 표시만 되돌렸다 — 복구 뒤 첫 발행이
  그때의 최신값 하나를 실었다(메모리를 선박 수 상한 안에 두려는 설계).
- api 는 MMSI 별 60 s 창(에포크 정렬)마다 첫 보고 하나를 저장한다(`ShipWriter` · `ShipRepository.WINDOW_S`). 그래서 장애 동안의 분이 DB 에서 빠졌다 —
  QA 2026-10 redis 150 s pause: 분당 선박 행이 평소 244–284 에서 116 · 137 로 줄었고, 앞뒤에 보인 선박 88척 중 85척이 그 분에 행이 없었으며,
  그 빈 곳을 설명하는 `ingest_gap` 은 0행이었다. 항적에 설명 없는 빈 곳이 생긴다(제품 규칙 — 모르는 것을 숨기지 않는다).
- 수신(외부 WebSocket)은 Redis 와 상관없이 계속된다. 위치는 받았지만 보내지 못했을 뿐이다.
- 운영 규모(2026-10-03 운영 스택): 분당 표본 ≈ 2,700(api `wakeline_ship_rows_total{result="written"}` 1분 차이), 실시간 선박 13,834척, ais 메모리 47 MiB / 한도 256 MiB.

## 결정
1. **발행이 실패하면 그때부터 분당 첫 위치를 모은다**(`ShipBook.hold`): MMSI 별로 60 s 창(api 와 같은 창)마다 처음 받아들인 위치 하나를 받은 순서대로.
   첫 줄은 보내지 못한 그 발행의 최신값이다. 발행이 되는 동안에는 모으지 않는다(평소 비용 0).
2. **복구되면 모은 위치를 먼저, 최신값을 그다음에 보낸다**: 모은 위치는 CHUNK(5,000)씩, payload `backfill: true`(같은 MMSI 가 시간 순서로 여러 번 올 수
   있다). 보내다 실패하면 못 보낸 것을 맨 앞으로 되돌려 다음 발행에서 다시 보낸다. 최신값까지 보내면 모으기를 끝낸다.
   **api 는 바꾸지 않는다**: 저장은 메시지 순서대로 창마다 첫 보고(장애가 없었을 때와 같은 행), 메모리 상태는 더 새 보고만(최신값),
   WS 팬아웃은 10 s 에 한 번이라 지도가 되감기지 않는다. 재전송 중복은 창 가드(메모리 + DB)가 막는다.
3. **상한 100,000 위치**(튜플 참조 ≈ 350 B — ≈ 35 MB, 지금 규모로 ≈ 37분). 넘으면 더 모으지 않고 (MMSI, 창) 수와 처음 모으지 못한 위치의 시각을 센다.
   최신값까지 보낸 뒤 그 시각부터 지금까지를 `ais_gap`(구역 없음 — 모든 선박, reason `redis unavailable — N per-minute positions beyond the 100000 held were
   not kept`)으로 보낸다. 항적 끊기 · 공백 목록은 기존 공백 처리를 그대로 탄다.
4. **관측**: 상태 해시 `backfill_pending` · `backfill_published_total` · `backfill_dropped_total`. 로그 WARN(발행 실패 — 모으기 시작, 60 s 에 한 번) ·
   INFO(복구 — 보낸 위치 수) · WARN(모으지 못한 구간).
5. **영수증 표식 상한**: 복구 뒤 엔트리가 더해진다 — `tools/contract_check.py` 의 계산에 `2 × ceil(BACKFILL_MAX / CHUNK) + BACKFILL_ROUNDS` 를 더해
   ≤ 9,045(`ShipWriter.MAX_MARKS` 10,000 안).

## 버린 대안
- **공백만 기록**(가장 단순): 받은 위치를 버리고 '공백' 이라 적는다 — 메울 수 있는 자료를 버린다. 상한을 넘었을 때만 쓴다(결정 3).
- **모든 위치를 쌓는 재전송 큐**: 메모리가 받은 메시지 수에 비례한다(분당 수만 건). api 는 분당 하나만 저장하므로 낭비다.
- **디스크에 쌓기**: 컨테이너는 읽기 전용 루트다 — 볼륨이 더 필요하다(새 인프라). 이 정도 장애 길이에는 메모리로 충분하다.
- **api 쪽에 표시를 두고 모은 위치를 실시간 상태에서 빼기**: api 는 이미 MMSI 별 단조(더 새 보고만)라 필요 없다. 계약 · 코드가 둘로 갈린다.

## 결과
- 단위 시험 `apps/collector/tests/test_ais_backfill.py`(분마다 한 행 · 최신값은 마지막 · 상한 → 공백 · 보내다 실패해도 순서 · 평소에는 모으지 않음),
  api 통합 시험 `ShipsIT.positionsHeldDuringARedisOutageBecomeOneRowPerMinute_andTheMapKeepsTheLatest`, 격리 스택 redis 150 s pause 전후 수치는 VERIFICATION #116.
- 남은 한계: 장애 중에 ais 프로세스가 멈추면 모은 위치는 메모리와 함께 사라진다(그 구간은 공백 기록도 없다 — 수신은 있었으므로 'ais process stopped' 공백과
  다르다). 상한보다 긴 장애는 공백으로 남는다. 최신값을 보내는 사이 받은 위치는 그 분의 첫 위치 대신 다음 발행의 최신값이 그 분의 행이 될 수 있다(같은 분 안의 실제 보고).
