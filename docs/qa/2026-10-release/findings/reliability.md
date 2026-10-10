# 신뢰성 — 출시 QA 2차(2026-10-10)

환경 표기는 [기능](functional.md)과 같다(U · A).

## 점검한 것(결함이 아닌 결과 포함)
| 상황 | 방법 | 결과 |
|---|---|---|
| api kill 동안 들어온 특보 목록 · 재전달 · 순서 바뀐 옛 목록 | `tools/qa/rel_warnings_restart.py`(A — 수집기 ACL 사용자로 XADD, DB 는 로컬 소켓 psql 로 읽기) | 7/7 — B 가 W2 를 B 의 수신 시각으로 끝냄 · kill 동안 쌓인 C 로 W2 다시 열림(행 겹침 없음) · 옛 A' 는 아무것도 끝내지 않음 · 실시간 목록 그대로 |
| 백업 → 새 볼륨 → 복원 | `tools/qa/rel_backup_restore_new_tables.sh`(A — README '백업·복원' 절차 그대로) | `wx_warning` · `retained_track` · `airspace` · `airspace_edition` · `alert_event` · `sigmet` · `audit_log` · `ops_user` · `app_setting`(retain_targets · airspace_alerts 값) 모두 같음 · 파일 0600 · 표 42개 · V21 · 다시 기동 healthy |
| 버리는 컨테이너 | `make infra-docker-test` · `make test-collector-db` | edge 42 · Redis ACL 301 · db 권한 36 · 백업 48 · 비밀번호 교체 27 · 이미지 교체 11 · 수집기 PG 11 + 11 — 모두 통과 |
| Redis 설정 · ACL 바꿈 뒤 배포 | 2026-10-09 VERIFICATION #124 · #125 · #126(앞 작업) | 해시 라벨로 다시 만들기 — 이번 QA 에서 다시 보지 않았다(정책 시험 · 격리 프로젝트로 확인됨) |

## 결함

### QA-600 · 보통 · api `/watch` — DB 가 안 되면 공항 조회 하나 때문에 응답 전체가 503
- **환경**: U(MockMvc — `AirportRepository.latestFor` 가 `CannotGetJdbcConnectionException`).
- **재현**: `cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa600WatchDbDownTest'` — `?aircraft=71be01&airports=RKSI`.
- **기대**: 항공기 · 선박 · 알림은 메모리 값(ADR-037 §2)이니 200 + `meta.db_unavailable = true`(공개 조회의 관례 — `ProblemAdvice.answeredWithoutStore`, 선박 검색 · 상세).
  숨은 탭 알림(ADR-037 §5)이 이 응답 하나에 기댄다.
- **실제**: `Status expected:<200> but was:<503>` — 관심 항공기의 진입 · 신호 끊김까지 DB 장애 동안 잃는다.
- **원인**: `apps/api/src/main/java/dev/wakeline/watch/WatchController.java:143` — 예외 처리 없이 `airports.latestFor` 를 부른다.

### QA-601 · 보통 · api 유지보수 — 통계 따라잡기 실패가 지정 대상 보존 복사(70 h)를 막음(조건부 데이터 손실)
- **환경**: U(PostGIS). **재현**: `--tests 'dev.wakeline.history.Qa601CatchUpRetainedCopyDbTest'` — `catchUpStats` 가 던지게 하고 10시간 전 지정 대상 점 → `catchUp()`.
- **기대**: 보존 복사는 다른 따라잡기와 따로(ADR-038 결정 3 — 매시 1분 요약 작업은 실패를 따로 가둔다). **실제**: `expected: 1L but was: 0L`.
- **원인**: `apps/api/src/main/java/dev/wakeline/history/MaintenanceJobs.java:273-276` — 같은 `try` 안에서 통계 따라잡기 뒤에 복사한다.
- **영향 · 심각도 근거**: 매시 복사는 3 h 창뿐이라 api 가 3 h 넘게 멈췄다 뜬 뒤 통계 따라잡기가 계속 실패하면 그 사이 점은 72 h 에 파티션째 지워져 보존표에 오지 못한다.
  두 조건이 겹쳐야 해서 '높음(조건부 데이터 손실)'에서 한 단계 내렸다.

### QA-602 · 보통 · 수집기 특보 — 계약 길이 한도를 넘는 줄 하나가 목록 전체를 api 에서 버리게 함
- **환경**: U(pytest + 스트림 계약 JSON Schema). **재현**: `uv run --offline pytest -q tests/qa/test_qa_602_603_warning_line_isolation.py -k 602`.
- **기대**: "모양이 틀린 줄은 그 줄만 버린다"(ADR-036 결정 2) — 계약(`wx_warnings_payload` — end_notice ≤ 40 · kind/level/command ≤ 16 · 이름 ≤ 80 · raw ≤ 400)을
  어기는 줄은 버리고 센다.
- **실제**: 해석기가 그대로 실어 `["['warnings'… is too long"]` — api 의 스키마 검사가 봉투 전체를 DLQ 로 보낸다. 그 특보가 발효 중인 동안 5분마다 되풀이되고 화면은 옛 목록,
  수집기 상태는 ok.
- **원인**: `apps/collector/wakeline_collector/kma_warning_rules.py:92-130`(`parse_line` 이 길이를 보지 않음).
- **심각도 근거**: 해제예고(ED_TM)는 자유 글자다 — 실제 응답에서 40자를 넘는지는 확인하지 못했다(받은 표본은 빈 칸). 나면 조용히 오래 간다.

### QA-603 · 낮음 · 수집기 특보 — 날짜 계산이 넘치는 줄이 줄 단위 격리를 벗어나 목록 전체를 그 주기에 잃음
- **환경**: U. **재현**: `-k 603` — 발표 `000101010000`(KST → UTC 가 서기 1년 앞) · 예비 때 `999912312359`(다음 날).
- **실제**: `OverflowError: date value out of range` — `parse` 는 `ValueError` 만 잡는다(`kma_warning_rules.py:146`). 실제 응답에서 나올 값은 아니다.

### QA-604 · 낮음 · 수집기 특보 — 다시 부르기가 남은 정규 주기 몫을 남기지 않음
- **환경**: U. **재현**: `uv run --offline pytest -q tests/qa/test_qa_604_warning_retry_headroom.py` — `kma_warning headroom 0 — regular cycles left today 289`.
- **기대**: jobs/weather.py 의 설명대로 "하루 내내 일시 오류여도 정규 주기가 budget_exhausted 로 막히지 않게" 남은 정규 주기 수만큼 남긴다.
- **원인**: `apps/collector/wakeline_collector/jobs/weather.py:48-51` — `REGULAR_CALLS` 에 `kma_warning` 이 없다(주기는 `Settings.kma_warning_poll_s` 라 운영 설정 `rt` 에 없다).
- **영향**: 하루 예산 400 · 정규 288 — 일시 오류로 다시 부른 횟수가 112 를 넘는 날은 남은 정규 주기가 UTC 자정(09시 KST)까지 막힌다. 2026-10-09 운영 배포 직후에도
  첫 호출이 읽기 시간 초과(15 s)로 다시 불렸다 — 일시 오류는 실제로 난다.
