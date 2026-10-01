# Wakeline 코드 리뷰 결과와 개선 계획 (2026-10-01)

- 기준 커밋: `main` `e0e1eba` — 작업 브랜치 `review/cto-2026-10`
- 상태: **계획 — 승인 대기**. 승인 전에는 코드를 바꾸지 않는다.
- 근거 원문(영어, 파일:줄 · 재현 테스트 · 측정값 포함):
  [api-review.md](api-review.md) · [web-review.md](web-review.md) · [collector-review.md](collector-review.md) · [security-review.md](security-review.md)

---

## 0. 한눈에 보기

| 구분 | 결과 |
|---|---|
| 방법 | 네 영역(api · web · collector · 보안)을 읽기 전용으로 나눠 리뷰. 버그는 **오늘 코드에서 실패하는 테스트**로 재현(api 7 · web 11 · collector 5), 성능은 **측정값**만 적음. 운영 스택 · `.env` 는 건드리지 않음 |
| 치명(Critical) · 높음(High) | **없음** |
| 보통(Medium) | 보안 1(운영 CSRF 우회) · 데이터 손실 1(선박 정적 정보) · 신뢰성 5 · 프로세스 2(보안 자동화 미실행 · Postgres 시험 미실행) |
| 구조 | api: **12개 패키지 전체가 하나의 순환**(141개 import) · 위반 11건. web: 컴포넌트 20여 곳이 effect 안에서 직접 API 호출, 728줄 `MapView`. collector: 순환은 없으나 1,600줄 job 이 규칙과 입출력을 섞음 |
| 계획 | 0 안전장치 → **1 보안 → 2 데이터 손실 · 버그** → 3 구조(동작 불변 리팩터링) → 4 성능(측정 기반) → 5 최종 검증 · 독립 리뷰 |
| 결정 필요 | §5 의 8개 — 모두 권장안을 적었다. 승인하면 권장안대로 진행 |

---

## 1. 지금의 빌드 · 테스트 방법 (기준선)

| 영역 | 명령 | 지금 결과 | 시간 |
|---|---|---|---|
| api | `make test-api` = `./gradlew test jacocoTestReport jacocoTestCoverageVerification` + REST 계약 | 968 통과 · JaCoCo LINE 97.1 % / BRANCH 86.3 %(하한 95 / 80) | 약 6분(한 포크, `it` 패키지가 223 s) |
| collector | `ruff check` · `ruff format --check` · `mypy` · `pytest` (+ 실 Redis 시험) | 1,729 통과 · 21 건너뜀(실 Redis 14 — 따로 돌림, **실 Postgres 7 — 어디서도 돌지 않음**) · 커버리지 98 % | 약 2.5분 |
| web | `eslint .` · `tsc --noEmit` · `vitest run` · `next build` · `check:first-js --in-image` | 1,413 통과 · 첫 화면 JS **543,507 B / 550,000 B(여유 약 6.5 KB)** | vitest 약 11 s |
| E2E | `make e2e` (격리 fixture 스택 8701) | 43 통과 | 약 2분 |
| 인프라 | `python3 -m unittest discover -s infra/tests` · `make infra-docker-test` | 129 · 454 통과 | 1분 미만 · 수 분 |
| 보안 | `make security` (gitleaks + Trivy) | PASS | 약 3분 |
| CI | `.github/workflows/ci.yml` (npm audit · pip-audit · Trivy · CodeQL · gitleaks · Dependabot) | **원격 저장소가 없어 한 번도 실행되지 않는다** (S2) | — |

**규칙(이번 작업):** 브랜치 `review/cto-2026-10` 에서 한 주제씩 작은 커밋. 리팩터링과 버그 수정은 한 커밋에 섞지 않는다.
커밋마다 그 커밋이 건드린 앱의 테스트 · 빌드 · 린트 · 타입 검사를 통과시킨다:

- api: 전체 `./gradlew test` + JaCoCo. 계약이 바뀌면 `make contract`.
- collector: ruff · ruff format · mypy · pytest. Redis 를 건드리면 실 Redis 시험도.
- web: eslint · tsc · vitest · next build · `check:first-js --in-image`. 바이트 변화를 커밋 메시지에 적는다.

각 단계 끝에 `make e2e` · `make security` · `make infra-docker-test` 를 돌린다.

---

## 2. 발견한 문제 (심각도 순)

표기:
- 상태 **재현** = 오늘 코드에서 실패하는 테스트가 있다.
- 상태 **코드** = 코드와 바이트코드를 읽어 확인했다.
- 상태 **확인 필요** = 확인 방법을 적어 두고, 고치기 전에 먼저 확인한다.

### 2.1 보안 (먼저 고친다)

