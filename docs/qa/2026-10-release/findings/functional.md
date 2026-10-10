# 기능 — 출시 QA 2차(2026-10-10)

- 대상: `main` `3ba5ac49` · QA 브랜치 `qa/release-2026-10`. 환경 **U** = 단위 · 통합 시험(이 Mac · Vitest 5 / JUnit 5 · Testcontainers `wakeline-db:local` / pytest),
  **A** = 격리 스택 A(`wakeline-e2e` · `http://localhost:8701` · fixture 모드 · 운영 이미지와 같은 소스로 빌드).
- 재현 시험은 모두 고치기 전 코드에서 실패했다(실패 글은 각 `test(qa): …` 커밋 메시지에). 고친 커밋과 다시 돈 결과는 [DEFECTS](../DEFECTS.md).

## 점검한 것(결함이 아닌 결과 포함)
- 공개 API 새 경로 5개 + 항적 resolution 의 정상 · 경계 · 비정상 375사례(`tools/qa/fuzz_api.py` — `evidence/functional/fuzz-20261010T035218Z.*`): **5xx 0**, 표시 1건(QA-500).
  범위 밖 시각(+300000 · −5000 · +10억 년)은 새 경로(`/warnings/history`)에서도 400 — 앞선 QA-001 의 공통 검사(`ProblemAdvice` `@InitBinder` → `TimeParams.checked`)가 걸린다.
- WS 86시나리오(`tools/qa/ws_probe.py` — `evidence/functional/ws-20261010T043701Z.*`): 기대와 다른 것 2 — `zoom` 400자리는 앞선 QA-203 수정의 설계(0–24 로 자름)라
  점검 도구의 낡은 기대를 고쳤고, 이진 프레임 종료 코드는 환경 현상(아래 '미확인')이다.
- 앞선 QA 의 재현 시험(코드에 남은 `Qa*` · `test_qa_*` · `qa-*.spec`)은 회귀 전체 실행에서 모두 통과(REPORT §2).

## 결함

### QA-700 · 낮음(처음 보통 — 독립 검토로 조정) · 수집기(fixture) — 특보 재생이 2026-10-10 에 발표 시각을 하루 미래로 옮김(회귀 시험 · CI 빨강)
- **환경**: U(pytest) · A(`make demo` · `make e2e` 의 특보 화면).
- **재현 절차**: 2026-10-10 KST 에 `cd apps/collector && uv run --offline pytest -q tests/test_kma_warning_job.py` — 또는 날짜와 상관없이
  `uv run --offline pytest -q tests/qa/test_qa_700_fixture_warning_time_shift.py`(시계를 2026-10-10 12:30 KST 로 고정).
- **기대**: 발표 시각 = 이번 시(2026-10-10 03:00 UTC), 예비 때 = 내일.
- **실제**: `assert {'2026-10-11T03:00:00Z'} == {'2026-10-10T03:00:00Z'}` — 기존 시험 `test_the_fixture_provider_moves_the_times_to_now` 도 그날 실패
  (`assert 83209.188805 < 3700`). 회귀 `make test` 가 첫 단계에서 멈췄다.
- **원인**: `apps/collector/wakeline_collector/providers/fixture.py:198-200` — `replace` 두 번을 잇는다. 첫 치환이 넣은 '이번 시'의 날짜가 2026-10-10 이면 두 번째 치환
  (`20261010` → 내일)이 그것까지 바꾼다.
- **심각도 근거**: 제품 기능은 fixture 모드만이지만 그날 회귀 · CI 를 막는다(출시 절차를 막음).

### QA-701 · 낮음 · api `/watch` — 진행 중인 AIS 수신 공백이 `ais_last_gap` 에 나오지 않음
- **환경**: U(통합 — 실제 Redis · PostGIS).
- **재현**: `./gradlew --offline test --tests 'dev.wakeline.qa.Qa701WatchOpenAisGapIT'` — ais 상태 해시에 `gap_open_since` 를 쓰고 api 가 읽은 뒤 `/watch?ships=…`.
- **기대**: 계약 v5 §G50 `ais_last_gap {started_at, ended_at?, reason}` · ADR-037 §3 "열린 AIS 공백의 까닭" — 진행 중인 공백(ended_at 없음).
- **실제**: `ais_last_gap` 없음(끝난 공백만 — 웹의 "AIS 수신 공백 중(까닭)" 문구는 결코 나오지 않는다).
- **원인**: `apps/api/src/main/java/dev/wakeline/watch/WatchController.java:78` 이 `ShipStore.lastGap()`(끝난 공백만 — `ShipStore.addGap` 이 열린 공백을 거절) 을 싣는다.
  열린 공백은 `AisStatus.current().openGaps()` 에 있다.

