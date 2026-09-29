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

## G. 12차 개정(2026-09-30 · 레인 kst · 사용자 결정 "[상황판·재생·통계·공항 화면]을 포함한 필요한(해당되는) 메뉴에 시각을 UTC 지우고, KST 표시") — 화면 시각은 KST 만
같은 날 병행 레인(백엔드)이 11차 개정으로 §G18 · §G19 를 먼저 썼다 — 이 절은 그다음 번호 §G20 이다(합칠 때 11차 개정이 이 절 앞에 온다. 번호는 `tests/docs-contract-g11` 이 겹치지 않는지 본다).
- G20(§G13 · §G11 · §G10 · §C7 · ADR-017 R-45) **화면의 시각은 한국 표준시(KST)만 — UTC 는 저장 · 전송 형식으로만 남는다** — §G13 의 "KST 먼저 · UTC 함께"
  (두 시간대 · UTC 쪽 날짜 · 머리글 `(KST · UTC)` · compact `…Z` · 원본 UTC 툴팁)와 §G10 · §G11 의 "원본 UTC 는 툴팁" 을 대신한다. API · WS · DB · 서버 로그의 시각은 UTC ISO 그대로다.
  - 한 곳: `lib/time.ts`(글자 — 화면 시간대는 `DISPLAY_TZ` 한 곳이 정한다: KST · Asia/Seoul · +09:00 고정) · `components/KstTime.tsx`(`<KstTime>` · `<KstRange>` —
    `<time dateTime>` 에 ISO 8601 +09:00, title 에 연도 · ms 까지의 KST). 화면 코드는 시각 글자를 직접 만들지 않는다(§G13 의 소스 검사 그대로 — 예외는 복사 형식 ·
    오류 화면 · 선박 ETA 뿐, 파일 · 줄 수까지 시험에 고정).
  - 범위: 모든 화면 — 상황판(상태 바 · 알림 · 카드 · 목록 · 지도 툴팁 · 선 라벨 · 레이더 타임라인 · 기상청 패널 · 연안 교통량 · 입출항) · 재생 · 통계 · 공항 · 운영 ·
    로그 · 출처·한계 · 설명서 · 오류 화면. 보이는 글자 · title · aria-label 어디에도 UTC 가 없다(원문 제외).
  - 형식(lib/time 이 만드는 글자): inline `09-29 14:02:54 KST` · 날짜가 자명한 자리 `14:02:54 KST` · 좁은 자리(상태 바 · 지도 툴팁 · 선 라벨 · AIS 공백 배지)
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
      판단하면 00–08시가 빠진 수를 완료로 남긴다(리뷰). 원본이 사라진 교통량 · 알림 날과 격리 수(실행마다의 규칙별 수는 이 표에만 있다)는 다시 셀 수 없어
      비어 있고, 화면이 '집계되지 않은 날짜 — … KST 날짜 집계로 바꾸기 전 날짜' 로 말한다.
    - 경계가 UTC 날로 정해진 것 — 수집기 하루 예산 키(`budget:{공급자}:{yyyymmdd}`, 공급자 한도와 맞춘 UTC 날)와 그것을 옮긴 `provider_budget_day` — 는 바꾸지 않고,
      화면이 그 창을 KST 로 적는다: `09-28 09:00 – 09-29 08:59 KST`(머리글 `budget window (KST)`, "매일 09:00 KST 에 새로 시작" — lib/time `utcDayWindowKst`).
      `/ops/providers` 가 `budget_day_zone: "UTC"` 로 밝힌다. 시간 창 예산(`…:h:{yyyymmddHH}`)은 시 경계가 KST 와 같아 바꿀 것이 없다(화면에 나오지 않는다).
    - 웹은 응답이 밝힌 기준만 믿는다: `day_zone` 이 `Asia/Seoul` 이 아닌 통계 · 격리 수 응답, `budget_day_zone` 이 `UTC` 가 아닌 예산 응답은 날짜 · 창을 그리지 않고
      그렇다고 적는다(옛 api 와 새 웹이 섞인 배포 중에 UTC 날짜를 KST 날짜로 보이지 않게). 통계 날짜의 옛 "UTC 자정 시각" 문자열은 날짜로 읽지 않는다(`—`).
  - 바꾸지 않는 것: API · WS · DB · 서버 로그의 시각(UTC ISO), 복사 · 내려받기 형식(텍스트 머리 줄 ISO `+09:00`, 항목 JSON · `.ndjson` 의 `ts` — 버튼 title 이 "서버 형식 ‘…Z’" 라 적는다), 원문.
  - 성능: §G13 과 같다 — 고정 오프셋 산술(Intl 없음 — 형식기 생성 비용 · ICU 차이 없음), 같은 입력의 분해 결과 캐시(2,048개, 차면 비움, `TIME_CACHE_MAX`).
  - 옮기는 중인 이름: 다른 레인(대시보드 UX)이 같은 때 고치는 파일(StatusBar · AlertPanel · AircraftSearch · AircraftCard)은 이 레인이 건드리지 않았다 — 그 파일과
    그 레인의 새 코드(lib/statusbar.ts · lib/ships.ts)가 쓰는 `DualTime` · `dualPair` · `fmtDual` · `dualParts` · `dualRangePair` · `fmtDualDayMinute` · `fmtDualSpan` 을
    **KST 전용 별칭(@deprecated)** 으로 남겼다(UTC 쪽 필드 없음 — 그 레인도 이미 KST 만 그린다). 합친 뒤 호출부를 `KstTime` · `fmtKst` · `timeParts` · `fmtKstRange` ·
    `fmtKstDayMinute` · `fmtKstSpan` 으로 옮기고 별칭을 지운다. 상단 검색 상자의 설명 한 줄("… KST · UTC(…Z) …")이 남아 있다 — 시험(`tests/helpers/kst-only` OTHER_LANE_PENDING)이 셈하고, 고치면 알린다.
  - 회귀 막기: `tests/kst-time.test.ts`(형식 · 모름 · 캐시 · 컴포넌트) · `tests/helpers/kst-only.ts`(글자 · DOM 의 UTC 흔적 — data-raw 밖) · 화면마다 그 검사(상황판 전체
    `tests/kst-dashboard.test.ts` · 재생 · 통계 · 공항 · 운영 · 로그 · 출처 · 설명서 · 오류 화면) · 소스 검사(lib/time 밖의 시각 글자 모양 · 한국어 화면 글의 UTC · 별칭을
    쓰는 파일) · `tests/kst-only-screens.test.ts`(모든 경로가 이 검사에 들어 있는지) · api `StatsAggregationDbTest`(KST 자정 경계 · KST 시) · `MigrationDbTest` V16 ·
    collector `test_db_writer`(KST 날짜) · `test_rest_contract_rules`(day_zone · KST 시).
  - 설명서 그림은 합치는 사람이 다시 찍는다(`lib/guide-shots.json` 의 설명 · 대체 글과 통계 날짜 고르기 선택자만 바꿨다 — `public/guide` · `lib/guide-manifest.json` 은 그대로).
