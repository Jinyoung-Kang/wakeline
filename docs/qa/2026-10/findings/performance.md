# QA 2026-10 — 성능(계획 §3.5) · 고친 빌드(출시 후보)

- 담당: 성능 에이전트 · 결함 번호 QA-400 … QA-499 · 작업 트리 `qa-perf`(바탕 `e6857473` — 신뢰성 수정 재검증 뒤의 `qa/2026-10`)
- 측정 시각: 2026-10-01 21:24 – 23:58 UTC(한국 10-02 06:24 – 08:58). 모든 수치는 이 세션에서 잰 값이고, 계산으로 늘린 값은 '추정'이라고 적었다.
- 증거: `docs/qa/2026-10/evidence/performance/`(k6 로그 · 요약 JSON · 자원 표본 CSV · EXPLAIN · Lighthouse 보고서 · 느린 문장 로그).

## 환경(모든 결과 공통)

| 항목 | 값 |
|---|---|
| 기계 | Apple M1 · 16 GB · macOS 26.7 · Docker Desktop 엔진 29.8.1 — **Docker VM 4 CPU · 8 GB 를 운영 스택(8700)과 스택 B(8702)가 함께 쓴다**(둘 다 떠 있었고 다른 작업은 없었다 — 아래 'VM 의 다른 CPU') |
| 스택 | **A** compose 프로젝트 `wakeline-e2e` · `http://localhost:8701` · 망 `wakeline-e2e_wakeline`(api `10.78.0.30:8000` · edge `10.78.0.10:8700`) · fixture 모드(외부 호출 0) |
| 이미지 | `wakeline-api:qa-fix` `40390885d7c8` · `wakeline-web:qa-fix` `9c1cd9c9c4bb` · `wakeline-collector:qa-fix` `cf7cd1d2bbb6`(모두 2026-10-01 20:56 UTC 빌드) · db 컨테이너 `c4c4132db222`(`wakeline-db:qa-fix` 와 같은 시각 빌드 · PostgreSQL 18.6 · PostGIS 3.6.4) |
| 컨테이너 한도 | api 1 GiB(힙 최대 약 410 MiB = `MaxRAMPercentage=40`, `MALLOC_ARENA_MAX=2`) · db 1 GiB(shared_buffers 256 MB) · collector · web · redis 512 MiB · edge 256 MiB |
| 부하 도구 | k6 `grafana/k6:2.3.0@sha256:9c2dee7f…` 컨테이너를 **같은 Docker VM 의 스택 A 망**에서(api 와 CPU 를 나눠 쓴다 — 아래 'VM 의 다른 CPU' 에 들어 있다) |
| api 제한 | REST · WS 측정 동안만 `PUBLIC_RATE_LIMIT_PER_MIN=1000000 WS_MAX_CONN_PER_IP=1000 WS_MAX_CONN=1000` 으로 api 를 다시 만들었다(고친 이미지 덧붙임 · `--no-deps` — 다른 서비스는 그대로). edge 측정 · 끝은 기본값 |
| 자원 표본 | `tools/qa/perf_sample.py`(5 s 마다 — docker stats 는 `wakeline-e2e-*` 만, VM CPU 는 `/proc/stat`(컨테이너 안에서도 VM 전체), api 의 java RSS · cgroup · 액추에이터 힙 · GC · Hikari) |

**VM 의 다른 CPU**(= VM 전체 − 스택 A 컨테이너 합, 400 % 만점): 부하 없을 때 가운데 48 %(최대 95 %) — 운영 스택 · 스택 B 의 평소 몫과 표본 · 합성 생산자의
`docker exec`. k6 실행 중에는 k6 자신이 더해져 52–84 %(가운데), 계단 부하 꼭대기에서 최대 279–283 %. 모든 지연 수치는 이 경합 속 값이다.

## 판정 기준(쓴 목표)

| 목표 | 값 | 출처 |
|---|---|---|
| REST 지연 | 경로마다 p95 ≤ 300 ms(오류 < 1 %) | `perf/rest.js` 임계값 · NFR-02(100 rps) |
| WS 지연 | diff 지연 p95 ≤ 500 ms · 오류 0 | `perf/ws.js` 임계값 |
| api 메모리 | ≤ 512 MB — **MiB 로 읽었다**(512 MiB = 536.9 MB, 너그러운 쪽). 컨테이너 메모리(docker stats)와 java RSS 둘 다 본다 | NFR-03 |
| 첫 화면 JS | 550,000 B(gzip 본문 · 웹 이미지의 Node) | ADR-026 · `check:first-js` |
| 화면 | Core Web Vitals 'good' — LCP ≤ 2.5 s · CLS ≤ 0.1 · TBT ≤ 200 ms(TBT 는 INP 의 실험실 대용). 설계서의 NFR-04 LCP 값은 읽지 못했다(계획 §3.5) | web.dev CWV |
| 그 밖 | 병적인 문장(합법 파라미터 하나가 공개 조회 상한 3 s 를 넘거나 다른 요청을 막음) · 병적인 응답 · docs/PERF.md 수치보다 나빠짐 | 이 브리프 |

## 데이터 크기(합성 — `tools/qa/seed_perf.sql`)

운영 스택은 읽지 않으므로 운영 규모는 문서의 수치로 맞췄다(PERF §1 · §3 · §13, ADR-017 R-06). 넣는 데 17분 44초(`evidence/performance/seed-run.log`), 그 뒤 운영의
자동 VACUUM 이 할 일을 미리 `VACUUM (ANALYZE)`(18.5 s — 파티션 부모는 운영처럼 ANALYZE 하지 않았다). DB 전체 **8.8 GB**(전 약 70 MB).

| 표 | 행(합성) | 크기(힙 + 인덱스) | 모양 |
|---|---|---|---|
| track_point(파티션 3개 · 09-29 00:00 → 10-01 21:00 UTC, 69 h + 측정 중 실시간) | 25,875,394(25,668,000) | 4.42 GB | 관심 지역 200대 / 10 s(2 h 비행마다 새 hex, 10대는 72 h 내내 같은 hex) + 전세계 10,000대 / 120 s(6 h 비행) = 시간당 372,000행, 시각 순서로 넣음(BRIN 상관이 운영과 같다) |
| ship_position(파티션 3개) | 9,601,416(9,527,889) | 1.62 GB | 12,000척, 300척은 매분 · 나머지는 분마다 17.1 % → 분당 약 2,300행(PERF §3 1,773–2,769) |
| track_point_1m | 8,556,242 | 1.28 GB | 관심 지역 200대 × 1분 × 29.5일(원해상도 구간은 앱의 요약 문장 그대로) |
| alert_event | 1,175,452(1,173,333) | 1.19 GB | 하루 40,000건 × 29.3일(ADR-017 R-06 '하루 약 50 MB'), id = epoch ms × 1000(AlertIds 형식) |
| sigmet | 207,524(200,000) | 117 MB | 250일 · 108 s 간격 · 2–6 h 유효(같은 때 약 130건 — PERF §13 P4 와 같은 크기) |
| ingest_run · quality_event | 377,783 · 65,887 | 108 MB · 11 MB | 하루 약 12,800 · 2,200건 × 29.5일 |
| aircraft · ship | 200,128 · 40,405 | 31 MB · 13 MB | 영구 표 |
| stats_daily · metar_obs · radar_frame · ingest_gap | 31,622 · 18,395 · 949(합성) · 3,000(합성) | 4 MB · 5 MB · — · — | 250일치 통계(최근 7일은 api 의 따라잡기가 다시 셈) |

