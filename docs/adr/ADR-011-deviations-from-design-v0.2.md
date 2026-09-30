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
| 429 처리 | 지수 백오프 2→300 s | 60→120→240→300 s 후 폴백(관심 지역 순서는 2026-09-30 저녁부터 adsb.fi → adsb.lol — 아래 '공급자 운용 보강 3'). 15분 안에 되풀이되면 10→20→40→60→120→240→360분 뒤로 미룸(R-17, 상한 6 h — 아래 '수집기 여유 보강'), 이력은 재시작 뒤에도 이어 감(아래) | adsb.lol 이 10 s 주기에서 실제로 429 를 돌려줌(실측) |
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
  통합 마무리 리뷰(2026-09-30)로 고친 것: 설정 `KMA_APIHUB_RPS` 는 compose 가 collector 에 넘기지 않아(collector 는 .env 전체를 받지 않는다) .env 에 적어도 늘 0.5 였다 —
  이제 `infra/compose.yml` 이 넘기고(`${KMA_APIHUB_RPS:-0.5}`) `.env.example` 에 적었다(`test_every_collector_setting_in_env_example_reaches_the_collector` 가 .env.example 의 수집기
  설정이 모두 닿는지 본다) · KST 00:00–00:14 의 전날 목록 429 는 WARN 한 줄뿐이고 실행은 `ok`(http 200) 또는 보내지 않은 바이너리의 `throttled`(http 없음)였다 — 이제 목록의 429 와 같다.
- **관심 지역의 '3회 연속 실패' 쉼도 선호도**(429 미룸과 같은 규칙 — 새 숫자 없음): 쓸 수 있는 공급자가 하나도 없으면 쉬는 공급자를 작업 주기 그대로 다시 시도한다. 부르는
  속도는 그 공급자가 1순위일 때와 같다(관심 지역 10 s — adsb.fi 호스트 버킷 0.8 req/s 안). 실패해도 쉼 끝 · WARN 수는 전과 같고, 답하면 쉼을 끝낸다. 얻는 것은 **풀린
  공급자에게서 곧바로 받는 것**이다 — 위 흐름을 10 s 격자로 되풀이하면(adsb_fi 가 언제 풀렸는지는 로그에 없어 t = 150 s 로 가정) 고치기 전에는 쉼 끝(t = 600 s)에야 받았고
  고친 뒤에는 t = 150 s 에 받는다(`test_observed_2026_09_30_sequence_gets_data_as_soon_as_fi_answers_and_says_no_provider_until_then`). 다시 시도하는 동안에도 일하는
  공급자는 없다 — 아래 '공급자 없음' 상태가 그대로 보인다(리뷰 2026-09-30: 첫 판은 다시 시도를 공급자로 적어 이 상태를 가렸고 '공급자 없음 0' 이라 적었다 — 정의상 0 이었을
  뿐 자료가 온 것이 아니었다).
  다시 시도가 받은 짧은 쉼(429 · 호출 제한기 쿨다운 · 예산)은 실패 쉼 위에 얹힌다 — 그동안은 부르지 않고, 끝나면 남은 실패 쉼(다시 시도 · 공급자 없음)이 이어진다(통합 마무리
  리뷰 2026-09-30: 전에는 짧은 쉼이 600 s 쉼을 덮어 약 60 s 뒤 그 공급자를 정상 공급자로 골랐다 — 답한 적도 없이 'recovery — … 쉼 끝', 그 뒤 실패는 새 '3회').
- **전세계 체인은 다시 시도하지 않는다**(FR-16 의 10분 쉼 그대로): 전세계를 지원하는 공급자는 OpenSky 하나이고 호출마다 크레딧 4 를 쓰며 실패한 호출도 예산에 남는다(연결
  실패만 돌려준다). 전세계는 선택 기능이다(ADR-009). 그동안은 '공급자 없음'(풀리는 때 = 쉼 끝).
