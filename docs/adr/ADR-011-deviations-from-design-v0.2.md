# ADR-011 설계서 v0.2 와 달라진 점(구현 시 결정)

| 항목 | 설계서 | 구현 | 이유 |
|---|---|---|---|
| 명령 도구 | justfile | Makefile | 기존 포트폴리오와 동일, `just` 미설치 |
| DB 이미지 | postgis/postgis:18-3.6 + platform amd64 | 직접 빌드 wakeline-db(공식 postgres:18-trixie + PGDG PostGIS 3.6, arm64 · amd64 — 2026-09-30, 그 전 imresamu/postgis:18-3.6) | 에뮬레이션 회피 · 유지되는 기반 이미지(ADR-004 개정) |
| Redis DB 분리(db0/db1) | 스트림·예산 / 캐시·세션 | 단일 DB, `maxmemory-policy noeviction` | LRU 는 인스턴스 전체에 적용되므로 DB 분리로 보호되지 않음. 스트림 MAXLEN·캐시 TTL 로 상한 |
| 스트림 payload | gzip JSON | gzip + base64 문자열 | 문자열 필드로 두 언어 클라이언트 모두 단순하게(320 KB → 430 KB, 120 s 주기라 무시 가능) |
| 공항 목록 | AWC airport API 일 1회 | METAR bbox 응답의 관측소로 생성 | AWC airport bbox 가 한국 공항 1곳만 반환(실측) |
| 비행 카테고리 | 저장 시 계산 | AWC `fltCat` 우선, 없을 때만 계산해 `computed` 로 표기 | 실제 값이 있으면 그것을 쓴다(정직성) |
| 보간 워커 | lib/interpolate.worker.ts | public/interpolate.worker.js + 일치 테스트 | Turbopack 워커 제약(ADR-002) |
| 공개 포트 | 8080 | 8700 | 8080 은 SmartCollab 사용 |
| 통계 차트 | Recharts | 의존성 없는 SVG 막대 | 번들 크기·의존성 최소화 |
| CSRF 헤더 | X-CSRF-Token | X-CSRF-Token(쿠키 WAKELINE_CSRF) | Spring Security `csrf.spa()` 에 이름만 지정 |
| 429 처리 | 지수 백오프 2→300 s | 60→120→240→300 s 후 폴백. 15분 안에 되풀이되면 10→20→40→60→120→240→360분 뒤로 미룸(R-17, 상한 6 h — 아래 '수집기 여유 보강'), 이력은 재시작 뒤에도 이어 감(아래) | adsb.lol 이 10 s 주기에서 실제로 429 를 돌려줌(실측) |
| 부하 도구 | k6 | k6 스크립트 + `perf/quick_*.py`(k6 미설치 시) | 로컬에 k6 가 없어 같은 시나리오를 Python 으로도 제공 |
| 서비스 이름 | SkyWx | Wakeline | 항공기·선박·기상을 함께 다루게 되어 이름을 넓혔다(ADR-015). DB·역할·Redis 키·볼륨을 데이터 손실 없이 옮김 |
| 컨테이너 | 6개 | 상시 7개(edge·web·api·collector·ais·redis·db) + 일회성 migrate | DDL 비밀번호를 api 에서 빼려고 migrate 분리, AIS 푸시 수신을 항공기 폴링과 격벽으로 분리(ADR-014) |
| 추적 주기 | 관심 지역 10 s · 전세계 120 s 고정 | + 뷰포트 핫 리전 30 s · 선택 항공기 집중 추적 5 s(수요 기반 임대) | 확대해 보거나 고른 항공기만 촘촘히 — 호출량은 수집기 전체 상한 안(ADR-013) |
| 선박 | 없음 | AIS(aisstream.io) 실시간 · 0~45°E 제외 전 해역 | 공급자 연결 하나의 전달 한계를 재서 정함(ADR-014 부록 A) |
| 컨테이너 PID 1 | 앱 | api·collector·ais·redis 는 docker-init | 신호 전달·좀비 회수, 앱이 죽으면 재시작 정책이 동작(VERIFICATION #22) |
| 부하 도구 | k6 설치 | grafana/k6 컨테이너(`make bench`) | 호스트에 설치하지 않고 같은 도커 네트워크에서 api 층 직접 측정 |

## 공급자 운용 보강(2026-09-29 · 운영 화면·로그 관찰)

관찰: 관심 지역 adsb.lol 이 10–11 s 주기에서 5–7회 호출마다 429 를 되풀이했고, 재시작(재배포) 직후마다 백오프가 60 s 부터 다시 시작했다.
전환 사유는 모두 `fallback/recovery` 였고, 운영 화면의 오류는 `ReadTimeout('')` · `ProviderHttpError('HTTP 429: <html>…` 처럼 읽히지 않았다.
KMA 레이더는 5분 주기 약 27회 중 약 7회 `ReadTimeout` 경고를 남겼다(다음 주기가 따라잡아 프레임은 늦을 뿐 잃지 않았다).

- **429 이력 보존**: 체인의 R-17 상태(단계 · 마지막 429 · 쉼 끝 · 미룸 끝 · 조용함 기준)를 429 마다 해시
  `wakeline:provider:{공급자}:ratelimit:{작업}` 에 벽시계 epoch 초로 남기고, 첫 선택 때 읽어 단조 시계로 바꿔 되살린다(`chain_store.py`).
  만료는 두 겹이다: 기록 안의 논리 만료 `expires_at`(조용함 기준 + 15분 — 그 뒤에는 이력이 초기화된 것과 같다)과, 쓸 때마다 같은 때로 거는
  **Redis TTL**(HSET + EXPIRE 한 파이프라인) — 더 쓰지 않는 공급자 · 작업의 키도 남지 않는다. 이를 위해 수집기 ACL 의 EXPIRE 셀렉터에
  `~wakeline:provider:*:ratelimit:*` 을 더했다(`(~budget:* ~wakeline:provider:*:ratelimit:* +expire)`, R-86 의 허용 목록 방식 그대로 —
  api 가 읽는 공급자 상태 해시 `wakeline:provider:{공급자}` 는 여전히 만료시킬 수 없다, `redis_acl_test.sh` 로 확인). 이 규칙은 redis 기동 때
  읽으므로 **redis 컨테이너를 다시 띄워야 적용된다** — 그 전에는 EXPIRE 가 거부되고, 수집기는 기록을 그대로 두고 논리 만료로 계속하며 경고를 한 번 남긴다.
  지난 기록 · 형식이 틀린 기록(미룸 길이가 0–360분 밖 포함) · 상한(360분 + 60 s)보다 먼 미래를 가리키는 기록은 버리고 지운다. 단계는
  8(쉼 300 s · 미룸 360분이 모두 가장 긴 값인 단계)에서 멈춘다 — 이력이 재시작을 넘어 이어지므로 상한이 없으면 1025단계에서 백오프 계산이 넘쳤다.
  (처음에는 미룸 60분 · 단계 5 였다 — 사다리를 늘린 까닭은 아래 '수집기 여유 보강'.)
  Redis 오류는 선택을 막지 않는다(호출마다 1.5 s 상한, 메모리 이력으로 계속, 경고는 장애마다 한 번). 첫 읽기가 실패하면 읽힐 때까지 선택 · 429 마다
  다시 읽고, 그동안 받은 429 는 메모리에만 적는다(읽지 못한 기록을 1단계로 덮지 않게) — 읽기가 되면 저장된 단계에 이어 센 것으로 맞추고 저장한다.
  되살린 쉼·미룸은 전환 사유에 `(재시작 전 기록)` 을 붙인다. 호출 속도는 바꾸지 않았다 — adsb.lol README(github.com/adsblol/api, 2026-09-29 확인)는 "Rate limits are dynamic based on the environment load." ·
  "If you get 4xx errors, you are doing something wrong." 라고만 하고 수치를 밝히지 않으므로 속도를 추정해 정하지 않는다.
- **전환 사유**: 앞 순위를 건너뛴 까닭 · 돌아온 까닭을 적는다 — `fallback — adsb_lol 429 쉼(60 s)` · `fallback — adsb_lol 429 반복 → 20분 뒤로 미룸` ·
  `fallback — adsb_lol 3회 연속 실패(10분 쉼)` · `fallback — adsb_lol 운영자 끔` · `fallback — adsb_lol 일시정지(크레딧/예산)` ·
  `recovery — adsb_lol 쉼 끝(1순위 복귀)`. 가린 뒤 120자, `set_active` 와 `switch_event` 에 같은 글. 순위는 그 작업 범위를 지원하는 공급자 사이의 순서다.
  429 경고 로그는 다음에 무엇을 하는지를 체인의 현재 상태로 적는다 — 모양은 하나: `region: adsb_lol rate limited (429) — backing off 120 s,
  deferred 10 min; next: 'adsb_fi takes over'`(대안이 없으면 `next: 'adsb_lol again after the backoff (no other provider)'`). 바뀌는 값은 숫자와
  따옴표 안에만 있어 로그 지문(`logsink.message_template`)이 같다 — `/logs` 에서 한 429 계열이 한 묶음이다(지문은 이 변경 전의
  `8dee472131af8d17` 에서 한 번 바뀐다).
- **오류 문구**(`errors.describe_error`): 상태 `last_error` · `ingest_run.error_text` · 작업 로그가 같은 한 줄을 쓴다. `HTTP 429 Too Many Requests`
  (HTML 은 `<title>`, 없으면 표준 문구, HTML 이 아닌 본문은 앞 120자), `ReadTimeout — read 제한 15 s 초과 (apihub.kma.go.kr)`(그 요청에 실제로 걸린 값 —
  모르면 쓰지 않는다), `ConnectError — 연결 실패 (host): <원인>`, 그 밖은 `<종류> — <메시지>`. 늘 가린다. 노선 조회는 응답 내용을 싣지 않는다(content=False).
- **KMA**: 실패 기록에 단계(목록 날짜 · 바이너리 tm)와 그 호출에 걸린 시간을 싣는다. 일시 오류(시간 초과 · 연결 실패 · 프로토콜 오류)는
  **실패한 호출마다** 같은 주기 안에서 5 s 뒤 한 번 다시 부르고(예산 1 추가 예약), 다시 불러도 실패하면 그 주기를 끝낸다(이 규칙은 뒤에
  `retry.py` 로 옮겨 기상 작업도 같이 쓴다 — 아래 '수집기 여유 보강'). 전날 목록(덧붙이는 것) ·
  HTTP 오류(403 등) · 속도 상한은 다시 부르지 않는다. KMA 호출만 읽기 제한 15 s(전체 상한 40 s 는 그대로).
  주기 길이의 상한(설정값으로 계산 — 잰 값이 아니다): 다시 부른 호출이 모두 첫 시도에서 40 s 를 채우고 실패한 뒤 40 s 걸려 성공하면 오늘 목록
  (40 + 5 + 40) + 전날 목록 40(KST 00:00–00:14) + 바이너리 4 × (40 + 5 + 40) = 465 s, 여기에 속도 상한 대기(호출마다 최대 10 s, 전체 상한 밖)가
  더 붙을 수 있다. 주기 300 s 를 넘을 수 있지만 `run_periodic` 은 주기가 끝난 뒤 300 s 를 쉬고 다음을 시작하므로 겹치지 않는다 — 다음 주기가
  늦어질 뿐이고 놓친 프레임은 보관 창(최근 12개) 안에서 채운다. (첫 구현은 '한 주기에 한 번'만 다시 불러 245 s 안에 든다고 적었으나, 전날 목록과
  속도 상한 대기를 빠뜨린 계산이었다.)
  5 s · 한 번 · 15 s 는 **선택값**이다 — KMA 응답 시간을 재서 정한 값이 아니다(위 관찰 빈도는 2026-09-29 운영 로그에서 본 대략값이다).

## 수집기 여유 보강(2026-09-29 · 배포 뒤 운영 관찰 후속)

측정한 값과 고른 값을 나눠 적는다. 측정은 모두 2026-09-29 운영 스택(compose `wakeline`)에서 본 값이고, 고른 값은 그 측정에서 계산한
필요량 위에 둔 **선택값**이다(공급자·Redis 가 알려 준 한도가 아니다).

### 측정(출처)

| 무엇 | 값 | 출처 |
|---|---|---|
| 선박 스트림 `wakeline:ships` | 597항목 · MEMORY USAGE 16,825,126 B · 첫 항목 약 99분 전 | Redis(스트림 항목 수 · `MEMORY USAGE` · 첫 항목 ID 시각) |
| 선박 스트림 예산 트림 | `stream_budget_trims` 233(01:12Z 기동 뒤 누계) | `wakeline:ais:status` |
| 항공기 스트림 `wakeline:aircraft` | 890항목 · 37.8 MB 로 2.5 h 전체 | Redis(같은 방법) |
| Redis 메모리 | used 65.7 MB · `maxmemory 256mb` · 컨테이너 한도 512 MB | Redis `INFO memory` · `infra/redis/redis.conf` · `infra/compose.yml` |
| Redis `256mb` 의 단위 | `CONFIG GET maxmemory` → 268435456(= 256 MiB) | 일회용 `redis:8-alpine` 컨테이너에서 `--maxmemory 256mb` 로 확인(2026-09-29) |
| adsb.lol 429 | 복귀 11:29:34 KST → 429 11:30:33 → 60분 미룸 → 복귀 12:30:41 — 60분 미룸 뒤에도 약 1분 만에 다시 429 | 수집기 로그 · 전환 사유 |
| AWC SIGMET | 한 번 `ReadTimeout — read 제한 8 s 초과 (aviationweather.gov)`, 다음 주기는 성공 | 수집기 로그 `job.weather` |
| KMA 다시 부르기 | 배포 뒤 일시 오류 한 주기를 다시 불러 살린 것을 봄 | 수집기 로그 `job.kma_radar` |

adsb.lol README(github.com/adsblol/api)는 "Rate limits are dynamic based on the environment load." 라고만 하고 수치를 밝히지 않는다 — 한도를
추정해 호출 속도를 정하지 않는다(위와 같다).

### 측정에서 계산한 것

- 선박 항목 하나 = 16,825,126 B ÷ 597 ≈ 28.2 KB(MEMORY USAGE 기준 — Redis 내부 구조를 포함하므로 예산이 세는 필드 길이 합보다 조금 크다).
  10 s 마다 한 항목이므로 2.5 h(900항목)에 약 25.4 MB(24.2 MiB)가 든다. 예산 16 MiB 로는 약 595항목 ≈ 99분 — 관찰한 첫 항목 나이(약 99분,
  창 약 1.66 h)와 맞는다. ADR-014 때 잰 값(10 s 마다 약 13 KB)보다 두 배 남짓 크다 — 까닭은 재지 않았다.
- 항공기는 37.8 MB 로 2.5 h 를 다 담으므로 예산 80 MiB 가 창을 줄이지 않는다.

### 고른 것

- **선박 스트림 예산 16 → 32 MiB**(`publisher.py` `STREAM_BUDGET_BYTES`). 필요량 약 25.4 MB 는 예산의 약 76 %(필드 길이 합으로는 조금 더
  남는다). 선박 수가 늘면 다시 모자랄 수 있다 — 운영 화면 PIPELINE 의 '선박 스트림 보존 창'(api `stream_window_s.ships` 와 ais
  `stream_retention_s` 비교)과 ais `stream_budget_trims` 로 본다. 항공기 80 MiB 는 그대로.
- **Redis 여유(설정값 · 측정값으로 계산 — 최악을 잰 것이 아니다)**: 두 스트림 예산 합계 96 → 112 MiB.
  - 첫 구현의 계산은 틀렸다(리뷰): "두 배 224 MiB + 로그 약 24 MiB = 248 MiB, maxmemory 에 약 8 MiB 남음"은 로그 스트림을 서버 로그
    하나로만 넣었고(ADR-018 개정의 브라우저 오류 스트림 `wakeline:logs:client` 8 MiB 를 빠뜨렸다) 스트림이 아닌 키를 모두 뺐다.
  - 바로잡은 최악(재시작 전 항목이 예산 계산에서 빠지던 리뷰 전 코드): 예산이 창을 줄일 만큼 발행량이 클 때 두 발행자(수집기 · ais)가 재시작하면
    두 스트림이 최대 2.5 h 동안 예산의 두 배 — 2 × 112 = 224 MiB. 여기에 로그 두 스트림 약 32 MiB(3,000 × 8 KiB + 1,000 × 8 KiB,
    ADR-018 개정 — `MAXLEN ~` 은 노드 단위라 스트림마다 한 노드(기본 `stream-node-max-bytes` 4 KiB · 100항목) 이하가 더 남는다)와 그 밖의
    키 약 11 MB(측정 때 used 65.7 MB − 항공기 37.8 MB − 선박 16.8 MB: KMA 프레임 · SIGMET · 레이더 스트림 · 상태 · 예산 · 속도 제한 해시와
    그때의 로그 스트림 — 최악이 아니라 그 시점 값)를 더하면 약 267 MiB. **maxmemory 256 MiB 를 약 11 MiB 넘는다** — `noeviction` 이라
    넘는 동안 XADD · HSET · 예산 EVAL 쓰기가 거부된다. 선박 16 MiB 때는 2 × 96 + 32 + 11 ≈ 235 MiB 였다 — 이 변경(16 → 32 MiB)이 최악을
    한도 밖으로 밀었다.
  - 그래서 고친 것: 수집기 Publisher 는 스트림에 처음 보내기 전 한 번 보존 창 안의 기존 항목을 최신부터 되읽어(XREVRANGE 16항목씩 — 수집기
    ACL 에 이미 있는 명령, 예산 + 한 항목까지만 읽는다) 예산 계산에 넣는다(`publisher.existing_entries` · `StreamTrim.seed`). 항공기
    스트림은 재시작해도 예산 80 MiB(+ 한 항목)를 넘지 않는다. 되읽기가 거부되면(NOPERM 등) 경고 한 번 뒤 예전처럼 이 프로세스가 보낸
    것만 센다(발행은 막지 않는다), Redis 연결 오류면 그 항목을 로컬 큐에 넣고 다음 발행 때 다시 되읽는다. ais 는 선박 스트림을 읽을
    권한이 없어(ACL `+xadd +hset +hget +hgetall`) 되읽지 않는다 — 선박은 여전히 재시작 뒤 최대 2 × 32 MiB 다(ACL 을 넓히려면 Redis
    재시작이 필요해 이번에는 하지 않았다).
  - 고친 뒤 최악(계산): 80 + 2 × 32 + 32 + 11 ≈ 187 MiB — maxmemory 256 MiB 에 약 69 MiB 남는다. 그 밖 키의 최악(SIGMET 스트림 200항목 ·
    KMA 프레임 12장의 크기)은 재지 않았다 — 이 여유 안에 드는지는 운영 `INFO memory` 로 본다.
  - 예산은 필드 길이 합이고 MEMORY USAGE 는 항목마다 조금 더 크다: 일회용 `redis:8-alpine`(8.10.2)에서 MEMORY USAGE − 필드 길이 합 = 항목당
    약 61–65 B(28,000 B × 200항목 · 8,000 B × 3,000항목, 2026-09-29). 항공기 2.5 h(약 1,000항목)면 약 0.06 MiB 라 위 계산을 바꾸지 않는다.
  - 지금 발행량(항공기 약 37.8 MB · 선박 약 25.4 MB / 2.5 h)은 두 예산보다 작아 시간 트림(MINID)이 먼저 자르므로 두 배 경우가 생기지
    않는다 — 두 스트림 합계는 약 63 MB 다(계산). Redis used 는 측정 때 65.7 MB(16 MiB 로 잘린 선박 16.8 MB 포함)에서 약 8.6 MB 늘어 약
    74 MB 로 예상한다(계산 — 배포 뒤 다시 잰다). maxmemory 는 바꾸지 않았다 — 올리면 컨테이너 한도 512 MB 안의 AOF 재작성 fork 여유가
    줄어든다(`infra/compose.yml` 주석).
- **429 미룸 사다리 10 → 20 → 40 → 60 → 120 → 240 → 360분(상한 6 h)**(`fallback.py` `RATE_LIMIT_HOLD_S`). 120 · 240 · 360분은 선택값이다 —
  근거는 위 관찰(60분 미룸 뒤에도 약 1분 만에 429)뿐이고, adsb.lol 이 언제 풀리는지는 모른다. 관찰한 모양(복귀하고 약 1분 뒤 429)을 흉내 낸
  24 h 모의 시험에서 1순위 429 는 27 → 10번으로 준다(모의 — 측정이 아니다, `test_r17_primary_that_429s_right_after_every_recovery…`).
  대가: adsb.lol 이 실제로 풀렸어도 최대 6 h 동안 2순위(adsb.fi)가 관심 지역을 맡는다(60분 미룸 때도 그랬다 — adsb.fi 호출은 호스트 버킷
  0.8 req/s 안). 쉼(60 → 120 → 240 → 300 s) · 15분 조용함 초기화 · '선호도(다른 공급자가 없으면 쓴다)'는 그대로. 단계 상한 STAGE_MAX 5 → 8,
  저장 기록 검증(미룸 길이 0–360분 · 먼 미래 상한 360분 + 60 s)과 Redis TTL(조용함 기준 + 15분 — 최대 약 6 h 15분)이 따라간다.
- **기상 작업도 일시 오류를 한 번 다시 부른다**(AWC METAR/TAF · SIGMET 국제/미국, RainViewer). KMA 의 규칙을 `retry.py`
  (`call_retry_once` · `CallFailed`)로 옮겨 함께 쓴다: 시간 초과 · 연결 실패 · 프로토콜 오류만, **실패한 호출마다** 5 s 뒤 한 번, 그 전에 예산
  1 을 따로 예약(못 하면 다시 부르지 않는다, fixture 모드는 예산을 쓰지 않는다), 다시 부른 호출도 HttpClient 의 속도 상한을 지난다(허가를
  못 받으면 Throttled 로 끝나고 또 부르지 않는다). **예산(리뷰 후속)**: 첫 구현은 다시 부르기를 여유 없이 예약하고 보내지 않은 호출의
  몫도 돌려주지 않아, 연결 실패가 곧바로 끝나는 긴 장애에서 RainViewer 가 주기(약 65 s)마다 2 를 써 약 18 h 뒤 일일 예산 2,000 이 바닥나고
  RainViewer 가 돌아와도 UTC 자정까지 레이더가 budget_exhausted 였다(리뷰의 모의 — 측정이 아니다). 이제 (1) 보내지 않은 시도
  (`http.NOT_SENT_ERRORS` — 연결 전 실패 · 연결 풀 대기 초과 등 — 와 속도 상한 Throttled)는 첫 시도든 다시 부른 시도든 예산 1 을 돌려준다
  (aircraft · route 와 같은 규칙, KMA 도 같다 — 전날 목록 포함). (2) 기상 작업의 다시 부르기 예약은 남은 하루의 정규 주기 몫을 남긴다
  (`weather.retry_headroom` — 예산 날(UTC)이 끝날 때까지 작업마다 (남은 초 // 주기 + 1) × 주기당 최대 호출 수의 합: RainViewer 60 s × 1,
  AWC 는 SIGMET 300 s × 2 + METAR 600 s × 상자 최대 2. 지금 주기 설정으로 계산한 상한이다). 하루 내내 보낸 뒤의 일시 오류여도 정규 주기가 예산
  소진으로 막히지 않는다 — 모의 시험(측정이 아니다, `test_a_day_of_…`): 한도 2,000 · 60 s 주기에서 하루 내내 RemoteProtocolError 면 1,390
  주기 · 다시 부르기 609번 · 사용량 1,999 로 budget_exhausted 없음, 하루 내내 ConnectError 면 사용량 0. 정규 주기만으로 한도를 넘는
  설정이면 다시 부르지 않는다. (3) SIGMET 은 국제 호출이 실패해 미국 호출을 하지 않으면 세트 예산 2 중 그 1 을 돌려준다.
  KMA 의 다시 부르기 예약에는 여유를 두지 않는다 — 정규 호출 수가 주기마다 다르고(목록 1 + 바이너리 0–4, 상한 5 × 288 = 1,440 > 한도
  1,000) 계속 실패하는(보낸 뒤 실패하는) 서버에서는 첫 호출이 두 번 실패하는 즉시 주기가 끝나 하루 최대 2 × 288 = 576 이다(설정값 계산).
  HTTP 오류(4xx · 5xx) · Throttled · 응답 모양 오류는 다시 부르지 않는다. 살린 주기는 경고 없이
  INFO 한 줄(`sigmet/awc: isigmet — ReadTimeout — … after N s — retrying once in 5 s`), 다시 불러도 실패하면 경고 한 번과 같은 내용의 상태
  `last_error` · 실행 기록 — 모양은 KMA 와 같다(N 은 그 시도에 실제로 걸린 시간): `sigmet/awc failed: isigmet — ReadTimeout — read 제한 8 s 초과
  (aviationweather.gov) after N s; retried once after 5 s (first attempt: ReadTimeout after N s)` · `ReadTimeout — read 제한 8 s 초과
  (aviationweather.gov) · isigmet · N s 경과 · 5 s 뒤 1회 재시도(첫 시도 ReadTimeout · N s)`. 다시 부르지 않은 실패도 단계와 걸린 시간을
  싣는다(`HTTP 503 Service Unavailable … · frames · N s 경과`) — 기상 작업
  경고의 로그 지문이 이 변경에서 한 번 바뀐다. 5 s · 한 번은 선택값이다. 최악의 주기 길이(설정값 계산 — 호출마다 전체 상한 30 s × 2 + 5 s):
  SIGMET 두 호출 130 s(주기 300 s) · METAR 상자 둘 130 s(600 s) · 레이더 65 s(60 s — `run_periodic` 은 주기가 끝난 뒤 쉬므로 겹치지 않고 다음
  주기가 늦어질 뿐이다). 속도 상한 대기(호출마다 최대 10 s)는 이 밖이다.
- **필드 계약(보존 창을 운영 화면에)**: `wakeline:collector` 에 `stream_retention_s`(항공기 스트림 시간 트림 목표, 정수 초) ·
  `stream_budget_bytes`(항공기 스트림 바이트 예산), `wakeline:ais:status` 에 선박 스트림의 같은 두 필드. 값은 그 프로세스의 `StreamTrim` 이
  실제로 거는 설정(설정값 — 잰 값이 아니다)이고, 모르면 빈 값이다. api 는 이것을 스트림 첫 항목 나이(`stream_window_s`, 잰 값)와 견준다 —
  예산 트림은 손실이 아니라 되읽기 창을 줄이는 것이다(손실은 api `stream_trim_loss_events` > 0 일 때뿐).

## 공급자 운용 보강 2(2026-09-30 오후 · 운영/로그 스크린샷 — 계약 v5 §G24)

본 것(사용자의 운영/로그 화면, 운영 스택 — 이 레인은 망 접근이 없어 다시 재지 않았다)과 고른 것을 나눠 적는다.

### 본 것

| 무엇 | 값 | 출처 |
|---|---|---|
| 기상청 429 | 10:55:56 · 11:26:16 · 13:01:59 · 13:22:09 KST, 본문 '현재 요청을 처리할 수 없습니다. 잠시 후 다시 시도해주십시오.' — 모두 같은 주기의 앞선 KMA 요청 0.1–0.5 s 뒤(예: 11:26:16.439 'still unavailable' → 11:26:16.558 429) | 로그 화면 |
| 기상청 호스트 한도 | 코드에 호스트 버킷 없음 — 수집기 전체 2 req/s · burst 2 만 | `ratelimit.default_limiter` |
| 관심 지역 공급자 없음 | 12:14:50 adsb_fi 'failed 3x — cooling down'(ConnectError SSLEOFError, opendata.adsb.fi) · adsb_lol 이 맡아 12:16:22 · 12:22:18 에 429('backing off 300 s … no other provider — deferral not applied') · 'region: no provider available' 12:16:32 · 12:22:28 | 로그 화면 |

### 계산한 것(설정값과 로그 시각으로 — 잰 값이 아니다)

- 관심 지역에 공급자가 없던 시간: 실패 쉼 600 s(12:14:50 → 12:24:50) 안에서 adsb_lol 429 쉼 300 s 두 번 — (12:21:22 − 12:16:22) + (12:24:50 − 12:22:18) = 300 + 152 = **452 s**.
  adsb_fi 는 12:24:50 까지 다시 시도하지 않았다(ConnectError 는 일시적일 수 있는데도). 운영 화면 위쪽 배지는 그동안 초록 `region: adsb_lol`, 상태 바 region 칩은 나이로
  STALE 만 — '공급자 없음'이라고 적은 곳은 로그 한 줄(까닭 없음)뿐이었다.
- 넘겨받은 직후 우리 쪽 adsb.lol 호출 속도: 관심 지역 주기(10 s)마다 한 번 — 넘겨받을 때 몰아 부르지 않고 429 를 같은 주기에 다시 부르지 않는다. adsb.lol 을 부르는 작업은
  이것뿐이다(수요 추적은 adsb.fi, 노선은 adsbdb — 코드 검색으로 확인했고 `test_only_the_aircraft_chain_calls_adsb_lol` 이 소스에서 지킨다). 이 문서가 인용한 adsb.lol 한도는 수치가 없다(README 'dynamic based on the environment load') — 넘겨받은 뒤 9번 · 6번 호출
  (약 1분) 만에 429 인 모양은 #38 · #42 관찰과 같다. 이 속도가 한도를 넘는지는 알 수 없다 — **속도를 추정해 늦추지 않는다**(위 원칙 그대로).

### 고른 것

- **기상청 호스트 버킷 0.5 req/s · burst 1**(`ratelimit.KMA_APIHUB_RPS` · 설정 `kma_apihub_rps` 상한 1.0). 선택값 — 기상청은 초당 한도를 밝히지 않았고 우리가 확인한 문서도
  없다. 요청 사이 2 s 는 429 가 난 가장 긴 간격(0.5 s)의 4배이고, 한 주기의 최대 호출 13번(목록 1 + 전날 목록 1 + 바이너리 4 + 다시 부르기 5 + 다시 받기 2)을 줄 세워도 약
  24 s — 주기 300 s 의 8 %. '파일 없음' 연속이 닫힌 뒤 보관 창의 빈 tm 을 이어 받는 묶음(최대 4)도 이 간격이다(`test_recovery_backlog_is_paced_by_the_kma_host_bucket`).
- 429 는 그 호스트를 멈춘다(모든 호출자 — 원래 그랬다). Retry-After 의 HTTP-date 모양도 따른다(전에는 버리고 단계 백오프만 썼다 — RFC 9110 §10.2.3). 기상청 작업은 그 주기의
  KMA 호출을 멈추고 실행을 `throttled`(http 429 · 쉰 초 · Retry-After)로 남긴다 — 공급자 오류(`error` · last_error)가 아니다. 속도 상한이 막아 보내지 않은 호출도 `throttled`.
  리뷰(2026-09-30)로 고친 것: 운영 수집기(`main()`)가 설정 `kma_apihub_rps` 를 넘기지 않아 늘 0.5 였다(`http.build_limiter` 하나로 만든다) · 부분 합성 다시 받기의 429 는
  INFO 로 삼켜 실행이 `ok` 였다(이제 WARN · 남은 다시 받기 멈춤 · 정규 부분이 `ok` 면 `throttled`) · 바이너리 도중 429 는 곧바로 끝나 그 주기의 품질 이벤트 · 공급자 성공 ·
  '파일 없음' 연속 발행 · heartbeat 를 잃었다(이제 주기 끝을 그대로 지난다).
- **관심 지역의 '3회 연속 실패' 쉼도 선호도**(429 미룸과 같은 규칙 — 새 숫자 없음): 쓸 수 있는 공급자가 하나도 없으면 쉬는 공급자를 작업 주기 그대로 다시 시도한다. 부르는
  속도는 그 공급자가 1순위일 때와 같다(관심 지역 10 s — adsb.fi 호스트 버킷 0.8 req/s 안). 실패해도 쉼 끝 · WARN 수는 전과 같고, 답하면 쉼을 끝낸다. 얻는 것은 **풀린
  공급자에게서 곧바로 받는 것**이다 — 위 흐름을 10 s 격자로 되풀이하면(adsb_fi 가 언제 풀렸는지는 로그에 없어 t = 150 s 로 가정) 고치기 전에는 쉼 끝(t = 600 s)에야 받았고
  고친 뒤에는 t = 150 s 에 받는다(`test_observed_2026_09_30_sequence_gets_data_as_soon_as_fi_answers_and_says_no_provider_until_then`). 다시 시도하는 동안에도 일하는
  공급자는 없다 — 아래 '공급자 없음' 상태가 그대로 보인다(리뷰 2026-09-30: 첫 판은 다시 시도를 공급자로 적어 이 상태를 가렸고 '공급자 없음 0' 이라 적었다 — 정의상 0 이었을
  뿐 자료가 온 것이 아니었다).
- **전세계 체인은 다시 시도하지 않는다**(FR-16 의 10분 쉼 그대로): 전세계를 지원하는 공급자는 OpenSky 하나이고 호출마다 크레딧 4 를 쓰며 실패한 호출도 예산에 남는다(연결
  실패만 돌려준다). 전세계는 선택 기능이다(ADR-009). 그동안은 '공급자 없음'(풀리는 때 = 쉼 끝).
- **공급자 없음은 이름 붙인 상태** — 일하는 공급자가 없다(고를 공급자가 없거나 쉬는 공급자를 다시 시도하는 중): `wakeline:active` 의 `{job}_none_since` · `_none_reason` ·
  `_none_next`(체인 상태로 정해진 가장 이른 풀림 — 모르면 빈 값) · `_none_retry`(다시 시도하는 공급자 — 없으면 빈 값), 전환 기록 `→ none` · `none →`, 공백마다 WARN 한 번에 까닭과
  다음(다시 시도 포함). 다시 시도한 공급자가 답하면 그 주기에 끝난다. 운영 배지는 빨강 `region: 공급자 없음 · HH:MM:SS KST 부터[ · adsb_fi 다시 시도 중]`, 상태 바 region 칩에
  `공급자 없음`. 작업을 끄면(전세계 끔) 필드를 비운다(꺼진 작업이 빨강으로 남지 않게).
