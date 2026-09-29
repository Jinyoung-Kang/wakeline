# ADR-023 연안 교통량 격자 — 해양교통안전공단 실시간 해양교통정보 + 해양수산부 해양격자 4단계

**상태** 채택 · 2026-09-29 · 사용자 요청(상황판 한반도 주변 선박 정보 · 공공데이터포털 활용신청 4건) · ADR-001(수집 분리) · ADR-005(예산) ·
ADR-006(요청 중 외부 호출 없음) · ADR-014(AIS) · ADR-017 R-72(수집기 값을 믿지 않음) · ADR-018(가림)

## 배경
사용자는 공공데이터포털에서 네 서비스를 활용신청했다: 해양수산부_선박운항정보(`1192000/VsslEtrynd5`) · 인천항만공사_인천항여객터미널 이용 국내외
선박정보(`B551504/ipaIpptVsslUseInfo`) · 한국해양교통안전공단_실시간 교통정보 조회(`B554035/realtime`) · 한국해양교통안전공단_운항항로 정보
(`B554035/oprt-rt-info-v3`). 상황판의 선박은 aisstream.io(ADR-014 — 육상 수신국 기반, 수신국이 없는 해역은 비어 있음)뿐이라 한반도 연안이 비어
보일 수 있다. 사용자가 고른 것은 **연안 교통량 격자 레이어**다. 2026-09-29 사용자 키로 확인한 두 서비스로 만든다: 위 목록의 실시간 교통정보와,
목록에는 없지만 같은 키로 응답을 확인한 해양수산부 격자4단계 WFS(`1192000/apVhdService_G4s`) — 이 서비스의 활용신청 상태(개발계정 한도가 이 키에 따로
걸리는지)는 포털에서 사용자가 확인할 일이다. 목록의 나머지(선박운항정보 · 인천항 여객터미널 선박정보 · 운항항로 정보)는 이 ADR 의 범위 밖이다
(응답을 확인하지 않았다).

## 확인한 형식(2026-09-29, 사용자 키 — 이 레인은 외부를 부르지 않았고 시험은 이 표본으로 만든 fixture 만 쓴다)
- **A. 한국해양교통안전공단 실시간 해양교통정보**: `GET https://apis.data.go.kr/B554035/realtime/get_realtime?serviceKey=&pageNo=1&numOfRows=6000&dataType=JSON`.
  JSON `response.header.resultCode`("200" 정상) · `resultMsg`, `response.body.items.item[]` = `{grid_id(예 "GR4_F2K41_C3"), vmtc(선박 척수), dnsty(밀집도 %)}`,
  `body.totalCount`, `body.regDt`("2026-09-29 18:05:05" — KST, 생성 시각). numOfRows=6000 한 번에 전체 스냅샷(5,099건, 245,985 B, vmtc 1–102 · dnsty 0–100).
  5분마다 새 자료. 포털 개발계정 한도 하루 500회.
- **B. 해양수산부 격자4단계 WFS**: `GET https://apis.data.go.kr/1192000/apVhdService_G4s/getOpnG4sWFS?ServiceKey=&grid_no=<id>&maxFeatures=1`(bbox 도 받지만 쓰지
  않는다). GML 3.1.1: `wfs:FeatureCollection numberOfFeatures`, 지물 `ofbd-DB:opn_grid_4_step_a` 의 `gid` · `grid_no` · `geom` → `gml:MultiSurface srsName="EPSG:5179"` →
  `Polygon/exterior/LinearRing/posList`(동거 북거 순). 표본 GR4_F2K41_C3 의 모서리가 표준 TM 역변환으로 정확히 37.450/37.475 N · 126.600/126.625 E —
  4단계 칸은 0.025°(1′30″) 정사각형이다. 포털 개발계정 한도 하루 10,000회.
- 키 파라미터 이름의 대소문자가 두 서비스에서 다르다(`serviceKey` · `ServiceKey`). 한 키(`DATA_GO_KR_SERVICE_KEY`)가 둘 다 연다.

## 결정
1. **수집기만 부른다**(ADR-001 · 006). 공급자 둘(`komsa_traffic` · `mof_grid4`) — 호스트 `apis.data.go.kr` 허용 목록 + 호스트 버킷 1.0 req/s(burst 2, 두 서비스가
   나눠 쓴다) + 수집기 전체 버킷. 격자 조회는 새 가장 낮은 우선순위 `PRIORITY_BACKFILL`(4)로 줄 서서 다른 호출의 토큰을 가로채지 않는다.