- **공급자 없음은 이름 붙인 상태** — 일하는 공급자가 없다(고를 공급자가 없거나 쉬는 공급자를 다시 시도하는 중): `wakeline:active` 의 `{job}_none_since` · `_none_reason` ·
  `_none_next`(체인 상태로 정해진 가장 이른 풀림 — 모르면 빈 값) · `_none_retry`(다시 시도하는 공급자 — 없으면 빈 값), 전환 기록 `→ none` · `none →`, 공백마다 WARN 한 번에 까닭과
  다음(다시 시도 포함). 다시 시도한 공급자가 답하면 그 주기에 끝난다. 운영 배지는 빨강 `region: 공급자 없음 · HH:MM:SS KST 부터[ · adsb_fi 다시 시도 중]`, 상태 바 region 칩에
  `공급자 없음`. 작업을 끄면(전세계 끔) 필드를 비운다(꺼진 작업이 빨강으로 남지 않게). 이 필드 쓰기(set_none · set_active · 비우기)가 Redis 오류로 실패하면 다음 주기에 다시
  쓴다(통합 마무리 리뷰 2026-09-30: 공백마다 한 번만 쓰고 오류는 삼키므로, 전에는 쓰기 한 번(1.5 s 상한)이 실패하면 공백 내내 초록 배지 · 회복 쓰기가 실패하면 빨간 배지가 남았다).

## 공급자 운용 보강 3(2026-09-30 저녁 · 운영/로그 스크린샷 — 계약 v5 §G25 · §G26)

본 것(사용자의 운영/로그 화면 · 오케스트레이터가 정리한 운영 스택 값 — 이 레인은 망 접근이 없어 다시 재지 않았다), 계산한 것(설정값 · 로그 시각으로 —
잰 값이 아니다), 고른 것(선택값)을 나눠 적는다.

### 관심 지역 순서: adsb.fi → adsb.lol(§G25)

| 무엇 | 값 | 출처 |
|---|---|---|
| adsb.lol 429 | 05:46 · 11:48 · 12:16/12:22 · 18:24 KST — 매번 미룸이 끝나 체인이 돌아온 뒤 약 1–2분 안 | 로그 화면(18:24 `region: adsb_lol rate limited (429) — backing off 300 s, deferred 360 min; next: 'adsb_fi takes over'`) · 전환 기록 |
| 같은 모양의 앞선 관찰 | 60분 미룸 뒤 복귀 11:29:34 → 429 11:30:33(2026-09-29) | 이 문서 '수집기 여유 보강' 측정 표 |
| adsb.fi | 그날 관심 지역을 하루 내내 맡음 — 운영 RUNS `region adsb_fi ok 7,797`, 오류는 12:14 의 TLS 묶음뿐(그때는 §G24 의 '공급자 없음' 상태가 다뤘다) | 운영 화면 RUNS |
| adsb.lol 한도 | 수치 없음 — README 'Rate limits are dynamic based on the environment load'(github.com/adsblol/api) | 위 '공급자 운용 보강' 인용 |
| 같은 시(時)의 수신 범위 | 두 공급자가 각각 5번 이상 돈 49시간(그때까지 3일) — 실행당 항공기 수 adsb.fi 92 · adsb.lol 86 | 리뷰(2026-09-30 저녁)가 운영 DB `ingest_run` 을 읽기 전용으로 잰 값(아래 SQL) |
| 설계서 v0.2 의 순서 | adsb.lol 1순위(레이트리밋 없음 · ODbL 모두에게 공개) · adsb.fi 2순위(초당 1회 · 개인·비상업) — 'P0 비교 후 1순위 확정' | 설계서 3.1 · 3.3 · 16절(아래) |

- 계산: adsb.lol 이 돌아올 때마다 WARN 한 줄 · 전환 둘(adsb_fi → adsb_lol → adsb_fi) · 곧 거절할 공급자에게 1–2분(관심 지역 10 s 주기로 6–12번 호출).
  미룸 사다리(R-17 — 10 → … → 360분)는 이 되풀이를 줄였지만 없애지 못했다(1순위가 돌아오는 것이 규칙이라서).
- 고른 것: **관심 지역 기본 순서 `adsb_fi,adsb_lol,opensky`** — adsb.lol 은 폴백으로만 쓴다. 쓸 때의 429 쉼(60 → 300 s) · 15분 안에 되풀이되면 미룸(10 → 360분) ·
  이력 보존(재시작) · 전환 사유 · '공급자 없음' 상태(§G24)는 그대로다. 전세계 체인은 OpenSky 만 지원하므로 바뀌지 않는다. 새 숫자는 없다.