| ID | 심각도 | 문제 | 근거 | 상태 |
|---|---|---|---|---|
| **S1** | **보통** | **운영 CSRF 방어를 다른 `localhost:<포트>` 페이지에서 우회할 수 있다.** 세 조건이 겹친다. ① Spring `csrf().spa()` 는 헤더가 없으면 `_csrf` 요청 파라미터로 토큰을 받는다. ② CSRF 쿠키는 `HttpOnly=false · Path=/` 이고 브라우저 쿠키는 포트를 구분하지 않는다. ③ Origin 검사가 없다. 그래서 다른 포트의 페이지가 쿠키 값을 읽어 XOR 토큰을 만들고 단순 POST(사전 요청 없음)를 보내면 `POST /api/v1/ops/providers/{name}/disable` 이 운영자 이름으로 실행된다 | `SecurityConfig.java:52-55, 106-131` · Spring Security 7.1.1 `SpaCsrfTokenRequestHandler` | 코드 |
| **S2** | 보통(프로세스) | 보안 자동화(npm audit · pip-audit · Trivy · CodeQL · gitleaks · Dependabot)는 설정만 있고 원격 저장소가 없어 **실행된 적이 없다**. 로컬 `make security` 는 gitleaks · Trivy 만 돈다 | `git remote -v` 비어 있음 · `tools/security_gate.sh:2-6` | 코드 |
| S3 | 낮음~보통 | DB 장애 중에는 **로그아웃이 503 으로 막히고 세션이 계속 유효하다**. 권한을 줄이는 요청인데도 실패-닫힘 규칙이 적용된다 | `OpsSessionLifetimeFilter.java:61-68` ↔ `OpsSessionController.java:37` | 재현 |
| S4 | 보통 | 익명 WS 클라이언트가 `zoom:1e10` 하나를 보내면 Jackson 3 `asInt()` 가 예외를 던져 **ERROR 스택 로그와 1011 종료**가 난다. 초당 여러 번 반복할 수 있다 | `WakelineWsHandler.java:151` | 재현 |
| S5 | 낮음 | PORT-MIS XML 의 DTD 거절은 원시 바이트만 본다. **UTF-16 본문은 통과**하고 내부 엔티티가 펼쳐진다(외부 엔티티 · XXE 는 아님). 같은 문제를 WFS 쪽은 이미 고쳤다 | `portcalls.py:82, 320-324` | 재현(로컬) |
| S6 | 낮음 | 마스킹하지 않은 예외 · 공급자 응답 글자가 `quality_event.detail` 에 저장되고 `/ops` 에 그대로 보인다 | `jobs/kma_radar.py:1309,1331` · `db.py:187-197` | 코드 |
| S7 | 낮음 | Redis 서비스 비밀번호가 `redis-server` **명령행**으로 넘어간다(프로젝트 규칙 위반, 기동 직후 `ps` 에 보이는 틈) | `infra/redis/start.sh:89,94-99` | 코드 |
| S8 | 낮음 | 운영자 계정 CLI 가 아직 **환경 변수** `WAKELINE_OPS_PASSWORD` 로도 비밀번호를 받는다(규칙: stdin 만) | `WakelineApplication.java:98-100` | 코드 |
| S9 | 낮음 | 응답 크기 상한을 **압축을 푼 뒤 청크마다** 잰다. 한 청크가 약 64 MiB 까지 풀릴 수 있다 | `http.py:191-200` | 코드 |
| S10 | 낮음 | 공급자가 준 RainViewer 타일 host · path 를 검증 없이 브라우저까지 전달한다(CSP 가 유일한 방어) | `jobs/weather.py:305-311` | 코드 |
| S11 | 낮음 | 공급망: 수집기 이미지의 `uv sync` 에 `--locked` 가 없다. 저장소 루트에 `.dockerignore` 가 없다 | `apps/collector/Dockerfile:8-11` | 코드 |
| S12 | 낮음 | 버전: Next.js 16.3.6 → **16.3.8** 이 나왔다. ESLint 9(개발용)는 **2026-08-06 지원 종료**. Python 3.13 은 오늘부터 보안 수정만(2029-10 까지). Node 24 는 2026-10-20 부터 유지보수 LTS(2028-04 까지) | endoflife.date (출처는 security-review §5) | 코드 |
| S13 | 정보 | `/api/v1/status` 가 수집기 해시 `wakeline:active` 를 **통째로** 공개한다. 지금은 안전하지만, 수집기가 새 필드를 쓰면 자동으로 공개된다 | `StatusService.java:109` | 코드 |
| S14 | 정보 | 로그인할 때 세션 ID 는 바꾸지만 **CSRF 토큰은 바꾸지 않는다**(S1 의 쿠키 던지기와 겹친다) | `OpsSessionController.java:99-112` | 코드 |

**안전하다고 확인한 것**(security-review §4):
- SQL 은 모두 바인드 파라미터를 쓴다.
- Redis Lua 는 정적이다.
- 명령 주입 · 역직렬화 · XSS(`innerHTML` 류 0) · SSRF(호스트 허용 목록 · 리다이렉트 안 따라감) · 경로 조작 문제가 없다.
- 키가 들어간 URL 이 로그에 남는 경로는 막혀 있다.
- 비밀값은 파일에 없다.

### 2.2 데이터 손실 · 정합성

