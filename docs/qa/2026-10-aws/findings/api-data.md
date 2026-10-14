# api 데이터 손실 · 시간 경계(api-data) — AWS 공개 데모 QA(2026-10-14)

- 대상: 브랜치 `qa/aws-2026-10`(main `29d39e38` + QA 도구) — 제품 코드는 고치지 않았다(찾기 단계). 결함 번호 범위 QA-1200–1219 중 **1200–1203** 을 썼다.
- 환경 **U**: 단위 · DB 시험(JUnit + Testcontainers — `DbTestSupport` 의 버리는 PostgreSQL · `wakeline-db:local` 이미지를 읽기만, 운영과 같은 api 계정
  `wakeline_api`). 라이브 스택(8701 · 8702)은 쓰지 않았다.
- 실행한 시험: 새 재현 시험 6건(모두 실패 — 아래) · 새 확인 시험 3건(통과 — 결함 아님) · 관련 기존 시험 28건(통과 — `dev.wakeline.history.*` ·
  `WarningPersistDbTest`). 출력은 [evidence/api-data/](../evidence/api-data/README.md).

| 번호 | 심각도 | 결함 | 재현 시험 |
|---|---|---|---|
| QA-1200 | 높음 | 70 h 넘게 멈춘 뒤 정지 직전 시간의 1분 요약이 영구히 빠진다(원본이 남아 있는데도) | `apps/api/src/test/java/dev/wakeline/qa/Qa1200SummaryCatchUpAfterLongStopDbTest.java` |
| QA-1201 | 높음 | 같은 조건에서 지정 대상(항공기 · 선박) 기록 보존이 정지 직전 시간의 점을 옮기지 않는다 | `…/qa/Qa1201RetainedCopyAfterLongStopDbTest.java` |
| QA-1202 | 보통 | 정시 요약(:05) 뒤에 늦게 쓰인 그 시간의 행은 따라잡기가 영영 요약하지 않는다 | `…/qa/Qa1202LateRowsOfASummarizedHourDbTest.java` |
| QA-1203 | 보통 | 줄을 버린 특보 목록이 이어지면 그동안 해제된 특보가 끝나지 않고, 끝난 시각도 하루 늦게 남는다 | `…/qa/Qa1203WarningNeverEndsWhileLinesAreDroppedDbTest.java` |

실행 명령(네 결함 모두):
```bash
cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa1200*' --tests 'dev.wakeline.qa.Qa1201*' --tests 'dev.wakeline.qa.Qa1202*' --tests 'dev.wakeline.qa.Qa1203*'
# → 6 tests completed, 6 failed (2026-10-14 03:55 KST)
```

---

## QA-1200 높음 — 70 h 넘는 정지 뒤 정지 직전 시간의 1분 요약 영구 누락(데이터 손실)
- **환경**: U(DB 시험). 사용자 결정(QA-PLAN §8-3): 재현되면 결함(높음 — 데이터 손실).
- **배경**: AWS 데모는 18:00 KST 에 EC2 를 멈춘다(ADR-039). 그 시간(17–18시 KST = 08–09 UTC)의 정시 요약은 09:05 UTC 에 돌 차례라 돌지 않고,
  다음 기동의 따라잡기만 채울 수 있다. 따라잡기 창은 `원해상도 보존 − 2 h` = **70 h 고정**이다. 주말(약 63 h)은 넘지만, 연휴에 일정을 끄거나 월요일 기동이
  실패하면(금 18:00 → 화 09:00 KST = 87 h) 그 시간은 창 밖이다.
