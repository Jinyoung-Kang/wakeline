# Wakeline — 실시간 항공기 · 선박 · 위험기상 상황판

전세계 항공기(ADS-B)와 선박(AIS), 기상 레이더, 항공 위험기상 경보(SIGMET), 공항 기상(METAR/TAF)을 한 지도에 겹칩니다.
**"지금 SIGMET 안에 있는 항공기"** 와 **"10분 안에 들어갈 항공기"** 를 근거 카드와 함께 실시간으로 찾습니다.
확대해 보는 곳과 고른 항공기는 서버가 따로 더 촘촘히 추적합니다(핫 리전 30 초, 집중 추적 5 초).

![상황판 — 한반도, 기상청 레이더, SIGMET, 알림](docs/images/01-dashboard-korea.png)

> 개인 학습·포트폴리오용 · 비상업 · 로컬 실행입니다. 운항 판단에 쓰면 안 됩니다.
> 모든 값에 출처와 관측 시각이 붙습니다. 모르는 값은 `—` 로 두고, 보간·예측값은 항상 "추정" 으로 표시합니다.

## 한눈에

| | |
|---|---|
| **역할** | 1인 기획·설계·구현·검증(수집기 · API/WS/공간 엔진 · 화면 · 인프라 · 성능·장애 시험) |
| **스택** | nginx · Next.js 16 / React 19 / MapLibre GL 6 · Spring Boot 4.1(Java 25, 가상 스레드, JTS) · Python 3.13(asyncio, httpx, websockets, shapely) · PostgreSQL 18 + PostGIS 3.6 · Redis 8 Streams · Docker Compose |
| **구성** | 상시 컨테이너 7개(edge · web · api · collector · ais · redis · db) + 일회성 migrate(Flyway V1–V7) |
| **데이터** | 항공기 adsb.lol · adsb.fi · OpenSky / 선박 aisstream.io / 기상 AviationWeather.gov · RainViewer · 기상청 API허브 레이더(HSR) / 지도 OpenFreeMap |
| **검증** | 자동 시험 1,288건(pytest 453 · JUnit 395 · Vitest 209 · Playwright E2E 16 · 인프라 정책 44 · Redis ACL 171) · 적대적 리뷰 2회(97건 · 19건 수정) · 장애 주입 6종 · 실측 문제 기록 23건([VERIFICATION](docs/VERIFICATION.md)) |
| **성능(실측)** | REST 100 rps p95 8.6–12 ms · WS 200 연결 p95 286 ms(목표 500) · 집중 추적 관측 간격 중앙값 5.05 s · api 크래시 복귀 6.2 s([PERF](docs/PERF.md)) |
| **설계 기록** | ADR 15건([docs/adr](docs/adr)) · 변경 계약 v1–v3([docs/audit](docs/audit)) |

## 1. 무엇을 하나

| 영역 | 기능 |
|---|---|
| 항공기 | 관심 지역(한반도 반경 250 NM, 10 s) · 전세계(OpenSky, 120 s) · **뷰포트 핫 리전**(줌 7 이상이고 관심 지역 밖이면 화면 중심 반경 ≤ 250 NM 을 30 s 마다, 줌 아웃·이동·보는 사람 없으면 60 s 안에 해제) · **선택 항공기 집중 추적**(ICAO 24-bit hex 로 전세계 어디서든 5 s, 세션당 30분 상한) · 검색 · 항적 · 10분 예측(추정) |
| 위험기상 | SIGMET 폴리곤 + 고도대 + 유효시간으로 구조화 → STRtree 교차 판정 → 히스테리시스 상태기계(진입 2회·이탈 3회) → 관측/예측 알림 근거 카드 · RainViewer / 기상청 HSR 레이더(LCC → 메르카토르 서버 재투영) · METAR/TAF |
| 선박 | AIS 실시간 · 선종별 색 · 선수방위 회전(없으면 침로 점선, 둘 다 없으면 원) · 줌 < 7 은 격자 집계 · 카드(선명·선종·크기·흘수·목적지·ETA — 모두 "보고값") · 항적 · **수신 공백 기록·표시** · 수신 범위 경계 |
| 이력·운영 | 재생(과거 시각 프레임) · 통계 · 공항 · 운영 화면(공급자 on/off · 수집 이력 · 품질 격리 · 런타임 설정 · 감사 로그 · DLQ) |