2. **교통 호출은 자료 시각이 정한다**(틱 30 s 는 '부를 때인지' 보는 간격일 뿐): 다음 regDt 예상 시각(마지막 regDt + 5분 + 60 s) 전에는 부르지 않는다.
   같은 regDt 면(unchanged) 다시 해석 · 발행하지 않고(같은 값을 다시 실어 TTL 만 늘린다) 120 → 240 → 480 → 900 s 물러난다. 실패는 60 → … → 900 s.
   같은 주기 안 다시 부르기는 하지 않는다. 어떤 경우든 **어느 한 시간이든 15회 이하** — 어느 24시간이든 360회 이하라 포털 한도(500)가 UTC · KST 어느
   날 경계로 세어져도 넘지 않는다. 예산 `budget:komsa_traffic` 하루 400(UTC 날 — 정상 288 + 여유).
3. **격자 기하는 모르는 칸만, 한 칸에 한 번**(`mof_grid4`, 하루 6,000): 처음 본 순서(같은 스냅샷 안에서는 척수가 많은 칸 먼저), 틱마다 15개 · 15 s 안.
   첫 스냅샷(약 5,100칸)은 약 3시간에 걸쳐 채워진다 — 그동안 화면은 확인한 칸만 그리고 "위치 확인 중 N칸"을 적는다. **칸 번호의 글자로 위치를
   짐작하지 않는다**(번호 체계는 확인하지 않았다 — 위치는 WFS 기하에서만).
   - found → 메모리 + DB `marine_grid4`(Flyway V14 — 다시 시작해도 다시 묻지 않는다). not_found(`numberOfFeatures` 0) · off_grid(아래 검사 실패 — 격리,
     품질 사례 `traffic_grid_off_grid` + 원본 보관) → Redis 부정 캐시 `wakeline:traffic_grid:negative`(7일 뒤 다시 묻는다).
   - 오류(HTTP · 응답 모양 · 시간 초과)는 그 칸만 5분 → 30분 → 2시간 → 6시간 뒤. 한 틱에서 연달아 3번 실패하면 채우기 전체를 5분 → 10분 → 30분 → 1시간
     쉰다(키 · 서비스 장애에 예산을 쓰지 않게). 보내지 않은 호출(속도 상한 · 운영자 끔 · 연결 전 실패 · 종료 취소)은 예산을 돌려준다.
   - DB 캐시를 아직 읽지 못했으면 기동 뒤 10분까지는 채우지 않는다(이미 아는 칸을 다시 묻지 않게). 그 뒤에는 DB 없이 채우고 DB 가 돌아오면 합친다.
   - 두 예산 모두 엄격(`budget.DEFAULT_STRICT`) — 예산 저장소(Redis)가 안 되면 부르지 않는다.
4. **투영 · 격자 검사**: EPSG:5179 = TM · GRS80(a 6,378,137 m, 1/f 298.257222101) · 원점 38° N · 중앙 경선 127.5° E · 축척 0.9996 · 동거 1,000,000 m ·
   북거 2,000,000 m. 역변환은 순수 Python(Krüger 급수 n⁶ · Karney 2011, `marine_grid.py`) — 원점 · 확인 표본 · pyproj(대조만)와 한반도 해역에서 1e-9° 안.
   Korea 2000 은 ITRF 기반이라 WGS84 와의 변환은 0 이다(EPSG:5179 → 4326 표준 변환과 같다). 받은 다각형은 **네 모서리가 모두 0.025° 배수에서 1e-6°(약 0.1 m)
   안이고 정확히 한 칸을 이룰 때만** 칸으로 받는다 — 아니면 off_grid. `srsName` 은 확인한 `EPSG:5179` 만 받는다(축 순서가 다를 수 있는 다른 표기는 오류 —
   짐작하지 않는다). 요청한 grid_no 와 다른 지물 · 다각형 둘 이상 · 안쪽 고리도 받지 않는다. DOCTYPE · ENTITY 가 있는 응답 · 256 KiB 초과는 해석하지
   않는다. DB 에도 같은 검사를 CHECK 로 둔다(둘째 방어선).
