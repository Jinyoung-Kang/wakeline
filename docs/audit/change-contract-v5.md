# 변경 계약 v5 — 단위 표기 · 선박 정보·추적 · 시스템 로그 · 신뢰성(2026-09-29)

사용자 요청: (1) 항공기 고도 m · 속도 km/h, 선박 속도 km/h 를 함께 표시 (2) VesselFinder 같은 선박 정보·추적(UI 는 따라 하지 않는다 — Palantir 풍, 시인성·명시성·가독성)
(3) 시스템 로그 메뉴 — 오류 전체 내용을 파악·복사하기 쉽게 (4) 시스템 아키텍처·신뢰성·성능 효율성·유연성·보안 개선.
컨테이너 추적은 **하지 않는다**: AIS 에 컨테이너 자료가 없고, 사용자가 넣은 Marinesia 키는 무료 등급(시간당 1회, 이력 403 · 프로필은 Ultimate)이며 컨테이너 기능이 없다.
Marinesia 는 **연동하지 않는다**(키는 `.env` 에 그대로, 어느 컨테이너에도 넣지 않는다).

## 0. 공통 원칙(모든 레인)
- 데이터 정직성: 모르는 값은 `—`/null. 단위 변환은 정의된 상수(1 ft = 0.3048 m, 1 kt = 1 kn = 1.852 km/h)로만 — 계산값이지만 추정이 아니다. 추정값(예측 고도 등)은 지금처럼 '추정' 표시를 유지한다.
- 새 외부 공급자 없음. 외부 호출은 collector·ais 만(ADR-006).
- 버그·보안 변경은 실패하는 시험 먼저. 커밋 제목에 이 계약의 절 번호(예: `v5-C4`)를 넣는다.
- UI: 기존 어두운 운영 화면 스타일(촘촘한 표, mono 수치, 상태 색)을 따른다. 참조 사이트의 모양은 따라 하지 않는다.

## A. 단위(웹 — 레인 web-units-ships)
- A1 `lib/format.ts` 에 변환·표기 도우미: `ftToM` · `ktToKmh` · `fpmToMs`, 그리고 두 단위 문자열
  - 고도: `FL340 · 10,363 m` / `12,000 ft · 3,658 m` / `GND` / `GND (1,200 ft · 366 m 보고)` / `—`. m 는 정수 반올림, en-US 천 단위 구분.
  - 지상속도: `460 kt · 852 km/h`(둘 다 정수). 수직속도: `+1,216 ft/min · +6.2 m/s`(부호 표시, m/s 소수 1자리, 0 은 부호 없음).
  - 선박 대지속력: `12.3 kn · 22.8 km/h`(둘 다 소수 1자리). 102.3(값 없음)은 이미 null 이다.
- A2 모든 항공기 고도·지상속도·수직속도 표시(카드 · 지도 툴팁 · 알림 목록 · 근거 카드 · SIGMET 안 항공기 목록 · 검색 결과 · 재생 상세·툴팁)와 선박 속력(카드 · 툴팁 · 목록)에 두 단위를 함께. 좁은 표 칸은 주 단위 아래 작은 회색 줄로 m·km/h 를 둔다.
- A3 지도 범례 고도 눈금에 m 를 함께(`10k ft · 3,048 m` …). SIGMET 고도대(`SFC – FL380`)는 항공기 고도가 아니므로 카드에서만 m 를 괄호로 덧붙인다.
- A4 시험: 변환 상수 정확값, 경계(0 · 음수 · null · FL 전환 18,000 ft), 각 표시 위치의 렌더.

## B. 선박 정보·추적(레인 api-ships · web-units-ships)
- B1 **선박 검색 API**(공개): `GET /api/v1/ships/search?q=&limit=`(limit 1–20, 기본 10). q 는 trim·대문자, 2–40자 `[A-Z0-9 .\-/]`(그 밖 400 `BAD_QUERY`).
  일치: 9자리 숫자 → MMSI 정확 일치, 3–8자리 숫자 → MMSI 앞부분, `IMO` 접두 또는 7자리 숫자 → IMO 정확, 그 밖 → 선명 앞부분·호출부호 앞부분.
  원천: 실시간 ShipStore(정적+동적) 먼저, 그다음 DB `ship` 표(실시간에 없는 선박). 응답 `{items:[{mmsi, name, call_sign, imo, ship_type, category, live, lat, lon, sog_kn, seen_at, last_position_at}], meta:{q, count}}` — 실시간이 아니면 위치·속력 null, `last_position_at` 은 DB 의 마지막 저장 시각.
  V10 마이그레이션: `ship` 의 `upper(name) text_pattern_ops` · `upper(call_sign) text_pattern_ops` · `imo` 인덱스(되돌리기 `DROP INDEX` — 머리 주석). REST 계약 검사에 표본 추가.
- B2 **격자 칸의 선종별 수**: `ships_grid` 칸 배열에 다섯 번째 원소로 선종별 수 배열을 붙인다 — `[lat, lon, count, "dominant", [n0..n10]]`, 순서는 웹 `SHIP_CATEGORIES`(cargo, tanker, passenger, fishing, tug, pleasure, hsc, special, military, other, unknown)와 Java `ShipCategory` 선언 순서가 같아야 한다(시험으로 고정). 웹은 네 원소 칸(구 서버)도 받는다.
- B3 웹:
  - 통합 검색(`/` 키): 항공기·선박 결과를 두 묶음으로(묶음 제목과 출처 표시). 선박 선택 → 지도 이동 + 카드 + 항적. 실시간이 아닌 선박은 "실시간 아님 · 마지막 저장 hh:mm" 과 함께 카드만(위치를 지어내지 않는다).
  - 선종 필터: 범례·레이어 패널의 선종 항목을 켜고 끄는 토글(표시 수 명시 — 예: "선종 필터 9/11"), 점 모드는 MapLibre filter, 격자 모드는 B2 선종별 수로 칸 수를 다시 셈(0 이면 칸을 그리지 않음). 설정은 브라우저에만 저장.
  - 선택한 선박: 격자 모드에서도 항상 그리고(선택 표시 고리 + 이름 또는 MMSI 라벨), 줌과 무관하게 라벨.
  - 항적: 기간 6 · 12 · 24 h 선택, 항적 점에 마우스를 올리면 시각(UTC — §G11 뒤 한국 표준시) · 속력(kn · km/h) · 침로 · 항해 상태. 속력·상태는 API `points[]` 값 그대로(없으면 `—`).
  - 카드: 처음 기록 · 마지막 저장 위치 시각 행 추가(API 가 이미 준다).
  - 선박 목록: 정렬 가능한 표(선종 색 · 선명 · MMSI · 속력 kn/km/h · 항해 상태 · 경과 시간), 검색 결과에도 같은 표.
- B4 하지 않는 것: 선박 사진·총톤수·건조 연도·선주·입출항 기록(AIS 에 없음), 기국(ITU MID 표가 저장소에 없음 — 다음 후보), 위험물 등급(선종 둘째 자리 — 공식 표 확인 전에는 표시하지 않음), 목적지 항구 좌표 표시(UN/LOCODE 좌표 추출은 다음 후보).

## C. 시스템 로그(레인 api-logs · collector-logs · infra-logs · web-logs)
- C1 **로그 항목**: `schemas/log_event.v1.json`(api 클래스패스 복사본 포함). Redis 스트림 `wakeline:logs`, 항목마다 필드 하나 `e` = JSON 문자열. 항목 하나의 직렬화 크기 상한 8 KiB — 넘으면 stack → exception.message → message 순으로 잘라 맞추고 잘린 곳에 `…(잘림 N자)` 를 붙인다.
- C2 **보내는 쪽**(api · collector · ais 모두 같은 규칙):
  - WARN · ERROR 만. 비밀값 가림(C5)을 거친 뒤 싣는다.
  - 지문 `fp` = SHA-256(서비스 + "\n" + 로거 + "\n" + 예외 종류 + "\n" + 메시지 틀)의 앞 16자리 16진. 메시지 틀 = 숫자열 → `#`, 16진 8자 이상 → `#`, 따옴표 안 문자열 → `'…'`. 서비스 안에서만 비교한다(언어 간 같을 필요 없음).
  - 같은 `fp` 는 10 s 에 1건만 보내고, 억제한 건수는 다음 항목의 `suppressed` 에.
  - 프로세스 안 대기열 500건 · 2 MiB 상한(넘으면 오래된 것부터 버리고 버린 수를 센다), 1 s 마다 또는 50건 모이면 `XADD wakeline:logs MAXLEN ~ 3000 * e <json>`.
    Redis 가 안 되면 대기열에 남겨 두고 1 → 30 s 지수 백오프로 다시 보낸다. 앱 스레드·이벤트 루프를 막지 않는다. 로그 싱크 자신의 오류는 싱크로 보내지 않는다(재귀 금지 — 표준 출력에만).
  - 자기 지표: api Micrometer `wakeline_log_events_total{result=sent|dropped|suppressed}`, collector·ais heartbeat/상태 해시에 `log_sent` · `log_dropped`. `GET /api/v1/ops/pipeline` 에 넣고 웹 pipeline 탭에 손실 행으로.
  - 예외 없는 WARN 은 exception null. `request_id` 는 api MDC 에서, 없으면 null. `context` 는 스레드 이름 외에 작업 이름 등(값 200자 · 20키 이하).
- C3 **Redis ACL**: collector·ais 사용자 키 패턴에 `~wakeline:logs` 만 더한다(XADD 는 이미 허용). api 는 이미 `~wakeline:*`. 정책 시험·ACL 동작 시험 갱신.
- C4 **api 조회**(운영 전용 — `/api/v1/ops/**` 규칙, 익명 404):
  - `GET /api/v1/ops/logs?service=&level=&q=&fp=&rid=&since=&until=&cursor=&limit=` — 최신 순, limit ≤ 200(기본 100), cursor = 마지막 항목 스트림 id. 필터는 XREVRANGE 를 끊어 읽으며 적용하되 한 요청이 훑는 항목은 3,000 이하(넘으면 `scan_truncated:true`). 응답 `{items:[{id, ...event}], next_cursor|null, scanned, scan_truncated}`.
  - `GET /api/v1/ops/logs/groups?since=&service=&level=` — fp 묶음: `{groups:[{fp, service, level, logger, exception_type, sample_message, count, suppressed, first_at, last_at, last_id}], scanned, scan_truncated}`(count = 항목 수, suppressed = 억제 합).
  - `GET /api/v1/ops/logs/{id}` — 항목 하나(트림돼 없으면 404).
  - 읽을 때 스키마 검증(맞지 않는 항목은 건너뛰고 `invalid` 수를 센다) + 한 번 더 가림(방어적).
- C5 **가림**: Java `LogMasker` 를 collector `masking.py` 와 같은 규칙으로 + 새 규칙 `[?&](key|apikey|access_key)=`(Python 도 추가). 언어 간 시험 벡터 `schemas/vectors/masking-cases.v1.json` 의 input → expected 가 두 언어에서 글자 하나까지 같아야 한다(pytest · JUnit). 설정 비밀값(DB · Redis 비밀번호 등)은 값으로도 가린다(6자 이상).
- C6 **브라우저 오류**(공개 수집): `POST /api/v1/client-errors` 본문 `{message ≤ 2000, stack ≤ 8000, path ≤ 300(경로만 — 쿼리 제거), component ≤ 200 | null, ts ISO}`. IP당 분당 10 · 전체 분당 120(Redis 제한기 새 키 `rl:cerr:*`), 8 KiB 넘으면 413, 형식 오류 400, 성공 204. `service:"web-client"`, `level:"ERROR"`, `untrusted:true`, User-Agent 앞 200자는 context 에. 쿠키 인증이 없으므로 CSRF 대상 아님.
- C7 **웹 `/logs`**(상단 메뉴 "로그", 운영 세션 필요 — 없으면 같은 자리에 로그인 폼):
  - 필터: 서비스(여러 개) · 수준 · 기간(1 h · 6 h · 24 h · 7 d) · 글자 검색 · 요청 id. 보기: 목록 / 묶음(fp). 자동 새로 고침 15 s — 새 항목은 "새 항목 N건" 단추로만 반영(보던 줄이 움직이지 않게).
  - 목록: 시각(UTC — §G10 뒤 한국 표준시) · 수준 배지 · 서비스 · 로거 · 메시지 첫 줄 · 억제 수 · 요청 id. 상세: 전체 메시지 · 예외 종류·메시지 · 스택(mono, 줄바꿈 전환) · context · 같은 fp 묶음 통계 · 같은 요청 id 의 다른 항목.
  - 복사: 항목 텍스트 · 항목 JSON · 묶음 전체 · 보이는 목록 전체(텍스트) · 내려받기 `.txt` · `.ndjson`(브라우저에서 만든다). 텍스트 형식은 사람이 읽고 붙여 넣기 좋게 — 첫 줄 `[시각 수준 서비스/로거] rid=…`, 그다음 메시지, 예외, 스택.
  - 탭 "AIS 수신 공백": 이미 있는 `GET /api/v1/ais/gaps` 를 표로(구역 · 시작 · 끝 · 길이 · 사유).
  - 키보드: ↑/↓ 이동, Enter 상세, `c` 텍스트 복사.
- C8 **웹 오류 처리**: `app/error.tsx` · `app/global-error.tsx`(읽기 쉬운 오류 화면 + 복사 + 다시 시도), `window.onerror` · `unhandledrejection` 수집 → C6(같은 메시지 60 s 에 1번, 페이지당 분당 5번 이하, `keepalive`). `ApiError` 가 problem+json 의 `code` · `request_id` 를 보존하고, 화면의 오류 문구에 요청 id 를 복사할 수 있게 보인다.
- C9 edge(nginx) 오류 로그는 이번 범위 밖(수집 에이전트 없음) — 화면에 "edge 로그는 컨테이너 표준 출력에만" 이라고 적는다.

## D. 신뢰성(레인 reliability)
- D1 **R-94 공급자 스위치의 원본을 DB 로**: V11 `provider_switch(provider text PK, disabled boolean NOT NULL, version int NOT NULL, updated_at timestamptz NOT NULL, updated_by int NULL REFERENCES ops_user(id))`, api 역할에 SELECT · INSERT · UPDATE 만 명시 GRANT(V9 기본 권한 없음 규칙).
  토글은 한 트랜잭션에서 감사 행 + DB 갱신, 커밋 뒤 Redis 미러. 60 s 마다(StartupMirror 와 같은 방식) DB → Redis 다시 미러 — collector 가 Redis 값을 바꿔도 1분 안에 돌아온다. DB 에 행이 없으면 지금 Redis 값을 한 번 옮겨 담는다(이관). 되돌리기 SQL 은 머리 주석.
- D2 **R-91 수집 실행 기록의 멱등**: V12 `ingest_run.run_key uuid NULL UNIQUE`. collector 는 실행마다 uuid 를 만들어 `INSERT … ON CONFLICT (run_key) DO NOTHING`(quality_event 는 같은 트랜잭션에서 run id 를 되찾아 연결). 커밋 뒤 시간 초과로 다시 시도해도 한 행만.
- D3 ADR-019 에 기록(원본의 위치 · 되돌리기).

## E. WS 계약(2차 — 레인 ws-contract, 위 레인을 합친 뒤)
- E1 R-76: `schemas/ws/server.v1.json`(메시지 17종 — type 으로 나뉜 oneOf) · `schemas/ws/client.v1.json`(10종). Java 시험이 실제 빌더로 만든 메시지를 검증하고, 그 표본을 웹 시험 fixture 로 저장한다.
- E2 R-93: 웹 `lib/ws-validate.ts` — 형태 검사(잘못된 원소는 버리고 수를 센다), `diff` 는 적용이 끝난 뒤에만 `lastSeq` 를 올리고, 처리 중 예외는 resync 요청 + C8 보고.
- E3 ADR-020.

## F. 마이그레이션 · ADR · 레인
| 번호 | 레인 | 내용 |
|---|---|---|
| V10 | api-ships | 선박 검색 인덱스 |
| V11 | reliability | provider_switch |
| V12 | reliability | ingest_run.run_key |
ADR-018(시스템 로그 경로) · ADR-019(공급자 스위치 원본 · 실행 기록 멱등) · ADR-020(WS 메시지 스키마).

