# QA 2026-10 결함 목록(통합)

- 대상: `main` `359a3eac`(2026-10-02 01:29 KST 운영 배포본) — 검증 브랜치 `qa/2026-10`, 환경은 격리 스택 A(`wakeline-e2e` · 8701) · B(`wakeline-qa` · 8702), fixture 모드.
- 상세(환경 · 재현 절차 · 기대 · 실제 · 증거 · 원인 파일:줄)는 영역별 기록에 있다: [보안](findings/security.md) · [신뢰성](findings/reliability.md) ·
  [기능](findings/functional.md) · [화면 · 접근성](findings/ui-a11y.md). 증거는 `evidence/<영역>/`, 고친 뒤 다시 돌린 결과는 `evidence/reverify/`.
- 번호는 영역별 범위(보안 001– · 신뢰성 100– · 기능 200– · 화면 300–). 같은 결함을 두 영역이 찾은 것은 앞 번호로 합쳤다(아래 '합친 것').
- 모든 결함은 재현 시험이 먼저 커밋되어 실패했고(`test(qa): QA-NNN …`), 고친 커밋(`fix(…): QA-NNN …`)에서 같은 시험이 통과한다.

## 요약
| 심각도 | 수 | 번호 |
|---|---|---|
| 치명 | 0 | — |
| 높음 | 3 | QA-100(데이터 손실) · QA-207(익명 요청 하나로 DB 자원 고갈) · QA-401(성능 단계 — 익명 요청으로 공개 조회 고갈) |
| 보통 | 8 | QA-102 · QA-104 · QA-206 · QA-301 · QA-302 · QA-307 · QA-400 · QA-402 |
| 낮음 | 21 | QA-001 · QA-002 · QA-101 · QA-103 · QA-105 · QA-203 · QA-204 · QA-208 · QA-209 · QA-210 · QA-303 – QA-306 · QA-308 – QA-313 · QA-403 |
| **합계** | **32**(중복 3 합침 — 처음 보고 35) | **29건 수정**(재현 시험 통과) · QA-400 은 목표를 다시 정해 닫음(ADR-031) · 2건 남음(QA-402 · QA-403 — 아래 '성능 단계') |

심각도 조정: QA-001 은 처음 '보통'이었으나 독립 재검토 의견대로 '낮음'으로 내렸다 — 정상 클라이언트가 만들지 않는 값(연도 30만 · ±10억)에서만 나고 사용자 기능 손실 없이 상태 코드와 ERROR 로그만 틀렸다(같은 원인의 QA-002, 같은 부류의 QA-203 · QA-208 이 낮음).