5. **스냅샷**: Redis `wakeline:traffic_grid`(SET EX 1200) = `{v, reg_dt_kst, reg_dt_utc, fetched_at, total, total_count, partial, rejected, resolved, unresolved,
   pending, not_found, off_grid, cell_deg: 0.025, cells: [[grid_no, lat_min, lon_min, 척수, 밀집도 %], …]}` — 기하를 확인한 칸만, grid_no 순. 발행 시각을
   싣지 않아 같은 입력이면 같은 값이다(ETag 가 내용이 바뀔 때만 바뀐다). `totalCount` 가 받은 건수보다 많으면 `partial`(다음 쪽은 받지 않는다 — 예산).
   항목 하나가 틀리면 그 항목만 뺀다(품질 사례). regDt 가 없거나 틀리면 스냅샷 전체를 받지 않는다(시각 모르는 집계를 '지금'으로 보이지 않는다).
   heartbeat(`wakeline:collector`): `traffic_grid_state`(active · no_key · fixture · operator_off) · `traffic_grid_last_ok` · `traffic_grid_reg_dt` ·
   `traffic_grid_resolved` · `traffic_grid_unresolved` · `traffic_grid_cells_known` · `traffic_grid_pending` · `traffic_grid_calls_komsa` · `traffic_grid_calls_wfs`(오늘 쓴 호출)
   · `traffic_grid_at` · `traffic_grid_lag_s`(regDt 나이).
6. **api `GET /api/v1/traffic/grid`**(공개 · Cache-Control public 30 s · ETag = 원문 SHA-256 앞 8바이트 + 상태 · 요청 제한 공통): 수집기 값을 믿지 않는다 —
   틀린 스냅샷은 `invalid`, 틀린 칸은 빼고 `invalid_cells` · `wakeline_traffic_grid_parse_errors_total{field}`. 상태 ok · stale(regDt 15분 초과 — **칸을 싣지
   않는다**) · disabled(heartbeat 가 120 s 안이고 수집기가 꺼졌다고 알림 — `disabled_reason`) · no_data. 모르는 값은 키가 없다(non_null). `source` =
   {provider: 한국해양교통안전공단 MTIS 실시간 해양교통정보, grid: 해양수산부 해양격자 4단계, note: 5분 집계 — 격자별 선박 척수(개별 위치 아님)}.
   5 s 메모 · 원문이 같으면 다시 해석하지 않는다(250 KB 를 요청마다 읽거나 풀지 않는다). 운영 공급자 목록에 `komsa_traffic` · `mof_grid4`(상태 · 켜고 끄기).
7. **웹 "연안 교통량(KOMSA)"**(기본 끔 · 다른 레이어처럼 이 브라우저에 기억): 켜져 있고 탭이 보일 때만 90 s 마다 `If-None-Match` 로 조회, GeoJSON 소스 하나를
   내용 버전이 바뀔 때만 통째로 바꾼다(304 · 같은 ETag 면 다시 그리지 않는다), 끄면 조회를 멈추고 칸을 비운다. 칸을 다시 검증한다(격자점 · 범위).
   색은 척수 구간(1 · 2–3 · 4–7 · 8–15 · 16–31 · 32+ — 표시용 선택, 확인한 범위 1–102 를 2배씩)의 한 가지 색상(주황) 순서 색 — 어두운 지도에서 많을수록 밝게,
   0척은 회색. 레이더 · SIGMET · 항공기 · 선박 아래. 범례 "격자 약 2.2×2.8 km · 5분 집계 · 선박 척수 — 개별 선박 위치 아님", 툴팁(격자 번호 · 척수 · 밀집도 % ·
   기준 시각 KST · UTC), 상태 줄(표시한 칸 / 전체 · 위치 확인 중 · 해양격자에 없음 · 격리 · 일부만 수신 · 멈춤 · 꺼짐의 이유 · 조회 실패), 출처(하단 · /about).
8. **비밀값**: 키는 수집기 컨테이너에만(compose — 격리 스택은 빈 값). 포털의 인코딩 키('%')는 한 번 풀어 둔다(httpx 가 한 번 인코딩 — 두 번 인코딩하면
   인증 실패). 키 값의 세 형태(디코딩 · 퍼센트 인코딩 · + 인코딩)를 값 치환 목록에 넣고, 모양 규칙(`serviceKey=` · `ServiceKey=` · JSON)은 언어 간 벡터
   (`schemas/vectors/masking-cases.v1.json`)로 Python · Java 가 같다. 로그 · 공급자 상태 · Redis · DB 에 키가 가지 않는다(시험).
9. **Redis ACL**: 수집기에 두 이름만(`~wakeline:traffic_grid` — SET 셀렉터로만 쓴다, `~wakeline:traffic_grid:negative` — 해시 명령). 지우거나 만료를 바꾸는
   명령은 없다. ais 는 접근 없음, api 는 `~wakeline:*` 로 읽는다.

