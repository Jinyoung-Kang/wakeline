# 변경 계약 v4 — 출발지·도착지 · 선박 실시간 표시 · 지도 시인성 (v2·v3 를 고치는 부분만)

v2·v3 는 그대로 유효하다. 아래 항목만 대체·추가한다. 근거는 §0 의 실측이다(2026-09-28 03:2x–03:4x UTC, 이 기계).

## 0. 실측
- **선박이 "안 뜨는" 곳**: aisstream 원천을 한 연결로 60 s 직접 받아 셈 — 부산 앞바다 0척 · 페르시아만 0 · 아라비아해 0 · 인천 31 · 도쿄만 134.
  공급자 수신국이 없는 해역이다(우리 쪽 필터가 아니다). REST·WS 도 같은 수(인천 칸 95척 · 도쿄만 451척).
- **WS 경로는 실시간**: 줌 9 도쿄만 스냅샷 393척 → 10 s 마다 diff(이동 10–22척, 관측 나이 중앙값 8–17 s). 웹도 diff 를 그대로 반영한다(lib/ws.ts).
- **그런데 줌 < 7 은 격자만** 보낸다(ShipFanout.POINTS_MIN_ZOOM = 7). 사용자 화면(줌 5–6)에서는 개별 선박이 보이지 않고, 회색 격자 원이 어두운 육지·항공기 아이콘 밑에 묻힌다.
- **연결 하나의 지연**: 0~45°E 제외 전 해역 1연결 — 공급자 쪽 지연 p50 7.9 s · p90 17.9 s, 6시간에 연결 종료 51회(keepalive 20 s 초과).
  **2연결로 나누면**(아메리카 `-90,-180,90,0` / 아시아·태평양 `-90,45,90,180`, 동시 10분): p50 1.9 s · 1.8 s, p90 6.0 s · 4.6 s, 최대 10.1 s, 끊김 0.
- **지도**: OpenFreeMap dark 의 육지(background rgb 12,12,12)와 바다(water rgb 27,27,29)의 명암비 약 1.2:1 — 구분이 거의 안 되고 바다가 오히려 밝다. 지명 글자 rgb 101,101,101 은 배경 대비 4.5:1 미만.
- **노선 공급자**: adsb.lol `/api/0/routeset` 은 계약대로 요청해도 201 + 빈 본문(두 번 시도). adsbdb.com `/v0/callsign/{CALLSIGN}` 은 200 + 출발·도착 공항(예: APJ736 김포 → 간사이).
  adsbdb 는 노선 자료에 대해 "David J Taylor 의 명시적 허락 없이 복사·게시·다른 데이터베이스에 넣지 말 것" 을 적고 있다(README, 2026-09-28 확인). 호출 한도는 문서에 없다.

## A. 항공기 출발지·도착지(ADR-016)
- 공급자: adsbdb `GET https://api.adsbdb.com/v0/callsign/{CALLSIGN}`. CALLSIGN = 공급자 콜사인을 trim·대문자, `^[A-Z0-9]{3,8}$` 일 때만(아니면 조회하지 않고 상태 `no_callsign`).
- **호출 주체는 collector 뿐**, 계기는 집중 추적 임대(선택한 항공기)뿐이다. 집중 추적 조회 결과의 콜사인이 캐시에 없으면 조회한다.
  속도 상한: RateLimiter 호스트 `api.adsbdb.com` 0.5 req/s · burst 2, 수집기 전체 2 req/s 버킷 공유, 우선순위는 핫 리전보다 낮게, 대기 상한 10 s.
  일일 예산 공급자 이름 `adsbdb` 2,000(예약·해제는 기존 규칙). 429 는 호스트 벌점(기존 규칙).
- **저장하지 않는다**(약관): PostgreSQL·파일·원천 보관(raw)에 쓰지 않는다. Redis 캐시만 — 키 `wakeline:route:{CALLSIGN}`, 값 JSON, `SET EX`:
  found·not_found 1,800 s, error 120 s. 로그에는 콜사인·상태만(노선 내용은 쓰지 않는다).