**실시간 상태**: fixture 모드는 전세계 항공기가 0대(빈 목록)이고 선박이 약 380척이라 운영보다 훨씬 가볍다. 측정 동안 `tools/qa/perf_feed.py` 가 생산자 ACL 사용자로
전세계 10,000대(120 s 마다 — fixture 의 빈 전세계 메시지 바로 뒤, 유럽 30 % · 북미 30 % · 동아시아 15 % · 나머지 25 %)와 선박 15,000척(5 s 마다 200척씩 —
초당 40건, 열 번에 한 번 정적 정보)을 실었다(`evidence/performance/feed.log`). 측정 중 `/status`: 관심 지역 127대 · 전세계 10,000대 · 선박 15,375척 · SIGMET 132.
api 의 저장기도 이만큼 썼다(전세계 2분마다 10,000행 — 운영과 같은 쓰기 부하, 기록기 버림 0).

## 결함

| 번호 | 심각도 | 한 줄 | 재현 시험 · 검사 |
|---|---|---|---|
| QA-401 | 높음 | 공개 `/alerts/history` 의 오래된 창(15–29일 전 — 합법 파라미터)이 alert_event 를 기본 키 역순으로 거의 전부 훑어 늘 3 s 에 끊겨 503 — 익명 클라이언트 하나가 초당 2건(IP 당 한도 안)으로 공개 조회 격벽을 차지해 재생 · 통계 · 항적이 503 · 수 초 지연 | `apps/api/src/test/java/dev/wakeline/qa/Qa401AlertHistoryOldWindowScansNewerRowsDbTest.java` · `perf/qa/qa-401-alerts-history-old-window.js`(k6 임계값) |
| QA-400 | 보통 | api 메모리 NFR-03(≤ 512 MB) 미충족 — 운영 규모 상태에서 100 rps(NFR-02 부하) 동안 RSS 529–556 MiB · 컨테이너 557–589 MiB, 몰림 한 번 뒤로는 힙 커밋이 상한 410 MiB 에 머물러 쉬는 동안에도 RSS 693 MiB | `tools/qa/perf_check_mem.py`(표본 CSV — 넘으면 종료 1) |
| QA-402 | 보통 | 지도 화면(`/` · `/replay`)이 Core Web Vitals 'good' 을 못 맞춤 — 데스크톱 TBT 1.4–1.7 s(가운데), 모바일 LCP 7.3–7.4 s · TBT 4.6–6.3 s | `tools/qa/perf_cwv_check.py`(Lighthouse 보고서 — 넘으면 종료 1) |
| QA-403 | 낮음 | 지도 없는 화면(`/about` · `/stats`)도 모바일 프리셋에서 LCP 2.67–2.73 s(> 2.5 s) · TBT 0.6–2.6 s(> 200 ms) — 데스크톱은 'good' | `tools/qa/perf_cwv_check.py` |

---

### QA-401 · 높음 · 성능(병적 쿼리 · 공개 조회 고갈)
- **환경**: 커밋 `e6857473` · 스택 A(고친 빌드 `wakeline-api:qa-fix` `40390885d7c8`) · 합성 데이터(alert_event 1,175,452행 · 29.3일 — ADR-017 R-06 의 '하루 약 50 MB' 규모) · HTTP(브라우저 없음)
- **재현 절차**(작업 트리 루트):
  ```bash
  # 1) 결정적 재현(Testcontainers — 운영 DB 이미지, 30일 · 300,000행 · 25일 전 6 h 창)
  cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa401AlertHistoryOldWindowScansNewerRowsDbTest'; cd -
  # 2) 스택 A(합성 데이터 seed_perf.sql 이 들어간 상태): 오래된 1 h 창 하나 — 3 s 뒤 503 + Retry-After 10
  curl -s -o /dev/null -w '%{http_code} %{time_total}\n' "http://localhost:8701/api/v1/alerts/history?from=$(date -u -v-25d +%FT%TZ)&to=$(date -u -v-25d -v+1H +%FT%TZ)&limit=50"
  # 3) 공개 조회 격벽 고갈(api 직접 · 제한 상향 중) — 기준선과 공격
  tools/qa/perf_k6.sh qa401-base-r1   qa/qa-401-alerts-history-old-window.js 62 -e ATTACK_RPS=0 -e VICTIM_RPS=10
  tools/qa/perf_k6.sh qa401-attack-r1 qa/qa-401-alerts-history-old-window.js 62 -e ATTACK_RPS=2 -e VICTIM_RPS=10
  # 4) 기본 제한의 edge 경유: 공격 k6 컨테이너(IP 하나, 2 r/s) 와 피해 k6 컨테이너(다른 IP, 1 r/s)를 함께
  ```
- **기대 결과**: 범위 30일 이하의 합법 요청은 창 안의 행만 읽어 수십 ms 안에 답한다(같은 창에 hex 를 주면 18–27 ms). 한 클라이언트의 요청이 다른 사용자의 공개 조회를 막지 않는다.
- **실제 결과**:
  - edge 경유 단건(3번씩): 24 h 기본 18–122 ms · 2일 전 1 h 29–924 ms · 7일 전 1 h 103–1,946 ms · 15일 전 1 h 2,749 ms(200) 다음 **503 · 503** · 25일 전 1 h **503 × 3**(3,017–3,026 ms) ·
    29일 전 1 h **503 × 3** — 본문 `data store temporarily unavailable; retry later`, `Retry-After: 10`(다시 해도 같다). 같은 창 + `hex=f10000` 은 200 · 18–27 ms.
  - `EXPLAIN (ANALYZE, BUFFERS)`(api 의 SQL 그대로, 3회): 25일 전 1 h 창 **8,128 · 8,773 · 9,506 ms** — `Index Scan Backward using alert_event_pkey`, `Rows Removed by Filter: 1,009,071`,
    `Buffers: shared hit=9,815 read=106,229(약 830 MB) dirtied=2,029 written=21,965`. 24 h 기본 창은 1.7–6.8 ms.
  - 공개 조회 고갈(api 직접, 60 s × 3): 공격 2 r/s 이면 오래된 창 요청 **100 % 실패**(p50 3.4–3.7 s), 함께 보낸 재생 · 통계 · 항적 · 알림 10 r/s 가 **실패 25.8 · 28.5 · 52.7 %**,
    p50 1.0 s · p95 2.2–2.6 s(기준선: 실패 0 % · p50 6 ms · p95 53–69 ms). db CPU 가운데 131–139 %(기준선 10–13 %). 그동안 api WARN: `statement cancelled (SQLSTATE 57014)` 359건 ·
    `could not get a DB connection`(격벽) 645건(재생 103 · 통계 262 · 선박 항적 149 · 항공기 항적 56 …).
  - edge 경유 · 기본 제한(api IP 당 분당 120 = 초당 2건 — 공격은 그 한도 안, 60 s × 3): 공격 IP 의 요청 97.5–100 % 실패, **다른 IP** 의 피해 요청(1 r/s)은 실패 0 % 였지만
    p50 0.63–1.15 s · p95 1.25–2.24 s(기준선 p50 12–16 ms · p95 44–81 ms — 목표 p95 300 ms 를 넘는다). 피해 요청이 늘거나 공격 IP 가 둘이면 직접 시험처럼 503 이 된다(격벽 허가 6 · 기다림 1 s).
  - 웹 화면은 이 경로를 부르지 않는다(공개 API 계약에만 있음) — 화면 기능의 손실은 없고, 영향은 공개 조회 전체의 가용성이다.