## 결함
| 번호 | 심각도 | 영역 | 내용 | 수정 커밋 | 재현 시험 |
|---|---|---|---|---|---|
| QA-100 | 높음 | 신뢰성 · 데이터 손실 | api 기동 때 스트림 소비자가 기록기 · 단일 인스턴스 가드보다 먼저 시작해, 그 사이 처리한 선박 메시지를 쓰지 않고 ACK — `ship_position` 에서 영구 손실(스택 B: kill 뒤 51행, 결정적 재현 237행). 같은 원인으로 두 번째 인스턴스 막기(R-79)도 뚫릴 수 있다(임대를 붙잡아 흉내만 냈다 — 실제 두 번째 api 는 띄우지 않아 미확인) | `4daccc6d` | `apps/api/…/qa/Qa100ConsumerStartsBeforeWritersTest.java` · `tools/qa/qa_100_api_crash_ship_loss.sh` |
| QA-207 | 높음 | 기능 · 성능(자원 고갈) | 통계 날짜가 기원전 4713년 앞이면 pgjdbc 가 `-infinity` 로 보내 `generate_series` 가 끝나지 않음 — 익명 요청 하나에 DB CPU 100 % · 임시 파일 0.5–0.8 GB · 3 s 뒤 503 "다시 시도". 6개 동시면 공개 DB 조회가 모두 503(측정: 통계 · 알림 이력 1 s 만에 503) | `8a840867` | `…/qa/Qa207StatsBcDateRunsAwayTest.java` |
| QA-001 | 낮음 | 보안(견고성) · 기능 | 범위를 벗어난(형식은 맞는) 시각 · 날짜 값이 검증 없이 DB 로 가 400 이 아니라 500 + ERROR 스택(공개 항적 · AIS 공백 · 알림 이력 · 통계, 운영 실행 · 로그 · 집계) — 합침: QA-201 · QA-202 | `8a840867` | `tools/qa/qa_001_outofrange_time.py` · `…/qa/Qa201*` · `Qa202*` |
| QA-102 | 보통 | 신뢰성 | Redis 장애 중 운영 세션 쿠키(Path=/api)가 실린 모든 `/api` 요청(공개 `/aircraft` · `/status` 포함)이 500 + ERROR 스택 — 로그인한 운영자는 상황판 REST 를 모두 잃음 | `ca693fc7` | `…/qa/Qa102RedisDownSessionCookieIT.java` |
| QA-104 | 보통 | 신뢰성 | DB 가 응답하지 않으면 공개 조회의 3 s 한도가 지켜지지 않음(공유 풀에 소켓 시간 초과 없음 — 재생 45 s, edge 504) | `8de7a7db` | `…/qa/Qa104FrozenDbPublicReadIT.java` · `tools/qa/rel_frozen_db_reads.py` |
| QA-206 | 보통 | 기능 | `/aircraft/search` 가 등록부호로 찾고도 응답에 등록부호를 싣지 않아 화면 검색 목록이 '—' | `d2bac03e` | `…/qa/Qa206AircraftSearchHidesRegistrationTest.java` |
| QA-301 | 보통 | 화면 | 배경지도 호스트에 닿지 못하면 재생 지도가 항공기 · SIGMET 을 하나도 그리지 않고 알림도 없음(상황판의 대체 스타일 R-01 이 재생에 없음) | `61450b82`(옮김) · `66352398` | `apps/web/e2e/qa/qa-301-replay-basemap-fallback.spec.ts` |
| QA-302 | 보통 | 화면(모바일) | 375 px 에서 운영 탭 audit · dlq · pipeline 이 화면 밖이고 누를 수 없음(320 px 는 settings 도) | `cf68d06f` | `…/e2e/qa/qa-302-ops-tabs-mobile.spec.ts` |
| QA-307 | 보통 | 화면 · 기능 | 운영 감사 탭이 최근 50건만 보이고 `next_cursor` 를 버림 — 앞선 설정 변경 기록을 볼 길이 없음 | `c357d956` | `…/e2e/qa/qa-307-audit-paging.spec.ts` |
| QA-002 | 낮음 | 보안(견고성) | `/ops/runs` 의 job · provider · status 에 NUL 바이트 → 500 — 합침: QA-205 | `20dce217` | `tools/qa/qa_002_nul_ops_runs.py` · `…/qa/Qa205OpsRunsFilterNulTest.java` |
| QA-101 | 낮음 | 신뢰성 · 계약 | DB 장애 중 운영 503 에 Retry-After 없음(계약 §2 · §G14). (`/ops/logs` 도 503 인 것은 R-95 의 실패-닫힘 규칙으로 의도 — ADR-024 문장을 고침) | `64a372c9` | `…/qa/Qa101OpsUnavailableRetryAfterTest.java` |
| QA-103 | 낮음 | 문서 | README '백업·복원' 이 공급자 켜고 끄기가 Redis 에만 있다고 함 — V11 부터 DB 원본이라 복원됨 | `4895e04c` | `…/qa/Qa103ReadmeRestoreProviderSwitchTest.java` |
| QA-105 | 낮음 | 신뢰성 | 종료 때 마지막 ACK 가 기록기 flush 보다 먼저 — 다음 기동에서 같은 메시지를 다시 처리(쓰기는 멱등이라 값은 맞음) | `4daccc6d` | `…/qa/Qa105FinalAckBeforeWriterFlushTest.java` |
| QA-203 | 낮음 | 기능(WS) | subscribe bbox 의 309자리 이상 정수 → BAD_BBOX 가 아니라 연결 종료(1002). zoom 의 같은 한계(ADR-017 §6 S4)도 함께 고침 | `d90574fc` | `…/qa/Qa203WsBboxHugeIntegerTest.java` |
| QA-204 | 낮음 | 기능(WS) | WS 메시지 상한이 4 KB(바이트)가 아니라 4,096 글자 — 12,240 바이트가 통과 | `84cf44cf` | `…/qa/Qa204WsMessageLimitIsCharsNotBytesTest.java` |
| QA-208 | 낮음 | 기능 | `/ops/stats/aggregate?day=-5000-01-01` → 200 · 감사는 -5000-01-01 인데 통계 행은 `day = -infinity` | `8a840867` | `…/qa/Qa208AggregateBcDayWritesInfinityTest.java` |
| QA-209 | 낮음 | 기능 | `/client-errors` 의 브라우저 시각을 `yyyy`(연대의 연도)로 적어 기원전 · 0년이 다른 서기 연도가 됨 | `7fff7d34` | `…/qa/Qa209ClientErrorTsYearOfEraTest.java` |
| QA-210 | 낮음 | 기능(fixture) | fixture 모드 항공기가 시간이 지나면 관심 지역을 영영 떠나고(55분 뒤 127 → 52대) 보고 방위와 반대로 움직이며 `position_jump` 131건 | `14e1bc5a` | `apps/collector/tests/qa/test_qa_210_fixture_aircraft_leave_region.py` |
| QA-303 | 낮음 | 화면(모바일) | 하단 출처 줄이 좁은 화면에서 잘려 출처 링크 둘이 화면 밖(FR-20 상시 노출) | `13246546` | `…/e2e/qa/qa-303-footer-reflow.spec.ts` |
| QA-304 | 낮음 | 접근성(2.4.3) | 패널 내용이 바뀌면(카드 열기 · 닫기, 설정 저장, 로그인 · 아웃 등) 초점이 `body` 로 떨어짐 | `f3aaee30` | `…/e2e/qa/qa-304-focus-loss.spec.ts` |
| QA-305 | 낮음 | 접근성(2.1.1) | 스크롤되는 내용 영역이 키보드 초점을 받지 못함(axe scrollable-region-focusable) | `b2ab346e` | `…/e2e/qa/qa-305-scroll-region-keyboard.spec.ts` |
| QA-306 | 낮음 | 접근성(1.4.3) | 대비 미달: 범례 미터 글자 4.19:1 · 선택한 로그 행의 ERROR 배지 4.41:1 | `ebb4a142` | `…/e2e/qa/qa-306-contrast.spec.ts` |
| QA-308 | 낮음 | 화면 · 기능 | 통계 7일 패널이 날마다의 `days[].aggregated` 를 무시하고 '구분할 수 없습니다' (기존 E2E 목이 실제 API 에 없는 필드를 넣어 가렸음 — 목도 고침) | `ded17e27` | `…/e2e/qa/qa-308-stats-days-aggregated.spec.ts` |
| QA-309 | 낮음 | 화면 · 기능 | 통계 날짜 칸이 미래 날짜를 받아 조회하고 '집계 뒤 채워집니다' 라고 약속 | `de90ce72` · `fe11e51d` | `…/e2e/qa/qa-309-stats-future-day.spec.ts` |
| QA-310 | 낮음 | 화면 · 접근성 | 대문자 CSS 가 시간 단위를 "9M 55S" · "35M 19S 전" 으로 바꿈(같은 화면의 m 은 미터) | `cb7d52c1` | `…/e2e/qa/qa-310-unit-case.spec.ts` |
| QA-311 | 낮음 | 화면 | 감사 before/after 열이 UTC `…Z` 원문인데 다른 원문 열의 '(raw)' 표시가 없음 | `8fd6ede0` | `…/e2e/qa/qa-311-audit-raw-utc.spec.ts` |
| QA-312 | 낮음 | 기능(수집) | ADS-B 호출부호 채움 '@@@@@@@@'(값 없음)가 api · 검색 · 카드 · 알림까지 그대로 | `f19743a5` | `apps/collector/tests/qa/test_qa_312_callsign_at_fill.py` |
| QA-313 | 낮음 | 접근성(3.1.2) | 영어 제목 · 이름표("Statistics" 등)에 `lang="en"` 없음 | `4958bea9` | `…/e2e/qa/qa-313-lang-of-parts.spec.ts` |

