# ADR-011 설계서 v0.2 와 달라진 점(구현 시 결정)

| 항목 | 설계서 | 구현 | 이유 |
|---|---|---|---|
| 명령 도구 | justfile | Makefile | 기존 포트폴리오와 동일, `just` 미설치 |
| DB 이미지 | postgis/postgis:18-3.6 + platform amd64 | imresamu/postgis:18-3.6 (arm64) | 에뮬레이션 회피(ADR-004) |
| Redis DB 분리(db0/db1) | 스트림·예산 / 캐시·세션 | 단일 DB, `maxmemory-policy noeviction` | LRU 는 인스턴스 전체에 적용되므로 DB 분리로 보호되지 않음. 스트림 MAXLEN·캐시 TTL 로 상한 |
| 스트림 payload | gzip JSON | gzip + base64 문자열 | 문자열 필드로 두 언어 클라이언트 모두 단순하게(320 KB → 430 KB, 120 s 주기라 무시 가능) |
| 공항 목록 | AWC airport API 일 1회 | METAR bbox 응답의 관측소로 생성 | AWC airport bbox 가 한국 공항 1곳만 반환(실측) |
| 비행 카테고리 | 저장 시 계산 | AWC `fltCat` 우선, 없을 때만 계산해 `computed` 로 표기 | 실제 값이 있으면 그것을 쓴다(정직성) |
| 보간 워커 | lib/interpolate.worker.ts | public/interpolate.worker.js + 일치 테스트 | Turbopack 워커 제약(ADR-002) |
| 공개 포트 | 8080 | 8700 | 8080 은 SmartCollab 사용 |
| 통계 차트 | Recharts | 의존성 없는 SVG 막대 | 번들 크기·의존성 최소화 |
| CSRF 헤더 | X-CSRF-Token | X-CSRF-Token(쿠키 WAKELINE_CSRF) | Spring Security `csrf.spa()` 에 이름만 지정 |
| 429 처리 | 지수 백오프 2→300 s | 60→120→240→300 s 후 폴백. 15분 안에 되풀이되면 10→20→40→60분 뒤로 미룸(R-17), 이력은 재시작 뒤에도 이어 감(아래) | adsb.lol 이 10 s 주기에서 실제로 429 를 돌려줌(실측) |
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
  수집기 ACL 의 `~wakeline:provider:*` 안에서 HSET · HGETALL · HDEL 만 쓰므로 ACL 은 넓히지 않았다. 그 대신 이 키에는 EXPIRE 권한이 없어(R-86)
  Redis TTL 이 아니라 **논리 TTL** `expires_at`(조용함 기준 + 15분 — 그 뒤에는 이력이 초기화된 것과 같다)을 둔다. 지난 기록 · 형식이 틀린 기록 ·
  상한(60분 + 60 s)보다 먼 미래를 가리키는 기록은 버리고 지운다. Redis 오류는 선택을 막지 않는다(호출마다 1.5 s 상한, 메모리 이력으로 계속, 경고는 장애마다 한 번).
  되살린 쉼·미룸은 전환 사유에 `(재시작 전 기록)` 을 붙인다. 호출 속도는 바꾸지 않았다 — adsb.lol README 는 한도가 부하에 따라 달라진다고만 하고
  수치를 밝히지 않으므로(이 변경에서 다시 열어 보지는 않았다) 속도를 추정해 정하지 않는다.
- **전환 사유**: 앞 순위를 건너뛴 까닭 · 돌아온 까닭을 적는다 — `fallback — adsb_lol 429 쉼(60 s)` · `fallback — adsb_lol 429 반복 → 20분 뒤로 미룸` ·
  `fallback — adsb_lol 3회 연속 실패(10분 쉼)` · `fallback — adsb_lol 운영자 끔` · `fallback — adsb_lol 일시정지(크레딧/예산)` ·
  `recovery — adsb_lol 쉼 끝(1순위 복귀)`. 가린 뒤 120자, `set_active` 와 `switch_event` 에 같은 글. 순위는 그 작업 범위를 지원하는 공급자 사이의 순서다.
  429 경고 로그는 다음에 무엇을 하는지(`…, adsb_fi takes over` · `repeated 429 → deferred 20 min` · `no other provider — …`)를 체인의 현재 상태로 적는다.
- **오류 문구**(`errors.describe_error`): 상태 `last_error` · `ingest_run.error_text` · 작업 로그가 같은 한 줄을 쓴다. `HTTP 429 Too Many Requests`
  (HTML 은 `<title>`, 없으면 표준 문구, HTML 이 아닌 본문은 앞 120자), `ReadTimeout — read 제한 15 s 초과 (apihub.kma.go.kr)`(그 요청에 실제로 걸린 값 —
  모르면 쓰지 않는다), `ConnectError — 연결 실패 (host): <원인>`, 그 밖은 `<종류> — <메시지>`. 늘 가린다. 노선 조회는 응답 내용을 싣지 않는다(content=False).
- **KMA**: 실패 기록에 단계(목록 날짜 · 바이너리 tm)와 그 호출에 걸린 시간을 싣는다. 일시 오류(시간 초과 · 연결 실패 · 프로토콜 오류)는 같은 주기 안에서
  5 s 뒤 한 번 다시 부르고(예산 1 추가 예약), HTTP 오류(403 등)·속도 상한은 다시 부르지 않는다. 다시 부르기는 **한 주기에 한 번** — 최악
  5호출 × 40 s + 5 s + 40 s = 245 s 로 주기 300 s 안에 든다. KMA 호출만 읽기 제한 15 s(전체 상한 40 s 는 그대로).
  5 s · 한 번 · 15 s 는 **선택값**이다 — KMA 응답 시간을 재서 정한 값이 아니다(위 관찰 빈도는 2026-09-29 운영 로그에서 본 대략값이다).