| ID | 심각도 | 문제 | 근거 | 상태 |
|---|---|---|---|---|
| **D1** | **보통** | **선박 정적 정보가 조용히 사라진다.** 중복 막기 메모를 행이 *쓰일 때*가 아니라 *큐에 넣을 때* 기록한다. 큐가 넘치거나 배치가 영구 실패하면 그 행은 버려진다. 그 뒤 수집기가 30분마다 같은 `updated_at` 으로 다시 보내도 "이미 저장"으로 건너뛴다. 결과적으로 api 를 재시작할 때까지 DB 의 선박 정보가 비거나 낡은 채로 남는다 | `ShipWriter.java:183-185, 212-219, 306-316` | 재현 |
| D2 | 보통 | 수집기 KMA job 이 Redis 를 실패하지 않는 것으로 다룬다. Redis 오류 · 메모리 부족(OOM)이 나면 `run_once` 가 예외로 끝나고, 그 주기의 **실행 기록 · 품질 사건이 사라지며** 프레임 목록과 meta 가 어긋날 수 있다(`except OSError` 는 redis-py 오류를 잡지 못한다) | `jobs/kma_radar.py:637-675, 908, 926, 1014, 1563-1616` | 재현 |
| D3 | 낮음 | 트랙 · 선박 쓰기가 SQLState 없는 예외를 **영원히 재시도**한다. 큐가 막혀 새 행이 버려진다(재현: 3초에 22번 시도). 같은 예외를 OrderedWriter 는 3번 뒤 포기한다 | `TrackWriter.java:457-466` · `ShipWriter.java:306-321` | 재현 |
| D4 | 낮음 | 예산 되돌리기가 UTC 자정을 넘기면 **다른 날 키**에서 뺀다(새 날 `used=-1` · TTL 없음). 또 EVALSHA 가 시간 초과로 실패하면 무조건 다시 실행해 **두 번 예약**한다(OpenSky 는 그때마다 4 크레딧) | `budget.py:87-91, 135-140` | 재현 · 코드 |
| D5 | 낮음 | 같은 날의 `aggregateDay` 두 실행(정시 · 따라잡기 · 운영 POST)이 겹치면 23505 가 난다. 운영 POST 는 500 을 받고 감사 행도 롤백된다 | `MaintenanceJobs.java:330-356` | 확인 필요 |
| D6 | 보통(알려진 것) | 공개 REST 읽기와 모든 쓰기가 12개 커넥션 풀 하나를 같이 쓴다. DB 가 느릴 때 읽기가 몰리면 쓰기가 굶어 큐가 넘칠 수 있다 | `application.yml:13` · `Sql.java:29` · 계약 v5 에서 미뤄 둔 항목 | 확인 필요(측정 먼저) |

### 2.3 기능 버그 (재현된 것 위주)

**api**
- **A1**(보통, 재현): 첫 관심 지역 스냅샷 전에 `/actuator/health` · `/actuator/health/ingest` 가 **500** 이다. Boot 4 의 `withDetail(null)` 거절 때문이다(`IngestHealthIndicator.java:78`). 지표가 알려야 할 바로 그 상태에서 500 이 난다.
- **A2**(낮음, 재현): Jackson 3 의 형 변환 예외가 5곳에서 난다. 레이더 `echo_cells` 이 숫자가 아니면 `/radar/kr` 가 500 이고, 범위 밖 설정값이면 400 대신 500 이다(`KrRadarFrames.java:43` · `SettingsService.java:200` 외).
- **A3**(낮음): 레이더 프레임 이미지가 Redis 오류면 404, 깨진 base64 면 500 이다(`WeatherController.java:236-244`). → §5 결정 6.
- **A4**(낮음): 조용한 catch-all 이 있다. 공개 속도 제한기는 Redis 가 죽으면 기록 없이 열린다. Redis 오류를 '전환 기록 없음'과 구분할 수 없다(`RateLimiter.java:29-34` · `OpsController.java:103`).