### 성능 단계(고친 빌드에서 — 출시 후보를 잰 결과)
| 번호 | 심각도 | 영역 | 내용 | 상태 | 재현 시험 |
|---|---|---|---|---|---|
| QA-401 | 높음 | 성능 · 가용성 | 공개 `/alerts/history` 의 오래된 창(15–29일 전 — 허용된 값)이 `ORDER BY id DESC` 때문에 기본 키를 최신부터 거꾸로 훑어 약 100만 행을 거르고(8.1–9.5 s) 늘 3 s 에 503 — 익명 클라이언트 하나가 초당 2건이면 공개 조회 격벽(6)을 채워 다른 공개 DB 조회가 25.8–52.7 % 실패 | **수정** `6d35f209`(고친 뒤: 공격 중 다른 공개 조회 실패 0 % · p95 52.9 ms — PERF §14.1) | `apps/api/…/qa/Qa401AlertHistoryOldWindowScansNewerRowsDbTest.java` · `perf/qa/qa-401-alerts-history-old-window.js` |
| QA-400 | 보통 | 성능(메모리) | 운영 규모 실시간 상태(전세계 1만 대 · 선박 1.5만 척)에서 100 rps 동안 api 컨테이너 576–589 MiB · RSS 550–556 MiB(NFR-03 ≤ 512 MB), 몰림 뒤 쉬어도 RSS 693 MiB 에 머묾. NFR-03 은 경합이 있으면 못 맞춘다고 이미 적혀 있다(VERIFICATION #26) — 새로운 것은 경합 없이 NFR-02 부하에서도 못 맞춘다는 것과 몰림 뒤의 고원 | **결정으로 닫음**(2026-10-02 사용자): NFR-03 을 잰 값으로 다시 정함 — 컨테이너 메모리 ≤ 768 MiB([ADR-031](../../adr/ADR-031-api-memory-target.md)). JVM 설정 6가지 × 3번 모두 안전하게 512 이하가 안 됐다(힙 밖 281–298 MiB 고정 — PERF §14.2) | `tools/qa/perf_check_mem.py` |
| QA-402 | 보통 | 성능(화면) | 지도 화면이 Core Web Vitals 'good' 밖: `/` 데스크톱 TBT 1,731 ms · 모바일 LCP 7.4 s · TBT 6.3 s, `/replay` 데스크톱 TBT 1,443 ms · 모바일 LCP 7.3 s(headless 소프트웨어 GL — 실제 GPU 보다 나쁘게 나온다). PERF §7 대비 퇴행은 아님 | **남음** — 지도 초기화 구조를 바꿔야 함(실제 GPU 로 먼저 재기) | `tools/qa/perf_cwv_check.py` |
| QA-403 | 낮음 | 성능(화면) | `/about` · `/stats` 가 모바일 프리셋에서만 CWV 밖(LCP 2.67–2.73 s · TBT 0.6–2.6 s), 데스크톱은 good | **남음** — QA-402 와 함께 | `tools/qa/perf_cwv_check.py` |

### 합친 것
- QA-201(Instant 범위 밖 → 500) · QA-202(LocalDate 범위 밖 → 500) → **QA-001** 과 같은 원인(시각 · 날짜 파라미터에 저장소 범위 검사 없음). 시험은 그대로 두고 결함 하나로 센다.
- QA-205(`/ops/runs` NUL → 500) → **QA-002**.
- QA-207 · QA-208 도 같은 원인이지만 영향(자원 고갈 · 잘못 저장)이 달라 따로 센다. 고친 커밋은 하나(`8a840867` — 공용 `platform.web.TimeParams`).

## 미확인 · 판단한 것
| 항목 | 판단 |
|---|---|
| 운영자 A 가 운영자 B 의 해결 표시를 id 로 되돌림(보안) | **의도된 동작으로 판단** — 해결 표시는 로그 묶음 전체의 상태(팀 공유)이고 역할은 `ROLE_OPS` 하나, 누가 했는지는 감사에 남는다(ADR-024) |
| 운영 공급자 표에 실행한 적 있는 공급자만 나옴(화면) | **결함 아님 → 개선 제안**: 끈 공급자는 Redis 미러(`disabled`)가 남아 표에 계속 보이므로 다시 켤 수 있다. 빠지는 것은 한 번도 돌지 않은(키 없는) 공급자뿐 |
| `/ops/logs` 가 DB 장애 중 503(신뢰성) | **의도** — R-95(세션을 비밀번호에 묶은 확인 — 실패하면 닫힘). ADR-024 문장을 고침(QA-101 커밋) |
| QA-207 의 동시 영향(기능) | **확인함**(리드, 스택 B): 같은 요청 6개 동안 정상 공개 조회(통계 · 알림 이력)가 1 s 만에 503 |
| 두 번째 api 인스턴스(신뢰성) | 띄우지 않음 — QA-100 수정으로 소비자가 가드가 임대를 쥔 뒤에만 읽는다(`LifecycleOrderIT` · `SingleInstanceGuardTest`) |
| 기상청 프레임 · 연안 교통량 격자 중 수집기 kill(신뢰성) | fixture 모드에서 두 작업이 꺼져 있어 재현 불가 — 기존 수집기 시험 26건으로 대신 |
| WS 전체 상한 200 · 브라우저 오류 전체 상한(신뢰성) | 한 호스트 IP 로는 IP 당 상한(5 · 10)이 먼저 걸림 — IP 당 상한은 확인 |
| 외부 공급자 느림 · 끊김(신뢰성) | fixture 모드는 외부를 부르지 않는다 — 수집기의 공급자 실패 시험(폴백 체인 · HTTP · 재시도 · 예산)으로 대신 |
| 항적 요청 두 건 2.1–2.2 s(기능) | 다시 재면 6–17 ms — 재현 안 됨 |
| KST 날짜 경계 통계 · 72 h 보존 경계의 재생(기능) | 새 스택이라 그 자료가 없음 — 기존 DB 시험(`StatsAggregationDbTest` 등)으로 대신 |
| 알림 배너 낭독 글자 붙음 · WS `selected` 중복 · 오프라인 에뮬레이션(화면) | 화면 낭독기 없음 · 원인 추적 못 함 · 브라우저 동작으로 보임 — 미확인으로 남김 |

## 개선 제안(결함 수에 넣지 않음)
영역별 기록의 '개선 제안' 절: 보안 1 · 신뢰성 5 · 기능 10 · 화면 7(+ 위 공급자 표 1). 큰 것만:
- 시각 · 날짜 · 글자 필터 파라미터 검증을 한 곳에(→ QA-001/207 수정에서 `TimeParams` · `Params.filterText` 로 일부 반영).
- SmartLifecycle 의 기동 순서를 phase 숫자가 아니라 의존으로(→ QA-100 수정에서 `StreamPrerequisite` 로 반영) — 새 생명주기 빈도 같은 규칙을 따르게.
- Redis 장애 중 AIS 위치가 선박마다 최신값으로 합쳐지고 공백 기록이 없음(설계 — 문서에 적을 것), 요청 제한기가 Redis 무응답마다 3 s 기다림, `/healthz` 가 DB 장애를 말하지 않음, 저장기 백오프 상한 30 s.
- 같은 정수 파라미터의 범위 밖 처리가 경로마다 다름(400 vs 자르기), 모르는 필터 값의 처리 차이, edge 가 만든 `/api` 오류가 HTML.
- Esc 로 닫기 · 토글 이름 · 맥락 없는 같은 단추 이름 · 운영 화면이 보이지 않는 탭까지 15 s 마다 부름.

## 독립 재검토(별도 에이전트 — 2026-10-02)
처음 보는 리뷰어가 결함 28건(기능 · 보안 · 신뢰성 · 화면 — 성능 4건은 그 뒤에 찾아 제외)을 **원본**(고치기 전 커밋 `0dc46530` 의 작업 트리 · 원본 이미지의 스택 B 8702)에서
적힌 절차와 재현 시험대로 다시 돌렸다.
- **재현**: 28건 모두 재현(부분 2건). 원본 Gradle `dev.wakeline.qa.*` 39건 모두 실패, 원본 화면 spec(스택 B) 20건 실패 · 대조 1건 통과, collector 재현 시험 실패.
  - QA-104: 스택 B 스크립트(`rel_frozen_db_reads.py`)는 두 번 모두 재현되지 않았다 — 멈추는 순간 연결을 이미 빌려 문장을 보낸 요청이 있어야 걸리는 경합이다. **결정적 재현은 `Qa104FrozenDbPublicReadIT`**(15,403 ms > 6,000 ms).
  - QA-310: METAR 쪽은 재현, ETA 쪽은 스택 B 에 예측 알림이 없어 단언까지 가지 못했다(코드로 `.badge` 대문자가 ETA 배지에 걸림을 확인).
- **심각도**: 26건 맞음, QA-001 → 낮음(반영), QA-206 은 보통이 맞되 낮음과의 경계.
- **고친 뒤**: 고친 끝 커밋에서 Gradle 39건 · 화면 spec 21건(스택 A) · collector 4건 모두 통과.
- **적힌 대로 따르지 못한 것(기록에 반영)**: (1) 영역별 기록의 명령은 스택 A(8701 · `wakeline-e2e-db-1`)를 가리키는데 A 는 이제 고친 이미지다 — **원본에서 재현하려면 8702 · `wakeline-qa-db-1`** 로 바꾼다.
  (2) QA-210 수정 커밋 `14e1bc5a` 는 `0dc46530` 의 조상이라 그 작업 트리에서는 QA-210 시험이 통과한다 — `14e1bc5a^` 에서 실패. (3) QA-101 · QA-102 · QA-105 · QA-103 의
  스택 B 손 절차는 설명이라 리뷰어는 재현 시험으로 판정했다. (4) QA-101 · QA-102 는 고친 커밋이 재현 시험의 기대를 바꿨다(브리프대로: QA-101 은 Retry-After 만 단언,
  QA-102 의 공개 경로는 '503'이 아니라 '쿠키 없는 요청과 같은 답 · 500 아님') — 처음 커밋한 시험 그대로는 고친 코드에서도 실패한다. (5) QA-207 의 '6개 동시' 는 리뷰어가 권한
  분류기에 막혀 하지 못했다 — 리드가 스택 B 에서 확인한 값(통계 · 알림 이력 1 s 만에 503)이 근거다. (6) 점검 스크립트 몇은 인자 없이 돌리면 저장소의 증거 폴더에 쓴다.
