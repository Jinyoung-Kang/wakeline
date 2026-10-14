# public-demo — 공개 데모 구성(A1) 화면 · API 점검(QA 2026-10-aws)

- 대상: 스택 **A1** = 격리 스택 A + `tools/qa/compose.aws-sim.yml`(web `WAKELINE_PUBLIC_DEMO=1` · api 공유 풀 6 · 공개 조회 허가 3 · 선택 조회 풀 2 · OpenSky 끔) —
  `http://localhost:8701`(compose `wlqa-a`, 이미지 `wakeline-*:qa`, fixture 모드). 시작 때 `WLQA_ENV=<세션 임시>/qa.env tools/qa/wlqa.sh A1 up -d --no-build --wait` 로
  web · api 를 다시 만들었고(환경 확인: web `WAKELINE_PUBLIC_DEMO=1`, api `HIKARI_MAXIMUMPOOLSIZE=6 · PUBLICREADS_PERMITS=3 · READPOOL_SIZE=2`), 끝난 뒤에도 A1 그대로 둔다.
  A1 에는 AWS 앞단(CloudFront · Caddy · gate)과 realip 가 없다 — 잠금(401 locked) · 오프라인 503 은 `page.route` 로 흉내 냈다.
- 도구: Playwright(Chromium headless · 시간대 UTC) · axe-core(WCAG 2.1 A · AA) · Python(urllib · websockets 17.1 — 수집기 venv) · Gradle 단위 시험.
  지도 타일(OpenFreeMap · RainViewer)은 `qa-aws-helpers emptyExternal` 로 빈 응답. 외부 공급자 · AWS · 운영 스택(8700)은 부르지 않았다. 운영자 자격 증명은 쓰지 않았다.
- 결함 5건: 기능 **QA-1350 보통** · 화면 **QA-1460 – QA-1463 낮음**. 치명 · 높음 없음.
- 실행한 시험 · 점검: 브라우저 13회(데모 스윕 4 · 상태 3 · 앞단 흉내 2 · 재현 4) + 점검 스크립트 2(공개 조회 문턱 1 · WS 남용 2회 실행) + Gradle 재현 1 + curl 확인(`/api/v1/status` · `/api/v1/openapi` · 화면 HTML 4).