**web**
- **W1**(보통, 재현): 로그 '이전 항목 더 보기'를 두 번 누르면 같은 쪽이 두 번 붙는다. 숨김 · 건너뜀 수가 부풀려진다(`LogsDashboard.tsx:238-248`).
- **W2**(보통, 재현): 운영 설정 '저장'을 두 번 누르면 PUT 이 두 번 나간다. 저장은 됐는데 화면은 "다른 곳에서 바뀜(409)" 오류를 보인다. 공급자 켜고 끄기도 같다(`ops/page.tsx:400-417, 263-265`).
- **W3**(보통, 재현): 검색에서 항공기 A 를 고르고 곧 B 를 고르면, A 의 늦은 응답이 지도를 **A 로 옮긴다**(`AircraftSearch.tsx:110-124`).
- **W4**(보통, 재현): 공급자 끄기 실패 메시지를 15초 자동 새로고침이 지운다. 운영자가 실패를 놓칠 수 있다(`ops/page.tsx:198, 233`). → §5 결정 4.
- **W5**(낮음~보통, 재현): 공항 카드가 다음 공항을 불러오는 동안 **앞 공항의 오류와 요청 id**를 보인다(`AirportCard.tsx:32-50`).
- **W6**(낮음~보통, 재현): `EtagPoller` 가 `stop()` 뒤에 도착한 응답을 발행한다. 레이어를 껐다 켜면 옛 폴러의 늦은 답이 새 상태를 덮는다(`etag-poller.ts:58-89`).
- **W7**(낮음~보통, 재현): 지도 칩의 `aria-live` 영역이 선박 수가 바뀔 때마다(≥10 s) 화면 낭독기에서 **다시 읽힌다**(`MapChips.tsx:64`). → §5 결정 3.
- **W8**(낮음, 재현): MapView 의 '이미 그림' 캐시가 지도보다 오래 산다. StrictMode(개발 모드)에서 SIGMET · AIS 범위 외곽선이 그려지지 않는다(`MapView.tsx:151, 441, 682-692`).
- **W9**(낮음, 재현): KR 레이더 · 공항 폴링에 진행 중 확인이 없다. 응답이 멈추면 5분 뒤 요청 6개가 쌓인다(`MapView.tsx:349-356`).
- **W10**(낮음, 재현): REST 응답을 검증 없이 캐스팅한다(WS 는 검증한다). `/radar/kr` 가 `frames` 없이 오면 **대시보드 전체가 오류 화면**이 된다(`RadarTimeline.tsx:54`).
- **W11–W17**(낮음): 경로 파라미터 미인코딩(운영 POST/PUT · 공항 링크) · 숨은 탭에서도 폴링(§5 결정 2) · 로그 자동 확인 타이머가 쪽을 넘길 때마다 다시 걸림 · `openById` 순서 보장 없음 · 세션 확인이 모든 오류를 '로그인 안 됨'으로 처리 · `apiGet` 이 `Headers` 객체를 버림 · 이전 기간 오류가 남음.

**collector**
- **C1**(낮음, 재현): job 태스크가 예기치 않게 끝나도 어느 job 인지 · 왜인지 남기지 않고 **종료 코드 0** 으로 끝난다(ais 는 1 로 끝난다)(`main.py:271-284`).
- **C2**(낮음): 원본 보관(raw archive) 실패에 로그도 카운터도 없다(`raw_store.py:48-49, 63-64`).
- **C3**(낮음, R-65 로 미뤄 둔 것): job 마다 '보내지 않음' 판정이 다르다. 풀 시간 초과를 공급자 실패로 세어 3번 쉬기에 넣고, 예산을 돌려주지 않는다(`jobs/aircraft.py:229-230` 외).
- **C4**(낮음, 잠복): `kst_now()` 가 KST 벽시계 시각에 UTC 표시를 붙여 돌려준다. KST 정의가 세 군데 있다(`providers/kma_radar.py:29-30` 외).
- **C5 · C6**(확인 필요): DB 풀 `max_size=2` 에서 생존 확인이 굶을 수 있다. 3xx 응답을 성공으로 다룬다(`db.py:180` · `http.py:186-189`).
- **C7**(프로세스): 실 Postgres 통합 시험 7개가 CI · Makefile 어디서도 돌지 않는다. 수집기 SQL 을 api 의 Flyway 스키마와 자동으로 맞춰 보는 장치가 없다.

### 2.4 구조 (아키텍처)

**api** — api-review §1–§2
- 패키지가 기술 단위(`rest` · `persist` · `ws` · `config` · `domain` …)로 나뉘어 있고, **12개 패키지 전체가 하나의 순환**이다(패키지 사이 import 141개).
- 방향 위반의 예:
  - `domain.Bbox` 가 HTTP 오류형 `config.Problem` 을 쓴다.
  - REST 컨트롤러가 WS 허브 상태를 읽는다(`rest → ws`).
  - 상태 서비스가 `rest` 안에 있어 `ops · ws` 가 `rest` 를 부른다.
  - `persist → ops.RegionSettings`.
- 데이터 접근이 들어간 컨트롤러가 3개 있다: `OpsController`(SQL), `OpsPipelineController` · `WeatherController`(Redis).

**collector** — collector-review §1–§2
- 순환은 없다. 방향이 틀린 import 가 6곳이다:
  - `errors → http`
  - `retry → budget`
  - 결정 상태기계 `fallback` 이 Redis 어댑터를 품는다
  - `portcalls → route`
  - `ais.sink` 가 publisher 의 비공개 이름을 쓴다
- `jobs/kma_radar.py`(1,626줄) · `jobs/traffic_grid.py`(1,627줄)가 규칙 · HTTP · Redis · 로그를 한 클래스에 섞는다. 두 파일 모두 이미 순수한 블록 약 375줄 · 320줄을 갖고 있어 떼어 내기 쉽다.