- **증거**: `evidence/performance/explain-r{1,2,3}.txt`('alerts.history' 절) · `k6-qa401-{base,attack}-r{1,2,3}.{log,json}` · `k6-qa401-edge-{base,attacker,victim}-r{1,2,3}.{log,json}` ·
  `stats-qa401-*.csv`(db CPU) · `qa-401-api-warn.txt` · `qa-401-db-canceled.txt`(취소된 문장 359건) · `qa-401-junit.log`.
- **의심 원인**: `apps/api/src/main/java/dev/wakeline/weather/data/AlertRepository.java:126-133` — `WHERE e.entered_at BETWEEN :from AND :to … ORDER BY e.id DESC LIMIT :n`. 플래너는 `LIMIT` 의
  일찍 멈춤을 '맞는 행이 id 순서에 고르게 퍼져 있다'고 보고 계산한다(창 1,547행 추정 → 역순 스캔 비용 190,904 × 51/1,547 ≈ 6,640 < entered_at 인덱스 + sigmet 조인 + 정렬).
  그러나 알림 id 는 시각에서 만든다(`weather/core/AlertIds.java` — epoch ms × 1000, `pg_stats` 상관 0.99)라 오래된 창의 행은 모두 역순 스캔의 끝에 있다. 창 안의 행이 많을수록(창이
  넓거나 알림이 잦을수록) 이 계획을 고른다 — 같은 시험이 1 h 창 · 30만 행에서는 entered_at 인덱스를 골라 통과하고, 6 h 창에서 실패한다.
- **재현 시험**: `Qa401AlertHistoryOldWindowScansNewerRowsDbTest.anOldOneHourWindowDoesNotScanEveryNewerAlert` — 실패:
  `[alert_event 에서 읽고 버린 행(Rows Removed by Filter) — 25일 전 6 h 창 · limit 50. 실행 106 ms. 계획: … "Index Name": "alert_event_pkey" … "Scan Direction": "Backward" …] Expecting actual: 247500L to be less than: 10000L`.
  k6 `perf/qa/qa-401-alerts-history-old-window.js` — 임계값 `http_req_failed{name:alerts_history_old} rate<0.01` · `http_req_failed{name:victim} rate<0.01` 넘음(종료 코드 99).

### QA-400 · 보통 · 성능(api 메모리 — NFR-03)
- **환경**: 커밋 `e6857473` · 스택 A · api `wakeline-api:qa-fix`(1 GiB 한도 · `-XX:MaxRAMPercentage=40` → 힙 최대 410 MiB · `MALLOC_ARENA_MAX=2`) · 실시간 상태 = 관심 지역 127대 + 전세계 10,000대 + 선박 15,375척(perf_feed.py — 운영 규모, PERF §1 · §7)
- **재현 절차**:
  ```bash
  python3 tools/qa/perf_feed.py 3600 &                       # 운영 규모의 전세계 항공기 · 선박(스택 A 전용)
  # api 를 제한 상향으로 다시 만든 뒤(이 문서 '환경'), 100 rps × 3분 — 자원 표본은 perf_k6.sh 가 함께 뜬다
  tools/qa/perf_k6.sh rest100-r1 qa/rest-routes.js 195 -e RPS=100 -e DURATION=3m
  python3 tools/qa/perf_check_mem.py docs/qa/2026-10/evidence/performance/stats-rest100-r1.csv   # 넘으면 종료 1
  ```
- **기대 결과**: api 메모리 ≤ 512 MB(NFR-03) — 부하(NFR-02 의 100 rps) 중에도, 그 뒤에도.
- **실제 결과**(5 s 표본, docker stats = cgroup 사용 − inactive_file · RSS = java 프로세스 VmRSS):

  | 구간 | 표본 | 컨테이너 MiB(최소–최대) | java RSS MiB | 힙 커밋 MiB |
  |---|---|---|---|---|
  | 기동 직후 쉼(다시 만든 뒤 2–5분, 운영 규모 상태) | 36 | 485–507 | 459–481 | 194–213 |
  | REST 50 rps × 3분 × 3 | 126 | 최대 557 · 574 · 577 | 최대 529 · 547 · 550 | 244–262 |
  | REST 100 rps × 3분 × 3 | 126 | 576–589(**모든 표본이 512 위**) | 550–556(모든 표본) | 262–266 |
  | 계단 50→600 rps × 3 | 228 | 최대 732–741 | 최대 693–708 | **410(상한)** |
  | WS 200 연결 × 3 | 168 | 742–745 | 692–693 | 410 |
  | 부하 뒤 5분 쉼 | 60 | **741–742** | **693** | 410(줄지 않음) |
  | 기본 제한으로 다시 만든 뒤 edge 20 rps 1분 | 16 | 최대 518 | 최대 522 | 240 |

  RSS − 힙 커밋은 약 280–290 MiB 로 일정했다(556 − 264 · 693 − 410) — 힙이 커밋 상한(410)까지 가면 RSS 는 약 690 MiB 이고, G1 은 쉬는 5분 동안 커밋을 돌려주지 않았다.
  GC 일시정지 합: 100 rps 3분에 0.90–1.04 s(최대 53–79 ms), 계단 6분에 11.7–34.1 s(최대 0.34–0.72 s).
- **문서와의 차이**: README '성능(실측)' · VERIFICATION #26 은 NFR-03 을 '미충족 · 다음 후보'(경합 있는 실행 577–611 MiB, 경합 없는 k6 약 500 MiB)로 적었다. 이번에 달라진 것:
  (1) 운영 규모의 실시간 상태(전세계 1만 대 · 선박 1.5만 척)에서는 **쉬는 기동 직후에 이미 485–507 MiB**, NFR-02 부하(100 rps)만으로 모든 표본이 512 를 넘는다(경합과 상관없이 — 다른 CPU 가운데 56–68 %);
  (2) 몰림 한 번(300 rps 이상) 뒤에는 힙 커밋이 상한에 붙어 **쉬어도 RSS 693 MiB** 가 남는다(문서에 없던 꼴 — 기록된 최대 661 MiB 보다 크다).
- **증거**: `evidence/performance/stats-{api-startup-lifted,rest50-r*,rest100-r*,step-r*,ws200-r*,after-load-idle,edge20-r1}.csv` · `resources-summary.md` ·
  `perf_check_mem.py` 출력(아래 '재현 시험').