## 한 일과 결과(수)
| 항목 | 방법 | 결과 |
|---|---|---|
| 데모 스윕 10경로 × 4폭 | 새 `e2e/qa/qa-aws-demo-sweep.spec.ts` — 앞선 aws-sweep 과 같은 수집 + **운영 정보 노출 검사**(보이는 글 · title · aria-label · 같은 출처 `/ops` · `/logs` 링크 · '운영 화면/메뉴/로그/탭' · `kma_warning` · 머리말 local) | 40 화면 **axe 위반 0 · 중복 요청 0 · 페이지 오류 0**. 콘솔 오류 = `/ops` · `/logs` 의 `GET /api/v1/ops/session` 404 뿐(설계 — 앞선 QA 와 같음). 메뉴 = 상황판 · 재생 · 통계 · 출처·한계 · 설명서(운영 · 로그 없음), 머리말 `portfolio · non-commercial · demo`, '로그 보기' 링크 0. 노출: `/guide` 운영 · 로그 절(ADR-039 '남는 것' — 수용), **`/about` 한 줄(→ QA-1460)**. 가로 넘침 `/` 1440 · 375 · 320(같은 QA browser QA-1420) · `/replay` 320 의 1 px(반올림 — browser 와 같음) |
| 공개 조회 허가 3 의 503 문턱 | 새 `tools/qa/pd_public_reads_threshold.py` — 공개 조회 경로 섞음 동시 10 · 20 · 30, 그다음 `stats_daily` 를 8 s 잠근 채 `/stats/traffic` 10개 + 다른 공개 조회 5 + 실시간 5 | 보통 DB: **10 · 20 · 30 모두 200**(p50 0.06–0.12 s, 최대 0.16 s — fixture 규모에서는 문턱에 닿지 않음). 느린 DB: `/stats/traffic` 10 = 503 UNAVAILABLE + `Retry-After: 10` 10(허가를 잡은 3개는 3.05 s 문장 상한, 7개는 1.08 s 허가 대기), **다른 경로의 공개 조회 5 중 4 도 503**(1.02 s — 허가 하나를 모든 공개 조회가 나눈다, 선박 검색은 200), 실시간(`/aircraft` · `/status` · `/healthz` · `/alerts` · `/sigmets`) 5 = 200 · 0.02 s, 잠금 뒤 바로 200. 500 · 504 · 429 0 |
| 503 을 받은 화면 | 새 `qa-aws-demo-states.spec.ts` 1 — 위 잠금 + 배경 요청 4개씩(허가를 잡음)으로 실제 503 을 만든 채 `/airports/RKSI` · `/alerts/[id]` · `/replay` | 재생 = "데이터 저장소를 잠시 사용할 수 없음(HTTP 503) — 10초 뒤 다시 시도" + 요청 id(설계대로 한 번 다시 부름). 공항 = "기상 이력을 불러오지 못했습니다(HTTP 503)." + 요청 id — **다시 부르기 · 단추 없음(→ QA-1463)**. 알림 근거 = "알림 근거를 받지 못함" + 요청 id(같은 QA web-code QA-1301 표에 있음). 세 화면 모두 `/logs` 링크 0 |
| 오류 경계 · 문구(공개 데모) | 같은 spec 2 · 3 — 청크 404 로 `/stats` 이동 → 오류 경계, `/api/v1/warnings` `received:false` · `/stats/alerts` 503 흉내 | 오류 화면 "운영자는 시스템 로그에서 같은 내용을 봅니다" · 보고 "보냄 — 운영자 시스템 로그의 web-client 항목" · `/logs` 링크 0 · 스택은 브라우저 청크 경로뿐. 특보 줄 "특보 목록 수신 전 — 수집기가 아직 보내지 않았거나 꺼져 있음"(운영 화면 가리킴 없음). 요청 id 복사 title "운영자에게 전하면 서버 로그를 찾는다" — **모두 ADR-039 대로** |
| 앞단 잠금 · 오프라인 흉내 | 새 `qa-aws-demo-front.spec.ts` 2 — 같은 출처 모든 요청을 gate 모양(화면 이동 = 401 HTML, 그 밖 = 401 `{"error":"locked"}`) / CloudFront 오프라인(503 text/html)으로, WS 는 `window.WebSocket` 감싸기로 새 연결 error → 1006 | 잠금(열린 WS 유지): 75 s 동안 실패한 요청은 `GET /api/v1/radar/kr` 401 하나, 화면 표시 변화 없음 — 그런데 한 운영일(08:50–18:00 = 9 h 10 m) 안에 얻은 쿠키(12 h)는 그날 안에 만료되지 않고 전날 쿠키는 다음 기동 전에 만료되므로 '열린 WS + 잠금'은 실제로 생기기 어렵다(결함으로 올리지 않음). 오프라인: 칩 `WS CLOSED · RETRY 7` · REGION STALE · 알림 패널 "연결 끊김…" — 까닭(운영 시간 밖) 없음 = **같은 QA web-code QA-1300 · QA-1302 와 같은 부류**(새로 세지 않음). 두 경우 모두 상단 메뉴 이동(RSC `?_rsc=` 가 401/503)은 **전체 문서 요청으로 바뀌어 잠금 · 오프라인 화면을 그대로 보인다**(문제없음) |
| WS 남용(한 IP) | 새 `tools/qa/pd_ws_demand_hog.py` — 호스트(한 IP)에서 WS 6개 · 관심 지역 밖 서로 다른 곳 줌 8 구독, 다른 IP 방문자(같은 compose 망의 수집기 컨테이너 → edge)가 두 곳 구독, 한 세션 select 8번 | IP 당 연결 상한 5 동작(6번째 `1013 connection limit`). 세션 제한 동작(7 · 8번째 select = `limited`). 메시지 rate(10 s 20개) · 크기 상한은 이번에 다시 보지 않았다(앞선 QA ws_probe 범위). **한 IP 가 핫 리전 임대 6 셀 중 5 개를 쥐고 다른 방문자의 두 번째 곳은 `throttled`(→ QA-1350)**. 집중 추적은 IP 당 5 hex / 50 이라 독차지까지는 아님 |
| WS 연결 상한을 받은 화면 | 같은 브라우저 컨텍스트에서 상황판 탭 6개 | 6번째 탭 = `WS CLOSED · RETRY 6` · "연결 끊김 — 6번째 재연결을 기다리는 중" — 까닭 없음(→ QA-1462) |
| 공개 경로의 내부 정보 | `curl /api/v1/status` · `/api/v1/openapi` · 공개 화면 HTML | `/status`: fixture_mode · 공급자 이름 · 전환 까닭 · 수요 수 · 수신 상태 — 판 · 호스트 · 망 · 비밀값 없음. `/openapi`: 공개 32경로 + `/healthz`, 운영 경로 0, `servers` 는 요청 Host(edge 허용 목록 밖 Host 는 421 — 위조 불가). 화면 HTML: `/` · `/stats` · `/about` 에 `/ops` · `/logs` 0, `/guide` 에만 운영 스크린숏 · 절(수용). 설명서 운영 · 로그 스크린숏은 운영자 이름 · 메시지 칸을 가렸고 fixture 값뿐 |