- **재현 절차**(시험이 하는 일):
  1. `stopDay` = (지금 − 72 h)의 UTC 날 − 1일, 그날 08:00–09:00 UTC(17–18시 KST)에 관심 지역 안 원해상도 점 1개. 그날 파티션의 끝은 이미 `now − 72 h` 이전이다.
  2. 새 `MaintenanceJobs`(= 기동) → `dropExpiredPartitions()`(첫 따라잡기 전이라 **보류** — 원본이 남는다) → `catchUp()`(성공).
  3. 따라잡기 때 원본 행 수를 센다 → `dropExpiredPartitions()`(보류가 풀린 다음 :02) → 그 시간의 `track_point_1m` 행 수.
  4. 경계 시험: 지금 시각 기준 70 h 전 시간과 71 h 전 시간에 점 하나씩(둘 다 72 h 보존 안) → `catchUp()`.
- **기대**: 원본이 남아 있는 시간은 창과 상관없이 요약한다 — 그 시간의 1분 요약 1행. 71 h 전 시간도 1행.
- **실제**: 원본은 따라잡기 때 있었고(1행), 다음 :02 에 파티션째 지워졌으며, 1분 요약은 **0행** — 재생(72 h 뒤에는 1분 요약만 읽는다)이 그 시간 영구히 빈다.
  70 h 전 시간은 요약되고(통과), 71 h 전 시간은 원본이 있는데도 0행.
- **증거**(실패 글 그대로, [gradle-run-1.log](../evidence/api-data/gradle-run-1.log)):
  ```
  Qa1200SummaryCatchUpAfterLongStopDbTest > theLastHourBeforeAStopLongerThan70HoursIsSummarizedWhileItsRawRowsRemain() FAILED
      [1-minute summary of the last hour before a 105 h stop (2026-10-09T08:00:00Z) — replay of that hour after the raw rows are gone]
      expected: 1L  but was: 0L
  Qa1200SummaryCatchUpAfterLongStopDbTest > anHourJustOutsideTheSeventyHourWindowIsSummarizedToo() FAILED
      [1-minute summary of hour 2026-10-10T19:00:00Z (71 h back, raw rows still kept)]  expected: 1L  but was: 0L
  ```
- **의심 원인**: `apps/api/src/main/java/dev/wakeline/history/MaintenanceJobs.java:374`(창 = `trackRetentionHours − CATCH_UP_MARGIN_HOURS`, `:52` 의 2 h) —
  창이 '원본이 실제로 남아 있는 범위'가 아니라 시계로 고정. 첫 따라잡기 성공이 `:118` 의 파티션 삭제 보류를 풀어, 창 밖이었던 시간의 원본은 바로 다음 :02 에
  지워진다. 원본은 시간 h 에 대해 최소 h + 73 h 까지(파티션 끝 + 72 h), 보류 중이면 더 오래 남는다 — 그 사이를 창이 덮지 않는다.

## QA-1201 높음 — 같은 조건에서 지정 대상 기록 보존(365일)이 정지 직전 시간을 잃음(데이터 손실)
- **환경**: U(DB 시험).
- **배경**: 지정 대상 보존(ADR-038 · 계약 v5 §G52)은 매시 :05 에 닫힌 3시간만 옮기고, 기동 뒤 따라잡기가 70 h(`RETAIN_CATCH_UP_HOURS`)를 옮긴다.
  18:00 KST 정지 직전 시간(17–18시 KST)은 다음 기동의 따라잡기만 옮길 수 있다 — QA-1200 과 같은 꼴의 고정 창이다.
- **재현 절차**: `retain_targets = '71be01, 440000001'` · 71 h 전 시간에 그 항공기 점(track_point)과 선박 점(ship_position) 하나씩(둘 다 72 h 보존 안) →
  새 `MaintenanceJobs` 의 `catchUp()` → `retained_track` 를 본다.
- **기대**: 원본이 남아 있는 지정 대상 점은 옮긴다 — `aircraft:71be01` · `ship:440000001`.
- **실제**: 원본 2점은 있는데 `retained_track` 은 **빈 목록**. 그 원본은 다음 보존 삭제(항적은 보류가 풀린 뒤, 선박은 보류 없이 파티션 끝 + 72 h)로 사라진다.
- **증거**:
  ```
  Qa1201RetainedCopyAfterLongStopDbTest > targetPointsOfTheLastHourBeforeAStopLongerThan70HoursAreRetained() FAILED
      [retained points of the designated targets in hour 2026-10-10T19:00:00Z (71 h back, raw rows still kept)]
      Expecting actual: []  to contain exactly (and in same order): ["aircraft:71be01", "ship:440000001"]
  ```