### QA-702 · 낮음 · api 항적 — 지정 보존 점을 분 머리로 걸러 창 경계가 원해상도와 다름
- **환경**: U(PostGIS). **재현**: `--tests 'dev.wakeline.history.Qa702RetainedTrackMinuteBoundaryDbTest'`.
- **기대**: 원해상도와 같이 실제 시각 `ts` 로 `[from, to]`.
- **실제**: `to=10:05:10` 인데 10:05:40 의 점이 나온다(`Expecting empty but was: [{… "hex"="71be01" …}]`), `from=10:05:30` 이면 10:05:40 의 점이 빠진다.
- **원인**: `apps/api/src/main/java/dev/wakeline/aircraft/data/TrackRepository.java:45` · `ships/data/ShipRepository.java:343` — `ts_minute BETWEEN :from AND :to`.

### QA-703 · 보통 · 웹 선박 카드 — AIS 가 끊겼을 때 공급자 지연 "0s"를 지어 보이고, 경고 기준을 넘은 지연을 '정상'으로 등급
- **환경**: U(Vitest · mini-dom). **재현**: `cd apps/web && npx vitest run tests/qa/qa-703-ship-card-ais-lag.test.ts`.
- **기대**: 제품 규칙(받쳐지지 않는 값을 짐작해 보이지 않는다 · 모르면 —) — 끊김이면 지연 모름, 경고 기준(120 s)을 넘으면 상태 바와 같은 '주의'.
- **실제**: `'✕ 공급자 지연 0s (경고)'` · 지연 300 s 인데 `data-grade="ok"`(상태 바는 '주의').
- **원인**: `apps/web/components/ShipCard.tsx:67` — `b.lag ?? 0` · `stale = b.kind !== "live" || b.tone === "bad"`(live 의 tone 은 warn 까지만).

### QA-704 · 낮음 · 웹 관심 대상 — 목록을 비웠다가 다시 더한 대상을 옛 답과 비교해 이미 열린 알림을 '진입'으로 알림
- **환경**: U. **재현**: `npx vitest run tests/qa/qa-704-706-watch-runner.test.ts -t QA-704`.
- **기대**: 막 더한 대상은 이번 답이 기준(lib/watch diffWatch 의 규칙) — 사건 없음.
- **실제**: 배너와 브라우저 알림 `'항공기 71be01 — 진입'`.
- **원인**: `apps/web/components/watch/WatchRunner.tsx:41,60` — 목록이 비면 조회가 멈추고 `prev` 를 그대로 둔다.

### QA-705 · 낮음 · 웹 관심 대상 — WS 알림 기준을 첫 전체 목록 전에 잡아, 이미 열린 알림을 '새 알림'으로 알림
- **환경**: U. **재현**: `-t QA-705`(실행기가 붙을 때 알림 목록이 비어 있고 — `alertsVersion` null — 뒤에 첫 전체 목록이 온다).
- **기대**: 첫 전체 목록의 알림은 기준. **실제**: `'항공기 71be01 — 진입'`.
- **원인**: `WatchRunner.tsx:93` — 첫 구독 때의 Map(빈 것)을 기준으로 삼는다. 실제로는 실행기가 지도 첫 그리기 뒤에 붙어 대개 목록이 이미 있지만, 재연결 · 늦은 WS 에서 난다.

### QA-706 · 낮음 · 웹 관심 대상 — 브라우저에서 알림 허락을 거둬도 숨은 탭 조회가 계속됨
- **환경**: U. **재현**: `-t QA-706` — 허락 'granted' → 숨김 → 'denied' 로 바꾼 뒤 2분: 요청 2 → 6.
- **기대**: ADR-037 §5 "끄는 법: 브라우저에서 알림 허락을 거둔다" · 코드 주석 "조건이 풀리면(… 허락 취소 …) 곧바로 멈춘다".
- **원인**: `apps/web/lib/watch-store.ts:49` — 허락 상태를 모듈을 불러올 때와 단추를 누를 때만 읽는다.