## QA-1350 · 보통 · 기능(WS 수요 임대 · 공개 데모) — 한 IP 가 핫 리전 수요 임대 6 셀 중 5 개를 연결이 이어지는 동안 쥐고, 뒤에 온 방문자의 곳은 throttled
- 환경: A1(공개 데모 · fixture 모드 — 수집기는 임대를 읽어 fixture 로 답함) · api `WAKELINE_WS_MAX_CONN_PER_IP=5` · `WAKELINE_WS_MAX_CONN=200`. 단위: `DemandServiceTest.Rig`.
- 재현 절차
  1. `cd apps/collector && uv run --offline python ../../tools/qa/pd_ws_demand_hog.py ../../docs/qa/2026-10-aws/evidence/public-demo`
     — 호스트(한 IP)에서 WS 6개를 열고 관심 지역(36.5, 127.8 · 250 NM) 밖 도쿄 · 상하이 · 베이징 · 타이베이 · 블라디보스토크 · 오사카를 줌 8 로 구독(1개는 상한으로 거절),
     8 s 뒤 같은 compose 망의 다른 컨테이너(다른 IP)에서 마닐라 · 홍콩 두 곳을 구독.
  2. 단위: `cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.ws.Qa1350OneIpHoldsHotDemandCapTest'`
- 기대: QA 계획 §2-1 '잠금 통과자의 남용 — 전역 상한을 혼자 차지하는가'. ADR-039 덧붙임 2-5(IPv6 를 끈 까닭)가 IP 별 제한으로 막으려던 것 — 한 IP 가 전역 상한(핫 리전 6 셀)을
  사실상 혼자 차지하지 못하고, 뒤에 온 다른 IP 방문자가 새로 본 곳이 임대된다.
- 실제: 한 IP 의 5 세션이 5 셀을 임대(`pending` · `active`), 다른 IP 방문자의 마닐라 = `pending`(마지막 1 셀), **홍콩 = `throttled`** — 화면 글은
  "핫 리전 호출 상한으로 지연"(`lib/demand.ts:103-104` — 공급자 호출 상한 때문이라고 말한다). 순위가 '세션 수 → 먼저 요청된 순'뿐이라 연결을 유지하는 한(핫 리전에는
  집중 추적의 30분 상한 같은 시간 상한도 없다) 계속 쥔다. IP 두 개(예: 휴대폰 + 집)면 6 셀 모두. 공개 데모는 OpenSky 를 끄므로(compose.aws.yml) 관심 지역 밖 항공기를
  보는 길은 핫 리전뿐 — 밀린 방문자는 그 곳의 항공기를 받지 못한다.
- 증거: `evidence/public-demo/ws-demand-hog.log` · `ws-demand-hog.json` · `qa-1350-gradle.txt`
  ```
  owner Vladivostok opened [1013, 'connection limit'] last_hot= null
  visitor Manila opened None last_hot= {"cell": "14.5:121.0:50", "radius_nm": 50, "state": "pending"}
  visitor HongKong opened None last_hot= {"cell": "22.5:114.0:50", "radius_nm": 50, "state": "throttled"}
  QA-1350 leased=[25.0:121.5:50, 31.0:121.5:50, 34.5:135.5:50, 35.5:139.5:50, 40.0:116.5:50, 14.5:121.0:50] hogIpLeased=5/6 visitor=[pending, throttled]
  java.lang.AssertionError: [다른 방문자의 두 곳 — 한 IP(203.0.113.7)가 핫 리전 6 셀 중 5 개를 쥐고 있다: …] Expecting ["pending", "throttled"] not to contain ["throttled"]
  ```