- **의심 원인**: `MaintenanceJobs.java:211`(`RETAIN_CATCH_UP_HOURS = 70`) · `:352`(따라잡기 복사 창). 선박 위치 파티션(`ship_position_drop_old`)은 항적과 달리 삭제
  보류가 없어(`:122`), 고칠 때 창만 넓혀서는 긴 정지 뒤 기동 직후 :02 와의 순서에 따라 원본이 먼저 지워질 수 있다(개선 제안 5).
- 심각도 메모: 앞선 QA-601(같은 보존 복사 · 통계 실패와 3 h 정지가 겹칠 때)은 보통이었다. 이것은 QA-1200 과 같은 단일 조건(70 h 넘는 정지)이라 같은 등급으로 적었다.

## QA-1202 보통 — 정시 요약 뒤에 늦게 쓰인 행은 1분 요약에 영영 들어가지 않음(조건부 데이터 손실)
- **환경**: U(DB 시험).
- **배경**: 매시 :05 의 `summarize1m` 은 지난 시간을 그때 있는 원해상도로만 요약한다. 그 시간의 행이 :05 뒤에 쓰이는 경로가 있다 —
  Redis 장애 동안 수집기는 XADD 를 로컬 큐(1,000건 · 64 MiB)에 쌓았다가 장애가 끝나면 순서대로 보내고(`apps/collector/wakeline_collector/publisher.py:243` · `:249`),
  api 는 그 관측을 관측 시각(`ts = seenAt`, `TrackWriter.java:457`)으로 쓴다. 예: Redis 가 10:50–11:10 UTC 에 멈추면 11:05 의 요약은 10:00–10:49 만 보고,
  10:50–10:59 의 행은 11:10 뒤에 들어온다. api 재시작 직후 스트림 백로그를 따라잡는 중에 :05 가 도는 경우도 같다.
- **재현 절차**: 지난 시간 10분에 점 하나 → `summarize1m()`(그 시간 요약) → 같은 시간 55분에 점 하나(늦게 쓰임) → `catchUp()` → 그 시간의 `track_point_1m`.
- **기대**: 원해상도가 있는데 요약이 없는 분은 따라잡기가 채운다(`summarizeHour` 는 `ON CONFLICT DO NOTHING` 이라 다시 돌려도 같다) — `e12201` · `e12202`.
- **실제**: `["e12201"]` — 55분은 요약되지 않는다. 72 h 뒤 원본이 지워지면 재생에서 그 분들만 빈다(같은 시간의 다른 분은 보인다).
- **증거**:
  ```
  Qa1202LateRowsOfASummarizedHourDbTest > rowsWrittenAfterTheHourlySummaryAreSummarizedByTheCatchUp() FAILED
      [1-minute summary rows of hour 2026-10-13T17:00:00Z — the 55th minute was written after the :05 summary (raw row still kept)]
      Expecting actual: ["e12201"]  to contain exactly (and in same order): ["e12201", "e12202"]  but could not find: ["e12202"]
  ```
- **의심 원인**: `MaintenanceJobs.java:377` — 따라잡기가 '요약이 **하나도** 없는 시간'만 고른다(`NOT EXISTS … track_point_1m … AND EXISTS … track_point`).
  일부만 요약된 시간은 다시 보지 않는다. 대조: 지정 보존 복사는 매시 3시간 · 3시간마다 70 h 를 다시 옮겨(겹치면 무시) 늦은 행도 들어간다.
- 심각도 메모: 잃는 것은 늦게 쓰인 분들의 72 h 뒤 재생(파생 자료)이고 Redis · 소비 장애가 :05 를 걸쳐야 한다 — 앞선 QA-601(조건부 손실 · 보통)에 맞춰 보통.