- 캐시 값: `{"v":1,"status":"found"|"not_found"|"error","callsign":str,"fetched_at":ISO,"airline":{"name","icao","iata"}|null,"origin":Airport|null,"destination":Airport|null,"midpoint":Airport|null}`.
  Airport = `{icao ^[A-Z0-9]{4}$, iata ^[A-Z0-9]{3}$|null, name ≤120, city ≤80|null, country ≤80|null, country_iso ^[A-Z]{2}$|null, lat [-90,90], lon [-180,180]}`.
  검증을 통과하지 못한 공항은 null, 출발·도착 둘 다 없으면 not_found. 문자열은 제어문자 제거·길이 절단.
- api: WS `selected` 와 REST `GET /api/v1/aircraft/{hex}` 에 `route` 를 싣는다:
  `{status: found|not_found|pending|unavailable|no_callsign, callsign|null, airline|null, origin|null, destination|null, midpoint|null, fetched_at|null, source:"adsbdb"}`.
  pending = 캐시 없음(선택 직후 — 계약 v5 §G21: api 가 그 캐시를 읽는 중도 pending, 읽기는 늦어도 Redis 명령 상한 3 s), unavailable = 캐시 status error 또는
  Redis 오류(§G21: 그 상한까지 읽지 못함 포함). api 는 콜사인별로 5 s 메모리 캐시. 값은 다시 검증한다(수집기 값을 믿지 않는다).
- 웹 항공기 카드 "노선(콜사인 기준 등록 노선)": 출발·도착 공항(ICAO·IATA·이름·도시·국가), 경유(midpoint), 항공사, **현재 위치와 노선 대권 경로 사이 거리(km, 계산값)**,
  주의 문구 "콜사인에 등록된 정기 노선입니다 — 실제 운항 경로와 다를 수 있습니다", 출처 "adsbdb.com · flight route data © David Taylor, Edinburgh & Jim Mason, Glasgow".
  pending "노선 조회 중", not_found "이 콜사인의 등록 노선 없음", no_callsign "콜사인 없음 — 노선을 찾을 수 없음", unavailable "노선 조회 실패".

## B. 선박 출발지·도착지
- AIS 에는 출발지 항목이 없다. 목적지는 선원이 입력한 자유 문자열이다. api 가 **결정적 규칙**으로만 풀이한다(추정하지 않는다):
  - 정규화: 대문자 · 앞뒤 공백 제거 · 연속 공백 하나로.
  - `A<=>B` · `A<>B` → kind `between`, `A>B` → `from_to`(보고된 출발 A · 도착 B), 앞에 `>` 만 있는 `>B` → `to`, 그 밖 → `text`.
  - 각 조각의 UN/LOCODE: 공백형 `^([A-Z]{2}) ([A-Z0-9]{3})(?: .*)?$`(뒤에 선석 등 문구 허용) 또는 붙임형 `^([A-Z]{2})([A-Z0-9]{3})$`(정확히 5자).
    조회 대상은 UN/LOCODE 중 기능 코드에 항구(1) 또는 내륙항(8)이 있는 항목만. 붙임형 5자가 UN/LOCODE 의 어떤 지명과도 같으면(예: CAVAN) `ambiguous:true`.
- 응답: REST `GET /api/v1/ships/{mmsi}` 와 WS `ship_selected` 에 `destination_info`:
  `{raw, kind, from: Place|null, to: Place|null, places: [Place]}` · Place = `{text, locode|null, name|null, country|null, subdivision|null, ambiguous}`.
- 자료: `tools/gen_unlocode.py` 가 datasets/un-locode `data/code-list.csv`(ODC-PDDL 1.0, 원천 UNECE)에서 항구 항목만 골라
  `apps/api/src/main/resources/data/unlocode-ports.tsv` 를 만든다(열: code · name · country · subdivision · function · name_collision). 판(版)·내려받은 날·행 수를 파일 머리에 적는다.