**web** — web-review §1, §3
- 컴포넌트 · 페이지 20여 곳이 `useEffect` 안에서 엔드포인트 URL 을 직접 만들어 호출한다.
- 오래된 응답을 버리는 방식이 세 가지로 갈려 있다(`live` 플래그 · `seq` · 키 결과).
- 취소(AbortController)는 두 곳만 쓴다.
- `MapView.tsx`(728줄)의 한 effect(158–421)가 지도 · 워커 · WS · 폴링 · 팝업을 모두 만든다.
- 좋은 본보기는 이미 있다: `lib/ws.ts` · `ReplayLoader` · `RequestOrder` · stats 의 `useLoad` 는 React 와 분리된 모양이다.

### 2.5 성능 (측정값만 — 변경은 §3 Phase 4 에서 전후를 다시 잰다)

환경: M1 · 개발 빌드 마이크로벤치. 수치는 상대 크기다.

| ID | 위치 | 측정 | 판단 |
|---|---|---|---|
| P1 | api `StreamConsumer` 전세계 메시지(1만 대) | 메시지 하나에 84 ms. 스키마 검증 48.6 ms + **같은 JSON 두 번 파싱** 16.4 ms. 단일 소비 스레드라 뒤 메시지가 줄을 선다 | 측정 지표에 태그가 없어 운영에서 안 보인다 → 먼저 보이게 하고, 한 번 파싱으로 줄일지 판단 |
| P2 | api 엔진 | hot · focus 스냅샷마다 전체 주기 33 ms(1만 대 × SIGMET 130) | 운영 지표로 CPU 비중을 보고 판단(지금 예산 안) |
| P3 | api `LogReader` | 운영 로그 화면 폴링마다 전체 재스캔 119–139 ms(4,200건) | 스트림 마지막 id 로 캐시하면 0 에 가깝다 — 측정 후 결정 |
| P4 | api SIGMET 재생 조건 | 인덱스를 못 쓰는 조건(데이터가 쌓이면 느려짐) | 합성 20만 건 `EXPLAIN ANALYZE` 로 전후 |
| P5 | collector `kma_grid` | 전체 격자 float32 복사 2번 = 14.0 ms · +57 MiB | int16 임계값이면 2.4 ms · +6.4 MiB(같은 결과) |
| P6 | collector 이벤트 루프 | 전세계 처리(스레드)도 GIL 로 15–19 ms 멈춤. demand 정규화는 루프에서 2–15 ms | 수집기에 루프 지연 지표가 없어 운영에서 판단 불가 → 지표부터 |
| P7 | web 선박 목록 | 1만 척에서 매초 3.2–6.0 ms(50줄 보여 주려고 전체 정렬) | `useMemo` 로 줄인다 — Profiler 커밋 수 시험 |
| P8 | web 경보 패널 | 숨겨져도 1초마다 다시 그림(0.9–3.1 ms) | React 19 `<Activity>` 로 숨김 동안 0 |

---

## 3. 개선 계획 (우선순위 순)

### Phase 0 — 안전장치와 기준선 (동작 변경 없음)

1. 기준선을 기록한다: 테스트 수 · 시간, 첫 화면 JS, P1–P8 측정 스크립트(저장소 안 · 새 의존성 없이 — JUnit 측정 테스트 · `vitest bench` · pytest 측정).
2. **구조 가드 테스트**:
   - api `ArchitectureTest` — JUnit + JDK 만 쓴다. 오늘의 위반 11건을 허용 목록으로 두고, 순환 import 수는 **줄어들기만** 하게 한다.
   - collector `test_layering.py` — AST 로 검사하고 위반 6건을 허용 목록으로 둔다.
3. 리팩터링 전 **현재 동작을 고정하는 시험**:
   - api: 리스너 배선 · 순서, 세션 직렬화 클래스 이름, 상태 응답 골든.
   - web: 시험이 없는 fetch 경로들.
   - collector: 차단기 사다리 단위 시험.

### Phase 1 — 보안 (각각 실패하는 시험 먼저)

| 순서 | 항목 | 고치는 방법(근본 원인) |
|---|---|---|
| 1 | **S1 · S14** CSRF | ① 토큰을 **헤더에서만** 받는다(파라미터 경로 제거). ② 운영 변경 요청(GET 아님)은 `Origin`/`Sec-Fetch-Site` 가 허용 목록이 아니면 403. ③ 로그인 때 CSRF 토큰을 새로 만든다. SecurityIT 에 다른 Origin · `_csrf` 파라미터 사례를 더한다 |
| 2 | S4 WS 입력 | 숫자를 범위 안전하게 읽는다. 처리기 전체 예외를 프로토콜 오류로 바꾸고 WARN 은 속도를 제한해 남긴다. 메시지 종류별 잘못된 입력 표 시험 |
| 3 | S3 로그아웃 | 로그아웃 요청은 자격 비교를 건너뛴다(권한을 줄이는 요청). 최대 수명 확인은 그대로 둔다 |
| 4 | S5 · S6 · S9 · S10 수집기 | PORT-MIS 는 엄격한 UTF-8 + 전체 DTD 검사(WFS 와 같은 함수). `quality_event.detail` 은 마스킹한다. 압축 해제에 상한을 둔다. RainViewer host 는 허용 목록, path 는 정규식으로 검사한다 |
| 5 | S7 Redis | 비밀번호를 명령행 대신 ACL 파일(tmpfs, 0600)로 넘긴다 — **배포 때 Redis 재시작이 필요하다** |
| 6 | S8 CLI | 환경 변수 비밀번호 경로를 없앤다 → §5 결정 5 |
| 7 | S13 · I-2 | 상태 응답의 `wakeline:active` 필드를 허용 목록으로 제한한다. 429 본문은 `ProblemJson` 으로 만든다 |
| 8 | S11 · S12 · S2 | 수집기 이미지에 `uv sync --locked`, 루트 `.dockerignore` 추가. Next.js 16.3.8(패치). ESLint 10 은 `eslint-config-next` 가 지원하면 올린다(§5 결정 7). `make security` 에 npm audit · pip-audit 를 더한다 — CI 와 같은 검사를 로컬에서 돌린다 |