- **의심 원인**: `apps/api/Dockerfile:24` `JAVA_TOOL_OPTIONS="-XX:+UseG1GC -XX:MaxRAMPercentage=40 …"` 과 `infra/compose.yml:143` `memory: 1g` — 힙 최대 410 MiB + 힙 밖 약 280 MiB(메타스페이스 ·
  코드 캐시 · GC 구조 · 스레드 — VERIFICATION #26 의 NMT 분해와 같은 꼴)면 상한이 약 690 MiB 라 512 MB 를 보장할 수 없다. 힙 커밋을 줄이는 설정(G1 의 주기적 GC · 커밋 반환)이 없어
  몰림 뒤에 내려오지 않는다. 운영 규모 상태(전세계 1만 · 선박 1.5만 — ShipStore 정적 정보 · 조각 캐시)가 쉬는 힙을 194–213 MiB 로 올린다.
- **재현 시험**: `python3 tools/qa/perf_check_mem.py docs/qa/2026-10/evidence/performance/stats-rest100-r*.csv` — 종료 1:
  `stats-rest100-r1.csv api_mem n=42 min=576.4 med=577.8 max=579.6 OVER 512 MiB (42/42 표본)` · `api_rss_mib … max=552.2 OVER 512 MiB (42/42 표본)`(r2 · r3 도 같음).
  JUnit 으로는 만들 수 없다(컨테이너 · 운영 규모 상태 · 부하가 필요) — 브리프대로 점검 스크립트로 둔다.

### QA-402 · 보통 · 성능(화면 — 지도 화면의 Core Web Vitals)
- **환경**: 커밋 `e6857473` · 스택 A(`wakeline-web:qa-fix`) · Lighthouse 12.8.2(`npx -y lighthouse@12`) · Chrome for Testing 153.0.8010.12(Playwright chromium-1243) headless=new ·
  `--use-angle=swiftshader`(소프트웨어 GL) · 기본 throttling(simulate) · 데스크톱 프리셋 / 모바일(기본) · 화면마다 3번 · benchmarkIndex 2,511–2,826 · 측정 중 perf_feed.py 가 돌았다(운영 규모 상태)
- **막은 주소**(`--blocked-url-patterns`): `*rainviewer.com*` `*adsbdb.com*` `*aviationweather.gov*` `*data.go.kr*` `*kma.go.kr*` `*opensky-network.org*` `*adsb.lol*` `*adsb.fi*` `*aisstream.io*` —
  실제로 막힌 요청은 `tilecache.rainviewer.com` 뿐(지도 화면 실행마다 13–20건). 배경지도 `tiles.openfreemap.org` 는 열어 두었다(실행마다 12–16건, 24번 합 약 220건).
- **재현 절차**: `tools/qa/perf_lighthouse.sh 3 / /replay` 뒤 `python3 tools/qa/perf_cwv_check.py`(종료 1).
- **기대 결과**: CWV 'good' — LCP ≤ 2.5 s · CLS ≤ 0.1 · TBT ≤ 200 ms(실험실 대용).
- **실제 결과**(가운데 [최소–최대], 3번씩):

  | 화면 · 프리셋 | 점수 | LCP ms | TBT ms | CLS | JS 전송 KiB · 전체 KiB |
  |---|---|---|---|---|---|
  | `/` 데스크톱 | 55 [53–60] | 1,897 [1,265–2,021] | **1,731 [1,526–1,780]** | 0.006 | 605.3 · 1,541 |
  | `/` 모바일 | 34 [34–39] | **7,376 [6,076–8,469]** | **6,257 [5,577–8,907]** | 0.003 | 605.3 · 1,378 |
  | `/replay` 데스크톱 | 60 [59–62] | 1,241 [1,131–1,693] | **1,443 [781–1,847]** | 0.004 | 622.6 · 1,745 |
  | `/replay` 모바일 | 37 [36–39] | **7,268 [6,424–8,252]** | **4,624 [3,698–6,131]** | 0.000 | 622.6 · 1,404 |

  `/` 데스크톱의 주 스레드: 스크립트 평가 3.0 s — 앱 청크 `3eyx6maxrg7e7.js` 1.43 s(같은 청크가 `/about` 에서는 0.17 s → 지도 화면에서의 실행 — 실시간 상태 처리로 보인다, 프로파일은 하지 않음) ·
  `maplibre-gl.mjs` 1.35 s, 긴 작업 6개(최대 683 ms). 모바일(CPU 4배 느림 흉내)은 `maplibre-gl.mjs` 6.6 s · 앱 청크 4.0 s. LCP 요소는 지도 위 글자(`span.inline-block`).
- **치우침(SwiftShader)**: headless 는 GPU 가 없어 WebGL 을 CPU 로 그린다 — 지도 화면의 그리기 일이 같은 CPU 를 다투고, 래스터 작업 일부가 'Unattributable'(758–1,550 ms)로 잡힌다. 실제 GPU 의
  브라우저에서는 TBT · LCP 가 이보다 작을 것이다(크기는 재지 못함 — 이 기계의 GPU 브라우저 자동 측정은 계획 밖). 그러나 스크립트 평가(앱 청크 · MapLibre JS)는 GL 과 상관없는 몫이라
  데스크톱 TBT 200 ms 는 GPU 가 있어도 넘을 것으로 본다(추정).
- **문서와의 차이**: PERF §7 의 `/` 데스크톱(실데이터 · 5회 가운데) 점수 53 · LCP 2.39 s · TBT 698 ms(범위 620–2,732) — 이번 TBT 1,526–1,780 ms 는 그 범위 안이라 회귀라고 하지 않는다.
- **증거**: `evidence/performance/lighthouse/{root,replay}-{desktop,mobile}-{1,2,3}.json.gz`(전체 보고서) · `lighthouse/summary.tsv` · `cwv-check.txt` · `lighthouse-run.log` · `lighthouse-run2.log`.
- **의심 원인**: 첫 화면에서 MapLibre(gzip 297 KiB · 원본 1.1 MiB)와 앱 청크(원본 229 KiB)를 평가하고 지도 · 실시간 상태를 그리는 일이 주 스레드에 한꺼번에 몰린다(`apps/web/app/page.tsx` → 지도 `components/MapView.tsx` · `components/map/use*.ts`, 재생은 `components/ReplayMap.tsx`). 첫 화면 JS 예산(550,000 B)은 전송 크기만 보고 주 스레드 시간은 보지 않는다.
- **재현 시험**: `python3 tools/qa/perf_cwv_check.py` — 종료 1: `/ desktop 3 1897 [1265–2021] 1731 [1526–1780] … MISS TBT>200` · `/ mobile … MISS LCP>2500 TBT>200` ·
  `/replay desktop … MISS TBT>200` · `/replay mobile … MISS LCP>2500 TBT>200`.

### QA-403 · 낮음 · 성능(화면 — 지도 없는 화면의 모바일 CWV)
- **환경 · 재현 절차**: QA-402 와 같다(`tools/qa/perf_lighthouse.sh 3 /about /stats` → `perf_cwv_check.py`).
- **기대 결과**: CWV 'good'(LCP ≤ 2.5 s · TBT ≤ 200 ms · CLS ≤ 0.1).
- **실제 결과**: 데스크톱은 'good' — `/about` 점수 99–100 · LCP 563–575 ms · TBT 0–102 ms, `/stats` 70–98 · LCP 652–768 ms · TBT 0–693 ms(가운데 114) · CLS 0–0.085.
  모바일: `/about` 점수 78–80 · **LCP 2,666–2,706 ms · TBT 656–754 ms**, `/stats` 65–81 · **LCP 2,710–2,730 ms · TBT 598–2,619 ms**. JS 전송 178.5 · 184.9 KiB, 요청 13 · 18건(바깥 호스트 없음).
  `/about` 모바일의 긴 작업은 'Unattributable' 994 ms 하나와 앱 청크 70–93 ms — LCP 요소는 표 칸(`td`).
- **증거**: `evidence/performance/lighthouse/{about,stats}-{desktop,mobile}-{1,2,3}.json.gz` · `cwv-check.txt`.
- **의심 원인**: 모바일 흉내(CPU 4배 · 느린 4G)에서 Next · React 공용 청크(`3eyx6maxrg7e7.js` 등 entry 12개 — 원본 658 KiB)를 받고 평가한 뒤에야 본문 글자가 그려진다(LCP 가 FCP 1.09 s 보다 1.6 s 늦다).
  지도와 상관없는 몫이라 SwiftShader 치우침은 없다.
- **재현 시험**: `python3 tools/qa/perf_cwv_check.py` — `/about mobile 3 2667 [2666–2706] 671 [656–754] … MISS LCP>2500 TBT>200` · `/stats mobile … MISS LCP>2500 TBT>200`.

## 측정 결과(결함이 아닌 것 포함)

### 1. REST — 도착률 고정(api 직접 · 제한 상향, 3분 × 3번씩)
명령: `tools/qa/perf_k6.sh rest{50,100}-r{1,2,3} qa/rest-routes.js 195 -e RPS={50,100} -e DURATION=3m`(경로 16개를 무게 3:1:2:2:2:1… 로 섞음 — `perf/qa/rest-routes.js` 머리말).
요약: `python3 tools/qa/perf_summarize.py rest rest50 rest100`. **두 부하 모두 실패 0.00 %, 모든 경로 p95 ≤ 92.9 ms(목표 300 ms) — 6번 모두 임계값 통과.**

| 경로 | 50 rps: 처리량 /s · p50 · **p95** · p99 · 최대 ms(가운데 [최소–최대]) | 100 rps: 같은 순서 |
|---|---|---|
| `aircraft_region`(bbox 124,33,132,39 · lite) | 7.2 · 2.4 · **6.6 [6.4–7.9]** · 25.7 [22.1–34.1] · 124 [91–222] | 14.5 · 1.9 · **7.4 [5.9–7.5]** · 23.3 [22.7–26.6] · 153 [68–216] |
| `aircraft_wide`(2,500 sq° · full) | 2.5 · 8.9 · **20.1 [19.2–23.5]** · 62.8 [34.1–68.6] · 151 [67–458] | 4.7 · 7.0 · **21.8 [21.3–22.3]** · 63.8 [56.0–70.9] · 213 [170–275] |
| `ships_region`(120,30,135,42) | 4.8 · 11.2 · **32.0 [32.0–32.9]** · 73.0 [69.3–90.0] · 227 [209–374] | 9.6 · 9.1 · **28.7 [26.9–31.2]** · 80.4 [66.2–84.3] · 228 [226–413] |
| `sigmets`(active) | 4.8 · 2.5 · **7.5 [6.9–7.6]** · 22.8 [21.3–28.2] · 119 [76–173] | 9.5 · 1.9 · **7.2 [6.3–7.8]** · 21.4 [20.0–27.7] · 118 [114–156] |
| `status` | 4.7 · 1.1 · **5.3 [4.6–6.2]** · 20.8 [13.5–21.7] · 140 [59–361] | 9.5 · 0.9 · **4.4 [4.4–4.7]** · 19.2 [15.2–20.0] · 126 [53–146] |
| `replay_72h`(10분–68 h 전, 관심 지역) | 2.5 · 28.9 · **82.2 [76.7–82.4]** · 193.8 [183.1–196.0] · 357 [301–657] | 4.8 · 26.6 · **89.1 [82.9–92.9]** · 222.7 [177.8–391.2] · 332 [320–747] |
| `replay_1m`(4–29일 전 — 1분 요약) | 2.3 · 12.7 · **28.7 [27.3–33.4]** · 105.5 [60.1–143.9] · 303 [260–993] | 4.9 · 10.9 · **37.1 [35.3–41.4]** · 131.6 [106.4–162.2] · 229 [218–473] |
| `stats_sigmet`(기본 7일 · fir/hazard) | 2.4 · 3.0 · **8.9 [8.4–12.6]** · 21.8 [21.4–32.7] · 127 [88–549] | 4.8 · 2.3 · **9.9 [9.2–10.8]** · 30.0 [29.8–32.5] · 145 [90–291] |
| `stats_alerts`(기본 7일) | 2.4 · 2.0 · **6.9 [6.4–7.0]** · 21.7 [15.5–24.2] · 133 [92–708] | 4.7 · 1.6 · **7.6 [6.4–8.9]** · 23.0 [22.9–35.6] · 218 [167–393] |
| `stats_traffic`(1–6일 전) | 2.3 · 2.2 · **7.7 [6.9–8.4]** · 17.5 [16.1–25.3] · 438 [25–707] | 4.9 · 1.7 · **8.6 [8.2–8.8]** · 32.6 [30.3–38.2] · 178 [157–609] |
| `aircraft_track`(기본 2 h — 주 ①) | 2.4 · 3.7 · **13.3 [11.3–24.5]** · 35.6 [33.0–77.6] · 167 [83–521] | 4.7 · 2.4 · **9.3 [8.6–13.8]** · 43.7 [33.2–88.8] · 156 [116–356] |
| `ship_track`(기본 6 h) | 2.3 · 12.9 · **43.0 [38.3–48.2]** · 100.6 [67.0–113.0] · 216 [106–822] | 4.7 · 10.9 · **39.3 [39.3–43.2]** · 112.1 [86.6–129.4] · 275 [215–656] |
| `alerts_history`(2–29일 전부터 지금까지 — 주 ②) | 2.4 · 3.3 · **11.7 [10.3–12.1]** · 42.1 [32.0–55.5] · 401 [67–573] | 4.5 · 2.6 · **10.1 [9.3–13.9]** · 73.6 [35.1–79.5] · 107 [98–373] |
| `aircraft_search` | 2.5 · 4.7 · **15.5 [14.0–16.3]** · 42.5 [23.2–78.0] · 203 [52–293] | 4.9 · 3.7 · **13.8 [13.2–13.9]** · 53.9 [51.4–68.5] · 209 [172–233] |
| `ships_search` | 2.3 · 3.8 · **11.4 [11.1–12.1]** · 37.3 [31.3–45.9] · 144 [107–349] | 4.8 · 3.3 · **9.8 [9.2–11.0]** · 39.5 [24.4–51.5] · 133 [123–355] |
| `airport_wx` | 2.5 · 2.2 · **7.0 [7.0–8.2]** · 17.1 [15.4–33.4] · 163 [53–422] | 4.6 · 1.7 · **7.9 [7.8–8.0]** · 30.8 [20.5–44.6] · 164 [156–302] |

- 주 ①: 72 h 내내 같은 hex 인 합성 기체(f10000 …)의 기본 2 h 창은 합성 항적이 21:00 UTC 에 끝나 실행 시각에 따라 0–360점이었다 — 큰 범위는 '6. 큰 응답'(24 h · 5,000점)에서 쟀다.
- 주 ②: 끝이 '지금'인 창은 최신 알림부터 50건이라 빠르다. 시작 · 끝이 모두 오래된 창은 QA-401.
- **PERF.md 와 견줌**(§1 100 rps · 실데이터): `/aircraft` p95 8.6 → 7.4 ms · `/sigmets` 12.0 → 7.2 ms · `/status` 11.0 → 4.4 ms — 회귀 없음.

### 2. REST — 계단 부하(어디서 p95 300 ms 를 넘고 오류가 시작되나)
명령: `tools/qa/perf_k6.sh step-r{1,2,3} qa/rest-routes.js 370 -e MODE=step -e STEPS=50,100,200,300,400,600 -e STEP_S=60`(단계마다 60 s, 같은 경로 섞음). 요약 `perf_summarize.py step step`.

| 목표 rps | 이룬 rps | p50 ms | **p95 ms** | p99 ms | 오류 % | VM CPU(가운데, 400 % 만점) · api · db |
|---|---|---|---|---|---|---|
| 50 | 50.0 | 3.1 [3.1–3.2] | 24.8 [23.2–25.8] | 55.5 | 0 | 101 · 17 · 16 |
| 100 | 97.9 | 2.7 | 24.8 [23.2–28.2] | 56.8 | 0 | 130 · 31 · 34 |
| 200 | 195.8 | 3.4 | 49.1 [39.7–49.1] | 131.9 | 0 | 188 · 57 · 43 |
| 300 | 295.8 | 6.7 | **247 [87–411]**(3번 중 1번 300 넘음) | 595 [287–1,363] | 0 | 258 · 81 · 63 |
| 400 | 394.8 [385.5–395.8] | 9.8 [9.4–53.6] | **400 [358–2,024]** | 1,190 [695–2,977] | 0 [0–11.1] | 301 · 114 · 79 |
| 600 | 530 [332–557] | 1,308 [220–2,986] | 4,136 [2,605–15,159] | 10,131 | **33.8 [20.3–39.2]** | 384 · 199 · 28 |

- **꺾이는 곳: 200–300 rps 사이에서 p95 가 300 ms 를 넘고(3번 중 1번), 400 rps 에서는 3번 모두 넘는다. 오류는 400 rps(1번) · 600 rps(3번 모두)에서 시작**. 오류는 모두 503 + Retry-After —
  공개 조회 격벽(허가 6 · 기다림 1 s)이 돌려보낸 DB 경로(재생 · 통계 · 항적 · 알림 이력 · 공항 기상, `wakeline_db_public_reads_rejected_total` 12,448 — r1 뒤)이고 메모리 경로(`/aircraft` ·
  `/ships` · `/sigmets` · `/status` · 검색)는 600 rps 에서도 실패 0 % 였다(지연만 p95 1.4–2.2 s).
- 600 rps 단계에서 VM CPU 가 384 % 로 차서(k6 자신이 'VM 의 다른 CPU' 최대 279 % 의 대부분) 이 수치는 같은 VM 의 부하 생성기와 나눠 쓴 값이다 — 꺾이는 곳은 CPU 포화와 겹친다.
- 그동안 저장기는 버린 행 0(`wakeline_track_rows_total{result="dropped"} 0` · 선박 0 — 쓴 항적 206,543 · 선박 94,973행): 격벽이 기록기 몫을 지켰다(PERF §13 D6 뒤와 같은 결과).
- NFR-02(REST 100 rps)의 2–3배에서 꺾인다 — 목표 안이라 결함이 아니다. 600 rps 에서 GC 일시정지 합 11.7–34.1 s / 6분(최대 0.72 s), 힙 커밋 상한(410 MiB) — QA-400 참고.

### 3. REST — edge 경유(기본 제한 — 제한 동작)
명령(api 를 기본 제한으로 되돌린 뒤): `tools/qa/perf_k6.sh edge20-r1 qa/rest-routes.js 62 -e BASE_URL=http://10.78.0.10:8700 -e HOST=localhost:8701 -e RPS=20 -e DURATION=1m`(한 번).
- IP 하나에서 20 r/s × 60 s = 1,201건: **edge 가 571건을 429**(`limiting requests` — IP 당 10 r/s · burst 30), **api 가 390건을 429**(분당 120, 액추에이터 `status="429"` `uri="UNKNOWN"`),
  240건(20 %) 응답 200. 429 응답 p50 2.5 ms — 제한은 빠르게 돈다. 경로별 실패 65–90 %(`evidence/performance/k6-edge20-r1.log`).
- QA-401 의 edge 경유 시험(위)도 기본 제한에서 돌렸다 — 오래된 창 2 r/s 는 두 제한을 모두 통과한다.

### 4. WebSocket — 200 연결 · 선박 레이어
명령: `tools/qa/perf_k6.sh ws200-r{1,2,3} ws.js 265 -e CONN=200 -e SHIPS=1 -e ORIGIN=http://localhost:8701`(1분 램프업 → 3분 유지, 관심 지역 구독 줌 7). 요약 `perf_summarize.py ws ws200`.

| 항목 | 3번(가운데 [최소–최대]) | PERF §1(실데이터) |
|---|---|---|
| 메시지 · 스냅샷 · diff · 선박 메시지 | 21,692 [21,600–22,018] · 1,541 · 3,758 [3,631–3,870] · 4,611 [4,427–4,622] | 20,060 · 1,495 · 3,058 · 4,424 |
| 오류 | **0 · 0 · 0** | 0 |
| 항공기 diff 지연 p50 · **p95** · p99 · 최대 ms | 42 [28–54] · **230 [204–249]** · 438 [345–545] · 692 [505–768] | 29 · 286 · 786 · 1,027 |
| 선박 지연 p50 · p95 · p99 · 최대 ms | 18 [13–25] · 144 [144–180] · 301 [251–410] · 532 [392–670] | 7 · 34 · — · 81 |

- 목표(p95 ≤ 500 ms · 오류 0) 3번 모두 통과 — k6 임계값 통과(종료 0). 항공기 p99 꼬리는 PERF §1 보다 작다. 선박 지연은 PERF 보다 크다(p95 144–180 vs 34 ms) — 이번 상태는 선박 1.5만 척이
  5 s 마다 200척씩 바뀌어 diff 가 잦다(목표가 없는 지표 — 결함 아님).
- 자원: api CPU 가운데 3–6 %(최대 34–129 %), 메모리는 QA-400 의 표.

### 5. 자원(부하 중) — `evidence/performance/resources-summary.md`
`python3 tools/qa/perf_summarize.py res …`(표본 5 s). 대표:

| 구간 | api CPU % 가운데/최대 | api 컨테이너 · RSS MiB 최대 | 힙 사용 · 커밋 최대 | GC 합 s · 최대 s | db CPU % 가운데/최대 · 메모리 MiB | collector · redis MiB |
|---|---|---|---|---|---|---|
| 기동 뒤 쉼 | 2 / 76 | 507 · 481 | 186 · 213 | 0.44 · 0.079 | 0 / 150 · 956 | 71 · 27 |
| REST 100 rps(3번) | 30–32 / 75–100 | 580–589 · 552–556 | 231–240 · 264–266 | 0.90–1.04 · 0.053–0.079 | 25–28 / 61–114 · 941–1,023 | 70–97 · 34–38 |
| 계단(3번) | 65–79 / 226–275 | 732–741 · 693–708 | 347–402 · 410 | 11.7–34.1 · 0.34–0.72 | 35–51 / 130–162 · 950–1,024 | 48–81 · 42–57 |
| WS 200(3번) | 3–6 / 34–129 | 742–745 · 692–693 | 361–363 · 410 | 0.88–1.13 · 0.10–0.24 | 2 / 34–54 · 444–461 | 43–70 · 49–57 |
| QA-401 공격(3번) | 3–5 / 17–30 | 749–750 · 693–694 | 343–346 · 410 | 0.10–0.17 | **131–139** / 144–167 · 463–561 | 45 · 56–58 |

- db 컨테이너는 1 GiB 한도에서 메모리 941–1,024 MiB(docker stats — 페이지 캐시 포함)로 한도에 붙어 있다. DB 8.8 GB 에 shared_buffers 256 MB 라 큰 표는 디스크에서 읽는다(OOM · 재시작 없음).
- collector 는 70–97 MiB(PERF §7 의 173–217 MiB 보다 작다 — fixture 모드라 기상청 해석이 없다).

### 6. 느린 문장(`log_min_duration_statement = 100ms`, 21:55:39 → 23:57:20 UTC) · EXPLAIN
- 켜고 끈 기록: `ALTER SYSTEM SET log_min_duration_statement = '100ms'; SELECT pg_reload_conf();` → 끝에 `ALTER SYSTEM RESET …; SELECT pg_reload_conf();`(`show` = -1, auto.conf 항목 0).
- **로그가 돌아가 일부를 잃었다**: db 컨테이너 로그는 json-file 10 MB × 3 인데, 전세계 항공기 정적 정보 upsert(2분마다 · `INSERT INTO aircraft … FROM json…`)가 100 ms 를 넘을 때마다
  바인드 파라미터(약 1 MB JSON)를 DETAIL 로 함께 찍어 약 1시간이면 앞이 지워졌다. 그래서 고정 부하 구간은 그때 출력한 요약을 옮겨 두었다(`slowlog-fixed-runs-summary.md`), 그 뒤는 원문
  (`slowlog-raw-from-2251.log` · `slowlog-raw-2251-end.log`) · 요약(`slowlog-2251-end-summary.md`)으로 남겼다. 계단 부하(22:32–22:52) 구간의 원문은 잃었다.
- 요청 경로에서 100 ms 를 넘은 문장(REST 100 rps 구간 — 27분, 116건): `replay.track_point` 53건(가운데 130 · 최대 308 ms) · `ship.track` 11건(114 · 160) · `replay.sigmet` 4건(134 · 242) ·
  `aircraft.search` 2건(117 · 125) · `aircraft.track` 1건(124). 저장기: 항적 INSERT(2,000행 묶음) 37건(176 · 717 ms) · 항공기 정적 upsert 8건(183 · 328 ms). 이후 구간: QA-401 의 `alerts.history`
  (취소 전 2.0–2.8 s, 취소 359건) · `replay.sigmet` 55건(126 · 378 ms) · `UPDATE alert_event SET left_at … close_reason`(기동 정리) 256 ms · `UPDATE sigmet SET withdrawn_at …` 104–109 ms.
- **배치 문장**(요청 경로 밖 — api 기동 1분 뒤 따라잡기 · 매시): 교통량 하루 `INSERT … count(DISTINCT hex) FROM track_point` **3,359 · 5,147 · 6,313 ms**(KST 날 3개) · SIGMET 날 통계
  `INSERT … FROM sigmet WHERE valid_from …` 286–379 ms(valid_from 인덱스 없음 — 순차 스캔 20만 행) · 1분 요약 한 시 1,022–1,115 ms · 관측 수신 격자 부트스트랩 한 시 104–221 ms(25시간 ·
  407k–423k 행 3.0–3.3 s) · `SELECT least(min(valid_from) FROM sigmet, min(entered_at) FROM alert_event)` 125 ms(3시간마다). 따라잡기 전체 18 s(22:04:47 → 22:05:05) — 공유 풀 연결 하나를 쥔다.
- **EXPLAIN (ANALYZE, BUFFERS)** — `tools/qa/perf_explain.sql`, 3번(`explain-r{1,2,3}.txt`, 실행 시간 ms):

  | 문장 | r1 · r2 · r3 | 계획 |
  |---|---|---|
  | `replay.track_point` 관심 지역 · 30분 전 | 43.5 · 20.3 · 43.3 | 파티션 하나 · `…_ts_idx`(BRIN) 비트맵 → DISTINCT ON |
  | `replay.track_point` 넓은 bbox 2,500 sq° · 40 h 전 | 97.1 · 64.2 · 134.7 | 같은 꼴 — BRIN 비트맵 4,410행 → recheck 11,944 · filter 10,408 버림 → 1,021대 |
  | `replay.track_point_1m` 10일 전 | 0.8 · 2.5 · 2.6 | `track_point_1m_ts` |
  | `replay.sigmet` 넓은 bbox · 25일 전 | 39.5 · 100.1 · 105.2 | `sigmet_valid` 비트맵(PERF §13 P4 의 고친 조건) |
  | `aircraft.track` 기본 2 h · 24 h(5,001점) | 0.1–0.7 · **63.6 · 861.0 · 809.7** | 파티션 PK 스캔 — 24 h 는 5,017블록을 디스크에서(첫 실행이 차갑다) |
  | `ship.track` 6 h | 1.9 · 40.7 · 37.9 | 파티션 PK 스캔 |
  | `alerts.history` 24 h · **25일 전 1 h** | 1.7 · 6.8 · 6.6 · **9,506 · 8,773 · 8,128** | QA-401 |
  | `stats.sigmet` 92일 | 14.0 · 10.7 · 13.9 | stats_daily PK |
  | 관측 수신 격자 한 시 · 1분 요약 한 시 · 교통량 하루 | 220 · 169 · 187 / 275 · 272 · 491 / **4,594 · 5,665 · 5,113** | 교통량은 하루치 파티션 순차 스캔(약 900만 행, work_mem 64 MB) |

### 7. 큰 응답(edge 경유 · `Accept-Encoding: gzip` · 가장 큰 합법 파라미터, 3번씩)
명령: `python3 tools/qa/perf_large_responses.py 3 --json …/large-responses.json --check`(`large-responses.txt`). **JSON 응답은 모두 edge 가 gzip 했다(NOGZIP 0).** 1 MiB 넘는 원본 2개:

| GET(파라미터) | 상태 | 원본 B | 전송 B(gzip) | 시간 ms 가운데 [최소–최대] | 비고 |
|---|---|---|---|---|---|
| `/aircraft/f10000/track?from=-24h&to=now`(상한 24 h) | 200 | **1,065,365** | 213,321 | 77 [48–970] | 점 상한 5,000(TRACK_MAX_POINTS) — `truncated: true`. `stepS=60` 이면 278,851 · 59,883 B |
| `/ships?bbox=100,10,150,60`(2,500 sq°) | 200 | **1,617,430** | 251,477 | 49 [29–69] | 선박 상한 5,000(MAX_SHIPS_PER_MESSAGE) — `capped: true` |
| `/ships/coverage` | 200 | 724,651 | 181,757 | 30 [24–102] | 격자 칸 상한 16,000 에 닿은 상태(아래 '미확인') |
| `/aircraft?bbox=100,10,150,60&detail=full` | 200 | 616,047 | 89,251 | 38 [27–42] | lite 521,600 · 85,676 B |
| `/alerts`(활성 알림 전부 — 상한 없음) | 200 | 516,275 | 53,423 | 18 [7–23] | 전세계 1만 대 × fixture SIGMET 132 |
| `/stats/sigmet?from=-92d&group=fir` | 200 | 488,660 | 50,103 | 43 [39–59] | 92일 × FIR 약 110 |
| `/replay?at=-30m&bbox=2,500 sq°` | 200 | 392,833 | 65,184 | 62 [49–460] | 10일 전(1분 요약)은 44,868 B |
| `/ships/300000001/track?from=-24h`(매분 보고 선박) | 200 | 286,000 | 55,090 | 34 [29–183] | |
| `/alerts/history?from=-30d&limit=200` · `/ais/gaps?from=-31d` · `/sigmets?active=false` | 200 | 158,749 · 77,930 · 122,682 | 18,663 · 6,271 · 29,501 | 13–19 | |
| `/aircraft?bbox=-180,-90,180,90` | **422** | 244 | — | 12 | 전세계 bbox 는 상한(2,500 sq°) 밖 — REST 의 '전세계'는 받지 않는다 |

- 두 '큰' 응답은 상한(5,000점 · 5,000척)으로 묶여 있고 gzip 뒤 213 · 251 kB, 50–80 ms — 병적이지 않다(결함 아님). 나머지 26개는 원본 1 MiB 아래.

### 8. 첫 화면 JS(예산 550,000 B)
명령: `cd apps/web && npm run build && npm run check:first-js -- --in-image`(Next 16.3.8 확인 · 웹 이미지의 Node 24.21.0 · zlib 1.3.2.1-motley — 3번).
**546,721 B · 546,721 B · 546,721 B — 예산 안(여유 3,279 B)**, 파일 18개(MapLibre 3 · entry 12 · dynamic 2 · public 1). VERIFICATION 의 CTO 리뷰 값 545,458 B 보다 +1,263 B(QA 수정들).
Lighthouse 의 `/` 스크립트 전송량은 605.3 KiB(응답 머리 · 첫 화면 뒤 미리 받는 조각 포함 — 다른 척도). 증거 `first-js-check.log`.

### 9. 기동(운영 규모 데이터)
api 를 다시 만들고 `--wait` 가 healthy 를 본 때까지 13 s · 15 s(두 번), `Started WakelineApplication in 4.8 s`. 관측 수신 격자 부트스트랩 25시간 · 406,945 · 423,151행 3,289 · 3,047 ms.
기동 1분 뒤 따라잡기 18 s(KST 날 7개 통계 + 옛 날 1개). 이전 실행이 열어 둔 알림 492건을 닫는 `UPDATE` 256 ms.

## 미확인
- **관측 수신 격자 칸 상한(16,000)**: 합성 선박(12,000척이 무작위 방향으로 움직임)으로 기동 때 `ship coverage: memory cap reached (cells 16000 / 16000, ship-cells 22690 / 200000)` WARN 과
  `wakeline_ship_coverage_dropped_total{reason="cells"} 203,993` — 새 칸을 세지 않는다(설계된 동작, WARN · 지표 있음). 실제 선박은 항로를 따라 움직여 24 h 에 거치는 칸이 훨씬 적으므로
  운영(1.4–3만 척, 0–45°E 제외)에서 상한에 닿는지는 이 데이터로 판단할 수 없다. 운영 스택을 읽지 않았다.
- **실제 GPU 브라우저의 지도 화면 CWV**: SwiftShader 치우침(QA-402)의 크기는 재지 못했다(headless 만).
- **NFR-04 의 LCP 목표값**: 설계서(PDF)를 읽지 못해 CWV 'good' 으로 판단했다(계획 §3.5).
- **계단 부하 구간의 느린 문장 원문**: 로그 회전으로 잃었다(위 6).

## 개선 제안(결함 수에 넣지 않음)
- **느린 문장 로그가 바인드 파라미터를 통째로 찍는다**: 항공기 정적 정보 upsert 의 파라미터(전세계 1만 대 JSON, 약 1 MB)가 DETAIL 로 남아 db 로그(10 MB × 3)가 약 1시간이면 돈다.
  운영에서 `log_min_duration_statement` 를 켤 때는 `log_parameter_max_length`(예: 1024)를 함께 두는 것이 좋다(문서 · 운영 안내).
- **sigmet.valid_from 인덱스 없음**: 일 통계(하루 2문장 × 250일+)와 3시간마다의 `min(valid_from)` 이 20만 행을 순차로 읽는다(각 125–380 ms). SIGMET 은 지우지 않아 계속 커진다.
- **교통량 일 집계 3.4–6.3 s**: 하루 파티션(약 900만 행)을 순차로 읽는다 — 관심 지역 점은 전세계 점과 섞여 있다(MaintenanceJobs 주석과 같은 판단). 배치라 요청 지연에는 영향이 없다.
- **QA-401 와 같은 꼴의 다른 문장 점검**: `ORDER BY id DESC LIMIT` + 시각 범위 조건은 id 가 시각 순인 표에서 같은 함정이 있다(운영 화면의 `/ops/runs` 등 — 운영 경로라 이번 범위 밖, 재지 않음).

## 확인했고 문제없음
- REST 16경로 × 50 · 100 rps × 3번: 실패 0 %, p95 4.4–92.9 ms(목표 300) — PERF §1 보다 나빠지지 않음.
- 계단 부하에서 저장기 손실 0(항적 · 선박 dropped 0), 오류는 모두 설계된 503 + Retry-After(격벽).
- WS 200 연결 × 3: 오류 0 · p95 204–249 ms(목표 500).
- edge 제한: IP 당 10 r/s(burst 30) · api 분당 120 이 차례로 동작(429, 2.5 ms).
- JSON 응답 압축: 31개 경로 모두 gzip(edge), 1 MiB 넘는 둘은 상한으로 묶임.
- 첫 화면 JS 546,721 B ≤ 550,000 B(3번 같음).
- 데스크톱 `/about` · `/stats` CWV good, 모든 화면 CLS ≤ 0.085.
- 합성 데이터 위의 재생(72 h · 1분 요약 · SIGMET), 항적 · 선박 항적 · 검색 · 통계의 계획은 인덱스 · 파티션 가지치기를 쓴다(EXPLAIN 3번).

## 재현 · 도구(이번에 더함 — 모두 스택 A 전용)
| 파일 | 하는 일 |
|---|---|
| `tools/qa/seed_perf.sql` | 운영 규모 합성 데이터(위 표 — 표식 `provider`/`raw_ref`/`source` = `qa_synthetic`). `docker exec -i wakeline-e2e-db-1 psql -U postgres -d wakeline -v ON_ERROR_STOP=1 < tools/qa/seed_perf.sql` |
| `tools/qa/perf_feed.py` | 실시간 전세계 1만 대 · 선박 1.5만 척 생산자(생산자 ACL 사용자). 멈춤: `touch /tmp/wakeline-qa-perf-feed.stop` |
| `tools/qa/perf_k6.sh` | k6(스택 A 망) + 같은 동안 자원 표본 → 증거 폴더 |
| `perf/qa/rest-routes.js` | REST 16경로 섞음 — 고정(MODE=fixed) · 계단(MODE=step) · edge(BASE_URL · HOST). 경로마다 p95 < 300 · 오류 < 1 % 임계값 |
| `perf/qa/qa-401-alerts-history-old-window.js` | QA-401 — 오래된 창 · 피해 요청 |
| `tools/qa/perf_sample.py` · `perf_check_mem.py` · `perf_summarize.py` | 자원 표본 · NFR-03 검사(QA-400) · 표 만들기 |
| `tools/qa/perf_slowlog.py` · `perf_explain.sql` | 느린 문장 묶기 · 핵심 문장 EXPLAIN |
| `tools/qa/perf_large_responses.py` | 큰 응답 · 압축 검사(`--check` 면 BIG · NOGZIP · 5XX 에 종료 1 — 지금은 상한 안의 BIG 둘로 1) |
| `tools/qa/perf_lighthouse.sh` · `perf_cwv_check.py` | Lighthouse 24번(이미 잰 것은 건너뜀) · CWV 'good' 검사(QA-402 · QA-403) |

## 끝 상태
- DB 설정 되돌림(`log_min_duration_statement` = -1 · auto.conf 항목 없음, 23:57:20 UTC) · api 를 기본 제한(분당 120 · WS 200 / IP 5)으로 다시 만듦(23:39:09 UTC, `wakeline-api:qa-fix`) ·
  합성 생산자 멈춤(23:57:50 UTC — 이 세션이 띄운 프로세스) · 스택 A 7개 컨테이너 healthy · `/healthz` ok.
- **합성 데이터는 남겼다**(리드가 정한다 — DB 8.8 GB). 지우려면 `provider = 'qa_synthetic'`(track_point · ship_position · sigmet · ship) · `source = 'qa_synthetic'`(aircraft) ·
  `raw_ref LIKE 'qa_synthetic:%'`(ingest_run → quality_event CASCADE) · `evidence->>'provider' = 'qa_synthetic'`(alert_event — sigmet 보다 먼저) · metar_obs · radar_frame(`path LIKE '/v2/radar/qa%'`) ·
  ingest_gap(`provider`), track_point_1m 의 hex `f1….` · stats_daily(합성 날짜). 합성 항적 · 선박 위치는 보존 작업(매시 :02, 72 h)이 파티션째 지운다 — 이 세션이 만든 `track_point_20260929` · `ship_position_20260929` 는 10-03 00:02 UTC, 나머지 둘은 10-04 · 10-05 00:02 UTC.
- 운영 스택(8700) · 스택 B(8702)에는 docker 명령 · 요청을 보내지 않았다(docker stats 도 `wakeline-e2e-*` 이름만).