## 버린 대안
- **칸 번호를 풀어 위치 계산**: 번호 체계를 확인하지 않았다 — 짐작한 위치를 보이지 않는다(사용자 규칙).
- **bbox 로 한 번에 여러 칸(최대 100)**: 호출 수를 크게 줄이지만 bbox 응답을 확인하지 않았다. 확인한 한 칸 조회로 시작하고, 확인되면 후속으로 바꾼다
  (DB 캐시가 있어 한 번 채운 뒤에는 새 칸만 묻는다).
- **스냅샷을 DB 에 저장**: 5분 집계는 파생 · 일시 값이고 이력 화면이 없다 — Redis(TTL)만. 격자 기하만 DB(재기동 뒤 재조회 방지).
- **교통 호출 같은 주기 다시 부르기**: 틱 30 s 가 곧 다시 부르고, 다시 부르기를 더하면 한 시간 상한 계산이 흔들린다 — 물러나기만.

## 선택값(잰 값이 아니다)
PUBLISH_DELAY 60 s · 최소 간격 120 s · 시간당 15회 · 물러나기 단계 · 틱 30 s · 틱당 15칸 · 채우기 15 s · 차단기 3회 · 부정 캐시 7일 · DB 대기 10분 ·
TTL 20분 · 오래됨 15분 · 호스트 1 req/s · 예산 400 · 6,000 · 색 구간 · 웹 조회 90 s.

## 결과 · 대가
- 공급자는 5분 집계라 선박 하나하나는 보이지 않는다 — 화면은 늘 "개별 선박 위치 아님"을 적는다. 연안의 교통 밀도(AIS 수신국이 없는 곳 포함 여부는
  공급자 자료 범위에 따른다 — 확인하지 않았다)를 한 번에 볼 수 있다.
- 첫 기동 뒤 몇 시간은 일부 칸만 보인다(상태 줄이 수를 적는다). 격자 WFS 하루 약 5,100회(첫날) 뒤로는 새 칸만 묻는다.
- fixture 모드(`make e2e` · `make demo`)는 외부 호출이 없어 이 레이어가 '꺼짐 — fixture 모드'다(fixture 공급자는 만들지 않았다 — 후속 후보).
- 운영 실행 기록에 `traffic_grid`(ok · unchanged · error · budget_*) · `traffic_grid_geom`(틱마다 호출이 있었을 때 한 줄)이 쌓인다 — `unchanged` 는 호출은
  했으나 새 자료가 아니었다는 뜻이다(운영 화면에서 ok 가 아닌 색으로 보인다).

## 검증(자동 시험 — 외부 호출 없음)
수집기 `tests/test_traffic_grid_geo.py`(원점 · 확인 표본 · pyproj 대조 · 왕복 · 격자 검사 · GML: 확인 표본 · 0건 · 다른 칸 · 격자 밖 · srsName · 다각형 둘 ·
posList 형식 · OGC 예외 · 포털 게이트웨이 오류 · 빈/HTML/JSON 본문 · DOCTYPE · 크기) · `test_traffic_grid_komsa.py`(확인 모양 · 한 건 객체 · 빈 모양 · 숫자 글자 ·
resultCode 오류 · 포털 XML 오류 · regDt · 항목별 거절 · 겹침 · 스냅샷 값 · 5,099칸 크기) · `test_traffic_grid_providers.py`(허용 호스트 · 버킷 · 우선순위 ·
키 정규화(이중 인코딩 없음) · 파라미터 이름 · 가림) · `test_traffic_grid_job.py`(일정 · unchanged · 시간당 상한 · 실패 물러나기 · 예산 소진 · 예산 저장소 장애 ·
속도 상한 반환 · 운영자 스위치 · partial · 부정 캐시와 7일 · 재기동 · 칸 오류 물러나기 · 차단기 · WFS 예산 · DB 캐시 · DB 대기 · 발행 실패 · 취소 반환) ·
`test_traffic_grid_db.py` · `test_redis_integration.py`(실 Redis · 수집기 ACL, 선택 실행) · `test_rest_contract_rules.py` · 가림 벡터,
api `TrafficGridReaderTest` · `TrafficGridIT`(수집기 ACL 로 SET EX · 304 · 오래됨 · 꺼짐 · 없음) · `RestSamplesIT` + `rest_contract_check` · `RolePrivilegesDbTest`(V14) ·
`LogMaskerTest`(같은 벡터) · OpenAPI 스냅샷, 인프라 `test_redis_acl_rules.py` · `redis_acl_test.sh` · `test_compose_policy.py`, 웹 `tests/traffic-grid.test.ts` ·
`tests/mapview-traffic-grid.test.ts`.