### Phase 2 — 데이터 손실 · 신뢰성 버그 (각각 실패하는 시험 먼저, 근본 원인 수정)

- **api**
  - D1: 쓰기가 버려지면 메모를 비워, 다음 재전송이 다시 쓴다.
  - D3: 쓰기 오류 분류기를 하나(`DbErrors`)로 모은다. 모르는 오류는 3번 뒤 ERROR 로 포기한다.
  - A1: null 상세를 빼고, 상태 표(유예 · 없음 · 있음) 시험을 둔다.
  - A2: 범위 안전 읽기 + 표 시험.
  - D5: 같은 날을 advisory lock 으로 직렬화한다 — DB 시험으로 23505 를 먼저 확인한다.
  - A4: 오류 카운터와 속도 제한 WARN, `error` 필드.
  - A3: §5 결정 6 대로.
- **collector**
  - D2: KMA 의 Redis 오류를 잡고, 실행을 기록하고, 프레임 저장 순서를 정리한다.
  - D4: 예약한 키로 되돌린다. NOSCRIPT 만 다시 실행한다.
  - C1: 끝난 태스크와 예외를 남기고 종료 코드 1.
  - C2: 속도 제한 WARN + 카운터.
  - C5 · C6: 먼저 확인하고, 확인되면 고친다.
  - C7: 실 Postgres 시험을 `make test-collector-db` 와 `infra-docker-test` 묶음에 넣는다.
- **web**
  - W1 · W2: 진행 중 막기 + 단추 `disabled`/`aria-busy`.
  - W3: 선택 토큰.
  - W5 · W17: 오류를 키로 묶는다.
  - W6: 폴러 세대 번호 + 중단.
  - W8: 지도 단위 캐시.
  - W9 · W10: KR · 공항 폴링을 `EtagPoller` 로 옮기고 `parseKrRadar` 로 검증한다.
  - W11: 인코딩.
  - W14: 순서 번호.
  - W15: 세션 확인은 401/404 만 로그인으로 본다.
  - W16: `Headers` 를 보존한다.
  - W4 · W7 · W12: §5 결정대로.

### Phase 3 — 구조 개선 (동작 불변, 리팩터링 커밋만)

#### 3A api — 기능 단위 패키지, 의존 방향은 바깥 → 업무 규칙

목표 구조(api-review §2.2 — 149개 클래스 모두 대응표 있음, 옮긴 결과는 **패키지 순환 0** 으로 모의 확인됨):

```
platform.{config,web,data,support}   기반 — 기능을 import 하지 않는다
geo                                   Bbox · Geo · GeoJson — 아무것도 import 하지 않는다
aircraft.{core,data,web}              core = 업무 규칙 · 상태(JDBC · Redis · 서블릿 금지), data = 저장소, web = 컨트롤러 · JSON
ships.{core,data,web}
weather.{core,data,web}               SIGMET · 경보 엔진 · 레이더 · 공항
ingest(스트림 어댑터) · ws(WS 전송 — 아무도 import 하지 않음)
ops · settings · status · history · traffic · coverage · demand · route · portcalls · logs   작은 기능은 평평하게
```

순서 — 커밋마다 전체 시험을 통과시키고, 가드의 허용 목록 · 순환 수를 줄인다:

1. 이벤트 표시 인터페이스를 둔다(리스너 격리가 클래스 이름 검사에 기대지 않게).
2. `platform` · `geo` 를 뗀다.
3. 운영 보안 배선 · WS 설정을 옮긴다.
4. `settings` 를 옮긴다.
5. `status` 를 옮긴다.
6. JSON 인코더를 옮긴다 → **순환 0**.
7. `aircraft` 를 옮긴다.
8. `weather` 를 옮긴다.
9. `ships` 를 옮긴다.
10. 작은 기능 묶음을 옮긴다.
11. 컨트롤러에서 데이터 접근을 뺀다(`OpsQueries` · `PipelineSignals` · `KrRadarReader`) → 허용 목록 0.