- 어디에 걸리나: 순서는 운영 설정 `aircraft_providers`(DB `app_setting` → api 가 기동 때 · 60 s 마다 Redis `wakeline:settings` 로 미러 → 수집기가 주기마다 읽는다)다.
  수집기 설정 기본값(`config.py`) · `.env.example` · compose 기본값은 그 미러가 없을 때만 쓰인다 — 넷을 같은 순서로 바꾸고(인프라 시험이 견준다),
  운영 DB 는 **V17** 이 옮긴다: 운영자가 바꾼 적 없는 값(`updated_by` NULL · `env`)이 옛 기본값 그대로일 때만, 감사 기록 `SETTING_DEFAULT_V17`(시스템)과
  함께(`MigrationDbTest`). 운영자가 /ops 에서 고른 순서는 그대로 둔다 — 옛 순서가 필요하면 /ops 설정에서 `adsb_lol,adsb_fi,opensky` 로 되돌린다.
  기동 로그의 체인 줄은 이제 설정의 실제 순서를 적는다(전에는 `adsb_lol → adsb_fi` 를 글자로 박아 두었다).
- adsb.lol 이 1순위였던 까닭 — 설계서 v0.2(`docs/SkyWx_설계서_로컬개발용_v0.2.pdf`, 2026-09-27 · 저장소가 추적하지 않는 파일이라 이 레인은 원 작업 폴더의 것을
  읽기만 했다):
  1. 한도 — 3.1 표: adsb.lol 1순위 '현재 레이트리밋 없음(향후 피더 API 키 예정)', adsb.fi 2순위 '초당 1회'. 3.3 예산표: adsb.lol 8,640회(10 s) · 한도 '명시 없음',
     adsb.fi 는 '(폴백) ≤ 8,640회'.
  2. 이용 조건 — 3.1 표: adsb.lol 'ODbL 1.0, 모두에게 공개', adsb.fi '개인·비상업, 출처 표기'.
  3. 수신 범위 — 설계서는 순서를 재서 정하라고 적었다: '같은 시각 두 API의 결과 수를 1시간 비교해 1순위를 확정하세요'(그 글에서 견줄 두 API 는 adsb.lol · OpenSky),
     리스크 표 '한반도 커버리지 부족 — P0 비교 후 1순위 확정'. 곧 adsb.lol 1순위는 잰 값으로 확정하기 전의 잠정 순서였다.
- 그 까닭이 지금 어떤가(순서를 바꿔도 지키는 것):
  1. 한도의 전제는 더는 맞지 않는다 — adsb.lol 은 체인이 돌아올 때마다 429 다(위 표). 설계서도 README('없음')와 제3자 관측('동적 제한')이 다르다고 적고 '429 처리를
     전제로 설계'했다. adsb.fi 초당 1회는 호스트 버킷 0.8 req/s 안이다(관심 지역 10 s = 0.1 req/s — 수요 추적이 이 몫을 이미 빼고 계획한다, `jobs/demand._plan`).
     하루 예산 40,000 에서 관심 지역 몫 8,640(10 s × 하루 — `demand_budget_reserve_region`)은 이미 잡혀 있다.
  2. 이용 조건은 지킨다 — adsb.fi '개인·비상업'은 이 서비스(설계서 표지 '개인 학습·포트폴리오·비상업')가 이미 지키고 있었다(adsb.fi 는 수요 추적과 그날 관심 지역을
     맡았다). 출처 표기는 순서와 상관없이 둘 다 화면 하단 · /about 에 늘 적는다(`lib/attribution.ts` CREDITS — README §9). ODbL 의 '모두에게 공개'가 필요해지는
     때는 상업 · 공개 배포다 — 그때는 운영 설정으로 순서를 되돌리거나 adsb.fi 를 끈다(ADR-009 의 OpenSky 와 같은 성격).
  3. 수신 범위는 adsb.fi 가 같거나 많다 — 같은 시(時) 비교, 리뷰(2026-09-30 저녁)가 운영 DB `ingest_run` 을 읽기 전용으로 잰 값: `job='region'` · `status='ok'`
     그때까지 3일, 두 공급자가 각각 5번 이상 돈 시만 — **49시간, 실행당 평균 항공기 수(`records_in`) adsb.fi 92 · adsb.lol 86**. 한계: 같은 시 안이지 같은 순간이
     아니다(두 공급자가 한 시 안에서 번갈아 맡은 시들이다). 이 레인은 운영 스택을 건드리지 않는 규칙이라 다시 재지 않았다.
     다시 잴 때의 SQL(이 레인이 쓴 글 — 리뷰가 돌린 글과 같다고 보장하지 않는다. 버리는 컨테이너에서 가짜 행으로 동작만 확인했다):
     ```sql
     WITH h AS (
       SELECT date_trunc('hour', started_at) AS hr, provider, count(*) AS runs, sum(records_in) AS recs
       FROM ingest_run
       WHERE job = 'region' AND status = 'ok' AND provider IN ('adsb_fi', 'adsb_lol')
         AND started_at >= now() - interval '3 days'
       GROUP BY 1, 2),
     shared AS (SELECT hr FROM h WHERE runs >= 5 GROUP BY hr HAVING count(*) = 2)
     SELECT provider, count(*) AS hours, sum(runs) AS runs, round(sum(recs)::numeric / sum(runs), 1) AS records_in_per_run
     FROM h JOIN shared USING (hr) GROUP BY provider ORDER BY provider;
     ```