### QA-707 · 낮음 · 웹 근거 카드 — 예측 알림의 판정 때 위치를 "(추정 위치)"로 표시
- **환경**: U. **재현**: `npx vitest run tests/qa/qa-707-709-evidence-replay-warnings.test.ts -t QA-707`.
- **기대**: 근거의 `position` 은 관측 위치(AlertStateMachine) — 추정이 아니다. **실제**: `'… 위치 12s 전(추정 위치) …'`.
- **원인**: `apps/web/components/EvidenceCard.tsx:84` — `positionPart(…, a.estimated)` — `Alert.estimated` 는 PREDICTED 면 늘 true('진입을 예측').

### QA-708 · 낮음 · 웹 재생 링크 — 없는 날짜를 다른 날로 넘겨 엶
- **환경**: U · A. **재현**: `-t QA-708` — `parseReplayUrl("at=2026-09-31T00:00:00Z")`.
- **기대**: "읽을 수 없음" 안내 + 기본 시각. **실제**: 2026-10-01 00:00 로 연다(V8 `Date.parse` 가 넘김).
- **원인**: `apps/web/lib/replay-url.ts:21` — 형식 정규식만 보고 `Date.parse` 에 맡긴다.

### QA-709 · 보통 · 웹 기상특보 — 예비특보 · 발효 예정 특보를 "발효 중"으로 셈('wx' 탭 요약 · 선박 카드 줄)
- **환경**: U · A(격리 스택의 재생 응답은 예비 3건 → '발효 중 3건'). **재현**: `-t QA-709`.
- **기대**: '발효 중'은 발효 시각이 지난 정규 특보만 — 예비(발표 예정)와 발효 예정은 따로(제품 규칙 · 정직성).
- **실제**: 발효 1 · 발효 예정 1 · 예비 1 → `'발효 중 3건(해상 3 · 육상 0)'` · `'해상특보: 지금 발효 중 3건(풍랑 예비 · 풍랑 주의보)'`.
- **원인**: `apps/web/lib/warnings.ts:70` · `components/ShipCard.tsx:336`(목록 전체 개수). 기존 시험 `tests/warnings.test.ts` · `e2e/warnings.spec.ts` 가 이 문구를 고정했다.
- **심각도 근거**: 위험기상 상황판에서 '지금 발효 중' 여부는 핵심 정보다 — 행마다의 '예비 · 예상' 표시는 맞지만 요약이 틀린다.

### QA-710 · 낮음 · api `/watch` — 창(15분)이 지난 항목을 상한 넘김 '버림'으로 셈
- **환경**: U. **재현**: `--tests 'dev.wakeline.qa.Qa710RecentClosedAlertsDroppedTest'` — 1시간 전 닫힘 5,000 + 지금 닫힘 1 → `dropped()` 1(기대 0).
- **원인**: `apps/api/src/main/java/dev/wakeline/watch/RecentClosedAlerts.java:40` — 상한을 넘을 때 지난 항목을 먼저 지우지 않는다(지우기는 `forHexes` 에서만).
  웹은 이 값을 읽지 않는다(영향은 계약 값의 정확성).

### QA-711 · 낮음 · 수집기 운영 도구 — 깨진 공역 입력이 "거절:"이 아니라 traceback 으로 끝남
- **환경**: U. **재현**: `uv run --offline pytest -q tests/qa/test_qa_711_airspace_import_rejects_corrupt_input.py`.
- **기대**: 받아들일 수 없는 입력은 `거절: <까닭>` · 종료 코드 1(ADR-034 · `tools/airspace_import.py`).
- **실제**: 깨진 KMZ → `zlib.error`, Folder 1,500겹 → `RecursionError`(`xml_intake.py:58`), 400자리 고도 → `OverflowError`(`airspace.py:151`). DB 는 바뀌지 않는다.
- **원인**: `apps/collector/wakeline_collector/tools/airspace_import.py:55` — `airspace.AirspaceError` 만 잡는다.

### QA-712 · 낮음 · 웹 관심 대상 — 상황판을 두 탭에 열면 한 탭에서 더한 대상을 다른 탭이 덮어써 잃음
- **환경**: U. **재현**: `npx vitest run tests/qa/qa-712-801-803-watch-ui.test.ts -t QA-712` — 저장 결과 `['71be01','RKSI']`(다른 탭이 더한 선박이 사라짐).
- **원인**: `apps/web/lib/watch-store.ts:34,50` — 모듈을 불러올 때 한 번 읽고 `storage` 이벤트를 듣지 않는다(바꿀 때 자기 옛 목록 전체를 쓴다).