함정과 대응(api-review §2.7):
- **세션에 직렬화되는 클래스**(`OpsAuthentication` · `OpsUserService$User`)는 옮기지 않는다 — 옮기면 운영자가 모두 로그아웃된다.
- 리스너 순서(엔진 → WS)는 `@Order` 로 명시한다.
- 다른 언어 시험이 Java 파일 경로를 읽는 곳(6곳)은 같은 커밋에서 고친다.
- OpenAPI 스냅샷 · WS 표본 · REST 계약은 **바이트 그대로**여야 한다.
- **옮긴 클래스의 로그 지문이 바뀐다** → §5 결정 1.

#### 3B collector — 순수 규칙 모듈을 뗀다

순서(collector-review §2.3):

1. `http_errors` 를 뗀다.
2. publisher 의 `envelope` 를 모듈 함수로 만든다.
3. `textutil.clean_text` 를 뗀다.
4. `kma_rules` — 이미 순수한 229–603줄과 판정 도우미.
5. `kma_store` — Redis 어댑터. D2 수정 뒤에 한다.
6. `traffic_grid_plan` + `Breaker` — 중복된 차단기 논리를 하나로 모은다.
7. `chain_state` — 결정 상태기계를 Redis 에서 떼고, 끈 공급자 목록은 주기마다 한 번 읽는다.
8. `timeutil` — KST 정의를 하나로 모은다(C4).

테스트가 기대는 이름(`_now` · `_sleep` · `kst_now` · `_decode` · `fallback.time` 등)은 그대로 둔다.

**하지 않는 것:**
- `logsink`, 항만 계획기, 얇은 job 들, `ais/*` — 이미 나뉘어 있다.
- 항만 SQL — 그 기능을 다시 만질 때 한다.

#### 3C web — 화면과 로직 분리

1. **API 클라이언트**: `lib/api.ts` 는 전송만 맡는다. 영역별 `lib/endpoints/{aircraft,ships,weather,stats,replay,ops,logs}.ts` 를 둔다.
   - 함수마다 타입을 갖고, `AbortSignal` 을 받고, 경로 파라미터를 인코딩하고, 파서가 있으면 파싱한다.
   - 기존 `vi.mock("@/lib/api")` 시험 7개가 그대로 동작하도록 `@/lib/api` 에서 import 한다.
2. **순수 함수**: 컴포넌트 안의 규칙 · 변환 약 20개를 `lib/*` 로 옮긴다. 지연 로딩 카드의 것은 지연 전용 모듈로 보내 첫 화면 시험이 지킨다.
3. **커스텀 Hook**:
   - `useApiResource`(키별 결과 · 키 변경 시 중단 · 진행 중 새로고침 막기 · 숨은 탭 건너뜀 — stats `useLoad` 를 일반화)
   - `useVisibleInterval`(React 19.3 `useEffectEvent`)
   - `useOpsSession` · `useOpsTabs` · `useLogFeed`
   - MapView 를 Hook 6개로 나눈다(지도 수명 · 실시간 피드 · 포인터 · 기상 레이어 · 선박 레이어 · 선택 항적). 한 커밋에 한 묶음씩 하고, 첫 화면 JS 를 매번 잰다.
4. **하지 않는 것**:
   - react-query 같은 라이브러리 — 첫 화면 여유가 6.5 KB 이고, 스토어와 중복된다.
   - ShipCard 의 상태 있는 재조회 규칙, StatusBar, Replay, ResolveConfirm — 이미 잘 나뉘어 있다.
   - 이미 순수한 것을 감싸는 이름뿐인 Hook.

### Phase 4 — 성능 (측정 → 변경 → 다시 측정, 수치는 커밋 · PERF.md 에)

1. collector 루프 지연 지표를 단다 — 이것이 있어야 운영에서 P6 을 판단할 수 있다.
2. P5 `kma_grid` 정수 임계값.
3. P7 선박 목록 `useMemo`, P8 경보 패널 `<Activity>` — Profiler 커밋 수 시험.
4. P1 `StreamConsumer` 처리 시간 지표에 메시지 종류 태그를 단다. 한 번 파싱이 재현 가능한 이득을 보이면 그때 바꾼다.
5. P4 SIGMET 재생 조건 — 합성 데이터 `EXPLAIN ANALYZE` 전후.
6. P3 `LogReader` 캐시 — 전후 측정.
7. D6 풀 굶주림 — 격리 스택에서 k6 + DB 지연으로 **확인되면만** 읽기 동시 수를 제한한다.
8. P2 엔진 — 운영 지표로 판단하고, 이번에는 바꾸지 않는다.

### Phase 5 — 최종 검증 · 독립 리뷰 · 문서

1. 전체 시험 · E2E · 보안 게이트 · `infra-docker-test` · 첫 화면 JS(이미지 · 브라우저)를 돌린다.
2. **처음 보는 리뷰어 역할의 별도 에이전트**에게 전체 변경을 검토시킨다. 정확성 · 요구사항에 영향을 주는 지적만 고친다.
3. 문서:
   - **ADR-028**(패키지 경계 · 의존 규칙 · 가드 시험)
   - **ADR-029**(웹 데이터 접근 — endpoints · Hook · 오래된 응답 규칙)
   - VERIFICATION 항목, README 수치, 최종 보고(변경과 이유 · 실행한 명령과 결과 · 성능 전후 · 남은 위험)