- 의심 원인: `apps/api/src/main/java/dev/wakeline/ws/DemandService.java:77`(MAX_HOT_CELLS 6) · `:239`(전역 순위만) · `:324-330 choose`(세션 수 → first_at — IP · 방문자 몫 없음) ·
  `apps/api/src/main/resources/application.yml:86`(IP 당 WS 5 — 전역 셀 상한과 거의 같다). 심각도: 다른 방문자를 막지만 핵심 화면(관심 지역 · 알림)은 그대로이고
  관심 지역 밖 추적 일부만 잃는다 — '보통'으로 둔다(익명 공개 서비스였다면 '높음' — 공개 데모는 접근 코드 뒤).
- 재현 시험: `apps/api/src/test/java/dev/wakeline/ws/Qa1350OneIpHoldsHotDemandCapTest.java` — 1 실패(대조: 6번째 연결 거절은 통과)

## QA-1460 · 낮음 · 화면(공개 데모 문구) — `/about` 이 공개 데모에서도 '운영 화면'을 가리킨다
- 환경: A1(공개 데모) · `app/about/page.tsx`
- 재현 절차: `cd apps/web && QA_BASE_URL=http://localhost:8701 QA_EVIDENCE_DIR=$PWD/../../docs/qa/2026-10-aws/evidence/public-demo npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1460`
- 기대: ADR-039 덧붙임 2-7(#142 D-8) — 공개 데모에서는 운영 메뉴 · 화면을 가리키는 문구를 쓰지 않는다(WS 형식 오류 · 특보 줄 · 머리말 · 오류 문구 · 오류 화면은 그렇게 고쳤다).
- 실제: 메뉴에 운영 · 로그가 없는데 '출처·한계'의 시각 항목이 "…통계의 날짜와 **운영 화면의 격리 수 날짜**는 KST 날짜(00:00–24:00 KST)이고…"라고 적는다.
  (`/guide` 의 운영 · 로그 절은 ADR-039 '남는 것'으로 수용된 것이라 세지 않았다.)
- 증거: `evidence/public-demo/qa-146x-run.log` — `QA-1460 nav=["상황판","재생","통계","출처·한계","설명서"] operatorLines=["…통계의 날짜와 운영 화면의 격리 수 날짜는 KST 날짜(00"]`
  · `Error: public demo /about lines pointing to the operator screen` · `qa-1460-about.json` · `qa-1460-about.png` · 데모 스윕 `demo-sweep-w*.json` 의 `/about` leak
- 의심 원인: `apps/web/app/about/page.tsx:34`(고정 글 — `usePublicDemo`/`isPublicDemo` 를 보지 않는다)
- 재현 시험: `apps/web/e2e/qa/qa-1460-demo-about-points-to-ops-screen.spec.ts` — 1 실패

## QA-1461 · 낮음 · 화면(공개 데모 문구) — 공개 데모의 통계 화면이 AWS 에서 돌지 않는 "매일 03:30 KST 집계"를 집계 시각으로 알린다
- 환경: A1(공개 데모) · `app/stats/page.tsx` · `lib/stats.ts` · 설명서
- 재현 절차: `… npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1461`(환경 변수는 위와 같다)
- 기대: ADR-039 덧붙임 2-1 "03:30 KST 정시 집계는 AWS 에서 돌지 않는다 — 기동 뒤 따라잡기가 그 몫을 한다"(평일 08:50–18:00 만 켬). 공개 데모 표시
  (`WAKELINE_PUBLIC_DEMO` — compose.aws.yml 에만)가 켜진 화면은 실제와 다른 집계 시각을 말하지 않는다.
- 실제: 머리 "매일 03:30 KST 에 전날(KST 날짜) 집계 · 최근 7일 …", title "api 집계 작업은 매일 03:30 KST 에 돈다". 빈 칸 문구도 "다음 03:30 KST 집계 뒤 채워집니다(놓친 최근
  N일은 3시간마다 따라잡기)"(`lib/stats.ts:91` · `:126`), 설명서 '집계 시각'도 같다. AWS 방문자는 아침 기동 뒤 따라잡기로 채워진 숫자를 03:30 에 센 것으로 읽는다.