- 같은 호스트의 수요 추적(리뷰 2026-09-30 밤): focus · hot 도 opendata.adsb.fi 를 부른다. 그 호출이 429 를 받으면 호출 제한기가 **호스트 전체**를 막는다(Retry-After,
  없으면 30 → 60 → 120 → 300 s — `ratelimit.penalize`). 전에는 관심 지역이 그 쿨다운을 '쉼'으로 적어 남은 시간 동안 다음 순위(adsb.lol)로 갔다 — 순서를 바꾼 뒤로는
  수요 쪽 429 하나마다 전환 둘 · adsb.lol 호출(프로브로 확인: 30 s 쿨다운이면 adsb.lol 2번 · 'fallback — adsb_fi 호출 제한기 429 쿨다운(29 s)'). 고른 규칙:
  관심 지역은 **쿨다운 + 주기 2번 ≤ 60 s**(api 의 관심 지역 끊김 기준 — `EngineService.REGION_FEED_STALE_S`, 수집기 `REGION_FEED_STALE_S` 가 같은 값인지 시험이
  본다)이면 같은 공급자로 기다린다 — 그 주기들은 부르지 않고 실행 `throttled`(오류 글 'cooling down N s after HTTP 429'), 전환 · 공급자 없음 상태 없음, 쿨다운이
  5 s 안으로 줄면 제한기 대기(`REGION_WAIT_S`) 안에서 부른다. 기본 10 s 주기면 15분 안의 첫 429(30 s)는 기다리고, 되풀이된 429(60 → 300 s)는 전처럼 남은
  쿨다운만 다음 순위가 맡는다(기다리면 자료가 끊김 기준을 넘는다). 전세계는 기다리지 않는다. 수요 호출이 429 를 얼마나 자주 받는지는 재지 않았다 — 배포 뒤
  운영 RUNS 의 region `throttled`(오류 글 'cooling down') 수와 전환 기록 중 사유 '호출 제한기 429' 인 adsb_fi → adsb_lol 수로 본다(`test_aircraft_job` —
  기본 순서 · adsb.lol 쓸 수 있음에서 adsb.lol 호출 0 · 되풀이 429 는 폴백).
- 순서가 바뀌는 순간(V17 배포 창 — api 가 새 순서를 미러하는 동안 수집기는 그대로 · /ops 변경): 체인은 지난 선택의 순위와 건너뛴 공급자를 기억해, 건너뛴 적 없는
  공급자를 순서 때문에 고르면 전환 사유를 `order — 공급자 순서 변경(aircraft_providers — adsb_fi 1순위)` 로 적는다(전에는 `recovery — adsb_fi 쉼 끝(1순위 복귀)` —
  쉰 적이 없는데 쉼이 끝났다고 적었다, 리뷰 2026-09-30 밤).