## QA-1203 보통 — 줄을 버린 특보 목록이 이어지는 동안 해제된 특보가 끝나지 않음 · 끝난 시각이 늦게 남음
- **환경**: U(DB 시험). 사용자 결정(QA-PLAN §8-3): 재현되면 결함(보통).
- **배경**: AWS 리뷰 B-4 뒤 `WarningRepository.persist` 는 `dropped > 0` 인 목록에서 빠진 특보를 끝내지 않는다("다음 온전한 목록이 닫는다").
  버려지는 줄이 그 특보가 아니라 **계속 발효 중인 다른 특보**면(예: 구역 이름이 계약 한도 80자를 넘어 수집기가 매 주기 버리는 줄 — `kma_warning_rules.py:142-145` ·
  `:163`), 그 특보가 발효 중인 내내 어떤 특보도 끝나지 않는다. 수집기는 버린 줄 원문(앞 200자 — 구역 부호 포함)을 품질 기록에만 남기고 봉투에는 수만 싣는다
  (`apps/collector/wakeline_collector/jobs/weather.py:493`).
- **재현 절차**: 07:05 UTC 온전한 목록에 호우주의보 `L1100100` → 07:10 부터 24 h 동안 5분마다(288번) `L1100100` 이 없고 `dropped = 1` 인 목록 →
  (가) 공개 이력(`history`, 24 h 창)의 `L1100100` · (나) 그 뒤 온전한 빈 목록 한 번 → `ended_at`.
- **기대**: (가) 07:10 에 목록에서 빠졌으니 끝남(`ended_at` 있음). (나) `ended_at` = 목록에서 빠진 시각 07:10(계약 v5 §G49 "ended_at(목록에서 빠진 시각)").
- **실제**: (가) 24 h 뒤에도 `ended_at` 없음 — 공개 이력이 해제된 특보를 '발효 중'으로 낸다(버려지는 줄이 이어지는 한 무기한).
  (나) `ended_at` = **2026-10-10T07:10Z**(첫 온전한 목록 — 실제보다 24 h 늦게, 영구 기록).
- **증거**:
  ```
  Qa1203WarningNeverEndsWhileLinesAreDroppedDbTest > aLiftedWarningEndsEvenWhileAnotherWarningsLineIsDroppedEveryCycle() FAILED
      [ended_at of the warning lifted at 2026-10-09T07:10:00Z, after 24 h of lists without it (each list dropped another warning's line)]  Expecting actual not to be null
  Qa1203WarningNeverEndsWhileLinesAreDroppedDbTest > theEndTimeIsWhenTheWarningLeftTheListNotTheFirstCleanListAfterTheDroppedStreak() FAILED
      [ended_at of the warning that left the list at 2026-10-09T07:10:00Z]  expected: 2026-10-09T07:10:00Z  but was: 2026-10-10T07:10:00Z
  ```
- **의심 원인**: `apps/api/src/main/java/dev/wakeline/weather/data/WarningRepository.java:67-70`(`dropped > 0` 이면 끝내기 전체를 건너뜀) · `:71`.
  버린 줄이 '어느 특보인지' 모르는 채로 목록 전체의 끝내기를 멈춘다 — 고치려면 버린 줄의 구역 부호를 봉투에 싣거나(계약 변경 — 사용자에게 묻기),
  빠진 특보마다 처음 빠진 시각을 기억해 일정 횟수 · 시간 뒤 그 시각으로 끝내는 식이 필요하다.
- 앞선 기록과의 관계: 밤 · 주말 정지 뒤 첫 수신 시각이 `ended_at` 이 되는 것(AWS 리뷰 B-3 — 받은 목록이 없어 알 수 없음)은 수용된 한계라 따로 세지 않는다.
  이 결함은 api 가 그 특보가 빠진 목록을 5분마다 받고 있었는데도 끝내지 않는 경우다.