- 웹 선박 카드: "출발지(보고)" — from_to 면 A 풀이, 아니면 "— AIS 에는 출발지 항목이 없습니다". "목적지(보고)" — 원문 + 풀이(이름 · 국가 · UN/LOCODE),
  ambiguous 면 "코드로 읽은 값 · 같은 글자의 지명도 있음". between 이면 "A ↔ B 왕복(보고)". ETA 는 기존대로.

## C. 선박 실시간 표시
- ShipFanout 모드: **개별(points)** = (줌 ≥ 7 이고 화면 안 ≤ 5,000척) 또는 (4 ≤ 줌 < 7 이고 ≤ 1,500척). 격자로 바꾸는 기준은 1,500 초과,
  다시 개별로 돌아오는 기준은 1,200 이하(되풀이 전환 방지). 그 밖은 격자.
- 웹 칩 문구를 규칙에 맞게. 화면 안 0척이면 "화면 안 선박 0척 — aisstream 은 육상 수신국 기반이라 수신국이 없는 해역은 비어 있습니다".
- 격자 원: 우세 선종 색 + 흰 테두리 1.5 px · 최소 반지름 8 px · 불투명도 0.85 · 수 글자 halo. 항공기보다 아래 층은 유지.

## D. AIS 구역 나누기(ADR-014 부록 B)
- `ais_bboxes` 문법 확장: 구역을 `|` 로 나눈다(최대 3 — 공급자의 키당 연결 수). 구역마다 상자 1–16개(`;`), 전체 1,024자 이하. `|` 가 없으면 구역 하나(기존과 같음).
  api SettingsService 와 ais/bbox.py 가 같은 규칙으로 검사한다. 운영 권장값 `-90,-180,90,0|-90,45,90,180`.
- ais: 구역마다 WebSocket 세션 하나(각자 Backoff · Feed · idle watchdog · 재구독), 대기열·정리·ShipBook·발행은 공유. 구역 수가 바뀌면 세션을 늘리거나 줄인다.
- 공백 이벤트 payload 에 `scope`(그 구역의 정규화된 상자 문자열) 추가(선택 필드, 스키마 반영). DB V8: `ingest_gap.scope text NULL`,
  고유성 = `(source, coalesce(scope,''), started_at)` 인덱스(기존 UNIQUE(source, started_at) 대체). 되돌리기: 인덱스를 지우고 기존 제약을 다시 만든 뒤 열 삭제(부록에 SQL).
- 상태 해시: 기존 합계 필드는 유지하되 의미를 정한다 — connected = 모든 구역 연결, last_msg_at = 최댓값, msgs_per_s = 합, gap_open_since = 열린 공백 중 가장 이른 것,
  lag_p50_s = 구역 최댓값. 새 필드 `shards` = JSON 배열(≤ 3) `[{scope, state, connected, last_msg_at, msgs_per_s, lag_p50_s, gap_open_since, gap_reason, sessions_ended}]`.
- api AisStatus.publicView: `shards: [{coverage:[[...]], state, connected, gap_open_since}]` 추가. `coverage` 는 모든 구역 상자의 합.
- 만료 멈춤: 열린 공백이 있는 구역의 상자 안 선박만 만료하지 않는다(상태를 모르거나 오래되면 기존처럼 전체 멈춤).
- 항적 끊기: scope 가 있는 공백은 두 점 중 하나라도 그 구역 상자 안일 때만 적용한다. scope 없는 공백(옛 기록)은 모두에 적용.
- 웹 AIS 배지: 일부 구역만 공백이면 "AIS 공백 1/2 구역"(툴팁에 구역·시작 시각).

## E. 지도 시인성
- 웹이 스타일을 받은 뒤(`style.load`) 알려진 층의 색만 바꾼다(`lib/basemap.ts`, 층이 없으면 건너뜀). 외부 요청은 늘리지 않는다.
  목표: 육지·바다 구분(명암비 ≥ 1.5:1, 바다를 더 어둡게), 해안선·국경선 보이게, 지명 글자와 바탕 대비 ≥ 4.5:1(WCAG AA). 항공기 고도 색·SIGMET·레이더가 묻히지 않을 것.
  상황판·재생 지도 모두 적용. 단위 시험으로 대비를 계산해 확인한다.