- 배포(운영자가 할 일 — 저장소는 `.env` 를 추적하지 않는다): `make up` 이 V17 을 싣고 운영 설정을 옮긴다. 옛 `.env.example` 을 복사한 `.env` 에는
  `AIRCRAFT_PROVIDERS=adsb_lol,adsb_fi,opensky` 가 남아 compose 기본값을 덮는다 — 수집기는 운영 설정 미러(Redis `wakeline:settings`)가 없을 때 이 값을 쓴다
  (`runtime_settings.provider_order` — Redis 를 다시 띄운 뒤 api 가 다시 미러하기까지 60 s 안 등). 그 줄을 `AIRCRAFT_PROVIDERS=adsb_fi,adsb_lol,opensky` 로 바꾸거나 지우고
  `make up`(바뀐 환경으로 collector 를 다시 만든다). `make init`(make up · ps · logs 가 먼저 부른다)이 옛 값을 찾으면 한 줄로 알린다(`tools/init_env.py`
  `RETIRED_DEFAULTS` — 값은 바꾸지 않는다, SEC-13 규칙). /ops 에서 순서를 고른 적이 있으면 V17 은 그 값을 두므로 /ops 설정도 확인한다.

### 기상청 '파일 없음' 긴 연속의 확인 간격(§G26)

| 무엇 | 값 | 출처 |
|---|---|---|
| 기상청 내려받기 | 08:15 KST 부터 모든 바이너리 합성(HSR · HSP · CMX · PPI · CPP PUB)이 'file not exist' — 영상(data=img)만 답함. 알림 없음, 길이 모름 | 오케스트레이터 확인 · 로그 화면(`last answer: not gzip: '# file not exist (RDR_CMP_HSR_PUB_202609301725.bin.gz)'`) |
| `budget:kma_radar` | 18:34 KST 에 417 / 1,000 — 09:00 KST 에 시작한 UTC 날 | 운영 화면 BUDGET |
| 목록 ReadTimeout | 18:06 · 18:38 KST `listing 20260930 — ReadTimeout — read 제한 15 s 초과 … retried once after 5 s` | 로그 화면 |

- 계산: 417 ÷ 약 9.6 h ≈ 시간당 44 — 24 h 면 약 1,050 으로 한도를 넘는다. 설정값으로 본 연속의 정규 호출: 5분마다 목록 1 + 확인 ≤ 2 = 하루 864, 다시 부르기(일시 오류 —
  호출마다 한 번)까지 최악 1,728. 본 속도(44/h)와 36/h(864/일)의 차이는 나눠 재지 않았다 — 코드로 더해질 수 있는 것은 일시 오류 다시 부르기(실패한 호출마다 1 — 목록 ReadTimeout 이 그날 보였다)와 재기동 뒤 연속을 이어받지 못한 주기의 R-03(목록 1 + 바이너리 ≤ 4)이다.
- 고른 것: 연속의 나이(첫 tm 부터)가 **60분**(`MISSING_SLOW_AFTER_S`) 이상이면 **15분**(`MISSING_SLOW_EVERY_S` — 기본 주기의 3배)마다만 확인한다. 둘 다 선택값이다 —
  60분은 짧은 공백(R-03 의 늦게 생기는 파일 · 몇 주기짜리 장애)을 5분마다 보아 빨리 잡고, 긴 공백만 늦추려고, 15분은 늦춘 뒤 하루 288(최악 576)로 한도의 30 % 아래가
  되도록 골랐다. 확인하는 주기는 전과 같이 목록 1 + 확인 둘이다 — 추천안은 '가장 새 tm 하나'였으나, §G22 가 둘째 확인(10분 넘은 가장 새 tm)을 둔 까닭(목록이 먼저
  싣고 파일은 늦게 생기면 가장 새 tm 만 보는 확인은 회복 뒤에도 연속을 닫지 못한다 — 리뷰)이 늦춘 주기에서도 그대로라 둘 다 둔다(하루 288 대 192 — 둘 다 한도 안).
  그 사이 주기는 기상청을 부르지 않고 실행 `waiting`(새 상태 — 'missing' 은 그 주기에 기상청이 없다고 답했다는 뜻이라 쓰지 않는다)을 남긴다. 실행 기록이 주기마다
  하나라는 계약(§G22)과 운영 RUNS 요약(상태별 수)이 그대로 맞는다 — 행이 없으면 멈춘 작업과 기다리는 작업이 같아 보인다.