## QA-1204 보통 — 특보 줄을 모두 버린 응답도 빈 목록으로 발행된다(QA-1203 고침 뒤 독립 리뷰)
- **환경**: U(수집기 시험 — 실제 응답 fixture `wrn_now_data_preliminary.txt` 를 바꿈). 찾은 곳: QA-1203 고침(`b839e38a`)의 독립 리뷰.
- **배경**: QA-1203 고침으로 api 는 줄을 버린 목록(dropped > 0)에서도 1 h 넘게 빠진 특보를 끝낸다. 버린 줄이 빠진 특보 자신일 수 있다는 위험을 1 h 상한으로
  받아들였는데, 공급자 형식이 바뀌면 **모든** 줄이 같은 까닭으로 버려진다. 수집기는 그래도 `{complete: true, warnings: [], dropped: N}` 을 발행했다.
- **재현 절차**: 실제 응답의 특보 3줄 끝에 열 하나를 더함(모든 줄 `expected 10 columns, got 11`) · 모든 줄에 풀 수 없는 바이트 → `kma_warning_rules.parse` 와
  `KmaWarningJob.run_once`. 대조: 머리 주석만 있는 응답 · 3줄 중 1줄만 틀린 응답.
- **기대**: 하나도 읽지 못한 응답은 모양이 틀린 응답 — 호출 실패처럼 발행하지 않는다(계약 v5 §G49 '호출이 실패하면 발행하지 않는다' · `KmaWarningJob` 설명 '빈 목록을 지어 내지 않는다').
- **실제**: `Failed: DID NOT RAISE WarningResponseError` · `published a list with every line dropped: [{'complete': True, 'warnings': 0, 'dropped': 3}]`.
  그 결과 화면은 곧바로 '발효 중 0건 · 형식 오류로 뺀 줄 3', api 이력은 1 h 뒤 발효 중인 특보를 모두 끝낸다(해석하지 못한 것을 '해제'로 기록). 대조 2건은 기대대로.
- **의심 원인**: `apps/collector/wakeline_collector/kma_warning_rules.py` `parse` — 줄 격리(ADR-036 결정 2)를 읽은 줄이 하나도 없을 때도 적용했다.
  이력 쪽 손실은 내 QA-1203 고침이 1 h 상한을 더하면서 생겼다(그 전에는 dropped > 0 목록에서 아무것도 끝내지 않았다).
- **고침**(`ab72b8d3` · 재현 `273622db` — `tests/qa/test_qa_1204_warning_every_line_dropped.py`): 특보 줄이 있는데 모두 버렸으면 `WarningResponseError`
  ("every warning line dropped (N; first: <까닭>)" — 줄 내용은 싣지 않음). 화면은 마지막 목록과 그 나이(15분 뒤 '오래됨'), 실행 기록 · last_error 에 실패.
  대가: 발효 중인 특보의 줄이 **모두** 버려지면(몇 건이든 — 모두 80자 넘는 구역 이름 · 풀 수 없는 글자) 그 주기도 발행하지 않는다 — QA-602 · 1222 의 증상
  (목록 갱신이 멈춤)이 돌아오지만 이제 실행 기록에 실패로 보인다. 계약 · api 는 바꾸지 않았다.
- **독립 확인**(별도 에이전트): 재현 시험이 `273622db` 에서 4 실패 · 1 통과(대조), `ab72b8d3` 에서 5 통과 · 수집기 전체 2,031 통과 · 정상 응답(머리 주석만 · CRLF ·
  일부만 틀림 · fixture 모드) 그대로 발행 · 오류 글에 줄 내용 없음(까닭은 고정 문구 · 숫자, `mask` 를 거침) · 심각도 보통 타당. 격리 스택 A 표준 e2e 51 통과
  (fixture 특보 3건 · 버림 0).