- 증거: `evidence/public-demo/qa-146x-run.log` — `QA-1461 claims=["매일 03:30 KST 에 전날(KST 날짜) 집계 · …","title: api 집계 작업은 매일 03:30 KST 에 돈다 — …"]` · `qa-1461-stats.json` · `.png`
- 의심 원인: `apps/web/lib/stats.ts:16`(STATS_RUN_KST 고정) · `apps/web/app/stats/page.tsx:57` · `lib/stats.ts:91,93,126` · `components/guide/GuideView.tsx:396`
- 재현 시험: `apps/web/e2e/qa/qa-1461-demo-stats-claims-0330-run.spec.ts` — 1 실패

- 고침: 통계 화면 `b7901193`. **남은 곳(설명서)** — 공개 데모의 설명서 통계 절이 그대로 "매일 03:30 KST"(그림 13 번호 4 설명 · '집계 시각' 첫 문장)였다
  (재현 `f02ff9c9` — `qa-1461-demo-guide-claims-0330-run.spec.ts`, `evidence/public-demo/qa-1461-guide-run.txt`). `66213d7a`: 설명서도 공개 데모 표시로 집계 방식을 고르고
  (번호 설명 글의 자리 `{stats-run}` — `lib/stats statsRunPhrase`), 공개 데모에서는 '켜진 뒤 따라잡기'와 통계 그림이 늘 켜 둔 서버에서 찍힌 것임을 적는다(`qa-1461-guide-fix-run.txt` — claims 0).

## QA-1462 · 낮음 · 화면(WS 연결 상한) — IP 당 WS 상한(5)에 걸린 탭이 까닭 없이 '연결 끊김 · 재연결 대기'만 보인다
- 환경: A1 · 같은 브라우저 컨텍스트(한 IP) · `lib/ws-protocol.ts` · `lib/ws.ts`
- 재현 절차: `… npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1462` — 상황판 탭을 3 s 간격으로 6개 연다.
- 기대: 서버는 1013 + 까닭 "connection limit" 으로 닫는다. 화면은 같은 주소에서 연결이 너무 많다(다른 탭을 닫으면 이어진다)고 알린다.
- 실제: 탭 1–5 `WS OPEN`, 6번째 `WS CLOSED · RETRY 6` · title "연결 끊김 — 6번째 재연결을 기다리는 중(지수 백오프, 최대 30 s)" — 상한 · 탭 이야기 없음.
  공개 데모(AWS)는 IPv6 를 끄므로(ADR-039 덧붙임 2-5) 통신사 · 회사 NAT 뒤 방문자들은 같은 IPv4 의 5개를 나눠 쓴다 — 그 방문자는 자기 탭이 1개여도 같은 화면을 본다.
- 증거: `evidence/public-demo/qa-146x-run.log` — `QA-1462 tabs=["WS OPEN"×5,"WS CLOSED · RETRY 6"] sixth={"conn":"WS CLOSED · RETRY 6","connTitle":"연결 끊김 — 6번째 재연결을 기다리는 중(지수 백오프, 최대 30 s)","limitWords":[]}`
  · `Error: 6th tab explains the per-IP connection limit` · `qa-1462-ws-limit.json` · `qa-1462-sixth-tab.png`
- 의심 원인: `apps/web/lib/ws-protocol.ts:17-18,30-32`(1013 은 백오프 단계만 바꾸고 까닭을 남기지 않는다) · 서버 쪽 `apps/api/.../ws/WakelineWsHandler.java:74`(까닭 "connection limit").
- 재현 시험: `apps/web/e2e/qa/qa-1462-ws-connection-limit-no-reason.spec.ts` — 1 실패(전제 두 가지는 통과)

## QA-1463 · 낮음 · 화면(503 + Retry-After) — 공항 기상 이력 화면은 일시적 503 뒤 다시 부르지도, 다시 시도 단추를 주지도 않는다
- 환경: A1(공개 조회 허가 3) · `app/airports/[icao]/page.tsx`
- 재현 절차: `… npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1463` — 첫 `/api/v1/airports/RKSI/wx` 만 실제와 같은 503(`UNAVAILABLE` · `Retry-After: 2` · 본문은
  `pd_public_reads_threshold.py` 가 받은 것과 같음), 그 뒤는 실제 api. 실제 허가 고갈에서도 같은 화면(`demo-states.json` airport · `demo-states-503-airport.png`).
