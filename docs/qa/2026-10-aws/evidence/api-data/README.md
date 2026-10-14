# 증거 — api-data(데이터 손실 · 시간 경계)

상세 기록: [findings/api-data.md](../../findings/api-data.md).

| 파일 | 무엇 |
|---|---|
| [gradle-run-1.log](gradle-run-1.log) | 재현 시험 6건(QA-1200 ×2 · QA-1201 · QA-1202 · QA-1203 ×2 — 모두 실패) + 확인 시험 3건(통과)을 한 번에 돌린 Gradle 출력(2026-10-14 03:55 KST) |

## 명령
```bash
cd apps/api && ./gradlew --offline test \
  --tests 'dev.wakeline.qa.Qa1200*' --tests 'dev.wakeline.qa.Qa1201*' --tests 'dev.wakeline.qa.Qa1202*' --tests 'dev.wakeline.qa.Qa1203*' \
  --tests 'dev.wakeline.history.QaAwsApiDataChecksDbTest'
# 9 tests completed, 6 failed

cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.history.*' --tests 'dev.wakeline.weather.data.WarningPersistDbTest'
# 관련 기존 시험 + 확인 시험: 31건 통과(RetentionDbTest 4 · Qa702 1 · StatsAggregationDbTest 11 · RetainedTrackDbTest 2 · Qa601 1 ·
# MaintenanceCatchUpScheduleTest 3 · QaAwsApiDataChecksDbTest 3 · MaintenanceJobsDbTest 4 · WarningPersistDbTest 2)
```
- DB: Testcontainers 의 버리는 PostgreSQL(`DbTestSupport` 기본 이미지 `wakeline-db:local` — 읽기만, 태그를 바꾸지 않음). 라이브 스택 · 외부 공급자 · AWS 는 쓰지 않았다.
- 시험 결과 XML: `apps/api/build/test-results/test/TEST-dev.wakeline.qa.Qa120*.xml` · `TEST-dev.wakeline.history.QaAwsApiDataChecksDbTest.xml`(빌드 산출물 — 저장소 밖).

## 실패 글 요약
| 시험 | 실패 글 |
|---|---|
| `Qa1200SummaryCatchUpAfterLongStopDbTest.theLastHourBeforeAStopLongerThan70HoursIsSummarizedWhileItsRawRowsRemain` | `[1-minute summary of the last hour before a 105 h stop (2026-10-09T08:00:00Z) …] expected: 1L but was: 0L` (앞선 단언 — 따라잡기 때 원본 1행 · 그 뒤 파티션 삭제 — 은 통과) |
| `Qa1200….anHourJustOutsideTheSeventyHourWindowIsSummarizedToo` | `[1-minute summary of hour 2026-10-10T19:00:00Z (71 h back, raw rows still kept)] expected: 1L but was: 0L` (70 h 전 시간은 요약됨 — 통과) |
| `Qa1201RetainedCopyAfterLongStopDbTest.targetPointsOfTheLastHourBeforeAStopLongerThan70HoursAreRetained` | `Expecting actual: [] to contain exactly … ["aircraft:71be01", "ship:440000001"]` (원본 2점 있음 — 통과) |
| `Qa1202LateRowsOfASummarizedHourDbTest.rowsWrittenAfterTheHourlySummaryAreSummarizedByTheCatchUp` | `Expecting actual: ["e12201"] … could not find the following elements: ["e12202"]` |
| `Qa1203WarningNeverEndsWhileLinesAreDroppedDbTest.aLiftedWarningEndsEvenWhileAnotherWarningsLineIsDroppedEveryCycle` | `[ended_at of the warning lifted at 2026-10-09T07:10:00Z, after 24 h of lists without it …] Expecting actual not to be null` |
| `Qa1203….theEndTimeIsWhenTheWarningLeftTheListNotTheFirstCleanListAfterTheDroppedStreak` | `expected: 2026-10-09T07:10:00Z but was: 2026-10-10T07:10:00Z` |