- **미확인 · 남는 위험**: (1) 특보가 없는 응답에 '#' 아닌 잡줄이 오면 이제 거절된다(전에는 빈 목록 · dropped 1) — 실제 응답에서 본 적은 없다. (2) fixture 는 예비특보 줄뿐이라
  정규 특보의 실제 줄 모양은 확인한 적이 없다 — 형식 변경이 정규 특보 줄에만 걸리면 일부만 버린 목록이 발행되고 QA-1203 의 1 h 상한 위험이 남는다(ADR-036 '버린 대안').
- **개선 제안**: 거절한 응답도 원문을 보관(`archive`)해 운영자가 바뀐 모양을 볼 수 있게 — 지금은 '머리 주석 없음' 거절과 같이 last_error 의 첫 까닭만 남는다.
- **고르지 않은 것**(사용자 결정 2026-10-14): 버린 줄의 구역 부호를 봉투에 실어 api 가 그 특보만 기다리게 하는 계약 변경 — 모양이 바뀐 줄에서는 구역 부호의 열을
  믿을 수 없고, 풀 수 없는 줄은 부호를 읽을 수 없어 이 경우에 소용이 없다(ADR-036 '버린 대안'). 일부 줄만 버리는 동안의 위험은 QA-1203 의 1 h 상한으로 받아들인다.

---

## 확인했지만 결함이 아닌 것(통과하는 확인 시험 — `apps/api/src/test/java/dev/wakeline/history/QaAwsApiDataChecksDbTest.java`)
| 후보 | 결과 |
|---|---|
| 항적 파티션 삭제 보류 상한 6 h 경계(±1분) | 기동 + 6 h − 1분 보류 · 6 h 정각 · + 1분 삭제 — 상한대로(`isBefore`) |
| 지정 보존 선박 점의 실제 시각 창(QA-702 의 선박판) | `ShipRepository.retainedTrack` 도 `ts BETWEEN` — 분 머리로 거르지 않는다 · 닫힌 범위 |
| 매시 복사 · 따라잡기 복사가 같은 분을 동시에 | 오류 없이 분마다 한 번(60행), 첫 점 유지 |
| 따라잡기 실패 → 물러남 → 성공 · 보류 풀림 | 기존 `MaintenanceCatchUpScheduleTest` · `StatsAggregationDbTest.trackPartitionsAreKeptUntilTheFirstCatchUpAfterStart` 통과 |
| 교통량 `trafficRecountable` (금 → 월 · 87 h · 7일 밖) | 기존 `StatsAggregationDbTest` 11건 통과. KST 날의 첫 순간 UTC 파티션은 기동 때 `ensure_partitions(−1..+3)` 가 늘 만든다(코드 확인) |

## 미확인(의심했지만 재현하지 못함)
| 후보 | 왜 · 무엇을 봤나 |
|---|---|
| `catchUpSummaries(Instant.now())` · `summarize1m` 의 벽시계와 주입 시계의 어긋남 | 운영 빈은 늘 `Clock.systemUTC()`(`MaintenanceJobs.java:82`) — 어긋남은 시계를 바꾼 시험에서만 생긴다. 사용자에게 보이는 잘못 없음 → 개선 제안 1 |
| `OrderedWriter` 빈 큐 틈(`:178-180`) | 비어 있던 큐에서 막 꺼낸 작업 하나의 나이(≈0)가 잠깐 -1 로 읽힐 뿐 — 건강 판정(`IngestHealthIndicator` 의 writer_backlog)에도 자료에도 영향 없음 |
| `StreamConsumer` ACK 순서 | 영수증 · 순서 큐(FIFO)로 durable 순서대로 ACK. 종료 때 ACK · flush 순서(QA-105)는 고쳐져 있다. 새 경로를 찾지 못함 |
| `ais_last_gap` 의 `later(feed, ships)`(4b8edc75)가 끝난 공백을 열린 것처럼 | 둘 다 끝난 공백만 담는다(`AisStatus.parse` 는 끝 > 시작일 때만, `ShipStore.addGap` 은 열린 공백 거절) — 열린 공백은 `openGaps()` 에서만. 그런 경로 없음 |
| 기동 때 부트스트랩 스냅숏(어제 18:00)으로 유령 알림 | 관측은 `AircraftState.fresh`(60 s · OpenSky 300 s)만 써(IntersectionEngine:46) 어제 스냅숏으로 알림이 나지 않는다. 알림 INSERT 는 자연키 `ON CONFLICT` |
| 통계 KST 날짜 경계 | 기존 시험이 경계(KST 자정 · 09:00 KST 파티션 경계 · 08:59:59)를 덮고 모두 통과 — 새 결함 없음 |