---

## 4. 이번에 하지 않는 것 (이유)

- 마이크로서비스 · 메시지 브로커 · 새 저장소 · react-query 류 — 필요가 입증되지 않았다(사용자 원칙).
- 저장소 인터페이스 · 포트 계층 — 테스트용으로 이미 있는 두 개(`CoverageSource` · `DemandLeases`) 외에는 만들지 않는다.
- 데이터를 바꾸는 마이그레이션 · git 이력 재작성 · 강제 푸시 — 계획에 없다. 필요해지면 멈추고 묻는다.
- 공개 API · URL 변경 — 없다. 패키지 이동은 URL · OpenAPI 태그 · WS 메시지를 바꾸지 않으며, 계약 시험이 지킨다.
- 로컬 다중 계정 잠금(R-96) · 별도 호스트 이름(R-97) — 단일 호스트 설계의 알려진 한계이고 별도 결정 사항이다. S1 수정으로 CSRF 쪽 위험은 닫힌다.
- Python 3.14 · Node 다음 LTS 이주 — 아직 지원 기간 안이다. 별도 작업.

## 5. 결정이 필요한 것 (권장안대로 진행하려면 계획 승인만으로 충분)

| # | 질문 | 권장안 | 이유 |
|---|---|---|---|
| 1 | api 클래스를 옮기면 그 클래스가 남기는 로그의 **지문**이 바뀐다(지문에 로거 이름 = 클래스 이름이 들어간다). 기존 '해결 처리'는 옛 지문에 묶여 있어 같은 오류가 새 묶음으로 다시 보인다 | **받아들이고 VERIFICATION · 최종 보고에 적는다**(데이터는 바꾸지 않음) | 옛 이름 유지 장치는 복잡도에 비해 가치가 낮다. 해결 처리는 운영자가 다시 하면 된다 |
| 2 | 숨은 탭에서도 계속 폴링(운영 15 s × 7, 로그 15 s, 항공기 카드 30 s) | **숨은 동안 멈추고, 다시 보이면 즉시 새로고침** | WS · 워커 · EtagPoller 와 같은 규칙. 보이는 화면의 신선도는 같다 |
| 3 | 지도 칩의 화면 낭독기 알림 | **상태가 바뀔 때만 알림**(모드 · 경고 켜짐/꺼짐), 숫자 변화는 알리지 않음 | 10초마다 다시 읽는 것은 접근성 결함 |
| 4 | 운영 쓰기(공급자 켜고 끄기 · 설정) 실패 메시지 | **다음 쓰기나 닫기 단추 전까지 유지**(주기 새로고침이 지우지 않음) | 실패를 놓치지 않게 |
| 5 | 운영자 계정 CLI 의 환경 변수 비밀번호 경로(S8) | **제거**(stdin 만, `make ops-user` 는 이미 stdin) | 프로젝트 규칙과 맞춘다. 기능 제거라 확인을 받는다 |
| 6 | 레이더 프레임 이미지가 Redis 오류일 때 | **503 + Retry-After**(없을 때는 404 그대로, 깨진 데이터는 404 + 카운터) | 계약 §2(일시 장애 = 503)와 맞춘다. 지금 코드는 일부러 '없음'으로 다루므로 확인을 받는다 |
| 7 | ESLint 10(개발용) | **`eslint-config-next 16.3.x` 가 지원하면 올리고, 아니면 보류하고 보고** | 지원 종료이지만 개발 전용 · 런타임 영향 없음 |
| 8 | 전세계 항공기 메시지의 스키마 검증 생략(P1 선택지) | **생략하지 않는다**(신뢰 경계 유지). 한 번 파싱으로 줄이는 것만 측정 후 검토 | 보안 경계를 성능과 바꾸지 않는다 |

## 6. 위험과 대응

| 위험 | 대응 |
|---|---|
| 대규모 패키지 이동으로 회귀가 생긴다 | 한 기능씩 작은 커밋, 커밋마다 전체 시험, 가드 시험, 계약 · 스냅샷 바이트 비교 |
| 첫 화면 JS 여유가 6.5 KB 뿐이다 | 웹 커밋마다 `--in-image` 측정. Hook 을 파일 몇 개로 묶는다. 넘으면 그 커밋을 고친다 |
| 커밋마다 api 시험 약 6분 × 약 20회 | 이동 중에는 `it` 밖을 먼저 빠르게 돌리고, 커밋 전에 전체를 돌린다 |
| CI 가 돌지 않는다(S2) | 로컬 게이트를 기준으로 삼는다. 모든 명령 · 결과를 최종 보고에 적는다. 원격 · CI 연결은 사용자 결정 |
| 배포 때 Redis 재시작(S7) · api 재시작으로 세션이 끊길 수 있다 | 세션 클래스는 옮기지 않는다. Redis 는 AOF 라 짧은 재연결 WARN 만 난다(이전 배포에서 확인) |