| 집중 추적(5 s) | 선박 카드 · 항적 · 공백 | 격자 + 수신 범위 |
|---|---|---|
| ![](docs/images/04c-focus-tracking.png) | ![](docs/images/04e-ship-card.png) | ![](docs/images/04f-ships-grid-coverage.png) |

## 2. 아키텍처

```mermaid
flowchart LR
  B[브라우저<br/>Next.js · MapLibre] -->|HTTP · WS :8700| E[edge · nginx<br/>Host 허용 목록 · XFF 덮어쓰기 · limit_req]
  E -->|/| W[web · Next.js]
  E -->|/api /ws| A[api · Spring Boot<br/>ingest · engine · ws · demand · rest · ops · persist]
  C[collector · Python<br/>항공기·기상 폴링 · 정규화 · 품질 게이트 · 예산 · 속도 상한] -->|XADD| R[(redis · Streams · ACL<br/>예산 Lua · 세션 · 수요 임대)]
  S[ais · Python<br/>WebSocket 1개 · 대기열 · MMSI 별 최신 · 10 s 배치] -->|XADD| R
  R -->|XREADGROUP → XACK| A
  A -->|수요 임대 ZSET 60 s| R
  R -->|임대 읽기 전용| C
  A --> D[(db · PostGIS<br/>항적 · 선박 · SIGMET · 알림 · 감사)]
  C -->|수집 기록·품질| D
  X[adsb.lol · adsb.fi · OpenSky<br/>AWC · RainViewer · 기상청] -->|collector 만 호출| C
  Y[aisstream.io] -->|ais 만 연결| S
  B -.->|지도·레이더 타일만| T[OpenFreeMap · RainViewer]
```

- **읽기와 수집의 분리**(ADR-001·006): 외부 지연·429 가 사용자 요청으로 번지지 않는다. api 는 요청을 처리하면서 외부 API 를 부르지 않는다.
- **수요 기반 추적**(ADR-013): 브라우저는 WebSocket 으로 "무엇을 보는지"만 알린다. api 가 세션을 모아 Redis 에 60 s 임대(핫 셀 6개 · 집중 hex 50개 상한, 세션당 새 키 60 s 에 6개)를 쓰고,
  collector 가 임대를 읽어 호출한다. 호출은 우선순위(관심 지역 > 집중 > 핫) 토큰 버킷(adsb.fi 0.8 req/s · 수집기 전체 2 req/s)과 일일 예산 안에서만 나간다. 창을 닫으면 6 s 안에 임대가 사라진다(실측).
- **푸시 수신의 격벽**(ADR-014): AIS WebSocket 은 항공기 폴링과 다른 컨테이너·이벤트 루프에서 받는다. 수신 → 제한된 대기열(20,000건 + 32 MiB) → 정리 → 10 s 마다 바뀐 선박만 스트림으로.
  끊기면 1 → 60 s 지수 백오프 + 지터로 다시 붙고, 재전송이 없으므로 끊긴 구간을 공백으로 기록해 화면·항적에 보인다.
- **스트림이 언어 경계**: 두 언어는 `schemas/*.json` 하나로 계약하고 양쪽에서 같은 파일로 검증한다(바이트 동일 사본 검사 포함).
- **핫 상태는 메모리, 이력은 DB**: 불변 스냅샷 참조 교체(락 없음), STRtree 는 SIGMET 갱신 때만 재구축, 항적·선박 위치는 비동기 배치 저장(일 파티션 · 보존 정책).

### 결정과 그 근거(발췌)
| 결정 | 근거(측정·문서) |
|---|---|
| 선박 수신 범위를 0~45°E 제외 전 해역으로 | 연결 하나로 전세계를 받으면 공급자 쪽 지연이 13 → 22 s 로 커지다 10분에 11번 끊겼다. 구역별로 재 보니 유럽은 단독으로도 따라가지 못했다(ADR-014 부록 A) |
| 항적 선은 60 s 이상 수신 공백에서만 끊음 | 저장 간격이 60 s 라 더 짧은 공백은 저장점을 없애지 못한다. 그러지 않으면 1분마다 생기는 2–6 s 공백이 항적을 조각낸다 |
| seen_at 기준을 공급자 서버 시각으로 | 같은 관측이 세 작업에서 0.1 s 씩 다른 점으로 저장됐다(원천 응답 대조). 공급자 시각이 −10 ~ +2 s 밖이면 수신 시각으로 되돌린다 |
| 컨테이너 PID 1 = docker-init | `docker kill` 은 수동 정지로 기록돼 재시작 정책이 동작하지 않았다(장애 주입에서 발견) |