- 따라 바뀐 것: '확인 멈춤'(웹) · 이어받기(수집기 재시작) 기준 = 확인 간격 × 3(선택값, 전의 15분 = 5분 × 3 과 같은 규칙 · 아래로 15분) — 늦춘 연속은 45분. 확인 간격은
  해시 `missing_probe_every_s` → api `missing.probe_every_s` 로 웹에 닿고, 웹이 'N분마다 확인'을 적는다(모르면 쓰지 않는다 — 옛 api).
- 대가: 기상청이 돌아온 뒤 알아채기까지 최대 약 15분(늦게 생기는 파일이면 + 10분 — 전에는 5분 + 10분). 그동안 레이더는 RainViewer 다.
- 목록 ReadTimeout WARN(18:06 · 18:38)은 이 변경의 대상이 아니다 — 한 번 다시 불러도 실패한 주기의 경고로 전과 같다(늦춘 뒤에는 목록 호출 자체가 1/3 이 된다).

#### 개정(2026-10-01 · 계약 v5 §G26 개정) — 목록만 읽은 확인 · KST 자정 넘김

| 무엇 | 값 | 출처 |
|---|---|---|
| 기상청 목록 | tm=20260930 은 `RDR_CMP_HSR_EXT_202609301950`(19:50 KST)에서 끝남 · tm=20261001 은 비었거나 HTTP 504 | 오케스트레이터 직접 호출(00:50 KST 무렵) |
| 실행 기록 | `radar_kr` 00:20 · 00:35 · 00:50 KST — `ok` · http 200 · 오류 글자 없음 | 운영 RUNS |
| 연속의 마지막 확인 | `/api/v1/radar/kr` `missing.checked_at` 2026-09-30T15:05:11Z(00:05 KST — 마지막으로 tm 을 확인한 주기)에 머묾 | api 응답 |

- 까닭: 00:15 KST 뒤 확인은 오늘(빈) 목록만 읽어 확인할 tm 이 없었다 — 그 주기는 '새로 받을 tm 없음'이라 `ok`(공급자 성공)였고 연속의 마지막 확인을 옮기지 않았다.
  웹의 '확인 멈춤'(확인 간격 × 3)은 거짓 경보였다.
- 고른 것: (1) 연속 중 목록이 답한 확인 주기는 확인할 tm 이 없어도 확인이다 — 마지막 확인을 옮기고 실행은 `missing`(저장한 프레임 없음 · 오류 글자 'nothing to probe'),
  공급자 성공이 아니다. 새 상태 대신 `missing` 의 뜻을 넓혔다('이 주기에 기상청에 물어 연속이 그대로임을 보았다' — 내려받기 '파일 없음' 또는 목록에도 새 tm 없음):
  운영 요약이 연속의 확인을 한 줄로 세고, 새 상태는 웹 색 · 뜻 · 설명서를 모두 늘린다. §G26 이 `waiting` 을 따로 둔 까닭(기상청을 부르지 않았다)은 그대로다.
  (2) 확인마다 목록이 보인 것을 싣는다(`missing_list_tm` · `missing_list_newer` → api `list_tm` · `list_newer`) — 웹이 '기상청 목록에도 19:50 KST 뒤 새 tm 없음'을
  적는다. 읽은 목록이 last_tm 의 날을 덮지 못했으면 모름(빈 값). (3) 연속의 last_tm 이 전날 이전이고 새 날 목록이 아직 비었으면 확인하는 주기가 전날 목록도 읽는다 —
  자정 직후 창(00:00–00:14)만으로는 늦춘 확인이 창을 건너뛸 수 있고, 창 뒤에도 새 날 목록이 빌 수 있다. 그때 확인은 전날의 가장 새 tm 하나라 주기당 호출은 3 그대로다.
  이 전날 목록은 새 날 목록이 **답했으나 비었을 때만** 읽는다 — 새 날 목록 자체가 504 · 시간 초과면 목록이 실패한 주기(`error` · 아무것도 옮기지 않는다 · 확인 간격 × 3
  뒤 '확인 멈춤')이고 전날 목록으로 잇지 않는다. 또 이 전날 목록은 자정 직후 창의 덧붙이는 목록과 달리 확인에 필요한 목록이다(리뷰 2026-10-01): 호출이 실패하면
  (504 · 시간 초과) `error`(전날 목록 단계 · 공급자 오류 · WARN), 예산 예약이 거절되면 예산 상태 — 둘 다 마지막 확인 · 목록 필드를 옮기지 않는다. 처음에는 덧붙이는
  목록처럼 오늘(빈) 목록만으로 이어가 확인할 tm 이 없는 `missing` 으로 마지막 확인을 옮겼다 — 수집기가 몇 시간 동안 아무 tm 도 묻지 않았는데 '확인 멈춤'이 뜨지 않았다.