## F. 출처 표기
- `/about` 와 하단 출처: "노선 adsbdb.com(flight route data © David Taylor · Jim Mason)", "항구 코드 UN/LOCODE(UNECE, datasets/un-locode ODC-PDDL)".

## G. 구현 리뷰 뒤 개정(2026-09-28)
- **A-1 노선 조회의 콜사인은 api 가 정한다.** api 는 집중 추적 임대 메타(`wakeline:demand:focus:meta` 의 hex 항목 JSON)에 `callsign`(api 가 화면에 보이는 콜사인을 정규화한 값)을 싣는다.
  정규화 = 앞뒤 공백 제거 → **ASCII 가 아니면 콜사인 없음** → 대문자 → `^[A-Z0-9]{3,8}$`. collector 는 그 값을 같은 규칙으로 다시 검사해 조회한다
  (메타에 없으면 집중 추적 응답의 콜사인, 품질 게이트에서 격리된 기록의 콜사인도 포함). 이렇게 하면 adsb.fi 가 그 항공기를 돌려주지 않아도 "조회 중" 이 끝없이 남지 않는다.
- **A-2 상태 `disabled`.** fixture 모드(외부 호출 없음)이거나 운영자가 `adsbdb` 공급자를 끈 경우, collector 는 요청된 콜사인에 `status:"disabled"`(120 s)를 쓴다.
  api 의 route.status 에 `disabled` 추가, 화면은 "노선 조회 꺼짐(운영 설정)". 예산 소진·대기 초과·호출 실패는 `error` → `unavailable`.
  운영 화면 공급자 목록에 `adsbdb` 를 넣어 감사 기록과 함께 끄고 켤 수 있게 한다. 끈 뒤에는 대기 중인 조회도 보내지 않는다.
- **A-3 항공사.** 이름이 없어도 ICAO(3자)·IATA(2자) 코드가 유효하면 항공사를 남긴다(이름 null). 양쪽 같은 규칙.
- **A-4 AOF.** Redis 는 AOF(appendonly)로 디스크에 남긴다. 노선 캐시 값도 TTL 이 지날 때까지(그리고 AOF 재작성 전까지) 그 파일에 있다. 노선을 모아 두는 데이터베이스를 만들지는 않지만,
  약관을 엄격하게 읽으면 걸릴 수 있다 — ADR-016 에 적고 소유자 결정으로 남긴다.
- **B-1 UN/LOCODE 판(版).** 원천 파일에 판 표기가 없다. 판 대신 내려받은 날·원천 SHA-256·행 수를 머리에 적는다(추정해 판을 붙이지 않는다).
- **C-1 칩 문구.** 0척일 때 "수신국이 없는 해역" 문구는 AIS 가 연결돼 있고(구역 중 하나라도 connected) 화면이 수신 범위에 걸칠 때만. 연결 안 됨·상태 모름이면 그 사실만 말한다.
  줌 4–6 격자(1,500척 초과)는 정상 동작이라 경고 색을 쓰지 않는다(경고는 줌 ≥ 7 에서 5,000척 초과일 때만).
- **D-1 스키마.** `ais_gap_payload.scope` = `{"type":["string","null"],"maxLength":1024}`(형식은 api 가 검사, 틀리면 구역 없음 + 카운터 — 공백은 버리지 않는다).
- **D-2 수신 범위(coverage)는 실제로 구독한 구역만.** 상태 해시의 `bbox`('|' 로 이은 구독 문자열)에 들어 있는 구역의 상자만 합친다. 키 없음(disabled)·구독 전이면 null.
  collector 는 disabled 모드에서 구역 없는(scope null) 항목 하나만 싣는다.
- **D-3 구역을 지우는 순간 열린 공백**은 지운 시각에 닫아 기록한다(사유 끝에 " · 구역 제거"). 재시작 이월은 같은 구역이 없으면 구역 없는 공백으로 이월한다.
- **D-4 V8 되돌리기**는 원래 이름(`ingest_gap_source_started`)으로 제약을 다시 만들고 `flyway_schema_history` 의 V8 행을 지운다.