## 개선 제안(결함 수에 넣지 않음)
1. **시계를 하나로**: `summarize1m`(`MaintenanceJobs.java:181`) · `runCatchUp`(`:334`)만 `Instant.now()`, 나머지는 주입 시계 — 운영 동작은 같지만 경계 시험(QA-1200 같은)을
   고정 시계로 결정적으로 쓸 수 없다.
2. **따라잡기 창을 '남아 있는 원본'에 묶기**(QA-1200 · 1201 고칠 때): 가장 오래된 항적 · 선박 파티션의 시작부터. 2 h 여유의 근거(지워지는 중인 파티션을 읽지 않게)는
   파티션 DROP 이 부모의 ACCESS EXCLUSIVE 를 기다리므로(StatsAggregationDbTest.aPartitionDropWaits…) 읽기와 겹쳐도 깨지지 않는다.
3. **QA-1202 고칠 때**: 매시 :05 에 지난 2–3시간을 다시 요약(겹치면 무시 — 비용은 작은 시간 범위) 하거나, 따라잡기의 판정을 '원본이 있는 분 중 요약이 없는 분'으로.
4. **삭제 보류의 기준을 '첫 DB 접속'으로**: 지금 상한 6 h 는 프로세스 기동부터다(`:118`). RDS 가 기동 뒤 6 h 넘게 안 되면(설계상 수용한 상한) 돌아온 뒤 :02 가
   따라잡기(물러남 최대 30분)보다 먼저 와 금요일 교통량 원본을 지울 수 있다.
5. **선박 위치 파티션에도 보류**(지정 대상에 선박이 있을 때): `ship_position_drop_old` 는 보류 없이 매시 :02 에 돈다(`:122`) — 긴 정지 뒤 :01 무렵 기동하면 보존 따라잡기보다
   삭제가 먼저일 수 있다.
6. **재시작으로 닫은 알림의 `left_at`**: `closeOpenFromPreviousRun` 은 `left_at = now()`(`AlertRepository.java:68`, 계약 §3)라 AWS 일정에서는 마지막 관측보다 15–63 h 늦다
   (체류 통계에서는 빠지지만 이력 · `/alerts/{id}` 의 닫힌 시각으로 보인다). 마지막 관측 시각을 함께 남기거나 화면에서 '재시작으로 끊김 — 닫힌 시각 모름'으로.
7. **`/watch` 의 AIS 공백**: `AisStatus.openOrLastGap` 은 heartbeat 신선도를 보지 않는다 — 수집기가 공백 없이 죽으면 `/watch` 는 '수신 공백 중'을 말하지 않는다
   (`/status` 는 `heartbeat_stale` 로 말한다). 코드 읽기로만 확인.

## 앞선 QA 와 같음(다시 세지 않음)
- 밤 · 주말 정지 뒤 특보 `ended_at` = 첫 수신 시각(AWS 리뷰 B-3, 수용) — 지금도 그대로.
- QA-601(통계 실패가 보존 복사를 막음) · QA-702(지정 보존 항공기 점의 분 머리 창)는 고쳐진 채 통과(`Qa601CatchUpRetainedCopyDbTest` · `Qa702…`).
- 앞선 개선 제안 4(72 h 경계를 걸친 창은 원해상도 · 보존 점 중 한쪽만 — ADR-038 §5)는 그대로다(`AircraftController.java:204-207` · `ShipController.java:353-356`).