- 바꾸지 않는 것: 목록 실패는 `error` · 마지막 확인 그대로(확인하지 않았다 — 확인에 필요한 전날 목록의 실패도), 확인 간격 · '확인 멈춤' 기준(확인 간격 × 3) · 연속을 여는
  규칙 · 연속 밖의 `ok` · 연속과 상관없는 자정 직후 창의 전날 목록(덧붙이는 목록 — 실패하면 WARN 한 줄 · 오늘 목록으로 계속).
- 덧붙임(배포 2026-10-01 02:07 KST): 연속이 없을 때도 새 날 목록이 비었고 저장한 프레임이 전날 끝(23:55)에 닿지 않았으면 전날 목록을 덧붙여 읽는다 — 다시 띄운 수집기가 오래된 연속을 버린 뒤 빈 새 날 목록만으로는 확인할 tm 이 없어 연속이 다시 열리지 않았다(계약 v5 §G26 개정 '연속이 없을 때의 KST 자정 넘김').

#### 개정(2026-10-01 · 레인 kma 7차 · 계약 v5 §G26 개정의 개정) — 연속이 없을 때 필요한 전날 목록

| 무엇 | 값 | 출처 |
|---|---|---|
| 전날 목록 실패 주기 | 02:23:54 KST WARN `previous-day listing 20260930 — ReadTimeout … after 16.8 s — using today's only` · 그 주기 RUNS `radar_kr kma_radar ok` | 운영 로그 · RUNS(오케스트레이터) |
| 같은 모양의 모의 | 연속 없음 · 프레임 만료 · 새 날 목록 빈 답 · 전날 목록 ReadTimeout → `ok` · 공급자 `last_success_at` 새로 · `consecutive_failures` 0. 이어받기 상한 밖 다시 띄움 + 전날 목록 장애 → 01:00–02:00 `ok` 13번 | 조사 · 도전 모의(scratch) — 이 레인의 `test_kma_list_idle` 가 같은 모양을 고치기 전 코드에서 실패로 재현 |

- 까닭: `_behind_prev_day` 가 참이면 새 날 목록에 그 시각 이하의 tm 이 없다 — 그 주기가 읽을 것은 전날 목록뿐인데 덧붙이는 목록으로 다뤄, 잃어도 받을 tm 이 없는
  주기(`_outcome` 'ok')로 끝나 공급자 성공 · heartbeat 까지 적었다(§G22 가 없앤 모양).
- 고른 것: 이 전날 목록도 연속의 확인에 필요한 전날 목록처럼 **필요한 목록** — 실패 `error`(공급자 오류 · WARN · 성공 · heartbeat 없음), 예산 거절은 예산 상태(오류 글자가
  왜 필요한지 — 새 날 목록이 비었고 저장한 프레임이 전날 23:55 에 닿지 않았다 — 를 적는다. 전의 글은 연속이 있다고 가정했다), 429 · 속도 상한은 `throttled` 그대로.
  다시 부르지 않는다 — 새 날 목록이 하루 내내 빌 수 있어 5분마다 다시 부르면 설정값 계산 최악 (오늘 목록 1 + 1) + (전날 목록 1 + 1) = 4 × 288 = 1,152 > 한도 1,000.
  다음 주기가 5분 뒤이고, 운영에서는 02:28 에 전날 목록이 다시 답했다. 이어받기 상한 밖이라 버린 연속은 그 주기 첫머리에 지운다(`error` 주기는 발행하지 않아 남았다).
- 바꾸지 않는 것: 자정 직후 창의 전날 목록(새 날 목록에 tm 이 있거나 23:55 까지 저장했을 때 — 덧붙이는 목록), 호출 수 · 예산(주기마다 전날 목록 1), 연속을 여는 규칙.
