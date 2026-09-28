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
  - 항적: 기간 6 · 12 · 24 h 선택, 항적 점에 마우스를 올리면 시각(UTC) · 속력(kn · km/h) · 침로 · 항해 상태. 속력·상태는 API `points[]` 값 그대로(없으면 `—`).
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
  - 목록: 시각(UTC) · 수준 배지 · 서비스 · 로거 · 메시지 첫 줄 · 억제 수 · 요청 id. 상세: 전체 메시지 · 예외 종류·메시지 · 스택(mono, 줄바꿈 전환) · context · 같은 fp 묶음 통계 · 같은 요청 id 의 다른 항목.
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