## 3. 보안
- **단일 진입점**: 127.0.0.1:8700 의 nginx 만 공개. Host 허용 목록(그 밖은 421), X-Forwarded-For 덮어쓰기(위조 헤더로 IP 제한 우회 불가 — E2E 로 확인), IP당 요청·연결 제한 2단(edge + api).
- **비밀값**: `.env`(권한 600)에만, 필요한 컨테이너에만 주입. aisstream 키는 ais 컨테이너에만 있고 브라우저·로그·Redis 에 나가지 않는다(구독 본문에만 — 시험으로 확인). 비밀번호는 명령행이 아니라 환경변수·stdin 으로.
- **최소 권한**: DB 역할 3개(migrator · api · collector), 파티션은 SECURITY DEFINER 함수로만, 슈퍼유저는 로컬 소켓 전용. Redis ACL 사용자 3개(키 패턴·명령 제한, `SCAN`·`CLIENT TRACKING` 금지 — 세션 키 이름 유출 경로 차단).
- **운영 API**: 세션 + CSRF 이중 제출 + If-Match 낙관적 잠금, 비인가는 404, 로그인 실패 잠금·감사 기록(변경과 감사가 한 트랜잭션).
- **컨테이너**: 비root · read-only 루트 · `cap_drop: ALL` · no-new-privileges · 메모리·PID 상한 · 이미지 다이제스트 고정. 화면은 CSP nonce.

## 4. 정직성(구현에 박힌 규칙)
- 서버는 관측값만 스트림에 싣는다. 브라우저 보간 위치는 "지도 위치 추정 · dead reckoning", 예측 알림은 `PREDICTED` 유형과 보라색 점선으로 구분한다.
- AIS "값 없음" 표기(SOG 102.3, 선수방위 511, ETA 0/24/60 등)는 null 로 바꾼다. Timestamp 60(값 없음)은 위치 출처를 단정하지 않고 `—`, 61/62/63 은 수동·추정·장치 비작동 배지.
- 크기·ETA·목적지는 선원이 입력한 보고값이라고 적고, ETA 에는 연도가 없다고 적는다. 기국 공식 번호를 IMO 로 부르지 않는다.
- SIGMET 상한이 "TOP ABV FLnnn" 이면 그 값은 상한의 **하한**으로 표시한다. 폴리곤을 만들 수 없는 경보는 원문으로 남기고 판정에서 뺀다.
- 수집 공백·지연·오래됨은 숨기지 않는다: 상태 바 lag 배지, AIS 공백 배지, 선박·항공기마다 관측 시각(나이), 운영자가 공급자를 끄면 "공급자 꺼짐(운영자)".