- 기대: 허가 고갈 503 은 '잠시 뒤 다시'(Retry-After 10)다 — 재생(`lib/replay.ts` ReplayLoader — "10초 뒤 다시 시도"로 한 번 다시 부름) · 통계('다시 시도' 단추)처럼
  다시 부르거나 단추를 준다.
- 실제: 12 s 동안 요청 1번, "기상 이력을 불러오지 못했습니다(HTTP 503)." + 요청 id 에서 멈춤, 단추 없음 — 페이지 전체를 새로 불러야 한다.
  (`/alerts/[id]` 의 같은 빈칸은 같은 QA 의 web-code QA-1301 표 — "다시 시도 모두 없음(429 · 503 도 같은 글)" — 에 있어 세지 않았다.)
- 증거: `evidence/public-demo/qa-1463-run.log` — `QA-1463 wxRequests=1 error="기상 이력을 불러오지 못했습니다(HTTP 503).\n요청 id\nqa1463…\n복사" retryButtons=[] recovered=false`
  · `Error: recovered after Retry-After, or offers a retry` · `qa-1463-airport-503.json` · `.png`
- 의심 원인: `apps/web/app/airports/[icao]/page.tsx:25`(useApiResource 의 `retry` 를 쓰지 않음 — 자동 · 단추 둘 다 없음) · 문구 `lib/format.ts:317 airportErrorText`
- 재현 시험: `apps/web/e2e/qa/qa-1463-airport-wx-503-no-retry.spec.ts` — 1 실패

## 확인했고 결함이 아닌 것
| 내용 | 결과 · 증거 |
|---|---|
| 공개 데모 메뉴 · 머리말 · 링크 | 40 화면 모두 운영 · 로그 메뉴 없음, 머리말 `demo`(HTML `non-commercial · <!-- -->demo`), 공개 화면의 `/logs` · `/ops` 링크 0(`demo-sweep-w*.json`) |
| 오류 경계 화면(공개 데모) | 운영 경로 대신 '운영자 시스템 로그', 보고 결과 `SENT_DEMO`, 요청 id 는 복사만. 스택은 브라우저 청크 경로뿐(서버 스택 · 비밀값 없음 — `demo-states-error-screen.png`) |
| 특보 수신 전 줄 | 공개 데모에서 `(운영 화면의 kma_warning)` 없이 나온다(`demo-states.json` states.warningsLine) |
| 앞단 잠금 · 오프라인 중 화면 이동 | RSC 요청이 401/503 을 받으면 전체 문서 요청으로 바뀌어 잠금 · 오프라인 화면이 그대로 뜬다(`demo-front.json` nav · navReqs) |
| 공개 조회 격벽 | 허가 3 · 대기 1 s · 문장 3 s 대로 503 + Retry-After 10, 실시간 경로는 막히지 않음, 잠금이 풀리면 바로 회복(`public-reads-threshold.json`) |
| IP 당 WS 상한 · 세션 새 키 제한 | 6번째 연결 1013, 한 세션 select 7번째부터 `limited`(`ws-demand-hog.log`) |
| `/api/v1/status` · `/api/v1/openapi` | 판 · 내부 호스트 · 망 · 비밀값 없음, 운영 경로 0. Host 위조는 edge 가 421 |

## 미확인(재현하지 못함 — 결함 수에 넣지 않음)
| 내용 | 까닭 |
|---|---|
| AWS 자료 규모(DB 약 219 MB)에서 익명 요청 몇 개로 공개 조회 허가 3 을 오래 잡을 수 있는가(느린 공개 조회 1개 ≥ 1.5 s 면 한 IP 의 분당 120 으로 허가를 늘 채움 → 다른 방문자의 모든 공개 조회 503) | fixture 규모에서는 동시 30 도 0.16 s 안 · 문턱에 닿지 않음. 큰 자료 · 느린 쿼리는 성능 단계(P · AWS 규모)의 몫 — 여기서는 잠금으로 '느린 DB'만 흉내 냈다 |
| 실제 Caddy · gate · CloudFront 를 거친 WS 업그레이드 실패 모양(401 → 1006)과 오프라인 HTML | A1 에 앞단 없음 — page.route · WebSocket 감싸기로 흉내만. AWS 리허설(R) 몫 |
| AWS 에서 `/api/v1/openapi` 의 `servers` 값 | Caddy 가 Host 를 `localhost` 로 바꾸므로 `http://localhost` 가 될 것으로 추정 — R 에서 확인할 일(개선 제안 4) |
| 통신사 CGNAT 뒤 방문자들이 IP 당 WS 5 · 분당 120 을 나눠 쓰는 정도 | 로컬로 재현할 수 없다 — QA-1462 의 화면만 재현 |