| 레인 | 파일(주) |
|---|---|
| api-logs | apps/api …/logs/**(새 패키지) · LogMasker · client-errors 컨트롤러 · SecurityConfig(공개 경로 없음 — 기본 permitAll) · OpsPipelineController(로그 지표) · 시험 |
| collector-logs | apps/collector wakeline_collector/logsink.py(새) · masking.py(새 규칙) · main.py · ais/main.py · heartbeat/status 필드 · 시험 |
| infra-logs | infra/redis/start.sh · infra/tests(ACL 규칙·동작) |
| web-logs | apps/web app/logs/**(새) · components/logs/**(새) · Shell.tsx(메뉴) · lib/api.ts(ApiError) · lib/errorReport.ts(새) · app/error.tsx · app/global-error.tsx · lib/ops.ts(pipeline 행) · 시험 |
| web-units-ships | apps/web lib/format.ts · lib/ships.ts · lib/ship-layers.ts · lib/tooltip.ts · components(AircraftCard · ShipCard · AlertPanel · EvidenceCard · SigmetCard · AircraftSearch · MapLegend · LayerPanel · MapView) · app/replay/** · 시험 |
| api-ships | apps/api rest/ShipController(search) · ws/ShipGrid(B2) · persist(검색 질의) · V10 · 시험 · rest_contract_check 표본 |
| reliability | apps/api ops/OpsController · StartupMirror · V11 · V12 · apps/collector db.py · 시험 |

## G. 1차 구현 뒤 개정(2026-09-29)
- G1(§C3): collector · ais 키 권한은 `%W~wakeline:logs`(쓰기 전용) — 읽기(`XREVRANGE`)도 막는다(infra-logs 레인, 더 엄격). 남는 위험(ACL 로 막을 수 없음): 탈취된 collector·ais 는 `XADD … MAXLEN 0` 로 스트림을 비우거나 service 를 속일 수 있다 — start.sh 머리에 기록.
- G2(§C6): 브라우저 오류는 **별도 스트림** `wakeline:logs:client`(`MAXLEN ~ 1000`)에 싣는다. 익명 입력이 서버 오류(`wakeline:logs`)를 밀어내지 못하게(분당 120건이면 약 25분에 3,000건이 모두 바뀌었다). 조회 API 는 두 스트림을 id 순으로 합쳐 보여 주고 항목마다 `stream`(`server`|`client`)을 싣는다. `GET /ops/logs/{id}` 는 server → client 순으로 찾는다.
- G3(§C6): JSON 이 아닌 Content-Type 은 415(로그인과 같은 관례), 본문 형식 오류는 400 `BAD_CLIENT_ERROR`.
- G4(§B1): 저장만 된 선박(실시간 아님)에 `last_seen_at`(= `ship.last_seen`, 마지막으로 어떤 AIS 메시지든 받은 시각)을 싣는다 — 72 h 가 지나 위치가 없어도 "마지막 수신" 시각은 사실로 보일 수 있다.
- G5(§C8): 선박 카드 · 통합 검색 · 선박 항적 오류 문구에도 요청 id(복사 가능). 예외 종류가 빈 글이면 `—`.

## G. 2차 개정(2026-09-29 · 레인 followups-v5 · ws-contract 리뷰 뒤) — 구현이 §C4 · §G2 · §G4 · §E2 와 달라진 곳을 계약에 올린다
- G6(§C4 · §G2) **로그 조회 API** — §C4 의 cursor · 훑기 상한 문장을 대신한다:
  - 항목마다 `stream`(`server` | `client`). `next_cursor` = `"<stream>:<id>"` — 합친 순서(스트림 id, 같은 id 는 server 가 앞)에서 마지막으로 본 항목
    (쪽이 차면 마지막 항목, 훑기 상한에 걸리면 마지막으로 훑은 항목). 스트림 id 만 있는 cursor(§G2 전)는 `server` 의 것. 틀린 cursor 는 400 `BAD_CURSOR`.
  - `GET /api/v1/ops/logs/{id}?stream=server|client` — 주면 그 스트림에서만(두 스트림은 id 를 따로 매겨 같은 id 가 둘 다에 있을 수 있다), 그 밖 값은
    400 `BAD_STREAM`. 없으면 server → client 순.
  - `groups[]` 에 `last_stream`(`last_id` 가 어느 스트림의 id 인지).
  - 한 요청이 훑는 항목 상한 **4,200** = 스트림마다 MAXLEN + Redis 내부 노드 하나(stream-node-max-entries 기본 100): (3,000 + 100) + (1,000 + 100).
    근사 트림(`MAXLEN ~`)은 노드 통째로만 잘라 한 스트림에 MAXLEN + 99 건까지 남는다 — 한 번 훑기가 두 스트림 전체를 보고, 브라우저 오류 스트림
    (api 만 싣는다 — 1,099건 이하)이 가득이어도 서버 로그의 몫을 쓰지 못한다. 최악 비용: 가장 비싼 항목 4,200건을 묶음 + 목록으로 훑어 약 2.5 s
    (이 기계 · LogReaderTest — 시험은 20 s 미만만 확인한다, 웹은 15 s 마다 새로 읽는다). 웹 `LOG_SCAN_MAX` 가 같은 값을 보인다.
  - 첫 쪽(cursor 없음) · 묶음은 두 스트림의 한 시점 모습: Redis `TIME`(T)을 먼저 읽고 T 앞 밀리초까지만 보인다. T 뒤에 실린 항목은 모두 첫 쪽
    맨 위보다 새 것이라 "새 항목 N건"으로 보이고, 첫 쪽 · 새 항목 · cursor 로 이어 읽기를 합치면 빠지거나 겹치는 항목이 없다(T 의 밀리초 항목은
    다음 새로 고침에). 예외: 스트림 id 가 Redis 시계보다 60 s 넘게 앞서면(시계가 뒤로 감 · id 를 지정한 XADD) 자르지 않는다(WARN 로그) — 그동안
    새 오류를 숨기지 않는 쪽을 고른다(그때는 두 스트림 읽기 사이의 경합을 막지 못한다).
- G7(§G4) **`last_seen_at`** = `ship.last_seen` 과 저장된 마지막 위치 시각 중 늦은 것(검색 · 상세 모두, 저장만 된 선박만 — 실시간 선박은 검색에서 null · 상세에서 키 없음,
  마지막 수신은 `seen_at` · `state.seen_at`). `ship.last_seen` 은 위치로는 10분에 한 번만 넓히므로(ShipWriter — 쓰기 증폭 방지) 그대로 보이면 "마지막 저장 위치"보다 이른
  "마지막 수신"이 나올 수 있다. 두 값 모두 받은 AIS 보고의 실제 시각이다(추정이 아니다). REST 계약 검사: `last_seen_at` ≥ `last_position_at`.
- G8(§E2 · 레인 ws-contract 2차 리뷰): 버린 메시지의 복구는 종류마다 — 항공기 · 선박 흐름은 `resync`, 알림 · SIGMET · 레이더는 클라이언트 메시지 `{type:"resync", scope:"alerts"|"sigmets"|"radar"}`
  (client.v1.json 에 선택 키 scope 추가 · 서버는 그 목록만 버전과 무관하게 전체로 · 모르는 scope 는 BAD_RESYNC), status · selected · demand 는 다음 갱신. 알림 배치 버전 틈도 잃은 것으로 보고,
  전체 목록을 받을 때까지 알림 수는 "—". 웹 검증기는 스키마의 잎 제약마다 시험한다(ADR-020).

## G. 3차 개정(2026-09-29 · 레인 logs-trailing) — 억제 수가 프로세스 메모리에 남던 곳
- G9(§C2 · ADR-018) **뒤늦게 싣기(trailing flush)** — §C2 "억제한 건수는 다음 항목의 `suppressed` 에" 에 보탠다(api · collector · ais 같은 규칙):
  - 문제: 같은 `fp` 가 창(10 s) 안에서 억제되고 그 뒤 같은 `fp` 가 다시 오지 않으면 억제 수가 프로세스 메모리에만 남았다 — 두 번 난 오류가 `/logs` 묶음에
    "항목 1 · 억제 합 0" 으로 보이고, 자기 지표(`log_suppressed`)에만 흔적이 있었다.
  - 규칙: 억제 중인 발생 k(> 0)건이 있고 창이 닫힌(지금 − 창의 시작 ≥ 10 s) `fp` 는 보내는 쪽의 주기(1 s — 기존 전송 루프, 새 스레드 없이) 확인에서
    **마지막 억제 발생 하나**를 항목으로 싣는다: 그 발생의 `ts` · 메시지 · 예외 · 스레드 · `request_id` · `context`(발생 때 정해진 값 — 보낼 때 만든 값이 아니다),
    `suppressed = k − 1`. 그 `fp` 의 창은 그때 다시 시작한다(억제 수 0). 주기 전에 같은 `fp` 의 다음 발생이 오면 전처럼 그 항목이 k 를 싣는다.
  - 순서 · 시계: 한 주기에 뒤늦게 실을 `fp` 가 여럿이면 창을 시작한 순서(오래된 것부터 — 항목 · 뒤늦게 싣기로 창이 다시 시작한 `fp` 는 맨 뒤)로 싣는다.
    창은 단조 시계로 잰다(api `System.nanoTime` · collector·ais `time.monotonic` — 벽시계가 뒤로 가도 창이 늘지 않는다). 항목의 `ts` 는 발생 시각(벽시계) 그대로.
  - 불변식: 한 `fp` 의 어떤 발생 순서든, 모든 창이 닫히고 대기열을 보낸 뒤(버림이 없으면) 항목 수 + `suppressed` 합 = 발생 수. 마지막 발생은 늘 제 항목이다
    (묶음의 `last_at` = 마지막 발생 시각).
  - 종료(api `SmartLifecycle.stop` · collector·ais `aclose`): 억제 중인 발생을 창과 무관하게 싣고 나서 마지막 보내기 — 둘 다 기존 마감(api 2 s · collector·ais 0.5 s) 안.
  - 메모리: 억제 중인 발생은 `fp` 마다 하나(마지막)만 붙잡는다 — 지문 표 상한(api 2,000 · collector·ais 1,000)은 그대로. 붙잡는 시간은 창 + 주기(약 11 s,
    Redis 장애 백오프 중에는 다음 시도까지 최대 30 s 더). collector·ais 는 레코드의 얕은 복사(예외가 있으면 트레이스백도 — 예외 메시지 · 트레이스백 글은 붙잡을 때
    정한다)를, api 는 항목을 만드는 body(logback 이벤트 — 스레드 이름 · MDC 를 발생 스레드에서 미리 정한 것, 예외 메시지는 이벤트를 만들 때 정해진 것, 브라우저 오류는
    받은 값)를 붙잡는다. 스택 가림 · 직렬화는 전처럼 싣기로 정한 뒤에만 한다.
  - 지문 표가 가득일 때: 억제 중인 발생이 없는 `fp` 부터 잊는다(창 안이어도 — 잃는 발생이 없다). 모든 `fp` 에 억제 중인 발생이 있을 때만 가장 오래전에 창을 시작한
    `fp` 를 잊고 그 k건을 버림(`result=dropped` · `log_dropped`)으로 센다. 뒤늦게 실을 항목을 만들지 못하거나(collector·ais 는 8 KiB 에 맞추지 못함 · 예외, api 는 예외 · `Error` — api 는 8 KiB 에 맞게 잘라 크기로는 실패하지 않는다) 종료 마감을 넘기면
    그 k건도 버림 — 같은 주기의 다른 `fp` 는 그대로 싣고, 보내는 스레드는 멈추지 않는다(api 는 XADD 의 `Error` 도 실패로 보고 묶음을 대기열에 되돌린다).
    api 도 창을 연 항목을 만들지 못하면(직렬화 예외) collector·ais 처럼 창을 닫고 억제 수를 되돌린 뒤 그 발생을 버림 1로 센다.
  - 지표: 억제(api `wakeline_log_events_total{result=suppressed}` · collector·ais `log_suppressed`)는 **항목의 `suppressed` 로 실린 수** — 항목을 만들 때 센다
    (억제 중인 발생은 아직 세지 않는다). 발생마다 보냄 · 버림 · 억제 중 한 번만 센다(대기열 · 창 안에서 기다리는 것 제외). 전에는 억제하는 순간에 셌다 — 폭주의
    마지막 발생은 이제 보냄으로 센다.
  - 표시: 뒤늦게 실은 항목의 `ts` 는 그 발생의 시각이라 실린 시각(스트림 id)보다 최대 약 11 s(백오프 중이면 더) 이르다 — 목록(스트림 id 순)에서 가까운 다른
    `fp` 의 항목과 순서가 바뀌어 보일 수 있다. 조회의 `since` 경계(§C4 — ts 는 스트림 id 보다 늦지 않다)는 그대로 맞다. 웹 pipeline 탭의 억제 · 버림 설명을 고쳤다.
  - 언어 간 시험 벡터 `schemas/vectors/log-suppression.v1.json`(발생 · 주기 · 종료 단계, 단계마다 대기열에 넣은 항목 `[발생 번호, suppressed]` · 누계, 마지막은 종료):
    api `LogSinkTest` 와 collector `test_logsink.py` 가 같은 파일을 읽고, `tools/contract_check.py` 가 파일이 있는지와 모양(단계 누계 · 종료 뒤 불변식)을 본다.
    두 언어 모두 무작위 발생 순서로 불변식을 시험하고, `LogsIT` 가 창 안에서 두 번 난 경고 → 묶음 "항목 2 · 억제 합 0" 을 끝에서 끝까지 본다.

## G. 4차 개정(2026-09-29 · 레인 web-kst · 사용자 요청) — 운영 · 로그 화면의 시각을 한국 표준시로
- G10(§C7 · §C8) 사용자 요청 "[운영]과 [로그] 메뉴에 표시되는 시각을 한국 시각으로" — §C7 목록의 "시각(UTC)" 을 대신한다. API · 저장 · 스트림은 모두 UTC 그대로이고 웹 표시만 바꾼다.
  - 범위: 웹 `/ops`(모든 탭) · `/logs`(목록 · 상세 · 묶음 · AIS 수신 공백 탭) · 오류 화면(`ErrorScreen` — `app/error.tsx` · `app/global-error.tsx` 가 쓰므로 모든 경로에서 KST).
    항공 자료 화면(상황판 · 재생 · 통계 · 공항)은 UTC 그대로(이번 요청의 범위 밖) — §G11 이 이 문장을 대신한다(그 화면들도 KST).
  - 표시: 한국 표준시 +09:00 고정(`lib/kst.ts` — 1988년 뒤로 일광 절약이 없고, 시험이 2000–2040 을 tz 데이터베이스 Asia/Seoul 과 대조한다). 표 칸 `MM-DD HH:MM:SS`(머리글 "(KST)"),
    머리글이 없는 자리 `… KST`, `/logs` 목록은 ms 까지. 원본 UTC 는 툴팁("원본 UTC …"). `/logs` 상세 · 오류 화면은 KST 와 UTC 를 나란히.
  - 복사: 항목 텍스트 · 보이는 목록 · `.txt` · 묶음 전체 · 오류 화면 복사의 머리 줄 시각 = ISO 8601 `…+09:00`(ms 유지). 내려받기 파일 이름 `wakeline-logs-YYYYMMDDTHHMMSS+0900.<ext>`.
  - 바꾸지 않는 것: `.ndjson` · 항목 JSON 복사는 api 가 준 그대로(`ts` 는 UTC). `/ops` 의 원본 칸(격리 detail · DLQ payload head)도 글자 그대로 — 머리글 "(raw · UTC)".
    일 단위 집계(예산 · 격리 수)의 `day` 는 수집기가 UTC 날짜로 센다(budget.py `day_key` · db.py) — "day (UTC)", KST 09:00 에 날짜가 바뀐다.
  - 함께 고친 것: 값을 모르면 "—" 만 — 단위가 붙은 "— ms"(지연) · "—건"(묶음 항목 수)으로 보이지 않는다. `/ops` 공급자 표의 "budget used" 는 마지막으로 성공한 수집 때 센 값이다
    (collector `status.py` success() 만 쓴다 — 실패만 이어지는 공급자는 이전 UTC 날짜의 값이 남는다) — 툴팁이 "지금 날짜의 호출 수" 라고 말하지 않는다.

## G. 5차 개정(2026-09-29 · 레인 web-dashboard-kst · api-stream-window · collector-headroom · 사용자 요청 "상황판도 KST로 바꿔") — 모든 화면 한국 표준시 · 스트림 보존 창
- G11(§G10 · §B3) **항공 자료 화면(상황판 · 재생 · 통계 · 공항)도 한국 표준시** — §G10 의 "항공 자료 화면은 UTC 그대로" 와 §B3 의 "항적 점 … 시각(UTC)" 를 대신한다.
  API · 저장 · 스트림은 UTC 그대로이고 웹 표시만 바꾼다. 오프셋 +09:00 고정(`lib/kst.ts`)과 표 칸 · 머리글 규칙은 §G10 과 같다.
  - 상황판: 상태 바(지역 수집 `HH:MM:SS KST`) · 알림 배너 · 근거 카드 · SIGMET 카드 · 목록 · 기상청 패널 · 레이더 타임라인(RainViewer 프레임도 `MM-DD HH:MM KST`) ·
    항공기 · 노선 · 선박 카드 · 선박 표 · 통합 검색 · WS 형식 오류 상세 · 지도 툴팁(SIGMET 유효 · 공항 METAR · 선박 항적 점 `TIME`) · AIS 공백 배지(`hh:mm– KST`) ·
    항적 공백 라벨(`hh:mm–hh:mm KST`) · 집중 추적 칩. 머리글이 없는 자리는 ` KST` 를 붙이고, 구간은 끝에 한 번(`… – … KST`), 모르면 `—` 만(시간대 글자도 붙이지 않는다).
    날짜를 빼는 자리(`HH:MM KST` — 실시간 아닌 선박의 마지막 수신 · 저장)는 지금과 같은 **KST** 날짜일 때만.
  - 원본 UTC: 카드 · 표 · 목록 · 상태 바의 KST 시각은 title 에 `원본 UTC <ISO …Z>`(구간은 `원본 UTC a – b`, 시각이 title 에만 있는 자리는 `… KST · 원본 UTC …`) — §G13 이 대신한다(UTC 를 보이는 글자에 함께, title 에는 원본 ISO 그대로).
    예외 — 지도 툴팁 · 지도 선 라벨 안의 시각(툴팁 안에 또 툴팁을 둘 수 없어 KST 만)과 기상청 레이더 tm(기상청이 준 KST 그대로 — 원본이 KST, 툴팁이 그렇게 말한다).
    `/about` 에 같은 문장이 있다.
  - 재생: 날짜 · 시각 입력(datetime-local, 이름 `재생 시각(KST)`)은 KST 로 읽고 쓴다 — 벽시계 값 − 9 h, 없는 날짜 · 24시 · 형식 오류는 다른 날로 옮기지 않고 받지 않는다.
    보이는 재생 시각 `YYYY-MM-DD HH:MM:SS KST` · 그린 프레임 · 기록 시각 · 레이더 · SIGMET 유효도 KST. api 요청의 `at` 은 그 순간의 UTC ISO(`…Z`) 그대로(`/api/v1/replay?at=` — 계약은 UTC).
  - 통계: 집계 날짜는 UTC 날짜 그대로 — 날짜 고르기 `집계 날짜(UTC 날짜)` · 알림 표 `날짜(UTC 날짜)`(ADR-017 R-45, KST 09:00 에 날짜가 바뀐다 — KST 날짜로 옮기지 않는다).
    시간대별 막대는 그 UTC 날짜의 시간 순서(UTC 00 → 23시) 그대로 두고 라벨만 KST 시(09 … 23, 00 … 08 — 00 부터는 다음 KST 날), 설명 줄
    `UTC 날짜 D = KST MM-DD 09:00 – MM-DD 08:59`(§G13 이 대신한다 — 눈금 아랫줄에 UTC 시, 설명 줄도 두 시간대). 집계 시각 `매일 12:30 KST`(api cron 03:30 UTC).
  - 공항: METAR 관측 시각 · 이력 표 `obs (KST)` · 공항 카드 관측 · 수신.
  - 원문: METAR · TAF · SIGMET 원문은 발표된 그대로(안의 `…Z` 는 UTC) — 보이는 이름표 `(원문 · UTC)`(공항 카드 · 공항 화면 · SIGMET 카드 · 재생 상세). 툴팁만으로 두지 않는다.
  - 선박 ETA(계약 v2 §B4 — 선원 입력 월 · 일 · 시 · 분, UTC, 연도 없음): KST 로 바꿔 입력값과 함께 `MM-DD HH:MM KST · 선원 입력 MM-DD HH:MM UTC · 연도 없음`.
    +9 h 로 날이 넘어가면 그 달의 가장 긴 날 수로 넘기고(2월은 29일까지 입력을 받는다), 2월 28일 15:00 UTC 이후는 연도(윤년)를 몰라
    `02-29 또는 03-01 HH:MM KST(연도 없어 윤년 모름)` 로 둘 다 적는다(고르지 않는다). 달력에 없는 날(04-31 등)은 바꾸지 않고 입력값(UTC)만.
  - 바꾸지 않는 것: API · 저장 · 스트림 · 복사한 JSON(`ts` UTC) · 통계의 날짜 · 원문. 로그 화면 · 운영 화면은 §G10 그대로.
  - 회귀 막기: `tests/kst-dashboard.test.ts` 가 app/ · components/ · lib/ 에서 UTC 시각 글자를 만드는 모양(`}Z` 템플릿 · getUTC* 로 hh:mm · ISO 자르기)을 찾으면,
    `tests/kst-utc-hover.test.ts` 가 마운트한 카드에서 원본 UTC 툴팁이 없는 hh:mm 을 찾으면, `tests/docs-contract-g11.test.ts` 가 이 절과 README 가 동작과 어긋나면 실패한다.
- G12(§C2 · R-14 · ADR-011 '수집기 여유 보강') **스트림 보존 창 필드 계약**(collector-headroom · api-stream-window · web-dashboard-kst) — 바이트 예산 트림은 손실이 아니다:
  되읽기 창(api 가 멈췄다 돌아와 다시 읽을 수 있는 구간)을 줄일 뿐이고, 손실은 읽히기 전에 잘린 경우뿐이다(api `stream_trim_loss_events`).
  - 수집기 상태 해시: `wakeline:collector` 에 `stream_retention_s`(항공기 스트림 시간 트림 목표, 정수 초) · `stream_budget_bytes`(항공기 스트림 바이트 예산),
    `wakeline:ais:status` 에 선박 스트림의 같은 두 필드. 값은 그 프로세스의 `StreamTrim` 이 실제로 거는 설정(고른 값 — 잰 값이 아니다), 정수 문자열, 모르면 빈 값.
    고른 값: 목표 2.5 h(9,000 s) · 예산 항공기 80 MiB · 선박 32 MiB(ADR-011 — 선박 16 → 32 MiB).
  - `GET /api/v1/ops/pipeline`: `collector.stream_retention_s` · `collector.stream_budget_bytes` · `ais.stream_retention_s` · `ais.stream_budget_bytes`(해시 값, 다른 필드와 같은
    신선도 규칙 — collector heartbeat 120 s · ais `updated_at` 30 s 보다 오래됐거나 형식이 틀리면 null) · `api.stream_window_s.aircraft` · `api.stream_window_s.ships`
    (초, 0.1 s 반올림 = 요청 시각 − 30 s 스트림 지표가 XINFO STREAM 으로 기억한 첫 항목 id 의 시각 — **잰 값**. 스트림 없음 · 비었음 · Redis 오류 · 측정 전 · 측정이
    120 s 보다 오래됨 · 첫 항목이 60 s 넘게 미래면 null — 0 이나 지난 값으로 채우지 않는다). Micrometer `wakeline_stream_window_seconds{stream}`(모르면 NaN).
  - 웹 `/ops` PIPELINE 행 `stream_window_s.aircraft`(collector 묶음) · `stream_window_s.ships`(ais 묶음): 값 칸 = 창(1 h 미만 `30 min` — 분 정수, 그 이상 `1.7 h` — 소수 1자리,
    모르면 `—` 만) · `목표 2.5 h — 수집기 설정`(목표를 모르면 `목표 —`) · 상태 글자. 툴팁에 창의 뜻 · 목표 · 바이트 예산(MiB, 수집기 설정) · 판정 규칙.
  - 판정(창 w · 목표 t · 그 스트림의 `stream_budget_trims` n): w 나 t 를 모르면 판정하지 않는다(tone `muted`, 상태 없음) · w ≥ t → `ok` ·
    w < t 이고 n 을 모름 → `muted` `원인 모름(예산 트림 수 모름)`(원인을 지어내지 않는다) · w < t 이고 n > 0 → w < t − 10분이면 `warn`(주황) `예산 때문에 짧아짐`,
    아니면 `ok`(시간 트림 `MINID ~` 은 대략이라 조금 짧은 것은 정상 — 웹 `STREAM_WINDOW_SLACK_S`) · w < t 이고 n = 0 → `muted` `채우는 중`(기동 직후 등).
  - `stream_budget_trims`(collector · ais)는 손실(loss)이 아니라 누계(count)로 보인다 — 빨간색이 아니고, pipeline 탭의 빨간 배지는 손실(loss) 지표만 센다.
    탭 설명: 빨간 값 = 0 이 아닌 손실 지표 · 주황 = 예산 때문에 짧아진 스트림 보존 창(손실 아님).

## G. 6차 개정(2026-09-29 · 레인 web-core-v6 · 사용자 요청 "상황판·재생·통계·공항 화면을 포함한 필요한 메뉴에 UTC 와 KST 함께 표시")
- G13(§G10 · §G11) **KST 를 먼저, 같은 순간의 UTC 를 함께** — §G10 · §G11 의 "화면은 KST 만, 원본 UTC 는 툴팁" 과 §G11 의 예외(지도 툴팁 · 선 라벨 · 기상청 tm 은 KST 만)를 대신한다. **§G20(2026-09-30 사용자 결정 — 화면은 KST 만, UTC 는 지운다)이 이 절의 두 시간대 표시를 대신한다.**
  API · 저장 · 스트림은 UTC 그대로이고 웹 표시만 바꾼다. 오프셋 +09:00 고정(`lib/kst.ts`).
  - 한 곳: `lib/time.ts`(글자) · `components/DualTime.tsx`(그리기 — KST 는 보통 글자, UTC 는 흐리게, `<time dateTime>` 에 그 순간, title 에 원본 UTC ISO).
    화면 코드는 시각 글자를 직접 만들지 않는다 — `tests/kst-dashboard.test.ts` 가 lib/time · lib/kst 밖의 모양(`…Z` 템플릿 · getUTC* · toISOString 자르기 ·
    `isoKst(` · `${…} KST` / `${…}시 KST` / `${…} UTC` 템플릿)을 찾는다. 예외는 아래 "바꾸지 않는 것" 중 글자를 직접 만드는 곳뿐이고 시험에 파일 · 줄 수까지 적혀 있다:
    복사 · 내려받기 형식(`lib/log-line.ts` · `lib/logs.ts`), 오류 화면 시각 칸(`components/logs/ErrorScreen.tsx`), 선박 ETA(`lib/ships.ts`),
    재생 날짜 · 시각 입력 값(`lib/replay.ts` `toKstInput` — 보이는 글자가 아니라 datetime-local 값).
  - 범위: 모든 화면 — 상황판(상태 바 · 알림 · 카드 · 목록 · 지도 툴팁 · 선 라벨 · 레이더 타임라인 · 기상청 패널) · 재생 · 통계 · 공항 · 운영 · 로그 · 오류 화면.
  - 형식:
    - inline `09-29 14:02:54 KST · 05:02:54 UTC` · 날짜가 자명한 자리(방금 받은 응답의 갱신 시각) `14:02:54 KST · 05:02:54 UTC` · 재생 시각은 연도까지.
    - compact(상태 바 · 지도 툴팁 · 지도 선 라벨 · AIS 공백 배지) `14:02 KST · 05:02Z`, hh:mm 구간 `08:40–08:45 KST · 23:40–23:45Z`, 끝이 없는 구간 `… KST · …Z 부터`.
    - 표 칸: 첫 줄 KST `09-29 14:02:54`, 둘째 줄 흐린 `05:02:54 UTC` — 칸이 넓어지지 않게, 머리글 `(KST · UTC)`(화면 읽기 프로그램에는 "… KST · … UTC").
    - 통계 시간대별 막대(UTC 날짜 하루, 막대 순서 UTC 00 → 23시): 눈금 윗줄 KST 시 `09`, 아랫줄 흐린 같은 순간의 UTC 시 `00Z`(툴팁 · 화면 읽기 표 `09-28 09시 KST · 00시 UTC`),
      설명 줄 `UTC 날짜 2026-09-28 = 09-28 09:00 – 09-29 08:59 KST · 09-28 00:00 – 09-28 23:59 UTC`(`lib/time` `utcDayHours` · `fmtUtcDayDual`).
    - 구간: 쪽마다 끝에 한 번 `… – … KST · … – … UTC`. 한쪽을 모르면 아는 쪽만 두 시간대(`… KST · … UTC – —`), 모두 모르면 `— – —`.
    - UTC 날짜가 KST 날짜와 다르면(KST 00:00–08:59) UTC 쪽에 날짜: `08:41:14 KST · 09-28 23:41:14 UTC`. 구간은 한쪽이라도 다르면 양쪽에.
    - 모르면 `—` 만(시간대 글자도 붙이지 않는다).
    - 기상청 레이더 tm 은 기상청이 준 KST 이고 UTC 는 그 값에서 계산한다(−9 h, 원문 tm 은 기상청 패널에 그대로).
  - 바꾸지 않는 것: METAR · TAF · SIGMET 원문(`(원문 · UTC)` 표기) · 통계의 날짜(UTC 날짜로 집계 — `(UTC 날짜)` 표기) · 선박 ETA(선원 입력 UTC 를 KST 로 바꿔 입력값과 함께 — 이미 두 시간대) ·
    복사 · 내려받기 형식(텍스트 머리 줄 ISO `+09:00`, 항목 JSON · `.ndjson` 의 UTC `ts`) · 로그 상세 · 오류 화면의 시각 칸(KST ISO 와 원본 UTC ISO 를 나란히 — 이미 두 시간대).
  - 성능: 형식기는 Intl 을 쓰지 않는 고정 오프셋 산술이고(형식기 생성 비용 · ICU 차이 없음), 같은 입력의 분해 결과를 작은 캐시(2,048개, 차면 비움)에 둔다 — 표가 매초 같은 시각을 다시 그린다.
  - 회귀 막기: `tests/dual-time.test.ts`(형식 · 모름 · 캐시 · 컴포넌트) · `tests/helpers/dual-time.ts` 의 짝 검사(화면 글자에서 KST 시각마다 UTC 짝) — 상황판 · 운영 · 공항 · 통계 · 재생 시험이 쓴다.

## G. 7차 개정(2026-09-29 · 레인 api-resolve · 사용자 요청 "해결 완료된 [운영/로그] 메뉴에 있는 error 는 지우는 기능") — 해결 표시: 지우지 않고 가린다
- G14(§C4 · §C7 · §D · ADR-024) **해결 표시** — 운영자가 로그 묶음(fp) · 공급자 오류를 "upto 까지 해결됨" 으로 적고, 조회가 그 이하를 가린다.
  **증거는 지우지 않는다**: 로그 스트림(`wakeline:logs` · `wakeline:logs:client`) · `ingest_run` · 공급자 해시(`wakeline:provider:{name}`)는 그대로이고
  지금처럼 나이 들어 사라진다(스트림 MAXLEN · 보존 정리 · 다음 실패가 덮어씀). 가린 것은 `resolved=show` 로 언제든 다시 본다.
  - 원본 **V13** `ops_resolution(id bigserial PK, kind text CHECK IN ('log_group','provider_error'), key text NOT NULL, upto timestamptz NOT NULL,
    resolved_at timestamptz NOT NULL DEFAULT now(), resolved_by text NOT NULL, note text(≤ 200자), revoked_at timestamptz NULL, revoked_by text NULL)`.
    더한 제약: `log_group` 의 key 는 fp 모양(`^[0-9a-f]{16}$`) · key 1–64자 · resolved_by 빈 글 아님 · revoked_at 과 revoked_by 는 함께. 부분 인덱스
    `ops_resolution_active (kind, key) WHERE revoked_at IS NULL`. 권한(V9 뒤 명시 GRANT): api 는 SELECT · INSERT 와 **`revoked_at` · `revoked_by` 열의 UPDATE 만**
    (지우지 않고, 이미 적은 kind · key · upto · 메모 · 사람은 고치지 못한다 — 감사와 같은 증거) · 시퀀스 USAGE, collector 는 없음. 되돌리기 SQL 은 머리 주석
    (`DROP TABLE ops_resolution` + 이력 행 — 가림이 없어져 모든 오류가 다시 보인다, 감사 행은 남는다).
  - `POST /api/v1/ops/resolutions` 본문 `{"kind","key","upto"?,"note"?}`(JSON 만 — 그 밖 415) → **201** `{"id","kind","key","upto","resolved_at","resolved_by","note"}`
    (note 가 없으면 명시적 null, resolved_by = 운영자 이름). 운영 세션 + CSRF(다른 운영 쓰기와 같다 — 익명 쓰기는 CSRF 가 먼저라 403, CSRF 쌍을 갖춘 익명은 404).
    본문 규칙(틀리면 400 problem+json `BAD_RESOLUTION`): 모르는 필드 · 같은 키 두 번 · JSON 아님 · 4,096자 초과는 틀림(오타가 조용히 기본값 — "지금까지 모두" — 이
    되지 않게) · kind 는 두 값 · key 는 kind 에 맞게(fp 16자리 소문자 16진 | 운영 공급자 이름 `StatusService.PROVIDERS`, 앞뒤 공백도 틀림) · upto 는 시간대가 있는
    ISO 시각(없거나 null 이면 api 의 지금), **미래는 틀림** · 2000-01-01 이전은 틀림 · μs 로 자른다(DB 정밀도 — 발생 ts 는 μs 이하라 자르면서 덮던 발생을 놓치지
    않는다) · note 는 앞뒤 공백을 뗀 200 글자(코드 포인트) 이하 한 줄(제어 문자 없음), 빈 글이면 null.
    웹은 upto 를 보내지 않거나(지금) 항목 · 묶음의 `ts` · `last_at`(서버 시계)을 보낸다 — 브라우저 시계로 만든 시각은 미래일 수 있다.
  - `GET /api/v1/ops/resolutions` → `{"items":[활성 해결, 최신 순(resolved_at, id 내림차순)], "resolution_state"}`. 해결 기록을 한 번도 읽지 못했으면
    503 `UNAVAILABLE` + `Retry-After: 30`(다시 읽는 간격 — 실패한 읽기는 그동안 캐시되므로 §2 의 기본 10 s 뒤 재시도는 같은 503 을 받는다)(빈 목록으로 "해결 없음" 을
    지어내지 않는다).
  - `DELETE /api/v1/ops/resolutions/{id}` → **204**(revoked_at = now() · revoked_by = 운영자, 행은 남는다). 없는 id · 이미 되돌린 행은 404(두 요청이 겹쳐도 한 번만).
  - 감사: `RESOLVE`(target `kind:key`, before null, after = 행) · `UNRESOLVE`(target `kind:key`, before = 행, after `{id, revoked_at, revoked_by}`) —
    **행과 같은 트랜잭션**(감사가 실패하면 해결 · 되돌림도 없다. OpsResolutionsIT 가 두 행의 xmin 이 같음을 본다).
  - 뜻: 항목(발생)은 그 key 의 **유효 해결**의 upto ≥ 발생 시각이면 해결됨이다. 유효 해결 = 그 kind · key 의 활성 행 중 upto 가 가장 늦은 행(같으면 id 가 큰 행) —
    같은 key 에 활성 행이 여럿일 수 있고, 가장 최근 해결을 되돌리면 앞선 해결의 범위로 돌아간다(그 사이의 발생만 다시 보인다). **upto 뒤의 새 발생은 해결되지 않은
    것**으로 다시 보인다(재발을 숨기지 않는다).
  - 로그: `GET /api/v1/ops/logs` · `/ops/logs/groups` 에 `resolved=hide|show`(기본 hide, 대소문자 · 앞뒤 공백 무시, 그 밖 400 `BAD_RESOLVED`).
    - 목록 항목마다 `"resolved": {"id","upto","resolved_by"} | null`(키는 늘 있다). hide 면 해결된 항목은 빠지고 응답 `"hidden_resolved"` = 이 쪽을 훑으며 가린 수
      (다른 필터에 맞은 것만) — 가린 항목은 쪽 크기(limit)를 쓰지 않고 훑은 수(`scanned`)에는 든다(훑기 상한 4,200 은 그대로).
    - 묶음은 보이는 항목만 센다(hide 면 재발한 묶음은 upto 뒤의 항목만 — count · first_at · suppressed, 모두 해결된 묶음은 없다). 묶음의 `resolved` = 그 묶음의
      **모든** 항목이 해결됐을 때 그 해결, 아니면 null(hide 면 늘 null). 맨 위 항목 하나로 정하지 않는다 — 뒤늦게 실린 항목(§G9)은 스트림 순서와 ts 가 다를 수 있다.
    - `GET /api/v1/ops/logs/{id}` 는 해결 여부와 무관하게 항목을 돌려주고 `resolved` 를 싣는다.
    - 목록 · 묶음 응답에 `"resolution_state"`: `ok`(DB 에서 읽은 해결) · `stale`(DB 를 읽지 못해 마지막으로 읽은 해결로 가림) · `unavailable`(한 번도 읽지 못함 —
      아무것도 가리지 않는다). 가림이 조용히 바뀌지 않게 웹이 ok 가 아니면 알린다.
  - 공급자: `GET /api/v1/ops/providers` 의 `providers[]` 마다 `"last_error_resolution": {"id","upto","resolved_by"} | null`(키는 늘 있다 — 유효한 provider_error 해결,
    지금 오류를 덮는지와 무관) · `"last_error_resolved"`: 유효 해결의 upto ≥ `last_error_at` 이면 true, 아니면 false(해결 없음 · `last_error_at` 없음 · 형식이 틀림 —
    모르는 오류를 해결됨으로 보이지 않는다). 해시의 `last_error` 등은 그대로. 응답에 `"resolution_state"`.
  - 실행: `GET /api/v1/ops/runs` 에 `resolved=hide|show`(기본 hide, 같은 400 규칙). hide 면 `summary_24h` 에서 유효한 provider_error 해결이 있는 공급자의
    **status `'error'`** 실행 중 **finished_at ≤ upto** 를 셈(n) · `last_at` · `avg_latency_ms` 에서 빼고 `"hidden_resolved_errors"`(뺀 실행 수, show 면 0)로 센다 —
    n 이 0 이 된 행은 없다. 기준은 실패를 기록한 시각이다: collector 는 `status.failure`(해시 `last_error_at` = 그때)를 쓴 바로 뒤 `record_run`(finished_at = 그때)을
    적으므로 공급자의 `last_error_resolved` 와 같은 순간을 본다 — 해결 순간에 진행 중이던 실행이 upto 뒤에 실패하면 두 곳 모두 미해결로 보인다(started_at 으로 보면
    요약만 가려 두 답이 갈린다). finished_at 이 없는 실행(실패 시각을 모름)은 가리지 않는다. 공급자 오류는 `'error'` 만이다(collector 가 `status.failure` 로 `last_error` 를 쓰는 실행과 같다) — ok · throttled · budget_* 행은 그대로.
    실행 목록 `items` 는 증거라 가리지 않는다. 해결은 요약과 같은 문장에서 DB 로 읽는다(캐시 없이). `last_at` 표기는 지금과 같다(ms).
  - 캐시 · 장애: api 는 활성 해결 전체를 **5 s 이하** 캐시하고 쓰기(해결 · 되돌림) 뒤 바로 버린다 — 쓴 운영자의 다음 조회가 바로 반영한다. 캐시를 채우는 읽기와 겹친
    쓰기는 세대 번호로 가려 옛 값이 남지 않는다. 다시 읽기는 한 번에 하나이고, 그동안 다른 요청은 기다리지 않고 같은 세대의 지난 값을 받는다(첫 읽기 · 쓰기 뒤에만
    새 값을 기다린다 — 읽기-쓰기 일관). 다시 읽는 요청 하나의 상한은 풀 연결 대기(hikari `connection-timeout` 5 s) + 문장 3 s(`withQueryTimeout` — 문장만 덮는다)
    이고, 실패하면 위 `stale`/`unavailable` 로 답하고 30 s 뒤 다시 읽는다 — DB 장애 중에는 30 s 에 한 요청만 그만큼 기다리고 나머지 로그 조회는 Redis 만으로 바로 된다. 실패는 WARN(처음 · 그 뒤 60 s 마다)으로 시스템 로그에 남고 회복은 INFO. api 는 한 인스턴스다
    (SingleInstanceGuard) — 여럿이면 다른 인스턴스는 5 s 안에 반영한다.
  - 시험: MigrationDbTest(V13 열 · 제약 · 권한 · 되돌리기 · 다시 적용) · RolePrivilegesDbTest(표 스냅샷 `SELECT,INSERT` + 열 UPDATE 스냅샷) · ResolutionServiceTest
    (본문 규칙 · 유효 해결 · 캐시 5 s · 쓰기 뒤 버림 · 겹친 읽기 · 다시 읽는 동안 다른 요청은 지난 값(쓰기 뒤는 기다림) · stale/unavailable · 30 s) · ResolutionDbTest(감사와 한 트랜잭션 · 되돌림은 행을 남김 · 404) ·
    LogReaderTest · LogsControllerTest(hide/show · 가린 수 · 쪽 크기 · 묶음 규칙 · 뒤늦게 실린 항목) · ResolutionControllerTest(201 · 415 · 400 · 404 · 503 + Retry-After 30 · stale) ·
    OpsResolutionsIT(세션 · CSRF · 해결 → 재발 → 되돌림 · 공급자 · 실행 요약(upto 전에 시작해 뒤에 실패한 실행 · 실패 시각을 모르는 실행은 보임) · 같은 xmin). REST 계약 표본(rest_contract_check)은 운영 경로를 싣지 않는다(익명 404 표본만).

## G. 8차 개정(2026-09-29 · 레인 traffic-grid · 사용자 요청 "상황판 한반도 주변 선박 정보" — 사용자 선택: 연안 교통량 격자, ADR-023)
레인 안에서는 §G13 으로 적었으나 합칠 때 §G13(두 시간대) · §G14(해결 표시) 다음 번호 §G15 로 바꿨다.
- G15 **연안 교통량 계약**(collector · api · web · infra — 근거 · 확인한 형식 · 선택값은 ADR-023):
  - 외부: 공공데이터포털 `apis.data.go.kr` 두 서비스(한국해양교통안전공단 실시간 해양교통정보 `B554035/realtime/get_realtime` · 해양수산부 격자4단계 WFS
    `1192000/apVhdService_G4s/getOpnG4sWFS`), 키 하나 `DATA_GO_KR_SERVICE_KEY`(collector 에만 — 격리 스택은 빈 값, 인코딩 키 · 디코딩 키 모두 — ADR-022 의
    해양수산부 선박운항정보(PORT-MIS)와 **같은 키 · 같은 설정 하나**). 공급자 이름 · 예산 키 `komsa_traffic`(하루 400) · `mof_grid4`(하루 6,000), 둘 다 엄격 예산.
  - 호스트 한도(ADR-022 와 하나): `apis.data.go.kr` 호스트 버킷 **하나**(설정 `data_go_kr_rps` 1.0 req/s, burst 2)를 세 잡이 나눠 쓰고 우선순위로 나눈다 —
    교통 5분 폴링 `PRIORITY_FIXED`(0) > 선택 선박 항만 입출항 `PRIORITY_PORTCALL`(4) > 격자 기하 채우기 `PRIORITY_BACKFILL`(5, 가장 낮다). 입출항 조회가
    1 req/s 로 이어져도 교통 폴링은 다음 토큰(≤ 1 s)을 먼저 받고, 격자 채우기는 두 쪽이 기다리지 않을 때만 받는다(`tests/test_ratelimit.py`).
    하루 예산(UTC 날)은 포털의 API 별 개발계정 한도 안이다: `portmis` 3,000 · `mof_grid4` 6,000 · `komsa_traffic` 400. 포털이 하루를 어느 경계로 세든
    지키는 것은 Redis 시간 창이다(합친 뒤 검토 지적 — UTC 날 예산만으로는 KST 하루에 두 UTC 날의 몫이 들어갔다): 어떤 24시간이든 UTC 시 창은 많아야 25개.
    해양수산부 두 API 는 함께 세는 `budget:mof:h:{yyyymmddHH}` 시간당 390(25 × 390 = 9,750 — 두 API 의 한도(각 10,000)가 하나로 묶여 있더라도, 여유는 예약과 보낸 시각의 차이 몫), 격자
    채우기는 그 창의 100 을 입출항 조회 몫으로 남긴다(시간당 많아야 290칸). `komsa_traffic` 은 `budget:komsa_traffic:h:*` 15(25 × 15 = 375 ≤ 500).
    입출항 조회가 창에 막히면 error_kind `hourly_cap`(WS `$defs/port_calls` enum). heartbeat `data_go_kr_rps_1m` = 세 잡을 합친 최근 60 s 호출 수 / 60.
  - Redis(collector 가 쓰고 api 가 읽는다): `wakeline:traffic_grid` 문자열 JSON(SET EX 1200) = `{v:1, reg_dt_kst(+09:00), reg_dt_utc, fetched_at, total,
    total_count|null, partial, rejected, resolved, unresolved, pending, not_found, off_grid, failed, cell_deg: 0.025, cells: [[grid_no, lat_min, lon_min, 척수, 밀집도 %], …]}`
    (기하를 확인한 칸만 · grid_no 순 · 발행 시각 없음 — 같은 입력이면 같은 값 · 미해석 = pending + not_found + off_grid + failed). `wakeline:traffic_grid:negative`
    해시(grid_no → `{"reason":"not_found"|"off_grid"|"failed","at"}` — failed 는 1일, 나머지 7일). 시간 창 예산 `budget:komsa_traffic:h:{yyyymmddHH}`(UTC 시, 15) ·
    `budget:mof:h:{yyyymmddHH}`(UTC 시, 390 — `portmis` · `mof_grid4` 가 함께, 기존 `~budget:*` 셀렉터로 쓴다).
    heartbeat `wakeline:collector` 필드 `traffic_grid_state`(active · no_key · fixture · operator_off) · `traffic_grid_last_ok` · `traffic_grid_reg_dt` ·
    `traffic_grid_resolved` · `traffic_grid_unresolved` · `traffic_grid_cells_known` · `traffic_grid_pending` · `traffic_grid_failed` · `traffic_grid_calls_komsa` ·
    `traffic_grid_calls_wfs` · `traffic_grid_publish_delay_s`(배운 발행 지연 — 배우기 전 빈 값)(모르면 빈 값) · `traffic_grid_at` · `traffic_grid_lag_s`.
    ACL: 두 이름은 collector 루트 키 목록에 없고 셀렉터로만 — `~wakeline:traffic_grid` SET, `~wakeline:traffic_grid:negative` HSET · HGETALL(EX 는 ACL 로
    강제할 수 없다 — api 의 regDt 나이 판정이 방어선).
  - DB: Flyway **V14** `marine_grid4(grid_no text pk, lat_min, lon_min, lat_max, lon_max double precision, gid int, fetched_at timestamptz)` — 한 칸 CHECK ·
    grid_no 형식 CHECK, collector SELECT · INSERT · UPDATE, api SELECT. V13(해결 표시 §G14) 다음 번호다.
  - REST `GET /api/v1/traffic/grid`(공개 · `Cache-Control: public, max-age=30` · ETag `"t<원문 SHA-256 앞 8바이트>[-s]"` · 꺼짐 `"td-<이유>"` · 없음 `"tn"` ·
    형식 오류 `"ti"` · 요청 제한 공통): 늘 있는 키 `available` · `status`(ok · stale · disabled · no_data · invalid) · `stale_after_s`(900) · `cell_deg`(0.025) ·
    `cells` · `source{provider, grid, note}` · `time_zone` · `meta`, 그 밖(`disabled_reason` · `reg_dt_kst` · `reg_dt_utc` · `fetched_at` · `age_s` · 수들(`failed`
    포함) · `partial` · `invalid_cells`)은 모르면 키가 없다. `available` ⇔ `status == ok`, 그 밖에는 `cells: []`. stale = regDt 가 900 s 넘게 지남. regDt 가
    api 시계보다 120 s 넘게 미래면 invalid. disabled 는 heartbeat 가 120 s 안일 때만. 검사: `tools/rest_contract_check.py` `traffic_grid`(표본 RestSamplesIT) —
    교차 규칙은 ADR-023 §6(수의 합 · ok/stale 의 regDt 가 meta.generated_at 보다 120 s 넘게 미래가 아님).
  - 웹: 레이어 키 `traffic`(선택 필드 — 없으면 끔, 이 브라우저에 기억), 조회 90 s · `If-None-Match` · 탭이 보일 때만(다시 보이면 곧바로) · 켜져 있을 때만,
    ok 라도 서버 시각 보정 시계로 regDt + stale_after_s 가 지나면 칸을 그리지 않는다(조회 실패 때도), 범례 문구
    "격자 약 2.2×2.8 km · 5분 집계 · 선박 척수 — 개별 선박 위치 아님". 기준 시각은 §G13 공유 형식기(lib/time)로 KST 와 UTC 를 함께 — 지도 툴팁은
    compact 초까지(`18:05:05 KST · 09:05:05Z`), 레이어 상태 줄은 inline(`09-29 18:05:05 KST · 09:05:05 UTC`), UTC 날짜가 다르면 UTC 쪽에 날짜.
  - 가림(§C5 확장): 언어 간 벡터에 `serviceKey=` · `ServiceKey=`(인코딩 · 디코딩 키) · JSON `"ServiceKey"` · `SERVICEKEY=` 네 사례(ADR-022 의 PORT-MIS
    사례와 합쳐 중복 없이). 키 값은 `providers/data_go_kr.service_key_forms` 하나로 네 형태(원문 · 디코딩 · 퍼센트 인코딩 · + 인코딩)를 값 치환한다 — 세 잡이 같은 목록.

## G. 9차 개정(2026-09-29 · 레인 port-index · 배포 뒤 결함 — PORT-MIS 의 clsgn 은 거르지 않는다, ADR-022 개정)
- G16(ADR-022 결정 2 · 3 · 5 · 6 · 7 · 10 · §G15 의 입출항 부분) **한국 항만 입출항 = 수집기 색인, 선택은 읽기만** — 선택한 선박의 호출부호로 묻던 조회와
  그 임대 · 한도 · 캐시를 대신한다. 근거 · 선택값 · 계산은 ADR-022 '개정'.
  - 외부(collector): `GET apis.data.go.kr/1192000/VsslEtrynd5/Info5` 를 (항만청 10곳 × KST 날짜 하루)로 — `sde = ede` · `deGb=I` · `numOfRows=50` · 모든 쪽,
    **`clsgn` 은 싣지 않는다**. 작업 `portcalls_index` — 꼬리(최근 3일) 매시 · 창(30일) 채우기 · 오래된 날 하루 한 번 다시 받기(시간당 15일치까지).
    예산은 전과 같은 해양수산부 시간 창(`budget:mof:h:*` 390 — 격자 채우기는 100 을 남긴다) → `portmis` 하루 3,000 순서로 예약하고, 색인의 채우기 · 다시 받기는
    창의 50 을 꼬리 갱신에 남긴다. `portmis` 는 엄격 예산이 됐다(`budget.DEFAULT_STRICT`). 우선순위 `PRIORITY_PORTCALL`(4) 그대로.
  - DB: Flyway **V15** `port_call`(자연 키 `prt_ag_cd, clsgn, etrypt_year, etrypt_co` · `listed_date` · 값 열 · `entry_at/exit_at timestamptz` + 판 · `berth` ·
    `fetched_at` · `updated_at`, 인덱스 `(clsgn, listed_date DESC)` · `(prt_ag_cd, listed_date)`)와 `port_call_coverage(prt_ag_cd pk, covered_from, covered_to,
    refreshed_at, hole_days date[] NOT NULL DEFAULT '{}' — 받았지만 끝까지 색인하지 못한 날, updated_at)`. collector: port_call SELECT · INSERT · UPDATE · DELETE,
    범위 SELECT · INSERT · UPDATE. api: 둘 다 SELECT. 보존 = 목록 날짜 60일(collector 유지보수 — 범위 시작과 그 앞의 빈 곳도 함께). V14(§G15) 다음 번호다.
    끝까지 색인할 수 없는 날(키 없는 item · 쪽 사이 어긋남 · 다른 항만청 · 20쪽 초과 · DB 가 행을 거절)은 빈 곳 — 범위는 넘어가고 지우지 않는다. 저장된 행이
    있는 날의 빈 응답은 10분 넘게 떨어진 두 번째 빈 응답이 같을 때만 지운다.
  - Redis: `wakeline:demand:portcalls` · `wakeline:portcalls:*` 는 없다(쓰는 코드도 ACL 규칙도 — collector 규칙 · 셀렉터에서 뺐고 `infra/tests` 가 거부를 확인).
    heartbeat `wakeline:collector` 에 `portcalls_index_state`(active · no_key · fixture · operator_off · db_unavailable) · `portcalls_index_at` ·
    `portcalls_index_lag_s` · `portcalls_index_window_authorities` · `portcalls_index_hole_days` · `portcall_requests` · `portcall_index_units_ok/incomplete/failed` ·
    `portcall_index_rows_upserted/deleted`.
  - WS `ship_selected.port_calls`(`schemas/ws/server.v1.json` `$defs/port_calls` · `port_call` · `port_call_index`): status **ok · none · incomplete · disabled ·
    no_call_sign · error**(pending · limited · no_static · limited_by · error_kind · error_code · fetched_at · incomplete · reports 는 없어졌다). ok · none · incomplete 에는
    늘 `window_from` · `window_to` · `index{authorities: 10, complete, refreshed_at?, stale_after_s: 7200, gaps[{port_authority_code, port_authority,
    issues[not_indexed|partial|behind|stale|unindexed_days](1–4), covered_from?, covered_to?, refreshed_at?, unindexed_days?[날짜 1–31]}]}`. **none 은
    index.complete 일 때만**(10곳 모두 창 첫날부터 · 범위 끝 = 오늘(KST — window_to) · 창 안에 빈 곳 없음 · 꼬리 갱신 2시간 안) — 웹도 다시 확인하고 어긋나면
    보이지 않는다. `refreshed_at` 은 최근 3일에 대한 시각이다(더 오래된 날은 하루에 한 번쯤 다시 받는다). no_call_sign 에는 `call_sign_state`(not_received — "아직 받지 않음" · unusable).
    항목 `port_call`: `listed_date` · `entry_at`/`entry_revision` · `exit_at`/`exit_revision`(최종 · 최초 — 시각이 있을 때만) · `berth` · `purpose` · `first_port` ·
    `prev_port` · `next_port` · `dest_port` · `reported_name` · `kind` · `nationality` · **`read_at`(필수)**. 표본 `apps/web/tests/fixtures/ws-samples.v1.json`
    (`make ws-samples`)에 상태마다 하나씩(`ship_selected.port_calls_error · _disabled · _none · _incomplete · _no_call_sign_not_received · _no_call_sign_unusable`).
  - REST: 바뀌지 않는다(`/ships/{mmsi}` 는 입출항을 싣지 않는다 — REST 표본 · 규칙 변경 없음).
  - 웹: 표 항만청 · 입항 · 출항(DualTime 칸 · 판, 출항이 없으면 "—") · 선석 · 목적 · 전출항지 → 차항지, 색인 줄 "색인: 10개 항만청 · 최근 30일 · 갱신 <KST · UTC>",
    incomplete 는 항만청별 이유, 선명 다름 경고는 두 이름이 모두 영문일 때만. 설명서 2.6 · /about 이 색인 동작을 적는다.

## G. 10차 개정(2026-09-30 · 레인 static-fallback · 배포 뒤 결함 — api 재시작 뒤 선택 선박의 정적 정보가 null)
- G17 **메모리에 없는 선택 선박의 정적 정보 = DB 의 마지막 저장 정적 보고, 저장값이라고 밝힌다**.
  - 관찰(운영 스택): api 를 다시 시작한 뒤 지도에서 고른 실시간 선박(MMSI 538012043 AZAMARA PURSUIT)의 `ship_selected.static` 이 null, `port_calls` 가
    no_call_sign(not_received)로 오래 남았다. ShipStore 의 정적 정보는 선박 스트림(시간 창 최대 2.5 h — `publisher.STREAM_RETENTION_S`)에서만 다시 채워지는데
    이 선박의 정적 보고가 그보다 오래됐다. DB `ship` 행(ShipRepository — REST 상세 · 검색이 이미 읽는다)에는 마지막 정적 보고(호출부호 V7A3884)가 있었다.
    REST `/ships/{mmsi}` 는 이미 DB 로 채웠지만 저장값이라고 밝히지 않아, 카드는 호출부호를 보이면서 입출항은 '호출부호 아직 받지 않음' 이었다.
  - api(`StoredStaticReader` — ShipFanout 이 메모리에 정적 정보가 없을 때만 부른다): `ShipRepository.find`(문장 — 공개 조회 상한 3 s) · MMSI 별 메모리 캐시
    (찾음 · 없음 60 s, 읽기 실패 15 s — 한 선택을 되풀이해 다시 계산해도 DB 는 이 간격에 한 번) · 같은 MMSI 의 동시 miss 는 한 번만 읽는다(리뷰) · 예외를
    던지지 않는다. 대기 상한: 읽기는 세션의 순서 큐(SerialOutbox)에서 돌고, 풀 연결 대기는 문장 상한과 따로 Hikari connection-timeout 5 s(공유 풀 12)가
    걸린다 — 연결을 얻지 못하는 동안(풀 소진 · DB 없음) 한 번의 읽기가 그 세션의 메시지를 최악 약 8 s(5 s + 3 s) 막고 15 s 마다 되풀이된다
    (PortCallReader 와 같은 모양 — 순서 큐 밖으로 옮기거나 공개 조회 전용 풀을 두는 것은 이 레인 밖). 지표
    `wakeline_cache_requests_total{cache="stored_static"}` · `wakeline_stored_static_errors_total`. 저장값은 ShipStore 에 넣지 않는다(지도 목록 ShipLite · 검색의
    실시간 일치는 그대로). 입출항은 그 호출부호로 찾는다(`PortCallReader.forStatic`).
  - 시각 열: `ship.updated_at` = 지금 저장된 내용을 DB 에 쓴 정적 메시지의 aisstream 수신 시각(`static.updated_at` 과 같다 — DB 에 기록된 수신 시각).
    수집기(`ShipBook`)는 메모리의 정적 정보가 바뀐 메시지의 시각을 싣는데, 그 메모리는 수집기가 다시 시작하면 비고 30분 넘게 수신이 없거나(ttl_s 기본 1800 —
    `ais/main.py` 는 바꾸지 않는다) 선박 수 상한에 밀린 선박을 지운다 — 그 뒤 같은 내용을 다시 받으면 '바뀜' 으로 새 시각을 싣고 api 가 그 시각으로 행을 덮는다
    (수집기 `test_ais_book.py::test_static_time_is_not_the_first_reception_after_eviction_or_restart`). 그 밖의 같은 내용 재수신은 저장하지 않으므로(ShipWriter)
    이 값은 지금 내용의 첫 수신도 마지막 수신도 아니고, `ship.last_seen` 은 위치 보고로도 넓혀진다. 그래서 이름은 `static_updated_at`, 화면 글은
    'DB 기록 수신 시각' 이고 카드 설명(title) · 설명서 2.6 이 언제 새로 기록되는지와 '첫 수신도 마지막 수신도 아님' 을 적는다. 마이그레이션 없음.
    (리뷰 뒤 고침: 처음 화면 글 '이 내용 첫 수신' 은 수집기 재시작 · 메모리 제거를 빠뜨린 추정이었다.)
  - WS `ship_selected`(`schemas/ws/server.v1.json` — 두 키는 늘 있다): `static_source` = `live`(메모리) · `stored`(DB 의 마지막 저장 정적 보고) · `none`(둘 다 없음) ·
    `stored_unavailable`(메모리에 없고 DB 를 읽지 못함 — 저장돼 있는지 모름) · null(읽는 쪽이 없는 구성 — 시험뿐). `static_updated_at` = stored 일 때만 저장 행의
    updated_at, 그 밖에는 null. static 과의 관계는 스키마 anyOf(live · stored → static 있음, 그 밖 → static null), 시각이 `static.updated_at` 과 같은지는 api 시험 ·
    `tools/contract_check.py` 가 본다. DB 실패 → static null · stored_unavailable · port_calls no_call_sign/not_received(세션은 그대로). 표본(`make ws-samples`)
    `ship_selected.static_stored · _static_none · _static_stored_unavailable`.
  - REST `/ships/{mmsi}`: `static_source`(live · stored — static 이 있을 때만) · `static_updated_at`(stored 일 때만, 같은 뜻). `tools/rest_contract_check.py` 가
    있음 규칙과 같은 순간인지 본다(표본 `ship_detail` = live, `ship_detail_stored` = stored).
  - 웹: 검증기는 틀리거나 static 과 어긋난 출처 · 시각을 모름(null)으로 두고 센다. 선박 카드는 보이는 정적 정보가 저장값이면(WS → REST 순 — 그 정적 정보를
    준 쪽의 출처만) 정적 필드 바로 위에 "저장된 AIS 정적 보고 · DB 기록 수신 시각 <KST · UTC> (경과)" · "실시간 값이 아님", DB 를 읽지 못했으면 '모름' 을 적는다.
    '입출항도 이 호출부호로 찾음' 은 카드의 입출항 절(WS `port_calls` 뿐)의 `call_sign` 이 보이는 호출부호(서버와 같은 정규화 — ASCII · 앞뒤 공백 · 대문자)와
    같을 때만 붙인다(`lib/ships.storedPortCallsNote`). WS 가 `stored_unavailable` 인데 REST 가 같은 행을 읽어 저장 보고를 보일 때는 '입출항은 이 호출부호로
    아직 찾지 않음 — 서버가 선택 때 저장된 보고를 읽지 못함' 을 적는다(리뷰: 조건 없이 붙이면 입출항 절의 '호출부호를 아직 받지 않음' 과 어긋난 채 틀린 말).
    설명서 2.6 이 한 문장으로 적는다.

## G. 11차 개정(2026-09-30 · 레인 backend · VERIFICATION #51 '남은 것' — 선택 선박 조회가 WS 세션 우편함을 붙잡음, ADR-025)
- G18(§G17 의 '대기 상한' 문장 · ADR-022 개정의 입출항 읽기 · ADR-008 세션 우편함) **선택 선박의 DB 조회는 세션 우편함 밖에서, 전용 읽기 풀로**.
  - 관찰(코드 — `ShipSelectionLookupTest` 가 재현): `ShipFanout.runSelected` 는 세션 우편함(SerialOutbox — 한 번에 하나)에서 돌며 저장 정적 보고
    (`StoredStaticReader.lookup`)와 입출항(`PortCallReader.forStatic` — Redis heartbeat + 문장 둘)을 그 자리에서 읽었다(공유 Hikari 풀 12 · 연결 대기 5 s +
    공개 조회 문장 3 s). 풀에 연결이 없는 동안 선택 하나가 그 세션의 항공기 · 선박 diff · pong · heartbeat 를 저장 정적 보고 한 번에 최대 약 8 s, 입출항까지
    최대 약 19 s(설정값의 합) 붙잡고, 실패 기억(15 s)이 끝날 때마다 되풀이했다.
  - api(`ws.ShipLookups` · `ShipFanout`): 우편함은 읽는 쪽의 메모리 캐시만 본다(`StoredStaticReader.cached` · `PortCallReader.cachedForStatic` — I/O 없음).
    다 답할 수 있으면 곧바로 보낸다(대부분의 다시 계산). 읽어야 하면 조회 실행기에 맡기고 돌아온다 — 스레드 = 읽기 풀 연결 수(4), 대기열 max(256,
    `wakeline.ws-max-conn`), 가득 차면 그 읽기는 하지 않고 읽지 못함으로 답한다(`outcome=rejected` — 기억하지 않아 다음 다시 계산이 다시 읽는다). 결과는
    SHIP_SELECTED 우편함 작업으로 돌아와, 그 조회가 세션의 지금 조회(세대 — `WsSession.shipLookup` 객체)이고 물음(선박 · 메모리 정적 정보가 있는가 · 그
    호출부호)이 같을 때만 그때의 최신 선박 상태와 함께 보낸다. 선택이 바뀌었으면(다른 선박 · 해제) 버린다(답을 보내지 않은 조회 —
    `wakeline_ws_ship_lookup_dropped_total`), 세션이 닫혔으면 작업이 실행되지 않는다. 캐시 수명(찾음 60 s · 실패 15 s · 입출항 15 s)은 그대로다.
  - 리뷰 뒤 고침('답을 보냄' ≠ '읽는 중' — `ShipSelectionLookupTest` 가 재현: 마감 뒤 다시 계산마다 같은 호출부호를 다시 읽어 한 세션 · 한 선박이 조회 스레드
    넷을, 같은 선박을 고른 세 세션이 한 읽기에 스레드 셋을 잡았다): (1) `ShipLookups.load` 는 answer(늦어도 마감)와 settled(그 조회의 읽기가 모두 끝남 —
    마감과 무관)를 따로 준다. 세션은 settled 까지 조회를 들고 있어 같은 물음의 다시 계산(선박 이동 · 15 s 주기)은 새 읽기를 올리지 않고 캐시 또는 그 답과
    최신 선박 상태로 보낸다. 마감 뒤에 끝난 읽기는 곧바로 다시 계산을 불러 실제 값을 보낸다. (2) 같은 키의 동시 읽기는 하나(`persist.SingleFlight` — 저장
    정적 보고는 MMSI, 입출항은 정규화한 호출부호): 기다리는 쪽은 진행 중인 읽기의 future 에 이어 붙어 스레드를 잡지 않는다. (3) 한 세션의 다음 물음의 읽기는
    앞 조회가 settled 된 뒤 시작하고, 그사이 물음이 또 바뀌면 그 읽기는 하지 않는다(`outcome=skipped`) — 한 세션이 실행기에 두는 작업은 늘 하나 이하, 그래서
    대기열 max(256, WS 연결 상한)는 연결 상한 안에서 넘치지 않는다.
  - 마감: 답은 늦어도 물음 뒤 `ReadPool.readBoundMs()` = 읽기 풀 연결 대기 2 s + 공개 조회 문장 3 s = **5 s**(설정값 — 잰 값 아님)에 나간다(앞 조회를 기다린
    시간 포함). 그때까지 끝나지 않은 부분은 계약에 이미 있는 값으로 답한다 — static → `stored_unavailable`(static null · port_calls no_call_sign/not_received),
    입출항 → `error`(색인을 읽지 못함 — '기록 없음' 이 아니다). 읽기는 계속돼 캐시를 채우고, 끝나면 곧바로 바뀐 값을 보낸다.
  - 읽기 풀(`persist.ReadPool` — 이 두 읽기만 쓴다): `wakeline-read` · 크기 `wakeline.read-pool.size` 4(1–8) · 연결 대기
    `wakeline.read-pool.connection-timeout-ms` 2,000(문장 상한 이하만 받는다 — 넘으면 기동하지 않는다) · 최소 유휴 0(DB 가 없는 동안 뒤에서 다시 맺지 않는다) ·
    연결마다 서버 `statement_timeout=3s` · `default_transaction_read_only=on` · pgjdbc `socketTimeout=5`(문장 상한 + 2 s — 리뷰 뒤 고침: 두 문장 상한은 서버가
    답할 때만 문장을 끝낸다. 서버가 멈췄거나 망이 끊기면 소켓에서 기다리는 읽기는 이것만 끝낸다 — `ReadPoolDbTest`, 고치기 전 8 s 뒤에도 막힘) ·
    `connectTimeout` = 연결 대기를 초로 올림(2) · ApplicationName `wakeline-api-read` · Micrometer
    `hikaricp_connections_*{pool="wakeline-read"}`. DB 연결 수: 역할별 상한 없음(`infra/db/init/01-roles.sh`), 서버 max_connections 기본 100(compose 가 바꾸지
    않는다 — 슈퍼유저 예약 3) — api 공유 풀 12 + 읽기 풀 4 = 16, 수집기 프로세스는 각 2(`db.py`).
  - 새 최악(설정값): 세션의 다른 메시지는 선택 조회를 기다리지 않는다. ship_selected 는 조회가 필요하면 물음 뒤 ≤ 5 s. 읽기 풀이 바닥나면 저장 정적 보고는
    연결 대기 2 s 에 `stored_unavailable`(`StoredStaticIT` — 4 연결을 2.8 s 잡은 동안 1.8–2.8 s 에 답, 그동안 pong). 실행기 포화면 곧바로.
    스레드 · 연결이 묶이는 시간(리뷰 뒤 고침 — 포화를 정하는 값): 문장 하나 ≤ 2 s + 3 s = 5 s(서버가 답할 때) · ≤ 2 s + 소켓 5 s = 7 s(서버가 멈출 때 —
    `ReadPool.hardReadBoundMs`). 작업 하나가 스레드를 잡는 시간: 저장 정적 보고 ≤ 5 s(7 s) · 입출항 ≤ Redis 3 s(`spring.data.redis.timeout` — heartbeat 는
    15 s 기억) + 문장 둘(범위 — 15 s 기억 · 호출부호) = 13 s(17 s). 한 조회가 settled 되기까지(두 작업이 차례로) ≤ 18 s(24 s). 같은 키는 읽기 하나 · 세션마다
    작업 하나 이하라 스레드 넷이 모두 묶이려면 서로 다른 키를 읽는 세션이 넷 있어야 한다.
  - WS 계약은 그대로(키 · 값 · 스키마 사본 · 웹 검증기 · 표본 변화 없음): ship_selected 가 조회를 기다리는 동안 늦게 나갈 뿐이다. 웹은 첫 ship_selected 전에는
    입출항 절을 "—" 로 둔다(명시적 '조회 중' 상태를 새로 두지 않는다 — 계약 · 검증기 · 표본을 늘릴 만큼의 쓸모가 없다).
  - 지표: `wakeline_ws_ship_lookups_total{outcome=ok|deadline|rejected|error|skipped}` · `wakeline_ws_ship_lookup_seconds`(물음 → 답) ·
    `wakeline_ws_ship_lookup_queue` · `wakeline_ws_ship_lookup_dropped_total`(답을 보내지 않은 조회). 시험: `ShipSelectionLookupTest`(pong · diff 가 막힌 읽기를
    기다리지 않음 · 마감의 읽지 못함 · 늦은 결과는 읽기가 끝나면 곧바로 · 입출항도 우편함 밖 · 늦게 온 결과 버리기 · 포화 · 같은 MMSI 한 번 읽기 · 스레드
    하나와 캐시 · 마감 뒤 다시 계산 넷에 읽기 하나 · 한 세션이 선박 넷을 바꿔도 실행기 작업 하나) · `StoredStaticReaderTest` · `PortCallReaderTest`(future
    합치기 · 거절은 표시를 남기지 않음) · `StoredStaticIT`(표 잠금 3 s 동안 pong < 1 s · 읽기 풀 소진 · 읽기 풀 연결의 서버 설정) · `ReadPoolTest` ·
    `ReadPoolDbTest`(멈춘 서버 → 소켓 5 s).
- G19(§G17 의 시각 열 문장 · ADR-014 의 정적 정보 저장) **정적 정보의 받은 필드 — 저장 행은 받은 필드만 덮는다**.
  - 관찰(재현 — 수집기 `test_ais_static_received.py`, api `ShipPersistDbTest` · `StaticPartsIT`): ais 재시작이나 ShipBook 제거(ttl 30분 · 선박 수 상한) 뒤 레코드는
    빈 것(14칸 None)에서 시작해 받은 조각만 채운다. Class B 는 24A(선명)와 24B(호출부호 · 선종 · 크기)가 따로 오는데, 둘이 다른 발행(10 s)에 들어가면 첫
    발행의 static 은 call_sign · ship_type · dim_* 가 null 이고, 메시지는 '받지 않음' 과 '빈 값으로 받음' 을 구별하지 않았다 → api 의 STATIC_SQL 이 ship 행의
    호출부호 · 선종 · 크기를 NULL 로 덮었다(24B 가 오기 전에 선박이 사라지면 영구히 — §G17 의 저장 정적 보고 · REST /ships/{mmsi} 가 호출부호 없는 행을 보였다).
  - 어느 층의 일인가: '무엇을 받았는가' 는 AIS 조각을 보는 수집기만 알고, 저장값과 합치는 일은 행을 쓰는 api 저장 층이 한다 — 수집기는 받은 필드를 싣고
    api 는 그 필드만 덮는다. api 메모리(ShipStore — 지도 목록 · 검색 · 선택의 live)는 받은 그대로 둔다(저장값을 섞지 않는다).
  - 스트림(`stream_envelope.v1.json` `$defs/ships_payload` — 두 사본): `static_received` = static 의 MMSI → 수집기 레코드가 시작된 뒤 받은 정적 필드
    (`parse.STATIC_FIELDS` 순서 · enum · 중복 없음). 메시지 5 = 14칸 모두 · 24A = name · 24B = call_sign · ship_type · dim_a–d(보조 선박 98MIDxxxx 는 크기 키를
    싣지 않으므로 크기 없음) · 19 = name · ship_type · dim_a–d. 필드 목록이 아니라 조각 이름(5 · 24A · 24B)을 싣지 않은 까닭: 파서가 조각마다 실은 키를 이미
    정하고(보조 선박 24B 예외 포함), 필드 목록이면 api 가 조각 → 열 표와 예외를 다시 가질 필요가 없다. static 항목(`ship_static.v1.json`) 밖에 두는 까닭: 항목은
    additionalProperties false 라 이전 api 가 메시지 전체(위치 포함)를 거절한다. 받은 필드만 늘어도(값은 같은 null — 선박이 비워 보냄) 레코드는 '바뀜' 으로 새
    시각과 함께 다시 발행된다.
  - api(`ShipCodec.received` → `ShipStatic.received` · `written()` · `overlay()`, `ShipRepository.STATIC_SQL`): 있는 행은 받은 필드만 바꾸고(열마다
    `CASE WHEN ? THEN EXCLUDED.col ELSE s.col END`) 나머지 열은 저장값을 둔다. 받은 부분 안의 빈 값은 덮는다(선박이 비워 보냈다). updated_at 단조 규칙 · 보고
    범위 넓히기는 그대로. 한 배치 안의 같은 MMSI 는 updated_at 순으로 겹쳐 한 행(필드마다 가장 새 값, 받은 필드는 합). 매개변수가 VALUES 뒤에도 있어 pgjdbc 는
    이 문장을 다중 VALUES 로 다시 쓰지 않는다(정적 정보는 드물다 — 배치의 문장마다).
  - 배포 전환(어느 순서든 안전): 새 수집기 · 이전 api → 이전 api 는 모르는 payload 키를 무시한다(ships_payload 는 추가 키 허용) — 이전처럼 덮는다(지금의
    결함 그대로, 새로 나빠지지 않는다). 이전 수집기 · 새 api → `static_received` 가 없으면 받은 필드를 모름으로 보고 **값이 있는 필드만** 덮는다(null 은
    '받지 않음' — 저장값을 지우지 않는 쪽. 대가: 선박이 실제로 비운 값은 새 수집기가 받은 필드를 실을 때부터 반영된다). 그런 정적 정보는
    `wakeline_ship_static_unknown_fields_total` 로 센다. 목록에서 빠진 MMSI 도 같다.
  - 시각 열(§G17 문장 고침): `ship.updated_at` = 이 행에 **마지막으로 저장한** 정적 보고의 aisstream 수신 시각(DB 에 기록된 수신 시각) — 그 보고가 싣지 않은
    필드(받지 않은 부분)는 그보다 앞서 저장된 보고의 값이다. 그 밖(재시작 · 제거 뒤 새 시각, 같은 내용 재수신은 저장하지 않음, 첫 수신도 마지막 수신도 아님)은
    §G17 그대로. 수집기 쪽 updated_at 은 내용 또는 받은 필드가 바뀐 메시지의 시각(`ship_static.v1.json` 설명). 웹 카드의 보이는 줄(`lib/ships.STORED_STATIC_FIELDS_TEXT` — 아래 필드는 DB 에 저장된 값, 위 시각의 보고가
    싣지 않은 필드는 앞선 보고의 값) · 설명(title — `STORED_STATIC_TITLE`) · 설명서 2.6 · WS 스키마 ship_selected 설명이 이 뜻을 적는다(리뷰 뒤 고침: 처음에는
    title 만 고쳐 보이는 줄이 모든 필드를 '이 보고의 값' 이라 했다 — `static-source.test.ts` 가 보이는 글을 본다). 마이그레이션 없음.
  - 계약 검사: `tools/contract_check.py`(실수신 fixture → 발행: 모든 part 의 static_received 가 그 part 의 MMSI 를 정확히 덮고, 필드는 그 MMSI 가 fixture 에서
    실제로 보낸 조각의 키 합 · enum = STATIC_FIELDS 순서), `ShipStaticTest`(FIELDS = 스키마 enum = ship_static 정적 칸), `SchemaContractTest` · 수집기 시험
    (같은 스키마 파일로 이름 · 키 · 중복 거절).
## G. 12차 개정(2026-09-30 · 레인 kst · 사용자 결정 "[상황판·재생·통계·공항 화면]을 포함한 필요한(해당되는) 메뉴에 시각을 UTC 지우고, KST 표시") — 화면 시각은 KST 만
같은 날 병행 레인(백엔드)이 11차 개정으로 §G18 · §G19 를 먼저 썼다 — 이 절은 그다음 번호 §G20 이다(합칠 때 11차 개정이 이 절 앞에 온다. 번호는 `tests/docs-contract-g11` 이 겹치지 않는지 본다).
- G20(§G13 · §G11 · §G10 · §C7 · ADR-017 R-45) **화면의 시각은 한국 표준시(KST)만 — UTC 는 저장 · 전송 형식으로만 남는다** — §G13 의 "KST 먼저 · UTC 함께"
  (두 시간대 · UTC 쪽 날짜 · 머리글 `(KST · UTC)` · compact `…Z` · 원본 UTC 툴팁)와 §G10 · §G11 의 "원본 UTC 는 툴팁" 을 대신한다. API · WS · DB · 서버 로그의 시각은 UTC ISO 그대로다.
  - 한 곳: `lib/time.ts`(글자 — 화면 시간대는 `DISPLAY_TZ` 한 곳이 정한다: KST · Asia/Seoul · +09:00 고정) · `components/KstTime.tsx`(`<KstTime>` · `<KstRange>` —
    `<time dateTime>` 에 ISO 8601 +09:00, title 에 연도 · ms 까지의 KST). 화면 코드는 시각 글자를 직접 만들지 않는다(§G13 의 소스 검사 그대로 — 예외는 복사 형식 ·
    오류 화면 · 선박 ETA 뿐, 파일 · 줄 수까지 시험에 고정).
  - 범위: 모든 화면 — 상황판(상태 바 · 알림 · 카드 · 목록 · 지도 툴팁 · 선 라벨 · 레이더 타임라인 · 기상청 패널 · 연안 교통량 · 입출항) · 재생 · 통계 · 공항 · 운영 ·
    로그 · 출처·한계 · 설명서 · 오류 화면. 보이는 글자 · title · aria-label 어디에도 UTC 가 없다(원문 제외).
  - 형식(lib/time 이 만드는 글자): inline `09-29 14:02:54 KST` · 날짜가 자명한 자리 `14:02:54 KST` · 좁은 자리(상태 바 — AIS 공백 칩 포함 · 지도 툴팁 · 선 라벨)
    `14:02 KST` · hh:mm 구간 `08:40–08:45 KST` · 구간 `09-29 10:00:00 – 09-29 14:00:00 KST`(시간대는 끝에 한 번, 줄은 ` – ` 에서만 바뀐다) · 표 칸 `09-29 14:02:54`
    (머리글 `(KST)`, 화면 읽기에는 " KST" 까지) · title `2026-09-29 14:02:54.000 KST` · 재생 시각은 연도까지 · 모르면 `—` 만(시간대 글자 없이).
  - 원문: METAR · TAF · SIGMET 발표문 · 서버 로그 메시지 본문(예외 · 스택 · context 포함) · 수집기가 쓴 원본 레코드(격리 detail · DLQ payload head · 실행 오류 글자)는
    글자 그대로 — 요소에 `data-raw`. 발표문 이름표는 `(원문 · 발표 그대로)`(lib/time `RAW_BULLETIN_LABEL`)이고 툴팁이 "안의 ‘…Z’ 시각은 발표 형식(KST = …Z + 9시간)" 이라 적는다.
  - 기상청 레이더 tm 은 기상청이 준 KST 그대로(`HH:MM KST`). 선박 ETA(계약 v2 §B4 — 선원 입력 월 · 일 · 시 · 분, 입력 형식은 UTC 벽시계, 연도 없음)는 KST 로 바꿔
    `09-30 15:05 KST · 선원 입력 · 연도 없음`(2월 28일 입력 15:00 뒤는 `02-29 또는 03-01 … KST(연도 없어 윤년 모름)`, 달력에 없는 날은 시각을 지어내지 않고
    `— (선원 입력 날짜 04-31 이 달력에 없음 — KST 로 바꿀 수 없음, 연도 없음)`).
  - 재생: 날짜 · 시각 입력(`재생 시각(KST)`) · 보이는 시각 · title 은 KST, api 요청의 `at` 은 그 순간의 UTC ISO(`…Z`) 그대로(전송 형식).
  - 날짜로 센 집계(조사한 결과와 한 일):
    - 우리 DB 가 세는 것은 KST 날짜로 센다(서버): api `stats_daily`(SIGMET 발표일 · 교통량 · 알림 — 하루 = [00:00 KST, 다음 날 00:00 KST), 교통량 `dim` = KST 시 00–23) ·
      collector `quality_rule_count`(실행이 시작된 KST 날짜). 매일 03:30 KST 에 전날(KST 날짜)을 센다(api cron `zone = Asia/Seoul`), 따라잡기 · 보존 경계 · '오늘' 도
      KST 날짜. REST `/stats/sigmet` · `/stats/alerts` · `/stats/traffic` 의 `day` = KST 날짜, 기본 날짜 · 범위 = KST 오늘, 응답에 늘 `day_zone: "Asia/Seoul"`
      (`tools/rest_contract_check.py` 가 const 로 본다 — 교통량 `dim` 은 `00`–`23` 이고 시마다 한 행). `/ops/quality` 도 `day_zone`, `/ops/stats/aggregate` 는 KST 오늘 이전만.
    - 옛 행(UTC 날짜로 센 것)은 KST 날짜로 이름만 바꾸지 않는다(다른 하루다): Flyway **V16** 이 `stats_daily_utc_legacy` · `quality_rule_count_utc_legacy` 로 옮기고
      (서비스 역할 권한 없음 — 보관만, 머리 주석에 되돌리기 SQL) 같은 모양의 새 표를 만든다(권한은 옛 표와 같다). 통계는 api 따라잡기가 원본이 남은 계열을 KST
      날짜로 다시 센다 — 최근 7일은 모든 계열, 그보다 오래된 날은 SIGMET(영구) · 알림(30일 안)을 한 번에 92일까지(`backfillStats`). 교통량은 그날 첫 순간
      (00:00 KST)이 든 UTC 날 파티션이 보존(72 h) 안일 때만 다시 센다 — 항적은 UTC 날 파티션째 지워지고 00:00–08:59 KST 는 앞 UTC 날 파티션에 있어, 그날 끝으로
      판단하면 00–08시가 빠진 수를 완료로 남긴다(리뷰).
    - 교통량 이력은 V16 이 옛 행에서 정확히 옮겨 싣는다(통합 리뷰): 옛 `traffic_by_hour` 는 UTC 시마다 센 서로 다른 항공기 수이고 KST = UTC + 9 정시라 KST 날짜 D 의
      h 시는 옛 행 하나 — h < 9 이면 (D − 1, h + 15), 아니면 (D, h − 9). 두 UTC 날이 모두 교통량 완료 표식을 가졌고 센 지역이 같은 KST 날만 시 · 지역 · 표식(늦은 쪽)을
      싣고, 나머지 날은 싣지 않는다. 1분 요약(`track_point_1m`)으로는 세지 않는다 — 행에 센 지역이 없고 빠진 시간을 알 수 없다. SIGMET · 알림의 옛 행은 옮길 수 없다
      (UTC 날 하루의 수가 KST 날짜 둘의 사건을 섞었다). 그래서 비는 것은 끝난 알림이 지워진 30일 밖 날의 알림 통계, 옮길 조건을 못 채웠고 항적도 지워진 날의 교통량,
      V16 앞의 격리 수(실행마다의 규칙별 수는 그 표에만 있었다)뿐이고, 화면이 '집계되지 않은 날짜 — … KST 날짜 집계로 바꾸기 전 날짜' 로 말한다.
    - 격리 수를 바꾼 날(통합 리뷰): V16 이 KST 날짜 셈을 시작한 순간을 `kst_day_cutover`(api 읽기만)에 남긴다. `/ops/quality` 가 그 순간을 `counted_since`(UTC ISO)로
      내고 그 KST 날짜보다 앞 날짜의 행은 내지 않는다(배포 중 아직 돌던 이전 수집기가 UTC 날짜로 쓴 행뿐이다). 운영 화면은 그 날짜 칸에 `부분 · HH:MM KST 부터` 를 붙이고
      title 에 그 앞 실행이 보관 표에 있다고 적는다 — 바꾼 날의 부분 값을 00:00–24:00 KST 하루치처럼 보이지 않는다.
    - 배포(통합 리뷰): compose 는 `migrate` 가 끝날 때까지 이전 api · collector 를 돌려 둔다. 그 사이 이전 api 의 집계(03:30 UTC · 3시간마다 따라잡기)는 UTC 날 통계와
      완료 표식을 새 `stats_daily` 에 쓸 수 있고(새 api 는 표식이 있는 날을 건너뛴다), 이전 collector 는 UTC 날짜 격리 수를 새 표에 쓴다(00:00–08:59 KST 배포면
      전날 KST 날짜 — api 가 내지 않는다). 그래서 V16 을 싣는 배포는 먼저 쓰는 쪽을 멈춘다:
      `tools/dc build && tools/dc stop api collector && make up`(`tools/dc` = 개발 스택의 `docker compose -f infra/compose.yml --env-file .env`).
      멈추지 않고 배포했다면 배포 뒤 `/ops/stats/aggregate` 로 최근 7일(KST)을 다시 센다 — 원본이 남은 계열만 바로잡힌다.
    - 경계가 UTC 날로 정해진 것 — 수집기 하루 예산 키(`budget:{공급자}:{yyyymmdd}`, 공급자 한도와 맞춘 UTC 날)와 그것을 옮긴 `provider_budget_day` — 는 바꾸지 않고,
      화면이 그 창을 KST 로 적는다: `09-28 09:00 – 09-29 08:59 KST`(머리글 `budget window (KST)`, "매일 09:00 KST 에 새로 시작" — lib/time `utcDayWindowKst`).
      `/ops/providers` 가 `budget_day_zone: "UTC"` 로 밝힌다. 시간 창 예산(`…:h:{yyyymmddHH}`)은 시 경계가 KST 와 같아 바꿀 것이 없다(화면에 나오지 않는다).
    - 웹은 응답이 밝힌 기준만 믿는다: `day_zone` 이 `Asia/Seoul` 이 아닌 통계 · 격리 수 응답, `budget_day_zone` 이 `UTC` 가 아닌 예산 응답은 날짜 · 창을 그리지 않고
      그렇다고 적는다(옛 api 와 새 웹이 섞인 배포 중에 UTC 날짜를 KST 날짜로 보이지 않게). 통계 날짜의 옛 "UTC 자정 시각" 문자열은 날짜로 읽지 않는다(`—`).
  - 바꾸지 않는 것: API · WS · DB · 서버 로그의 시각(UTC ISO), 복사 · 내려받기 형식(텍스트 머리 줄 ISO `+09:00`, 항목 JSON · `.ndjson` 의 `ts` — 버튼 title 이 "서버 형식 ‘…Z’" 라 적는다), 원문.
  - 성능: §G13 과 같다 — 고정 오프셋 산술(Intl 없음 — 형식기 생성 비용 · ICU 차이 없음), 같은 입력의 분해 결과 캐시(2,048개, 차면 비움, `TIME_CACHE_MAX`).
  - 옮긴 이름(합친 뒤 지움): 다른 레인(대시보드 UX)이 같은 때 고치던 파일(StatusBar · AlertPanel · AircraftSearch · AircraftCard)과 그 레인의 새 코드
    (lib/statusbar.ts · lib/ships.ts)를 위해 `DualTime` · `dualPair` · `fmtDual` · `dualParts` · `dualRangePair` · `fmtDualDayMinute` · `fmtDualSpan` 을
    **KST 전용 별칭(@deprecated)** 으로 잠시 남겼다. 세 레인을 합친 뒤(integ) 호출부를 `KstTime` · `fmtKst` · `fmtKstClock` · `fmtTimeTitle` · `timeParts` ·
    `fmtKstRange` 로 옮기고 별칭 · `components/DualTime.tsx` · 그 레인의 옛 상태 바 배지(`lib/ships.aisGapBadge` — `lib/statusbar.aisGapInfo` 가 대신한다)를 지웠다.
    상단 검색 상자의 설명 한 줄은 그 레인이 "(마지막 수신·저장 시각은 KST · …)" 로 고쳤고(3c2ec90), 시험의 다른 레인 면제(`OTHER_LANE_PENDING` ·
    `OTHER_LANE_KOREAN_UTC` · `DEPRECATED_USERS`)도 지웠다 — 화면 · 소스 검사는 면제 없이 모든 파일에 적용되고, 옛 이름을 쓰는 파일이 하나라도 있으면 실패한다
    (`tests/kst-dashboard.test.ts` · `tests/kst-time.test.ts`).
  - 회귀 막기: `tests/kst-time.test.ts`(형식 · 모름 · 캐시 · 컴포넌트) · `tests/helpers/kst-only.ts`(글자 · DOM 의 UTC 흔적 — data-raw 밖) · 화면마다 그 검사(상황판 전체
    `tests/kst-dashboard.test.ts` · 재생 · 통계 · 공항 · 운영 · 로그 · 출처 · 설명서 · 오류 화면) · 소스 검사(lib/time 밖의 시각 글자 모양 · 한국어 화면 글의 UTC · 별칭을
    쓰는 파일) · `tests/kst-only-screens.test.ts`(모든 경로가 이 검사에 들어 있는지) · api `StatsAggregationDbTest`(KST 자정 경계 · KST 시) · `MigrationDbTest` V16 ·
    collector `test_db_writer`(KST 날짜) · `test_rest_contract_rules`(day_zone · KST 시).
  - 설명서 그림은 합치는 사람이 다시 찍는다(`lib/guide-shots.json` 의 설명 · 대체 글과 통계 날짜 고르기 선택자만 바꿨다 — `public/guide` · `lib/guide-manifest.json` 은 그대로).
    통합(2026-09-30): 찍는 스크립트는 실데이터 스택만 찍고(fixture 8701 은 멈춘다) 실데이터 스택(8700)은 아직 이 판이 아니라 다시 찍지 못했다. 13개 그림이 모두
    UTC · 옛 상태 바를 보여 그림 설명(KST 만 · 칩 + 상세)과 어긋나므로 그림과 manifest 항목을 지웠다 — 설명서는 ‘스크린샷 준비 중’ 자리표시와 그 화면의 설명을 보인다.
    배포 뒤 `node scripts/guide-screenshots.mjs http://localhost:8700 <자격 증명 파일>` 로 다시 찍는다.
## G. 13차 개정(2026-09-30 · 레인 route · 사용자 요청 "항공기 노선 조회도 권장 방안으로 진행해" — ADR-025 개정) — 선택 항공기 노선 조회도 세션 우편함 밖으로
- G21(§G18 이 남긴 일 · 계약 v4 §A 의 selected.route · ADR-008 세션 우편함) **선택 항공기 노선의 Redis 읽기는 세션 우편함 밖에서 — selected 는 곧바로 pending,
  답은 늦어도 Redis 명령 상한에**.
  - 관찰(코드 — `RouteSelectionLookupTest` 의 첫 시험이 옛 API 로 먼저 재현: GET 을 막은 동안 pong · diff 가 5 s 안에 오지 않음): `WsHub.sendSelected`(우편함
    작업)가 `RouteReader.forAircraft` 로 Redis GET `wakeline:route:{CALLSIGN}` 을 그 자리에서 읽었다(명령 상한 `spring.data.redis.timeout` 3 s, 콜사인별 5 s
    캐시 — 실패도 5 s). Redis 가 느리거나 답하지 않는 동안 선택 항공기 하나가 그 세션의 pong · 항공기 · 선박 diff · heartbeat 를 읽기마다 최대 명령 상한 3 s
    붙잡고, 캐시가 지날 때마다 되풀이했다.
  - Redis 연결이 기다리는 방식(`config.RedisConfig` 에서 확인 — 설정값 · 라이브러리 기본값, 잰 값 아님): 기본 연결은 `RedisConfig` 가 만든 팩토리라 Boot 의
    Redis 자동 구성이 물러난다(`@ConditionalOnMissingBean(RedisConnectionFactory)`) — `RedisConfig` 가 읽지 않는 `spring.data.redis.*` 키(예: `connect-timeout`)는
    효과가 없다. 명령 상한 = `spring.data.redis.timeout`(3 s): 서버가 답하지 않거나 끊긴 줄 모르는 연결에서 명령마다 이만큼. 끊긴 것을 아는 연결에서는
    `REJECT_COMMANDS` 라 곧바로 실패. 연결 맺기 상한은 설정하지 않아 lettuce-core 7.5.2 기본 10 s(`SocketOptions.DEFAULT_CONNECT_TIMEOUT`) — 공유 연결을 처음
    맺을 때(맺지 못했으면 다음 명령이 다시)만, 시도는 팩토리 잠금 안에서 하나씩.
  - api(`ws.RouteLookups` · `WsHub.selectedRoute` · `route.RouteReader`): 우편함은 `RouteReader.cached`(메모리 — I/O 없음)만 본다. 없으면 세션의 조회(같은
    물음)의 답, 그것도 없으면 노선 조회 실행기에 맡기고 돌아온다 — 데몬 스레드 4(`route-lookup-N`, **고른 값 — 잰 값 아님**: Lettuce 는 연결 하나를 여러
    스레드가 나눠 쓴다), 대기열 max(256, `wakeline.ws-max-conn`), 가득 차면 읽지 않고 곧바로 unavailable(`outcome=rejected` — 기억하지 않아 다음 다시 계산이
    다시 읽는다). 선박 조회 실행기(§G18 — 스레드 = DB 읽기 풀 연결 수)와 따로다: Redis 가 멈춰도 DB 조회 스레드를 잡지 않는다. 결과는 `SELECTED_ROUTE` 우편함
    작업으로 돌아와 다시 계산하고 바뀌었으면 보낸다.
  - 틀은 선박 조회와 같은 `ws.SelectionLookups`(§G18 의 `ShipLookups` 에서 선박에 매이지 않은 부분 — 출처 · 답/끝남(Flight) · 차례 · 마감 · 거절/예외 표시 ·
    지표 · 세션 쪽 세대(Pending) — 을 옮겨 일반화했다. 복사하지 않은 까닭: settled 가 답보다 먼저 · 마감 뒤 끝남이 다시 계산을 부름 · 답을 보내지 않은 조회만
    셈 같은 순서가 두 벌로 갈라지지 않게). `ShipLookups` 는 선박의 두 단계 사슬과 그 '읽지 못함' 값만 남고 동작 · 지표 이름은 그대로다.
  - selected(WS — 키 · 값 · 스키마 그대로): 물음(hex · 정규화한 콜사인)의 답이 캐시에 없으면 selected 를 **곧바로** route pending("노선 조회 중")으로 보내고,
    답이 오면 다시 보낸다. 5 s 캐시가 지나 같은 물음을 다시 읽는 동안은 이 세션에 이미 보낸 값을 그대로 싣는다(found 가 5 s 마다 "조회 중" 으로 깜박이지
    않는다 — 바뀌었으면 답이 올 때 보낸다). 그래서 **pending 의 뜻이 넓어진다**(계약 v4 §A "캐시 없음(선택 직후)"): 수집기가 아직 쓰지 않았거나, api 가 그
    결과를 읽는 중(≤ 아래 마감). 웹의 "노선 조회 중" 설명(title — `lib/route.ROUTE_PENDING_TITLE`)이 api 의 읽기와 그 상한을 적는다(`ROUTE_API_READ_BOUND_S`
    = 3 — `tests/route-pending.test.ts` 가 application.yml 의 값과 대조). 보통 경로 계산값 10 s(웹 `lib/route.ROUTE_NORMAL_PATH_S`)는 그대로다(api 의 다시 읽기 시간은 잰 값이 없어
    셈에 넣지 않는다 — 상한만 적는다).
  - 마감: api 는 늦어도 물음 뒤 Redis 명령 상한(운영 **3 s** — 설정값)에 답을 정한다. 설정 식은 한 곳 `RedisConfig.COMMAND_TIMEOUT`
    (`${spring.data.redis.timeout:3s}`)이고 `RedisConfig.commandTimeout`(Boot 의 Duration 해석과 같은 `DurationStyle` — 단위가 없으면 ms)으로 읽는다 — 기본
    연결의 Lettuce 명령 상한 · 이 마감(`WsHub`) · REST 기다림(`RouteReader`)이 같은 식이다. 해석할 수 없거나 0 이하면 기동하지 않는다. 그때까지 끝나지
    않았으면 unavailable("노선 조회 실패" — 계약 v4 §A 에 이미 있는 'Redis 오류'). 읽기는 계속돼 캐시를 채우고, 끝나면 곧바로 다시 계산해 실제 값을 보낸다 —
    실패를 붙잡아 두지 않는다. 앞 조회를 기다린 시간도 마감에 든다. 정한 답은 `SELECTED_ROUTE` 우편함 작업으로 나가므로 화면에 닿는 때는 그 세션 우편함의
    차례다(Redis 가 멈춘 동안은 앞선 status 작업이 먼저 기다릴 수 있다 — 아래 '남은 것', 상한은 말하지 않는다). 웹 title 도 그렇게 적는다.
  - 세대 · 단일 비행(§G18 과 같음): 다른 항공기 · 선택 해제 · 같은 항공기의 콜사인 바뀜 · 세션 닫힘이면 진행 중인 조회의 답은 버린다(답을 보내지 않은 조회 —
    `wakeline_ws_route_lookup_dropped_total`). 세션은 settled 까지 조회를 들고 있어 같은 물음의 다시 계산(항공기 이동 · focus 관측)은 새 읽기를 올리지 않고,
    다음 물음의 읽기는 앞 조회가 settled 된 뒤 시작한다(그사이 또 바뀌면 읽지 않는다 — `outcome=skipped`) — 세션마다 실행기 작업 하나 이하. 같은 콜사인은
    세션을 가로질러 Redis 읽기 하나(`RouteReader` 의 `persist.SingleFlight` — REST `/aircraft/{hex}` 도 붙는다, 기다림은 아래 상한까지). 캐시 시각은 읽기가 끝난 때(느린 읽기 뒤에도
    5 s 를 온전히).
  - REST 의 기다림 · 닫기(리뷰 2026-09-30): `SingleFlight` 는 진행 중 표시를 실행기에 올리기 전에 두므로 REST(`RouteReader.forCallsign`)가 아직 대기열에 있는
    WS 읽기에 붙을 수 있다 — 고치기 전에는 Redis 가 멈춘 동안 대기열 순서만큼 상한 없이 기다렸다. 이제 붙은 쪽은 Redis 명령 상한까지만 기다리고 unavailable 로
    답하며 센다(`wakeline_route_read_wait_timeouts_total` — 그 읽기는 그대로 둬 제 값으로 캐시를 채운다). REST 가 표시를 얻었으면 전처럼 제 스레드에서 한 번
    읽는다. `WsHub.stop` 이 조회 실행기를 `shutdownNow` 로 닫을 때 대기열에서 버린 읽기는 `SingleFlight.abandon` 으로 거절처럼 끝내고 표시를 지운다(그러지
    않으면 그 future 가 끝나지 않아 같은 콜사인의 REST 가 붙었다 — 선박 조회도 같은 틀).
  - 새 최악(설정값 — 잰 값 아님): 세션의 pong · diff · heartbeat ping 은 노선 읽기를 기다리지 않는다. 첫 selected 는 곧바로(pending), api 가 노선의 답을
    정하는 때 ≤ 3 s(화면에 닿는 때는 우편함 차례). REST 항공기 상세의 노선 ≤ 3 s(제가 읽든 붙든 — 공유 연결을 맺어야 하는 제 읽기는 연결 맺기가 더해진다).
    스레드 하나를 잡는 시간 ≤ 3 s(서버가 답하지 않을 때) · 곧바로(끊긴 것을 아는 연결) · 공유 연결을 아직 맺지 못했을 때는 연결 맺기(시도마다 ≤ 10 s, 잠금
    안에서 하나씩) + 3 s. Redis 가 멈춘 동안의 처리량 = 스레드 4 / 3 s — 넘치는 물음은 대기열에서 기다리고(세션마다 하나) 답은 여전히 마감에 나간다.
  - 남은 것(범위 밖 — 같은 종류): heartbeat · 초기 세트의 status 메시지는 여전히 우편함에서 Redis 를 읽는다 — `WsHub.statusPayload`(3 s 캐시)가 허브 전체 잠금
    (`statusLock`) 안에서 `StatusService.publicStatus` 를 부르고 그 안의 `safeHash` 셋(HGETALL — collector heartbeat · radar_kr meta · active providers)이 각
    명령 상한 3 s 를 기다릴 수 있다(합 ≤ 9 s — 설정값의 합). Redis 가 멈춘 동안은 heartbeat 주기(30 s)마다 한 세션이 그만큼 만들고 다른 세션은 그 잠금을
    기다린다. 연결 맺기 상한도 `RedisConfig` 가 설정하지 않는다(Lettuce 기본 10 s — 공유 연결을 맺을 때만). `spring.data.redis.connect-timeout` 을 적어도
    효과가 없다(`RedisConfig` 가 읽지 않는다 — 바꾸려면 `RedisConfig` 의 `SocketOptions` 로).
  - 지표: `wakeline_ws_route_lookups_total{outcome=ok|deadline|rejected|error|skipped}` · `wakeline_ws_route_lookup_seconds`(물음 → 답) ·
    `wakeline_ws_route_lookup_queue` · `wakeline_ws_route_lookup_dropped_total` · `wakeline_cache_requests_total{cache=route,result=hit}`(진행 중인 읽기에 붙은
    것 포함 — miss 는 실제 Redis 읽기) · `wakeline_route_read_wait_timeouts_total`(REST 가 붙은 읽기를 명령 상한까지 기다렸지만 끝나지 않음). 시험:
    `RouteSelectionLookupTest`(가짜 Redis 가 GET 을 막음 — pending 동안 pong · diff · heartbeat 주기 · 마감의 unavailable 과 늦은 실제 값 · 마감 뒤 다시 계산은
    새 읽기 없음 · 늦은 답 버리기 · 포화 · 세션을 가로지른 한 읽기 · 항공기를 바꿔도 작업 하나 · 다시 읽는 동안 깜박이지 않음 · 운영 배선 · 명령 상한을 읽는
    곳이 모두 한 식 · 닫을 때 버린 읽기는 거절로 끝남) · `WsIntegrationTest`(스프링이 만든 허브의 마감 = 속성 2500ms) · `RedisConfigTest` ·
    `RoutePausedRedisTest`(Testcontainers redis:8-alpine 을 docker pause — 각 500 ms 미만을 단언, 시험이 고른 명령 상한 1.5 s 에 unavailable, 같은 동안 REST 도
    그 안에, 다시 풀면 found) · `RouteReaderTest`(대기열의 읽기에 붙은 REST 는 명령 상한에 unavailable · 운영 생성자가 속성에서 상한을 읽음) · 웹
    `route-pending.test.ts`. ADR-025 '개정' 절.

## G. 14차 개정(2026-09-30 · 레인 kma · 운영/로그 스크린샷 — 기상청 레이더 '파일 없음'이 로그를 채우고 운영은 '성공'으로 보였다)
레인에서는 13차 · §G21 로 썼다 — 세 레인을 합칠 때(integ, 2026-09-30) 노선 조회(13차 · §G21) 다음으로 옮겼다: 14차 · §G22(`tests/docs-contract-g11` 이 번호가 겹치지 않는지 본다).
- G22(FR-31 · R-03 · R-72 · §G20) **기상청 내려받기 '파일 없음' 연속을 이름 붙여 싣는다 — 로그는 연속마다 WARN 한 번, 실행은 'missing', 화면은 까닭을 적는다**.
  확인(오케스트레이터가 실제 호출로, 2026-09-30 09:50 KST 무렵): 목록 API `rdr_cmp_file_list.php?cmp=HSR&tm=20260930`(기본 ext=Y)은 `RDR_CMP_HSR_EXT_*` 를,
  ext=K 는 EXT 와 `RDR_CMP_HSR_KMA_*` 를 09:50 KST 까지 싣는데 내려받기 API `rdr_cmp_file.php?tm=…&data=bin&cmp=HSR` 는 202609300815 부터 모든 tm 에 HTTP 200
  `# file not exist (RDR_CMP_HSR_PUB_<tm>.bin.gz)` 로 답했다(0800 · 0810 은 gzip). 내려받기에 ext=Y · ext=K 를 붙여도 PUB 를 찾고, 문서에는 tm · data · cmp · authKey 와
  PUB 파일 이름만 있다 — 공급자 쪽에서 내려받기 파일이 멈춘 것이고 우리 해석 문제가 아니다. 결함 셋: tm 마다 3번 뒤 WARN(5분마다 같은 지문 — 로그 화면이 그것으로 찼다),
  저장한 프레임이 없는 주기도 실행 'ok' · 공급자 LAST SUCCESS 갱신(RECORDS 0 · FAILS 0), 까닭이 어디에도 없음(KMA 칩은 나이로 STALE 만).
  - 수집기(`jobs/kma_radar.py`): tm 이 R-03 의 3번 모두 없다고 답했고 그보다 새 파일이 없으면(저장된 프레임 · 같은 주기에 받은 파일 — 주기의 후보를 모두 본 뒤에
    가린다: 후보는 오래된 것부터라 한 tm 씩 바로 가리면 뒤이어 온 늦은 파일을 보기 전에 연속을 열고 닫았다, 통합 리뷰 2026-09-30) 연속(`MissingStreak` — 첫 tm · 마지막 tm · 없다고 답한
    서로 다른 tm 수(확인한 tm 마다 한 번 — 확인하지 않은 tm 은 세지 않는다) · 마지막 확인 · 답에 적힌 파일 이름 · 목록이 그 tm 에 싣는 종류)을 연다. 첫 tm · 수에는 이
    프로세스에서 없다는 답을 받은, 파일이 있던 가장 새 tm 보다 새 tm 을 모두 넣는다(세 번을 채우기 전에 후보에서 밀려난 tm 포함 — 연속 한가운데서 다시 띄운 수집기의
    첫 tm 이 늦지 않게. 그 프로세스가 연속 전에 한 번도 묻지 않은 tm 은 받은 답이 없어 세지 않는다). 연 순간 WARN 한 번,
    그 뒤로는 `MISSING_REMIND_S`(60분 — 선택값)마다 주기 끝에 한 번만, gzip 이 다시 오면 INFO(공백 길이 — 첫 tm 부터 다시 온 tm 까지). 연속 동안은 주기마다 두 tm 만
    확인한다(`streak_probes` — 저장 안 됨 · 해석 불가 아님): 목록의 가장 새 tm 과, 첫 tm 이후이면서 `MISSING_RECHECK_S`(10분 — 선택값, R-03 의 마지막 시도 나이) 넘게
    앞선 가장 새 tm. 뒤의 것은 목록이 먼저 싣고 파일은 늦게 생기는 tm(R-03 — 2026-09-28 첫 시도에 182 중 14 tm) 때문이다: 가장 새 tm 하나만 보면 회복 뒤에도 그 tm 은
    아직 없어서 연속이 닫히지 않았다(리뷰). 예산 `budget:kma_radar` 주기당 목록 1 + 확인 2 = 하루 864 < 한도 1,000(전에는 목록 1 + 바이너리 4 = 하루 1,440).
    회복 뒤에는 보관 창의 빈 곳을 전처럼 다시 시도하고, 알린 공백 안의 tm 을 포기할 때는 INFO — 알린 공백은 meta 해시에도 남겨 다시 띄운 수집기도 읽는다
    (끝 tm 이 `MISSING_GAP_KEEP_S` 3 h 를 넘으면 버린다). 더 새 프레임은 받았는데 한 tm 만 없으면 연속이 아니다(전처럼 그 tm 에 WARN 한 번).
    `KMA_APIHUB_KEY` 가 없어 수집하지 않으면 남은 연속 · 알린 공백을 지운다. 연속 중 목록 호출이 실패하면 실행 'error', 연속과 마지막 확인은 그대로다. 목록 줄의 종류(EXT · KMA …)는 공급자가 파일 이름에서 읽어 tm 마다 싣는다
    (`parse_file_kinds` — 목록 글자 그대로). 수집기를 다시 띄우면 마지막 확인이 `MISSING_CARRY_S`(15분 — 선택값) 안인 연속만 이어받고, 아니면 지운다.
  - 실행 기록(`ingest_run.status`, 주기마다 하나): 프레임을 저장했거나 새로 받을 tm 이 없으면 `ok`, 새 tm 이 있었는데 저장한 프레임이 없으면 — 바이너리 예약이
    거절돼 멈췄으면 `budget_exhausted`(· `budget_unavailable`), '파일 없음' 답이 있었으면 `missing`, 해석 불가만이면 `quarantined`(오류 글자 = 마지막 답 · 연속 요약). `ok` 가 아닌 주기는 공급자 해시의 `last_success_at` · `last_records` 를 갱신하지 않는다
    (예산 사용량은 쓴다 · `consecutive_failures` 는 호출 실패만 센다 — 그대로).
  - 수집기 해시: `wakeline:radar_kr:meta` 와 `wakeline:provider:kma_radar` 에 `missing_since_tm` · `missing_last_tm` · `missing_tms` · `missing_checked_at`(UTC ISO) ·
    `missing_file` · `missing_listed`("EXT,KMA") — 닫으면 빈 값. 쓰기에 실패하면 다음 주기에 다시 쓴다. meta 해시에만 알린 공백 `missing_gap_from` · `missing_gap_to`
    (수집기 내부 값 — api 는 싣지 않는다).
  - api(R-72 — `KrRadarMissing`): `/radar/kr` 와 `/status` · WS `status` 의 `radar_kr` 에 `missing {since_tm, last_tm, tms, checked_at, file?, listed?}` — 연속이 없으면 키가 없다.
    핵심 값(since_tm · last_tm ≥ since_tm · tms ≥ 1 · 시간대 있는 checked_at)이 하나라도 틀리면 연속 전체를 빼고 센다(`wakeline_radar_kr_parse_errors_total{field="missing"}`),
    파일 이름(`RDR_CMP_…_<tm>.bin.gz`) · 종류(`[A-Z]{1,8}` 최대 8개)만 틀리면 그 키만 뺀다. `/radar/kr` 의 ETag 에 든다 — 프레임이 그대로여도 연속이 바뀌면 304 가 아니다.
    `/ops/providers` 는 공급자 해시를 그대로 싣는다(웹이 형식을 본다).
  - 계약 검사: `schemas/ws/server.v1.json` `status.radar_kr.missing` · `tools/rest_contract_check.py` `KR_MISSING`(교차 검사: last_tm ≥ since_tm, 파일 이름의 tm 은 그 사이) ·
    기록 표본 `radar_kr_missing`(연속 중 — missing 필수) · `status_ais`(missing 필수) · 웹 검증기 `lib/ws-validate` `KR_MISSING`(웹 표본 `ws-samples.v1.json` 을 다시 만들었다).
  - 웹(KST 만 · 값은 api 그대로 · 모르면 쓰지 않는다 — `lib/kr-radar krMissing`): 잰 것만 — 한 줄 `기상청 내려받기 파일(PUB) 없음 — tm 08:15–09:50 KST ·
    확인한 tm 20개 모두 없음 · 목록에는 EXT · 마지막 확인 09:50:31 KST`(구간 = 없다는 답을 받은 가장 이른 · 가장 새 tm, 수 = 확인한 서로 다른 tm — 구간의 tm 이 모두
    그만큼이라고 하지 않는다. PUB 는 기상청 답의 파일 이름에서 읽는다 — 뜻을 풀지 않는다). 마지막 확인이 `KR_MISSING_CHECK_STALE_MIN`(15분 = 수집기 `MISSING_CARRY_S`,
    시험이 견준다)을 넘으면(서버 기준 지금) `확인 멈춤`을 붙인다 — 수집기가 멈추면 연속을 지울 주체가 없다. 나이 경계는 웹이 둔다(운영 표는 api 가 검증하지 않는 공급자
    해시를 읽으므로 한 곳 — `isKrRadarStale` 의 나이 쪽과 같은 방식). KMA 칩 낱말 `파일 없음`(`파일 없음 · 확인 멈춤`, 주의 이상 · 줄에 고정, 문장은 title) ·
    상세 행 `기상청 내려받기 파일` · 레이더 패널 · 범례 · 타임라인(쓸 수 있으면 `파일 없음` 표시, 보관 프레임이 만료됐으면 `기상청 레이더 없음 — …`) · 운영 공급자 표
    (kma_radar 행 아래 주의 줄) · 실행 상태 `missing` · `quarantined` 는 주황과 뜻(title). 보관 프레임이 모두 만료돼 '사용 불가'여도 연속을 알면 KMA 칩을 남긴다.
  - 바꾸지 않는 것: 영상 · 목록 일관성(REL-19), STALE 기준(900 s — meta.fetched_at), 연속이 아닐 때의 R-03 3번 시도, 부분 합성 다시 받기(ADR-021), 원문(로그 메시지 본문 ·
    실행 오류 글자 — 기상청 답 앞부분 그대로).
  - 회귀 막기: collector `tests/test_kma_missing.py`(WARN 수 · 확인 2개 · 예산 · 회복 · 늦게 생기는 파일의 회복 · 예산 멈춤 실행 하나 · 알린 공백의 재기동 ·
    서로 다른 tm 수 · 키 없음 지우기 · 목록 실패 · 실행 상태 · 해시 · 이어받기 · 다시 쓰기 · 같은 주기의 늦은 파일은 한 tm · 연속 중 재기동의 첫 tm · 주기가 중간에
    끝나도 포기한 tm 을 알림) · `test_redis_integration`(수집기 ACL 아래 HGETALL meta · HSET missing_* · 알린 공백 — 실 Redis) · `test_rest_contract_rules` · api
    `KrRadarMissingTest` · `StatusServiceTest` · `RadarKrIT`(ETag · /status) · `RestSamplesIT` · `WsSchemaContractTest` · web `tests/kma-missing.test.ts` ·
    `tests/mapview-lifecycle.test.ts`(타임라인) · `tests/ops-page.test.ts`(공급자 줄 · 실행 상태 색).

## G. 15차 개정(2026-09-30 · 레인 ais · 로그 화면의 keepalive 1011 두 건) — ais 수신 진단 필드 · 끊김 로그 수준
레인에서는 13차 · §G21 로 썼다 — 세 레인을 합칠 때(integ, 2026-09-30) 번호만 뒤로 밀었다: 15차 · §G23(내용은 §G21 · §G22 와 겹치지 않는다).
- G23(§B1 상태 해시 · §C2 · 계약 v4 §D · ADR-014 부록 C) **ais 수신 진단 — 필드만 더하고 `ais_gap` 의미 · 기존 필드는 그대로**
  - `wakeline:ais:status` 에 더한 필드(문자열, 모르면 빈 값 — 0 으로 채우지 않는다): 최근 `diag_window_s`(60 — 고른 값) 초의 최댓값 `loop_lag_max_s`(이벤트 루프 지연, 초 소수 2자리) ·
    `queue_wait_max_s`(원문 대기열에 머문 시간) · `queue_depth_max`(대기열 깊이) · `ws_queue_max`(websockets 수신 버퍼에 남은 프레임, 구역 최댓값) · `ping_rtt_max_s`(keepalive 왕복,
    구역 최댓값), 고른 값 `ws_queue_limit`(64 — `ws_queue_max` 가 이 값 이상이면 그때 소켓 읽기가 잠시 멈춰 있었다: 한꺼번에 받은 묶음이나 루프 멈춤 뒤, 결함 아님) · `ping_timeout_s`(20), 누적 `loop_stalls_total`(루프 지연 ≥ 1 s 표본 수) · `reconnects_quick_total`
    (받던 연결이 끊겨 열린 공백 — 마지막 데이터 → 다시 받은 데이터 — 이 30 s 안에 닫힌 횟수, 없앤 구역 포함). `queue_wait_max_s` 에는 지금 맨 앞에서 기다리는 원문의
    머문 시간도 든다(정리 태스크가 멈춰도 모름이 되지 않게). 수집기가 고른 값(잰 값 아님 — 읽는 쪽이 숫자를 들고 있지 않게 싣는다, 초는 지수 없는 십진수):
    `queue_limit`(원문 대기열 건수 상한) · `loop_tick_s`(0.5) · `loop_stall_s`(1) · `loop_warn_s`(5) · `loop_warn_every_s`(60 — 루프 측정이 없는 수집기면 넷 다 빈 값) ·
    `reconnect_quick_window_s`(30) · `reconnect_warn_count`(3) · `reconnect_warn_window_s`(1800). fixture 재생은 연결이 없어 `ws_queue_max` · `ping_rtt_max_s` 만 빈 값이다
    (루프 지연 · 원문 대기열은 두 모드 모두 잰다 — `main.py`).
  - `shards[]` 원소에 `ping_rtt_max_s`(초 수 또는 null) · `ws_queue_max`(정수 또는 null)를 끝에 더한다 — 원소 필드 순서는 `SHARD_FIELDS`(contract_check 가 본다).
    api `AisStatus` 는 이 둘을 읽지 않는다(지금 필드만 검사 — 더한 필드가 있어도 구역 정보를 버리지 않는다, `AisStatusTest` · `RestSamplesIT` 표본에 실었다).
  - `GET /api/v1/ops/pipeline` 의 `ais` 에 같은 이름(snake_case)으로 싣는다: `reconnects_quick_total` · `loop_lag_max_s` · `loop_stalls_total` · `queue_wait_max_s` ·
    `queue_depth_max` · `queue_limit` · `ws_queue_max` · `ws_queue_limit` · `ping_rtt_max_s` · `ping_timeout_s` · `diag_window_s` · `reconnect_quick_window_s` ·
    `reconnect_warn_count` · `reconnect_warn_window_s` · `loop_tick_s` · `loop_stall_s` · `loop_warn_s` · `loop_warn_every_s`. 같은 신선도 규칙(updated_at 30 s)이고 초는
    부호 · 지수 없는 십진수만, 수 · 상한은 정수만 — 그 밖은 null. `diag_window_s` 도 초다(수집기 `_setting` · contract_check 와 같이 — 통합 리뷰 2026-09-30 에
    api 만 정수로 읽던 것을 고쳤다: 창이 60.5 처럼 소수가 되면 조용히 null 이었다). 운영 PIPELINE 탭은 창 · 상한 · 시간 초과를 detail 에 "수집기 설정" 으로 적고, 설명의 고른 숫자
    (회복 창 · 되풀이 WARN 기준 · 루프 틱 · 멈춤 · WARN 문턱과 간격)를 응답에서 채운다(모르면 "—"). 색으로 판정하지 않는다: 수신 버퍼가 상한 이상이면
    "상한 도달 — 그때 소켓 읽기가 잠시 멈춤(한꺼번에 받은 묶음 또는 루프 멈춤 — 결함 아님 …)" 을 적을 뿐이다(꺼낸 뒤 남은 수라 상한과 같아도 멈춰 있었다).
    어느 것도 손실 수가 아니다(손실 배지에 들지 않는다).
  - 끊김 로그 수준(수집기, 계약 v5 §C2 의 WARN · ERROR 싣기와 함께 읽는다): 받던 연결이 끊겨 열린 공백(마지막 데이터부터)이 30 s 안에 닫히면 INFO(로그
    화면에 오르지 않는다 — `reconnects_quick_total` 로 센다). 창은 끊긴 순간이 아니라 공백 길이로 잰다. 같은 연결이 30분에 3번째부터 끊김 · 끊길 때 공백이 이미
    30 s 를 넘음(idle 끊김 등) · 데이터 없이 끝난 연결 · 공백이 30 s 를 넘도록 다시 받지 못함(과 그 뒤 늦은 회복)은 WARN.
    `reconnects_quick_total` 은 로그 수준이 아니라 공백 길이로 센다: 되풀이 끊김(끊김 줄 WARN) · 그 사이 데이터 없이 끝난 재연결 시도(WARN)가 있었어도 공백이
    30 s 안에 닫히면 센다(회복 줄은 INFO) — 운영 "짧은 재연결" 설명도 그렇게 적는다('INFO 로만 남는 끊김' 이 아니다, 통합 리뷰 2026-09-30).
    공백(`ais_gap` · AIS 수신 공백 목록 · 상태 해시 `gap_*`)은 로그 수준과 상관없이 그대로 기록한다. 끊김 로그 한 줄에 최근 60 s 최댓값과 공급자 지연 p50 을 붙인다.
  - 회귀 막기: collector `test_ais_keepalive`(1011 기제 재현 — 루프 멈춤은 두 콜백 순서를 각각 고정) · `test_ais_diag`(한꺼번에 받은 묶음 · 멈춘 소비자 ·
    고른 값 싣기) · `test_ais_reconnect_log`(공백 길이로 재는 회복 창) · `tools/contract_check.py`(새 필드 모양 · main.py 처럼 만든 fixture 의 모름 · 구역 최댓값),
    api `OpsPipelineControllerTest` · `OpsPipelineIT`, 웹 `tests/ops-pipeline-ais-diag.test.ts`(설명에 숫자를 적지 않음 포함).