## 5. 빠른 시작(macOS Apple Silicon · Docker Desktop)
```bash
git clone <this repo> wakeline && cd wakeline
make up                   # .env 생성(내부 비밀값 자동, 권한 600) + 빌드·기동 → http://localhost:8700
make ops-user u=admin     # 운영자 계정 생성·비밀번호 변경(프롬프트, 12자 이상 — 화면·파일에 남지 않는다)
```
외부 키는 **없어도 동작**합니다(adsb.lol · adsb.fi · AWC · RainViewer 는 무인증). 있으면 켜지는 것: OpenSky(전세계 항공기), 기상청 API허브(한국 고해상도 레이더, 활용신청 필요), aisstream.io(선박).
외부 호출 없이 보려면 `make demo` — 분리된 스택(http://localhost:8701)에서 실응답 스냅샷(fixtures/)을 재생합니다.

| 명령 | 내용 |
|---|---|
| `make test` | pytest · JUnit(+Testcontainers) · Vitest · 인프라 정책 |
| `make e2e` | 격리된 fixture 스택(8701)을 띄워 Playwright 16건 → 스택·볼륨 삭제(개발 스택은 건드리지 않음) |
| `make contract` | Python 메시지 ↔ JSON Schema ↔ Java 사본 대조 + REST 응답 계약 |
| `make bench SHIPS=1` | k6 컨테이너로 api 층 직접 부하(측정 동안만 제한 상향, 끝나면 원복) |
| `make measure-ais d=600 i=30` | AIS 처리량·지연·자원(읽기 전용) |
| `bash tools/chaos.sh` | 장애 주입 6종(api·collector·redis 강제 종료, db 정지, 공급자 차단, ais 네트워크 단절) |
| `make logs s=api` · `make down` · `make clean` | 로그 · 중지(데이터 보존) · 볼륨 포함 초기화 |
| `make backup` · `make restore f=… confirm=wakeline` | PostgreSQL 백업(backups/, 0600) · 빈 새 볼륨에 복원(아래) |

### 백업·복원(PostgreSQL)
영구 보존 자료(SIGMET·알림·통계·감사 로그·운영자·설정)는 db 볼륨 하나에만 있습니다. `make clean`, Docker Desktop 의 데이터 삭제, PostgreSQL 메이저 업그레이드 전에는 백업을 받으세요.
```bash
make backup            # → backups/wakeline-<UTC>.dump (pg_dump 사용자 지정 형식, 파일 0600·디렉터리 0700, git 제외)
make backup full=1     # 72 h 원해상도 항적·선박 위치 행까지 담는다(기본은 이 파티션들의 구조만 — 파일이 작다)
```
- 스택을 멈추지 않아도 됩니다(pg_dump 는 한 스냅샷으로 읽고, db 컨테이너 안 로컬 소켓으로 접속해 비밀번호를 쓰지 않습니다).
- 보관: 새 백업을 확인한 뒤 같은 대상의 최신 10개만 남기고 오래된 것부터 지웁니다(`make backup keep=30` 으로 개수 변경, `keep=0` 이면 지우지 않음). 이 도구의 이름 형식(`<프로젝트>-<UTC>.dump`)이 아닌 파일은 건드리지 않습니다. 운영자 비밀번호 해시와 감사 로그가 들어 있으니 다른 곳에 둘 때도 소유자만 읽게 두세요.
- Redis 는 파생·일시 상태(스트림·캐시·세션·일일 예산 카운터)라 백업하지 않습니다. 운영 세션은 복원 뒤 다시 로그인하고, 운영 화면의 공급자 켜기/끄기는 Redis 에만 있어 다시 설정해야 합니다.

복원은 **새(빈) 볼륨에만** 합니다 — 기존 데이터를 덮어쓰지 않습니다.
```bash
make down
docker volume rm wakeline_db_data             # 되돌릴 수 없습니다 — 복원할 백업 파일을 먼저 확인
tools/dc up -d --wait db                      # db 만 새 볼륨으로: initdb 가 역할 3개(.env 의 비밀번호)·빈 wakeline DB·PostGIS 를 만든다
make restore f=backups/wakeline-<UTC>.dump confirm=wakeline
make up                                       # migrate 가 백업 이후 추가된 마이그레이션만 적용
```
`make restore` 는 확인 문구가 대상 프로젝트 이름과 다르거나, api·collector·ais·migrate 가 실행 중이거나, 대상 DB 에 표가 하나라도 있거나, 파일이 pg_dump 형식이 아니면 아무것도 바꾸지 않고 멈춥니다. 복원은 한 트랜잭션이라 도중에 실패하면 빈 DB 그대로 남습니다. 절차 전체는 `make infra-docker-test` 의 `infra/tests/db_backup_test.sh` 가 버리는 컨테이너로 확인합니다.

### 비밀번호 교체
DB 역할 비밀번호는 새 볼륨을 처음 초기화할 때 한 번만 `.env` 값으로 정해집니다. `.env` 의 값만 바꾸거나 잃으면(`make init` 이 빈 값을 새 난수로 채운다) api·collector·migrate 의 DB 인증이 실패합니다.
```bash
make rotate-db-passwords && make up          # DB 서비스 계정(wakeline_migrator·api·collector) 새 난수 → DB 와 .env 에 함께 적용 → 새 값으로 다시 기동
make rotate-db-passwords sync=1 && make up   # .env 를 잃었거나 값이 어긋나 인증이 실패할 때: .env 의 지금 값을 DB 역할에 맞춘다(.env 는 그대로)
make rotate-db-passwords P=wakeline-e2e sync=1   # 격리 스택(데모·E2E)의 DB 를 개발 스택이 바꾼 .env 값에 맞춘다
```
- 개발 스택과 격리 스택은 같은 `.env` 의 DB 비밀번호를 읽습니다. 그래서 새 값은 개발 스택에서만 만들고(격리 스택에서 새 값을 요청하면 아무것도 바꾸지 않고 멈춤), 교체 뒤 DB 볼륨이 남은 다른 스택이 있으면 도구가 맞추는 명령을 알려 줍니다.
- 도구(`tools/db_rotate_passwords.py`)는 DB 에 SCRAM 검증값만 stdin 으로 보내고(평문은 명령행·로그·화면에 없음), 새 값으로 로그인을 확인한 뒤에만 `.env`(0600)를 바꿉니다. 확인이 실패하면 DB 를 옛 값으로 되돌리고 `.env` 는 그대로 둡니다. `infra/tests/db_rotate_test.sh` 가 버리는 컨테이너로 확인합니다.
- Redis(default·api·collector·ais): redis 는 시작할 때마다 `.env` 값으로 ACL 사용자를 만듭니다. `.env` 에서 바꿀 값을 지우고 `make up` 하면 `make init` 이 새 난수를 채우고 redis·api·collector·ais 가 새 값으로 다시 만들어집니다.
- `DB_ROOT_PASSWORD`(postgres 슈퍼유저)는 TCP 접속이 막혀 있어(로컬 소켓 전용) 새 볼륨 초기화 때만 쓰입니다. 외부 키(OpenSky·기상청·aisstream)는 `.env` 를 고친 뒤 `make up`.

## 6. 저장소 구조
```
apps/api         Spring Boot — dev.wakeline.{ingest,engine,ws,demand,rest,persist,ops,config} · Flyway V1–V7 · JUnit/Testcontainers
apps/collector   Python — providers · normalize · quality · sigmet_parse · budget · ratelimit · demand · jobs · ais/(수신·대기열·정리·발행·공백)
apps/web         Next.js — app/(상황판·replay·stats·airports·ops·about) · lib(ws·store·ships·demand·viewport·interpolate) · e2e
schemas/         aircraft_state · ship_state · ship_static · sigmet · stream_envelope (계약의 단일 원천)
infra/           compose.yml · edge(nginx) · redis(ACL) · db(역할·pg_hba) · tests
docs/            adr/ · audit/(감사·리뷰·변경 계약) · PERF.md · VERIFICATION.md · images/
perf/ tools/     k6 스크립트 · AIS 측정 · 장애 주입 · 계약 검사 · .env 생성
```

## 7. 화면
| | |
|---|---|
| ![근거 카드](docs/images/02-alert-evidence.png) 알림 근거 카드 | ![핫 리전](docs/images/04b-hot-region-tokyo.png) 핫 리전(도쿄, 관심 지역 밖) |
| ![선박](docs/images/04d-ships-tokyo-bay.png) 선박(도쿄만) | ![세계](docs/images/05-world.png) 전세계 |
| ![재생](docs/images/06-replay.png) 재생 | ![운영](docs/images/09-ops-providers.png) 운영 화면 |

## 8. 한계와 다음 단계
- 선박은 0~45°E(유럽·아프리카·중동 서부)를 받지 않는다. 키당 3연결 안에서 구역을 나누고 구역별 공백을 기록하면 넓힐 수 있다(ADR-014 후속 과제).
- 결정한 범위에서도 공급자 쪽 지연이 p50 7.9 s · p90 17.9 s 이고, 20 s 를 넘으면 다시 연결한다(수 분에 한 번, 공백 2–8 s). 운영 설정 하나로 아시아·태평양만(지연 약 2 s)으로 좁힐 수 있다.
- WS 팬아웃 p99 786 ms: 같은 격자 칸을 보는 세션끼리 직렬화 결과를 나누면 줄일 수 있다(PERF §5).
- 선박 위치 72 h 보존은 약 1.9 GB 로 추정된다(측정한 분당 행 수로 계산).

## 9. 데이터 출처·약관
adsb.lol(ODbL 1.0) · adsb.fi(비상업, 초당 1회 이하) · OpenSky Network(연구·비상업) · aisstream.io(API 키, 재전송 없음) · AviationWeather.gov(미 정부 공개, 자체 상한 분당 20회) ·
RainViewer(개인·교육, 줌 ≤ 7) · 기상청 API허브 레이더 합성자료(활용신청) · OpenFreeMap / OpenMapTiles / OpenStreetMap contributors. 화면 하단과 `/about` 에 상시 표기합니다.