## 개선 제안(결함 수에 넣지 않음)
1. **수요 임대의 방문자 몫**(QA-1350 을 고칠 때): 핫 리전 순위에 IP(또는 세션 묶음)당 상한을 두거나 '세션 수' 대신 'IP 수'로 세기, 핫 리전에도 집중 추적처럼 시간 상한 —
   그리고 throttled 문구가 '공급자 호출 상한'과 '임대 상한(다른 방문자가 먼저 봄)'을 가르게.
2. **공개 조회 격벽의 IP 몫**: 허가 3 을 모든 공개 조회가 나눠 한 경로 · 한 IP 의 느린 조회가 다른 경로까지 503 으로 만든다(측정 — 다른 경로 5 중 4). 큰 자료에서 문턱을 재고(성능 단계),
   필요하면 IP 당 동시 공개 조회 1–2 로 묶는다.
3. **1013 · 1008 의 까닭을 화면에**(QA-1462): `close.reason` 을 상태 칩 title · 알림 패널에 싣고, 1013 "connection limit" 이면 '다른 탭 닫기'를 권한다. 공개 데모의
   `WS_MAX_CONN_PER_IP` 를 NAT 를 생각해 다시 정할지도 함께.
4. `/api/v1/openapi` 의 `servers` 를 공개 주소(`PUBLIC_ORIGIN`)로 고정하거나 빼기 — 앞단 뒤에서는 요청 Host 가 `localhost` 다.
5. 공개 데모에서 '공역 자료 없음 — 운영자가 가져오기 필요(make airspace-import)'(`lib/airspace.ts:203`) 같은 운영 명령 문구를 방문자 말로(지금 A1 · AWS 에서 보이지 않아 결함으로 세지 않음).

## 앞선 QA 와 같음(다시 결함으로 올리지 않음)
- 익명 `/ops` · `/logs` 의 `GET /api/v1/ops/session` 404 콘솔 줄(R-12 설계 — 앞선 QA · 같은 QA browser).
- `/guide` 의 운영 · 로그 절 · 스크린숏, `app/global-error.tsx` 의 로컬 문구 — ADR-039 '남는 것'.
- 상황판 가로 넘침(1440 · 375 · 320) — 같은 QA browser **QA-1420**. `/replay` 320 의 1 px — browser 와 같은 판단.
- 정지(오프라인) 중 상황판이 'WS closed · retry' · '연결 끊김'만 보임, REST 오프라인 HTML 503 의 "503 (HTTP 503)" — 같은 QA web-code **QA-1300 · QA-1302** 부류(브라우저 흉내로도 같은 모습).
- `/alerts/[id]` 의 실패 글(HTTP 상태 · 다시 시도 없음, 429 · 503 같은 글) — 같은 QA web-code **QA-1301**(실제 허가 고갈 503 에서도 같은 화면 — `demo-states-503-alert.png`).

## 더한 시험 코드 · 점검 스크립트(제품 코드는 고치지 않음)
- 재현(지금 실패): `apps/api/src/test/java/dev/wakeline/ws/Qa1350OneIpHoldsHotDemandCapTest.java` · `apps/web/e2e/qa/qa-1460-demo-about-points-to-ops-screen.spec.ts` ·
  `qa-1461-demo-stats-claims-0330-run.spec.ts` · `qa-1462-ws-connection-limit-no-reason.spec.ts` · `qa-1463-airport-wx-503-no-retry.spec.ts`
- 수집(통과): `apps/web/e2e/qa/qa-aws-demo-sweep.spec.ts` · `qa-aws-demo-states.spec.ts`(stats_daily 를 잠그는 단계가 있어 A1 전용) · `qa-aws-demo-front.spec.ts`
- 점검 스크립트: `tools/qa/pd_public_reads_threshold.py`(A1 · 8701 만) · `tools/qa/pd_ws_demand_hog.py`(수집기 venv — `uv run --offline python …`)
- 검사: `cd apps/web && npx tsc --noEmit -p . && npx eslint e2e/qa/qa-146*.spec.ts e2e/qa/qa-aws-demo-*.spec.ts` — 깨끗.
