# ADR-023 연안 교통량 격자 — 해양교통안전공단 실시간 해양교통정보 + 해양수산부 해양격자 4단계

**상태** 채택 · 2026-09-29 · 사용자 요청(상황판 한반도 주변 선박 정보 · 공공데이터포털 활용신청 4건) · ADR-001(수집 분리) · ADR-005(예산) ·
ADR-006(요청 중 외부 호출 없음) · ADR-014(AIS) · ADR-017 R-72(수집기 값을 믿지 않음) · ADR-018(가림) · ADR-022(같은 키 · 호스트 한도) · 계약 v5 §G15

## 배경
사용자는 공공데이터포털에서 네 서비스를 활용신청했다: 해양수산부_선박운항정보(`1192000/VsslEtrynd5`) · 인천항만공사_인천항여객터미널 이용 국내외
선박정보(`B551504/ipaIpptVsslUseInfo`) · 한국해양교통안전공단_실시간 교통정보 조회(`B554035/realtime`) · 한국해양교통안전공단_운항항로 정보
(`B554035/oprt-rt-info-v3`). 상황판의 선박은 aisstream.io(ADR-014 — 육상 수신국 기반, 수신국이 없는 해역은 비어 있음)뿐이라 한반도 연안이 비어
보일 수 있다. 사용자가 고른 것은 **연안 교통량 격자 레이어**다. 2026-09-29 사용자 키로 확인한 두 서비스로 만든다: 위 목록의 실시간 교통정보와,
목록에는 없지만 같은 키로 응답을 확인한 해양수산부 격자4단계 WFS(`1192000/apVhdService_G4s`) — 이 서비스의 활용신청 상태(개발계정 한도가 이 키에 따로
걸리는지)는 포털에서 사용자가 확인할 일이다. 목록의 나머지(선박운항정보 · 인천항 여객터미널 선박정보 · 운항항로 정보)는 이 ADR 의 범위 밖이다
(응답을 확인하지 않았다).

## 확인한 형식(2026-09-29, 사용자 키 — 이 레인은 외부를 부르지 않았고 시험은 이 표본으로 만든 fixture 만 쓴다)
- **A. 한국해양교통안전공단 실시간 해양교통정보**: `GET https://apis.data.go.kr/B554035/realtime/get_realtime?serviceKey=&pageNo=1&numOfRows=10000&dataType=JSON`(2026-09-30 개정 — 아래).
  JSON `response.header.resultCode`("200" 정상) · `resultMsg`, `response.body.items.item[]` = `{grid_id(예 "GR4_F2K41_C3"), vmtc(선박 척수), dnsty(밀집도 %)}`,
  `body.totalCount`, `body.regDt`("2026-09-29 18:05:05" — KST, 생성 시각). numOfRows=6000 한 번에 전체 스냅샷(5,099건, 245,985 B, vmtc 1–102 · dnsty 0–100).
  **2026-09-30 개정**: 격자가 6,422건으로 늘어 6000 이 모자랐다(배포 뒤 로그 'page holds 6000 of totalCount 6422 — published as partial'). numOfRows=10000 한 번으로 전체 6,422건(309,602 B)을 받는 것을 실제 호출로 확인하고 10000 으로 올렸다(VERIFICATION #58). 넘치면 여전히 partial 로 표시한다.
  5분마다 새 자료. 포털 개발계정 한도 하루 500회.
- **B. 해양수산부 격자4단계 WFS**: `GET https://apis.data.go.kr/1192000/apVhdService_G4s/getOpnG4sWFS?ServiceKey=&grid_no=<id>&maxFeatures=1`(bbox 도 받는다 —
  2026-10-01 실제 호출로 확인하고 채택했다: 아래 '개정(2026-10-01 bbox)'). GML 3.1.1: `wfs:FeatureCollection numberOfFeatures`, 지물 `ofbd-DB:opn_grid_4_step_a` 의 `gid` · `grid_no` · `geom` → `gml:MultiSurface srsName="EPSG:5179"` →
  `Polygon/exterior/LinearRing/posList`(동거 북거 순). 표본 GR4_F2K41_C3 의 모서리가 표준 TM 역변환으로 정확히 37.450/37.475 N · 126.600/126.625 E —
  4단계 칸은 0.025°(1′30″) 정사각형이다. 포털 개발계정 한도 하루 10,000회.
- 키 파라미터 이름의 대소문자가 두 서비스에서 다르다(`serviceKey` · `ServiceKey`). 한 키(`DATA_GO_KR_SERVICE_KEY`)가 둘 다 연다.

## 결정
1. **수집기만 부른다**(ADR-001 · 006). 공급자 둘(`komsa_traffic` · `mof_grid4`) — 호스트 `apis.data.go.kr` 허용 목록 + 호스트 버킷 1.0 req/s(burst 2) +
   수집기 전체 버킷. **호스트 버킷 · 키 · 키 가림은 ADR-022(해양수산부 선박운항정보 PORT-MIS, `portmis`)와 하나다**(설정 `data_go_kr_rps` ·
   `DATA_GO_KR_SERVICE_KEY` · `providers/data_go_kr.service_key_forms`). 세 잡은 우선순위로 나눈다: 교통 5분 폴링 `PRIORITY_FIXED`(0) > 선택 선박
   입출항 조회 `PRIORITY_PORTCALL`(4) > 격자 조회 `PRIORITY_BACKFILL`(5, 가장 낮다) — 입출항 조회가 1 req/s 로 이어져도 폴링은 다음 토큰을 먼저
   받고(≤ 1 s), 격자 조회는 다른 호출의 토큰을 가로채지 않는다(`test_ratelimit.py`).
   하루 예산(UTC 날)은 포털의 API 별 개발계정 한도 안이다 — `portmis` 3,000 · `mof_grid4` 6,000 · `komsa_traffic` 400. 그러나 UTC 날 예산만으로는 포털이
   하루를 다른 경계(KST 자정 · 지난 24시간)로 셀 때 두 UTC 날의 몫이 한 '하루'에 들어간다(합친 뒤 검토 지적 — KST 하루에 입출항 3,000 × 2 + 첫 격자 채우기
   약 5,100 ≈ 11,100). 그래서 **어느 경계로 세어도** 지키는 것은 Redis 시간 창이다: 어떤 24시간이든 UTC 시 창을 많아야 25개 걸친다. 해양수산부 두 API 는
   함께 세는 `budget:mof:h:{UTC 시}` 시간당 390(25 × 390 = 9,750 — 두 API 의 한도가 기관 단위로 묶여 있더라도 10,000 을 넘지 않는다. 여유 250 은 예약과 실제 보낸 시각의 차이(속도 상한 대기 ≤ 15 s — 많아야 32회) 몫, `providers/data_go_kr.MOF_*`),
   해양교통안전공단은 `budget:komsa_traffic:h:{UTC 시}` 15(25 × 15 = 375 ≤ 500 — 아래 2). 시험 `test_main.test_portal_daily_limits_hold_on_any_day_boundary`.
2. **교통 호출은 자료 시각이 정한다**(틱 30 s 는 '부를 때인지' 보는 간격일 뿐): 다음 regDt 예상 시각(마지막 regDt + 5분 + **배운 발행 지연**) 전에는
   부르지 않는다. 발행 지연(regDt 뒤 그 자료가 응답에 나오기까지)은 잰 적이 없다 — 처음 추정 60 s(선택값)에서 시작해 **관측으로 배운다**: 이른 호출
   (같은 regDt) 뒤 새 regDt 를 받으면 그 지연은 (마지막 이른 호출 − regDt, 받은 때 − regDt] 안이므로 위쪽 끝을 쓰고(폭이 90 s 보다 넓으면
   max(아래 끝, 지금 추정) + 90 s 로 좁힌다 — 이른 호출 뒤에는 줄이지 않는다), 한 번에 받은 주기마다 3 s 씩 줄여 본다(공급자가 빨라지면 따라간다).
   범위 [30, 540] s(540 = regDt + 5분 + 이 값 + 틱이 오래됨 900 s 안). 첫 호출 · 실패 뒤 받은 regDt 의 나이는 배우지 않는다. 배운 값은 heartbeat
   `traffic_grid_publish_delay_s`(배우기 전에는 빈 값)에 싣고 재기동 뒤 다시 쓴다 — **운영자가 사용자 키로 실제 지연을 볼 수 있는 곳**이다.
   (검토 지적: 고정 60 s 였을 때 발행이 65 s 넘게 늦으면 주기마다 두 번 불러 시간 상한에 막히고 하루 약 6시간 '멈춤'이었다 — 24시간 모형으로 재현.)
   같은 regDt 면(unchanged — 더 이른 regDt 도, 지난 자료로 되돌리지 않는다) 다시 해석 · 발행하지 않고(같은 값을 다시 실어 TTL 만 늘린다)
   60 → 60 → 60 s(늦은 발행) 뒤 120 → 240 → 480 → 900 s(멈춘 공급자) 물러난다. 실패는 60 → … → 900 s. 같은 주기 안 다시 부르기는 하지 않는다.
   수집기 시계보다 120 s 넘게 앞선 regDt 는 받지 않는다(실패 · 품질 사례 `traffic_grid_reg_dt_future` — 한 번 받으면 뒤의 옳은 자료가 모두
   '더 이른 것'이 되어 층이 얼어붙는다).
   상한 둘: 메모리 60분 창 15회와 **Redis 시간 창** `budget:komsa_traffic:h:{UTC 시}` 15회(하루 예산보다 먼저 예약, 보내지 않은 호출은 둘 다 돌려준다) —
   Redis 로 세므로 재기동 · 두 번째 수집기도 같은 창을 쓴다. KST 날은 UTC 시 24개(시 경계가 같다)이므로 **어느 날 경계로 세어도 하루 360회 이하** —
   포털 한도(500) 안(지난 24시간으로 세어도 창 25개 — 375). 예산 `budget:komsa_traffic` 하루 400(UTC 날 — 정상 288 + 여유). 24시간 공급자 모형(지연 0–300 s · 흔들림 · 틱 30/45 s)에서
   하루 평균 시간당 13회 이하, 첫 한 시간 뒤 regDt 나이 900 s 미만(시험 — 모형이지 잰 값이 아니다).
3. **격자 기하는 모르는 칸만, 한 칸에 한 번**(`mof_grid4`, 하루 6,000 — **2026-10-01 bbox 개정: 물을 bbox 타일이 있으면 타일 먼저, 한 칸 조회는
   타일이 주지 않은 칸만**. 아래 규칙(순서 · 부정 캐시 · 물러나기 · failed · 차단기 · 시간 창 · 하루 예산)은 한 칸 조회에 그대로이고 타일도 같은 예산 · 시간 창 · 차단기를 쓴다): 처음 본 순서(같은 스냅샷 안에서는 척수가 많은 칸 먼저 · 실패한 적이 있는
   칸은 새 칸 뒤), 틱마다 15개 · 15 s 안. 호출마다 해양수산부 시간 창(위 1)을 하루 예산보다 먼저 예약하되 **입출항 조회 몫 100 을 남긴다**
   (`MOF_GRID4_HOURLY_HEADROOM` — 사람이 기다리는 조회가 매시 적어도 100회) — 채우기는 시간당 많아야 290칸이다. 창이나 하루 예산에 막히면 까닭을
   실행 기록에 한 번 적고("… — geometry fill resumes at <다음 UTC 시 · 날>") 그때까지 채우지 않는다(틱마다 같은 거절을 쌓지 않는다). 첫 스냅샷
   (확인한 표본 5,099칸 — 2026-09-30 에는 6,422칸이라 약 22시간 이상(6,422 ÷ 290 ≈ 22.1))은 **약 18시간 이상**(5,099 ÷ 290 ≈ 17.6) 걸쳐 채워진다(계산 — 잰 값이 아니다; 입출항 조회가 창을 쓰거나 호스트 버킷 1 req/s · 응답 시간에 따라 더
   걸린다 — 처음 구현의 "약 4–5시간"(시간당 약 1,200칸)은 시간 창을 두기 전 값이다). **2026-10-01 개정으로 철회**: 스냅샷 하나를 채우면 끝나는
   일이 아니다 — 끝나는 때를 말하지 않는다(아래 '개정(2026-10-01)'). 그동안 화면은
   확인한 칸만 그리고 "위치 확인 중 N칸"을 적는다. **칸 번호의 글자로 위치를 짐작하지 않는다**(번호 체계는 확인하지 않았다 — 위치는 WFS 기하에서만).
   - found → 메모리 + DB `marine_grid4`(Flyway V14 — 다시 시작해도 다시 묻지 않는다). not_found(`numberOfFeatures` 0) · off_grid(아래 검사 실패 — 격리,
     품질 사례 `traffic_grid_off_grid` + 원본 보관) → Redis 부정 캐시 `wakeline:traffic_grid:negative`(7일 뒤 다시 묻는다).
   - 오류(HTTP · 응답 모양 · 시간 초과)는 그 칸만 5분 → 30분 → 2시간 → 6시간 뒤. **5번 연달아 실패하면 failed** — 부정 캐시에 `failed` 로 적고
     1일 동안 묻지 않으며(그 뒤 처음부터 다시), 스냅샷 · 화면에 "위치 확인 중"이 아니라 **"위치 조회 실패 N칸"**으로 센다(품질 사례
     `traffic_grid_lookup_failed`). 검토 지적: 전에는 6시간마다 영원히 다시 묻고 확인 중으로 셌으며, 가장 오래된 이 칸들이 먼저 나와 차단기를 걸었다.
     한 틱에서 연달아 3번 실패하면 채우기 전체를 5분 → 10분 → 30분 → 1시간 쉰다(키 · 서비스 장애에 예산을 쓰지 않게). 보내지 않은 호출(속도 상한 ·
     운영자 끔 · 연결 전 실패 · 종료 취소)은 예산을 돌려준다.
   - DB 캐시를 아직 읽지 못했으면 기동 뒤 10분까지는 채우지 않는다(이미 아는 칸을 다시 묻지 않게). 그 뒤에는 DB 없이 채우고 DB 가 돌아오면 합친다.
   - 두 예산 모두 엄격(`budget.DEFAULT_STRICT`) — 예산 저장소(Redis)가 안 되면 부르지 않는다.
4. **투영 · 격자 검사**: EPSG:5179 = TM · GRS80(a 6,378,137 m, 1/f 298.257222101) · 원점 38° N · 중앙 경선 127.5° E · 축척 0.9996 · 동거 1,000,000 m ·
   북거 2,000,000 m. 역변환은 순수 Python(Krüger 급수 n⁶ · Karney 2011, `marine_grid.py`) — 원점 · 확인 표본 · pyproj(대조만)와 한반도 해역에서 1e-9° 안.
   Korea 2000 은 ITRF 기반이라 WGS84 와의 변환은 0 이다(EPSG:5179 → 4326 표준 변환과 같다). 받은 다각형은 **네 모서리가 모두 0.025° 배수에서 1e-6°(약 0.1 m)
   안이고 정확히 한 칸을 이룰 때만** 칸으로 받는다 — 아니면 off_grid. `srsName` 은 확인한 `EPSG:5179` 만 받는다(축 순서가 다를 수 있는 다른 표기는 오류 —
   짐작하지 않는다). 요청한 grid_no 와 다른 지물 · 다각형 둘 이상 · 안쪽 고리도 받지 않는다. DOCTYPE · ENTITY 가 있는 응답 · 256 KiB 초과는 해석하지
   않는다. DB 에도 같은 검사를 CHECK 로 둔다(둘째 방어선).
5. **스냅샷**: Redis `wakeline:traffic_grid`(SET EX 1200) = `{v, reg_dt_kst, reg_dt_utc, fetched_at, total, total_count, partial, rejected, resolved, unresolved,
   pending, not_found, off_grid, failed, cell_deg: 0.025, cells: [[grid_no, lat_min, lon_min, 척수, 밀집도 %], …]}`(미해석 = pending + not_found + off_grid +
   failed) — 기하를 확인한 칸만, grid_no 순. 발행 시각을
   싣지 않아 같은 입력이면 같은 값이다(ETag 가 내용이 바뀔 때만 바뀐다). `totalCount` 가 받은 건수보다 많으면 `partial`(다음 쪽은 받지 않는다 — 예산).
   항목 하나가 틀리면 그 항목만 뺀다(품질 사례). regDt 가 없거나 틀리면 스냅샷 전체를 받지 않는다(시각 모르는 집계를 '지금'으로 보이지 않는다).
   heartbeat(`wakeline:collector`): `traffic_grid_state`(active · no_key · fixture · operator_off) · `traffic_grid_last_ok` · `traffic_grid_reg_dt` ·
   `traffic_grid_resolved` · `traffic_grid_unresolved` · `traffic_grid_cells_known` · `traffic_grid_pending` · `traffic_grid_failed` · `traffic_grid_calls_komsa` ·
   `traffic_grid_calls_wfs`(오늘 쓴 호출) · `traffic_grid_publish_delay_s`(배운 발행 지연 — 배우기 전 빈 값) · `traffic_grid_at` · `traffic_grid_lag_s`(regDt 나이) ·
   채우기 진행(2026-10-01 개정): `traffic_grid_not_found` · `traffic_grid_off_grid` · `traffic_grid_not_queued` · `traffic_grid_fill_state` ·
   `traffic_grid_fill_resume_at` · `traffic_grid_fill_pass_at` · `traffic_grid_fill_pass_{lookups,found,not_found,off_grid,errors}`.
6. **api `GET /api/v1/traffic/grid`**(공개 · Cache-Control public 30 s · ETag = 원문 SHA-256 앞 8바이트 + 상태 · 요청 제한 공통): 수집기 값을 믿지 않는다 —
   틀린 스냅샷은 `invalid`, 틀린 칸은 빼고 `invalid_cells` · `wakeline_traffic_grid_parse_errors_total{field}`. regDt 가 api 시계보다 120 s 넘게 미래여도
   `invalid`(field `reg_dt_future`, 스냅샷마다 한 번 — 나이를 0 으로 잘라 '신선'하게 보이지 않는다). 수(`failed` 포함)가 맞지 않으면 `invalid`.
   상태 ok · stale(regDt 15분 초과 — **칸을 싣지 않는다**) · disabled(heartbeat 가 120 s 안이고 수집기가 꺼졌다고 알림 — `disabled_reason`) · no_data.
   모르는 값은 키가 없다(non_null). `source` =
   {provider: 한국해양교통안전공단 MTIS 실시간 해양교통정보, grid: 해양수산부 해양격자 4단계, note: 5분 집계 — 격자별 선박 척수(개별 위치 아님)}.
   5 s 메모 · 원문이 같으면 다시 해석하지 않는다(250 KB 를 요청마다 읽거나 풀지 않는다). 운영 공급자 목록에 `komsa_traffic` · `mof_grid4`(상태 · 켜고 끄기).
7. **웹 "연안 교통량(KOMSA)"**(기본 끔 · 다른 레이어처럼 이 브라우저에 기억): 켜져 있고 탭이 보일 때만 90 s 마다 `If-None-Match` 로 조회(켜면 곧바로,
   탭이 다시 보이면 곧바로 — 마지막 확인이 10 s 안이면 빼고), GeoJSON 소스 하나를 내용 버전이 바뀔 때만 통째로 바꾼다(304 · 같은 ETag 면 다시 그리지
   않는다), 끄면 조회를 멈추고 칸을 비운다. 칸을 다시 검증한다(격자점 · 범위). **ok 라도 이 브라우저 시계(서버 시각 보정)로 regDt + stale_after_s 가
   지나면 그리지 않고, 그리는 중이면 그 순간 비우며 상태 줄은 "자료 멈춤"** — 조회가 실패하거나 탭이 오래 숨었다 돌아오면 api 가 '멈춤'을 말할 기회가
   없기 때문이다(검토 지적). regDt 를 모르면 신선하다고 보지 않는다.
   색은 척수 구간(1 · 2–3 · 4–7 · 8–15 · 16–31 · 32+ — 표시용 선택, 확인한 범위 1–102 를 2배씩)의 한 가지 색상(주황) 순서 색 — 어두운 지도에서 많을수록 밝게,
   0척은 회색. 레이더 · SIGMET · 항공기 · 선박 아래. 범례 "격자 약 2.2×2.8 km · 5분 집계 · 선박 척수 — 개별 선박 위치 아님", 툴팁(격자 번호 · 척수 · 밀집도 % ·
   기준 시각 KST — 계약 v5 §G20), 상태 줄(표시한 칸 / 전체 · 위치 확인 중 · 해양격자에 없음 · 격리 · 위치 조회 실패 · 일부만 수신 · 멈춤 · 꺼짐의 이유 · 검증 실패(형식
   또는 미래 시각) · 조회 실패), 출처(하단 · /about).
8. **비밀값**: 키는 수집기 컨테이너에만(compose — 격리 스택은 빈 값). 포털의 인코딩 키('%')는 한 번 풀어 둔다(httpx 가 한 번 인코딩 — 두 번 인코딩하면
   인증 실패). 키 값의 네 형태(원문 · 디코딩 · 퍼센트 인코딩 · + 인코딩 — ADR-022 와 같은 `service_key_forms` 하나)를 값 치환 목록에 넣고, 모양 규칙(`serviceKey=` · `ServiceKey=` · JSON)은 언어 간 벡터
   (`schemas/vectors/masking-cases.v1.json`)로 Python · Java 가 같다. 로그 · 공급자 상태 · Redis · DB 에 키가 가지 않는다(시험).
9. **Redis ACL**: 두 이름은 수집기 루트 키 목록에 없고 **셀렉터로만** 닿는다 — `(… ~wakeline:traffic_grid +set)` · `(~wakeline:traffic_grid:negative +hset
   +hgetall)`. 루트 목록에 두면 루트 명령(HDEL · HINCRBY · XADD …)이 모두 닿았다(검토 지적). 지우기 · 만료 바꾸기 · 모양 바꾸기(XADD · 스냅샷 HSET)는
   거부된다(`redis_acl_test.sh`). **SET 에 EX 를 붙이게 강제하는 ACL 은 없다** — 수집기가 늘 EX 1200 을 붙이고, 실제 방어선은 api 의 regDt 나이
   판정(stale)이다. 시간 창 키 `budget:komsa_traffic:h:*` 는 기존 `~budget:*`(Lua · EXPIRE 셀렉터)로 쓴다. ais 는 접근 없음, api 는 `~wakeline:*` 로 읽는다.

## 버린 대안
- **칸 번호를 풀어 위치 계산**: 번호 체계를 확인하지 않았다 — 짐작한 위치를 보이지 않는다(사용자 규칙).
- ~~**bbox 로 한 번에 여러 칸(최대 100)**: 호출 수를 크게 줄이지만 bbox 응답을 확인하지 않았다. 확인한 한 칸 조회로 시작하고, 확인되면 후속으로 바꾼다~~
  — **2026-10-01 채택**: bbox 응답을 실제 호출 두 번으로 확인했다(10 km 28칸 · 50 km 450칸). 아래 '개정(2026-10-01 bbox)'.
- **스냅샷을 DB 에 저장**: 5분 집계는 파생 · 일시 값이고 이력 화면이 없다 — Redis(TTL)만. 격자 기하만 DB(재기동 뒤 재조회 방지).
- **교통 호출 같은 주기 다시 부르기**: 틱 30 s 가 곧 다시 부르고, 다시 부르기를 더하면 한 시간 상한 계산이 흔들린다 — 물러나기만.
- **고정 발행 지연(regDt + 5분 + 60 s)**: 처음 구현. 공급자가 65 s 넘게 늦으면 주기마다 두 번 불러 시간 상한에 막히고 하루 몇 시간씩 '멈춤'이었다(검토 ·
  24시간 모형) — 관측으로 배운다.
- **시간 상한을 메모리에만**: 재기동이 되풀이되면(기동마다 곧바로 부른다) UTC 날 예산 400 만 남아 KST 하루에 400 + 400 까지 갈 수 있었다 — Redis 시간 창.
- **해양수산부 두 API 는 UTC 날 예산만(3,000 + 6,000)**: 합친 때의 선택. 같은 까닭으로 KST 하루에 두 몫을 쓸 수 있었다(검토 지적) — 함께 세는 시간 창.
  **UTC 날 예산을 반으로(2 × (입출항 + 격자) ≤ 10,000 — 예: 2,000 + 3,000)**도 보았다: 코드는 그대로지만 입출항 조회가 하루 내내 줄고, 첫 채우기(하루
  3,000칸)도 UTC 날 두 개에 걸친다 — 함께 세는 시간 창은 채우기가 쉬는 동안 입출항 조회가 시간당 390 까지 쓴다.
- **계속 실패하는 칸을 끝없이 다시 묻기**: 6시간마다 영원히 묻고 '확인 중'으로 보였다 — 5번 뒤 failed(1일)로 따로 센다.

## 선택값(잰 값이 아니다)
발행 지연 처음 추정 60 s · 배운 값 범위 30–540 s · 줄여 보기 3 s · 좁히기 90 s · 최소 간격 120 s · 시간당 15회 · 물러나기 단계 · 미래 허용 120 s ·
틱 30 s · 틱당 15칸 · 채우기 15 s · 차단기 3회 · 연달아 실패 5번 · failed 1일 · 부정 캐시 7일 · DB 대기 10분 · TTL 20분 · 오래됨 15분 · 호스트 1 req/s ·
예산 400 · 6,000 · 해양수산부 시간 창 390 · 입출항 몫 100 · 색 구간 · 웹 조회 90 s · 다시 보일 때 최소 간격 10 s.

## 확인하지 못한 것(사용자 키로 배포 뒤 볼 일 — 이 레인은 외부를 부르지 않았다)
- **발행 지연**: 공급자가 regDt 뒤 몇 초에 그 자료를 내주는지 모른다. 이제 일정이 스스로 배우므로 가정에 기대지 않는다 — 배운 값(위쪽 끝)은 heartbeat
  `traffic_grid_publish_delay_s` 에 보인다. 540 s 를 넘게 늦는 공급자라면 주기마다 이른 호출이 생겨 시간 상한에 닿고 자주 '멈춤'이다(정직하게 보인다).
- **모르는 grid_no 에 대한 WFS 응답**: 빈 FeatureCollection(`numberOfFeatures` 0)이면 not_found(7일), 포털 게이트웨이 오류 문서 등이면 오류 → 5번 뒤
  failed(1일). 어느 쪽이든 화면에 이유가 따로 보인다. 실제 모양은 확인하지 않았다.
- **Flyway 번호**: V14 는 V13(해결 표시 `ops_resolution` — ADR-024)과 함께 합쳐졌다(V13 → V14 순서). 레인 브랜치만으로 `make migrate` 를 돌린 DB 가
  있다면 V13 이 뒤에 들어와 Flyway 검증(outOfOrder=false)이 실패한다 — 그런 개발 DB 는 다시 만든다.

## 결과 · 대가
- 공급자는 5분 집계라 선박 하나하나는 보이지 않는다 — 화면은 늘 "개별 선박 위치 아님"을 적는다. 연안의 교통 밀도(AIS 수신국이 없는 곳 포함 여부는
  공급자 자료 범위에 따른다 — 확인하지 않았다)를 한 번에 볼 수 있다.
- 일부 칸만 보인다(상태 줄이 수를 적는다) — 조회는 시간당 많아야 290칸 · UTC 날 6,000칸. ~~첫 기동 뒤 약 18시간 이상 … 첫 채우기 약 5,100회 뒤로는
  새 칸만 묻는다~~(2026-10-01 개정으로 철회 — 결과가 없는 칸이 계속 나타나는 동안 채우기는 몫을 계속 쓰고, 끝나는 때는 계산할 수 없다).
- fixture 모드(`make e2e` · `make demo`)는 외부 호출이 없어 이 레이어가 '꺼짐 — fixture 모드'다(fixture 공급자는 만들지 않았다 — 후속 후보).
- 운영 실행 기록에 `traffic_grid`(ok · unchanged · error · budget_*) · `traffic_grid_geom`(틱마다 호출이 있었을 때 한 줄)이 쌓인다 — `unchanged` 는 호출은
  했으나 새 자료가 아니었다는 뜻이다(운영 화면에서 ok 가 아닌 색으로 보인다).

## 검증(자동 시험 — 외부 호출 없음)
수집기 `tests/test_traffic_grid_geo.py`(원점 · 확인 표본 · pyproj 대조 · 왕복 · 격자 검사 · GML: 확인 표본 · 0건 · 다른 칸 · 격자 밖 · srsName · 다각형 둘 ·
posList 형식 · OGC 예외 · 포털 게이트웨이 오류 · 빈/HTML/JSON 본문 · DOCTYPE · 크기) · `test_traffic_grid_komsa.py`(확인 모양 · 한 건 객체 · 빈 모양 · 숫자 글자 ·
resultCode 오류 · 포털 XML 오류 · regDt · 항목별 거절 · 겹침 · 스냅샷 값(failed 포함) · 5,099칸 크기) · `test_traffic_grid_providers.py`(허용 호스트 · 버킷 ·
우선순위 · 키 정규화(이중 인코딩 없음) · 파라미터 이름 · 가림) · `test_traffic_grid_job.py`(일정 · 24시간 공급자 모형으로 발행 지연 배우기(지연 0–300 s ·
흔들림 · 틱 30/45 s — 시간당 평균 13회 이하 · 어느 한 시간 15회 이하 · regDt 나이 900 s 미만) · 빨라진 공급자 따라가기 · 배운 값 재기동 복원 · Redis 시간 창
(재기동 반복) · unchanged · 미래 regDt · 시간당 상한 · 실패 물러나기 · 예산 소진 · 예산 저장소 장애 · 속도 상한 반환(하루 · 시간 창) · 운영자 스위치 · partial ·
부정 캐시와 7일 · 재기동 · 칸 오류 물러나기 · failed(5번 · 1일) · 재시도 순서 · 차단기 · WFS 예산(막히면 한 번 적고 다음 UTC 날까지 조용히) · 해양수산부
시간 창(입출항 몫을 남기고 멈춤 · 다음 UTC 시에 다시 · 창이 차면 멈춤 · 반환) · DB 캐시 · DB 대기 · 발행 실패 · 취소 반환) · `test_budget.py`
(시간 창 · 함께 세는 창과 headroom) · `test_portcalls_job.py`(입출항도 같은 창 · hourly_cap) · `test_main.py`(창 상한 × 25 ≤ 포털 한도) · `test_traffic_grid_db.py` · `test_redis_integration.py`(실 Redis · 수집기 ACL — 시간 창 키 둘(교통 · 해양수산부) · HDEL/XADD 거부, 선택 실행) · `test_rest_contract_rules.py` ·
가림 벡터, api `TrafficGridReaderTest`(failed 합 · 미래 regDt) · `TrafficGridIT`(수집기 ACL 로 SET EX · 304 · 오래됨 · 꺼짐 · 없음) · `RestSamplesIT` +
`rest_contract_check` · `RolePrivilegesDbTest`(V14) · `LogMaskerTest`(같은 벡터) · OpenAPI 스냅샷, 인프라 `test_redis_acl_rules.py`(셀렉터 모양) ·
`redis_acl_test.sh`(HDEL · HINCRBY · XADD · HSET · GET 거부) · `test_compose_policy.py`, 웹 `tests/traffic-grid.test.ts`(시계로 본 오래됨 · 다시 보일 때 조회 ·
위치 조회 실패) · `tests/mapview-traffic-grid.test.ts`(조회 실패 뒤 오래된 값 안 그림 · 오래되는 순간 비움).
2026-10-01 개정: 수집기 `tests/test_traffic_grid_fill.py`(스냅샷 줄 · 같은 regDt 호출에서 넣은 칸도 +K · 넣지 못한 칸은 서로 다른 칸 수 · 채우기 요약 줄 ·
heartbeat 의 채우기 상태(daily_budget · waiting_db 포함) · failed 로 뺀 수 · 부정 캐시는 기한이 지난 항목만 비움 · 재기동 · 한정된 칸 모형에서 수렴) ·
`tests/test_db_pg_integration.py`(실제 WFS 응답을 해석한 칸이 V14 에 저장되고 다음 기동이 되살림 — 선택 실행), 웹 `tests/ops-traffic-grid-fill.test.ts`
(heartbeat 가 오래됐거나 꺼짐이면 수를 보이지 않음) · `tests/guide-page.test.ts`(설명서가 끝나는 때를 말하지 않음).

## 개정(2026-10-01) — 격자 위치 채우기: 끝나는 때를 말하지 않는다 · 스냅샷 줄이 무엇을 세는지 · 채우기마다 요약(운영 로그)
운영 질문: 채우기가 수렴하는가. 아래 '잰 것'은 운영 스택의 수집기 · api · db 표준 출력(2026-09-30 UTC, 오케스트레이터가 읽어 넘김)이고,
'계산'은 그 수와 코드 상수로만 한 산수다. 합성 모형의 수는 적지 않는다(가정이라 — 시험은 규칙만 확인한다).

**잰 것**
- 두 번의 기동(17:18:10Z · 18:05:59Z) 모두 `502 negative-cached grid ids loaded` · `7303 grid cells loaded from marine_grid4`.
- 17:18:11Z `MOF hourly window: grid share used (304 of 390 in UTC hour 2026093017, 100 left for port calls) — geometry fill resumes at 18:00Z`.
- 호스트 종료: api 가 17:58:43Z 부터 DB 연결 실패, 17:58:48Z Redis 재연결 거절 · db 가 17:58:45Z 깨끗이 멈춤 · AIS 공백 17:58:43Z → 18:05:53Z(프로세스 멈춤).
  수집기의 마지막 줄은 17:58:01Z, 다음 기동은 18:05:59Z.
- 18:18:17Z `(290 of 390 in UTC hour 2026093018 …) — resumes at 19:00Z`.
- 스냅샷 줄 `regDt … — N cells (0 rejected, K new unknown ids)`: 예) 18:55:05Z 3,846칸 · K = 342. K 는 스냅샷마다 약 340–450, 재기동 직후 1,372
  (30시간 창의 첫 줄 1,379). 스냅샷 크기: 5,099 · 5,128(2026-09-29) · 6,422(2026-09-30) · 3,846(2026-09-30 18:55Z).

**계산 · 코드에서 읽은 것**
- 두 기동 사이에는 조회가 한 번도 나갈 수 없었다: 17:18:11Z 부터 18:00Z 까지는 시간 창에 막혀 쉬었고, 18:00Z 전에 호스트가 멈췄다(17:58:4xZ — 설사
  그 뒤까지 살았어도 Redis 가 거절해 두 예산이 엄격이라 부르지 않는다). 그래서 7,303 · 502 가 같은 것은 결과가 남지 않는다는 증거가 아니다.
  18시 창의 290 은 18:05:59Z 의 DB 읽기 **뒤에** 쓴 것이다. 찾은 칸은 틱마다 `marine_grid4` 에 upsert(V14 CHECK 를 통과하는 값 — 실 PostgreSQL 시험
  `test_db_pg_integration`), 해양격자에 없는 칸 · 격자 밖은 Redis 부정 캐시에 적는다(코드 · 시험). 단서: upsert 는 수집기의 DB 쓰기 큐를 거친다 — DB
  장애 동안 500건을 넘으면 오래된 쓰기부터, DB 가 거절하거나 거듭 실패한 쓰기도 버리고 다시 보내지 않는다(heartbeat `db_dropped` · /logs WARN
  `db: write queue full … dropping oldest` · `db: … rejected … dropped`). 그렇게 버려진 칸은 그 프로세스의 메모리에만 남아 다음 기동 뒤 한 번 더
  묻는다(조회 하나). 확인: 이어지는 두 기동의 `N grid cells loaded from marine_grid4` 차이 = 그 사이 요약 줄들의 found 합(버린 쓰기가 없을 때).
- 결과가 있는 칸 7,303 + 502 = 7,805 > 본 스냅샷 중 가장 큰 6,422 — 배가 있는 칸은 스냅샷마다 바뀌어, 시간이 지나며 나타나는 칸이 스냅샷 하나보다
  많다. 그 전체 수는 잰 적이 없다 → **채우기가 끝나는 때는 계산할 수 없다**(위 결정 3 · 결과의 '약 18 · 22시간' 철회).
- K(예전 'new unknown ids')는 `GridGeometry.observe` 가 이 프로세스의 메모리 대기열에 **새로 넣은** 칸 수다: 기하도(DB 에서 읽은 것 + 이 프로세스가
  찾은 것) 유효한 부정 캐시도 없고 대기열에도 없는 칸. 한 프로세스 안에서 한 칸은 대기열을 떠나기 전에는 다시 세지 않는다(부정 캐시 기한이 지나면
  다시) — 코드로는 같은 칸을 스냅샷마다 세는 것이 아니다(운영 로그로는 아직 확인하지 못했다 — 아래 열린 항목). 대기열은 재기동하면 비므로, 재기동 뒤
  첫 스냅샷은 결과가 없는 칸을 모두 다시 센다(1,372). 결과가 있는 칸은 다시 묻지 않는다. 같은 regDt 호출(unchanged)도 대기열에 넣는데 예전에는 그 수가
  어느 줄에도 없었다 — 이제 다음 스냅샷 줄의 K 에 더한다(K = 앞 스냅샷 줄 뒤에 넣은 칸 모두).
- 모형(코드에서 읽은 것): 대기열은 결과로만 준다(찾음 · 해양격자에 없음 · 격자 밖 · failed 로 뺌 — 조회는 시간당 많아야 290; DB 캐시를 늦게 읽으면 그때
  한 번 더 준다). 그래서 한 프로세스 안에서 채우기 한 번 앞뒤의 두 스냅샷 줄 사이 L 의 변화 = 그 사이 줄들의 ΣK − 그 요약 줄의 (f + nf + og + s)다.
  K 가 줄마다 340–450 으로 이어지면(새 regDt 는 시간당 12번) L 은 첫 줄(약 1,372) 뒤 시간당 12 × K − 290 = 3,790–5,110 늘어
  (20,000 − 1,372) ÷ (3,790–5,110) ≈ 3.6–4.9시간에 상한 20,000(MAX_TRACKED)에 닿는다. 그 뒤로는 K ≤ 앞 줄 뒤의 조회 수다 — 한 시의 몫은 정시에
  한꺼번에 나가므로(틱마다 15, 30 s) 정시 직후 두세 줄에만 줄마다 많아야 150(5분에 10틱), 잰 속도(아래 — 한 시 몫 약 12분)로는 약 120 이고 나머지 줄은 0.
  상한을 넘은 칸은 넣지 않고 다음에 보일 때 넣는다 — 전에는 수만 세고 어디에도 보이지 않았다(이제 스냅샷 줄 · 요약 줄 · heartbeat
  `traffic_grid_not_queued` — 마지막으로 읽은 스냅샷에서 넣지 못한 서로 다른 칸 수).
- **열린 항목 — 잰 K 가 모형과 맞지 않는다(풀지 못했다)**: 잰 K 는 줄마다 약 340–450 이 하루 내내다. 알려진 재기동은 08:49Z(17:49 KST 재배포 — 조사
  기록), 17:18Z, 18:05Z 이고, 08:49Z → 17:18Z 가 한 프로세스(8.5시간)였다면 위 모형대로는 기동 뒤 4.9시간 안에 K 가 떨어졌어야 한다. 13:48Z(22:48 KST)
  배포가 수집기를 다시 시작했는지는 모른다(조사 기록의 모르는 것 — 그랬다면 두 프로세스는 약 5.0 · 3.5시간이라, 어긋남은 5.0시간 프로세스의
  마지막 약 0.1–1.4시간으로 줄어든다). 확인하기 전까지 K 가 무엇을 세는지의 답은 코드 · 시험 · 합성 모형에서 나온 것이고, **채우기가 옳게 동작한다고
  말하지 않는다**. 확인 방법(새 스냅샷 줄 — 첫 줄의 'first snapshot since this process started' 로 프로세스의 시작을 안다): K 가 340 이상으로 이어지는
  프로세스는 기동 뒤 약 5시간 안에
  `lookup queue L` 이 20000 에 닿고, 그 뒤 K 는 정시 직후 두세 줄의 약 120 이하 · 나머지 줄 0 이어야 한다. L = 20000 인데 K ≥ 340 인 줄이 나오거나,
  채우기 한 번 앞뒤에서 L 의 변화가 ΣK − (f + nf + og + s) 와 다르면 모형이 틀렸다(다른 무엇이 대기열에 다시 넣는다) — 그때 다시 조사한다.
  08:49Z–17:18Z 수집기 로그를 다시 읽을 수 있으면 먼저 그것으로 본다(예전 줄에는 L 이 없어 K 와 재기동만 볼 수 있다).
- 하루: 24 × 290 = 6,960 > 하루 예산 6,000 — 쉬지 않고 채우면 UTC 날마다 하루 예산에서도 멈춘다(`daily budget exhausted (used=6000) — geometry fill
  resumes at <다음 UTC 날>`). 설계대로다(포털 한도 — 결정 1). 멈추는 때: 한 시의 몫은 정시에 한꺼번에 나가므로, 앞 20시간(00–19Z)이 모두 몫 290 을
  채웠다면(5,800) 남은 200 은 20:00Z 부터 틱 14번(15개씩 — 6.5분 이상)에, 잰 속도(18Z 시: 18:05:59Z 기동 → 18:18:17Z 에 창 290 — 입출항 호출 포함 약
  12분)로는 약 8분에 나간다 → 빨라야 약 20:07–20:10Z(05:07–05:10 KST)부터 다음 UTC 날(09:00 KST)까지. 입출항 호출이 앞 시들의 290 안에서 몫을
  나눠 썼거나 물을 칸이 떨어진 시가 있으면 더 늦거나 멈추지 않는다. (처음 적은 '빠르면 05:41 KST' 는 조회가 시간 안에 고르게 나간다고 본 틀린
  계산이었다 — 검토 지적.)
- 다시 묻는 규칙: 찾음 → 다시 묻지 않음. 해양격자에 없음 · 격자 밖 → 7일 뒤(보일 때만 — 칸마다 7일에 많아야 한 번). 오류 → 5분 · 30분 · 2시간 · 6시간
  뒤, 연달아 5번이면 failed(1일). 실패 횟수는 메모리라 재기동하면 처음부터이고, 대기열에 처음 묻는 칸이 남아 있는 동안 다시 물을 칸은 그 뒤에
  선다(결정 3의 순서) — 계속 오류인 칸은 대기열이 긴 동안 프로세스마다 약 한 번 묻는다. 요약 줄의 errors 로 보인다(값이 크면 후속).
- 잠재 결함 하나를 고쳤다(운영 증상의 원인은 아니다): 메모리 부정 캐시가 20,000 에 닿으면 새 부정 결과를 적지 않고 대기열에서만 뺐다 — 그 칸은 보일
  때마다 다시 물었을 것이다. 잰 크기는 502항목(2026-09-30 두 기동 — 채우기는 2026-09-29 부터)이라 운영에서는 닿지 않은 경로다. 첫 고침은 기한이 지난
  항목이 없으면 가장 먼저 끝나는 **유효한** 항목을 비웠다 — 그 칸도 다시 묻는다(검토 지적). 이제 기한이 지난 항목만 모두 비우고 유효한 항목은 상한을
  넘어도 남긴다(크기는 Redis 해시만큼 — 기동 때도 상한 없이 읽는다). Redis 해시는 줄지 않는다(수집기 ACL 에 HDEL 이 없다 — 다시 물으면 덮어쓴다) —
  기동 줄은 유효한 항목(까닭별)과 기한이 지난 항목을 나눠 적는다.

**보이게 한 것(DB 없이 수렴을 본다)**
- 스냅샷 줄: `regDt … — N cells (R rejected): A with geometry, B without (P waiting for a lookup, NF not in the MOF grid, OG off grid, F lookup failed[,
  Q not queued — queue full at 20000]); lookup queue L (+K newly queued[ — first snapshot since this process started: the queue is not kept across
  restarts, so ids queued before a restart are counted again])` — A ÷ N 이 지도에 그려지는 몫이다. Q 는 이 스냅샷에서 넣지 못한 서로 다른 칸 수,
  K 는 앞 스냅샷 줄 뒤에 넣은 칸 수(같은 regDt 호출에서 넣은 칸 포함 — 한 프로세스의 줄마다 더하면 그 프로세스가 넣은 칸 수).
- 채우기 한 번(다시 시작한 틱 → 멈춘 틱)마다 INFO 한 줄: `geometry fill pass <시작> → <끝> — n lookups: f found, nf not in the MOF grid, og off grid,
  e errors (s set aside as failed); C cells known, W ids waiting (r after an error)[, q of the latest snapshot's cells not queued (queue limit 20000)];
  mof_grid4 today u of 6000 (UTC day); <stopped: … — geometry fill resumes at … | paused: … | stopped: mof_grid4 switched off by the operator | queue empty — … | nothing due — …>`.
  시간 창 · 하루 예산으로 쉬면 시간마다 한 줄이다(따로 적던 '… resumes at …' 줄을 합쳤다). 시각은 로그가 늘 쓰는 UTC 'Z' 그대로.
  q 는 마지막으로 읽은 스냅샷에서 대기열이 가득 차 넣지 못한 서로 다른 칸 수다(누계가 아니다 — 처음 적은 'q not queued since start' 는 부를 때마다
  거절을 더해 칸이 아니라 거절 횟수였다: 검토 지적). 수렴은 이렇게 읽는다: 줄마다 C 가 f 만큼 늘고, A ÷ N 이 오르고, W · q 가 줄면 따라잡는 중 —
  W 가 늘고 q 가 0 보다 크면 새 칸이 조회보다 빨리 나타난다.
- 운영 화면 providers 탭 한 줄 '연안 교통량 격자 위치'(heartbeat 그대로 — 웹은 수를 만들지 않는다, 모르면 "—", 시각은 KST): 그려지는 칸 / 스냅샷 칸 ·
  위치 확인 · 조회 대기 · 대기열이 가득 차 못 넣은 칸(마지막 스냅샷 — 0 보다 크면 주황) · 해양격자에 없음 · 격자 검사 실패 · 위치 조회 실패 · 오늘 조회 ·
  상태와 다음 때(시간 몫 · 하루 예산은 계획한 쉼이라 흐린 색, 연달아 오류 · 운영자 끔은 주황) · 마지막 채우기 한 번(웹 `tests/ops-traffic-grid-fill.test.ts`).
  collector 해시는 HSET 으로만 쓰이고 지워지지 않는다(키 없음 · fixture 로 도는 수집기는 `traffic_grid_state` 만 쓴다) — 그래서 수는 heartbeat
  `traffic_grid_at` 이 서버 시각(응답의 `generated_at`)으로 120 s 안(api `TrafficGridReader` 와 같은 선)이고 상태가 active · operator_off 일 때만 보인다.
  아니면 'heartbeat 오래됨 — 마지막 <KST>' · '꺼짐 — …' · 판정할 수 없음만 적는다(검토 지적: 멈춘 수집기의 '조회 중'과 수가 그대로 남았다).
- heartbeat(`/ops/providers` 의 collector 해시): 위 결정 5 목록의 채우기 진행 필드. `traffic_grid_fill_state` = filling · idle · retry_wait · waiting_db ·
  hour_window · daily_budget · breaker · operator_off, `…_resume_at` = 다음에 움직이는 때(없으면 빈 값), `…_fill_pass_*` = 이 프로세스에서 마지막으로 끝난 채우기.
- 버린 대안: **최신 스냅샷의 칸 먼저 묻기** — 지금 그려질 칸을 먼저 채우지만, 한 번 보이고 사라지는 칸에 조회를 쓴다. 잰 근거가 없어 순서는 그대로
  (처음 본 순서 — 늘 차는 칸이 먼저 보인다). **대기열을 Redis 에 두기** — 재기동 뒤 다시 세는 수가 줄 뿐 조회 수는 같다(결과가 있는 칸은 이미 넣지 않는다).

## 개정(2026-10-01 bbox) — 격자 위치를 bbox 타일로 채운다(버린 대안 → 채택)
운영 질문: 한 칸 조회로는 채우기가 새 칸을 따라잡지 못한다. 아래 '잰 것'은 오케스트레이터가 실제로 부르거나 읽은 것이고, '계산'은 그 수와 코드 상수로만
한 산수, '시뮬레이션'은 합성 분포와 가정한 서버로 돌린 모형이다(잰 값이 아니다 — 그렇게 적는다).

**잰 것**
- 실제 호출 두 번(2026-10-01 06:3x KST, 수집기 컨테이너에서, 키는 출력하지 않음 — `docs/review/evidence/public-data-apis-2026-09-29.txt` 끝):
  `getOpnG4sWFS?ServiceKey=…&bbox=916000,1935000,926000,1945000&srs=EPSG:5179&maxFeatures=100` → 200 `text/xml; subtype=gml/3.1.1` · 18,635 B ·
  `numberOfFeatures` 28 · grid_no + geom 지물 28(서로 다른 28, 한 칸 조회로 확인한 GR4_F2K41_C3 포함). `bbox=896000,1915000,946000,1965000`(50 km) ·
  `maxFeatures=1000` → 289,093 B · 450 · 서로 다른 450. 포털 문서(15074709)는 WMS 표에만 `bbox`(xmin,ymin,xmax,ymax) · `srs`(EPSG:5179)를 적는다 — WFS 명세는
  첨부 .docx(읽지 않았다).
- 운영 로그(2026-10-01 06:02–06:12 KST, 라운드 8 뒤): 5분 스냅샷마다 약 4,200칸 · 기하 없는 칸 약 1,400 · 처음 보는 칸 약 430 이 스냅샷마다 새로
  대기열에(시간당 약 5,000) · 한 칸 조회 190번 → 188 찾음 · 2 해양격자에 없음 · 아는 칸 7,303 → 8,216 · mof_grid4 UTC 날 5,852/6,000 · 채우기는 해양수산부
  시간 창(몫 290/390)에서 멈춤.

**계산**
- 한 칸 조회는 시간당 많아야 290칸인데 새 칸은 시간당 약 5,000 이 대기열에 들어온다 — 따라잡을 수 없다. bbox 는 호출 한 번에 수백 칸이다.
- 지물 하나 = (289,093 − 18,635) ÷ (450 − 28) = 640.9 B ≈ 641 B(확인한 한 칸 응답의 지물도 641 B), 봉투 약 700 B.

**결정**
1. **공급자** `Grid4WfsProvider.bbox(box)`(같은 주소 · 같은 공급자 `mof_grid4`): `ServiceKey`(한 칸 조회와 같은 인코딩 — 한 번만) ·
   `bbox=xmin,ymin,xmax,ymax`(EPSG:5179 m 정수) · `srs=EPSG:5179` · `maxFeatures=1000` — bbox · srs 의 쉼표 · 쌍점은 **기록한 호출처럼 인코딩하지 않는다**
   (httpx params 는 %2C · %3A 로 바꾼다 — 그 모양은 확인하지 않았다). 한 변 64 km 를 넘거나 정수가 아닌 상자는 보내지 않는다. 호출 하나 = 예산 1 —
   `mof_grid4` 하루 예산과 해양수산부 시간 창 `budget:mof:h:*` 모두, 한 칸 조회와 똑같이 예약하고 보내지 않은 호출은 둘 다 돌려준다. 우선순위
   `PRIORITY_BACKFILL`(가장 낮다) · 요청 전체 30 s(선택값 — 교통 호출과 같다). 해석은 `asyncio.to_thread` — 잰 값(합성 응답): 32 km 타일(201지물 ·
   128,737 B) 9.8 ms · 450지물(287,801 B) 22 ms, 이벤트 루프를 몇 ms 넘게 막지 않게(다른 큰 해석과 같은 규칙).
2. **해석** `marine_grid.parse_wfs_tile`: 지물마다 한 칸 조회와 같은 검사(공유 `_feature` — grid_no 형식 · 다각형 하나 · 안쪽 고리 없음 · 확인한 srsName ·
   EPSG:5179 → WGS84 · 0.025° 격자), DOCTYPE · ENTITY 거절은 해석 전. **나쁜 지물 하나는 그 지물만** — 격자 밖이면 off_grid(부정 캐시 7일 · 품질 사례
   `traffic_grid_off_grid` · 원본 보관), 모양 오류 · 번호 형식 오류 · 같은 번호의 다른 기하는 rejected(품질 사례 `traffic_grid_tile_feature_rejected` — 그 번호는 한 칸
   조회가 맡는다). **모든 지물이 모양 오류면 응답 전체가 오류**(빈 타일로 끝났다고 적지 않는다 — 예: 공급자가 좌표계 표기를 바꿈). `numberOfFeatures` 가
   없거나 수가 아니면 오류(잘렸는지 알 수 없다). **잘렸을 수 있음** = 지물 수 ≥ maxFeatures 또는 `numberOfFeatures` ≠ 지물 수 → 타일을 넷으로 나눠 다시
   묻는다(받은 칸은 지물마다 검사를 통과한 실제 기하라 쓴다). **타일은 어느 번호도 '해양격자에 없음'으로 만들지 않는다** — 상자에 없는 번호는 묻지 않은
   번호다(0건은 한 칸 조회만 말한다).
3. **크기 상한** `MAX_WFS_TILE_BYTES` = 384 KiB(393,216 B ≈ 612지물): 모형(칸이 빈틈없이 깔렸고 bbox 는 겹치는 칸을 모두 준다 — 가정. 같은 두 상자에서
   28칸 · 18,504 B, 450칸 · 287,599 B 를 내 확인한 두 호출과 1% 안) 으로 32 km 타일은 176–201지물 · 113–129 KB(33–39 N). 상한은 가장 큰 32 km 타일의
   약 3배이고 확인한 가장 큰 응답(289,093 B)보다 크다. 넘으면 해석하지 않고(`WfsTooLarge`) 넷으로 나눈다 — 오류로 세지 않는다(가장 작은 4 km 에서도 넘으면
   오류 → 물러나기). 한 칸 조회 상한 256 KiB 는 그대로.
4. **타일** `grid_tiles.Tile`: EPSG:5179 원점에 고정한 32 km 정사각형(키 `level/ix/iy`), 나누면 16 → 8 → 4 km(`MAX_LEVEL` 3). 32 km 인 까닭: 기대 지물
   (≤ 약 200)이 확인한 450 의 절반 아래라 maxFeatures · 응답 크기의 서버 상한(확인하지 않았다)에서 멀고, 시뮬레이션(아래)에서 아는 칸의 넓이를 약 150번 —
   한 시간 몫의 절반 — 에 덮는다. 25 km 는 호출이 약 1.5배(225), 40 km(104번)는 지물 약 300 · 약 190 KB 로 450 에 가까워진다.
5. **어디를 묻는가 — 받은 기하에서만(칸 번호로 위치를 계산하지 않는다 — 사용자 규칙)**: ① 아는 칸(marine_grid4) 중심이 든 가장 작은 타일(칸이 많은 타일
   먼저) — 단 모서리 하나라도 끝난 타일 안인 칸은 세지 않는다: 타일은 가장자리에 걸친 칸도 주므로, 세면 재기동마다 끝난 타일의 이웃을 모두 넣어 바깥으로
   번져 갔다(시험으로 찾았다 — `test_finished_tiles_survive_a_restart_and_are_not_fetched_again`) ② 한 칸 조회로 찾은 칸의 타일(곧바로 다음 차례) ③ 받은
   타일에서 **지금 스냅샷에서 위치를 모르던** 칸이 타일 경계에 닿거나 넘으면(받은 꼭짓점의 EPSG:5179 범위) 그 꼭짓점이 든 이웃 타일 — 배가 없는 곳으로는
   넓혀 가지 않는다. 순서: 나눈 타일 → 한 칸 조회 · 가장자리 · 다시 묻기 → 아는 칸(칸 많은 순). 오류가 났던 타일은 처음 묻는 타일 뒤.
6. **예산 · 순서**: 물을 타일이 있으면 채우기 몫(시간당 290)을 타일에 먼저 쓰고, 한 칸 조회는 물을 타일이 없을 때만 — 같은 틱에 타일이 푼 칸은 한 칸
   조회 대기열에서 빠진다. 틱당 15번 · 15 s · 해양수산부 시간 창(입출항 몫 100) · 하루 6,000 · 차단기(한 칸 조회와 함께 연달아 3번) · 운영자 끔은 모두 그대로.
   타일 오류는 그 타일만 5분 → 30분 → 2시간 → 6시간, 5번 연달아면 failed(1일 — 품질 사례 `traffic_grid_tile_failed` · WARN).
7. **상태 저장 — Redis 해시 `wakeline:traffic_grid:tiles`**(키 → `{"status","at","cells"}`), 재기동 뒤 끝난 타일을 다시 묻지 않는다. 고른 까닭: (a) 부정 캐시와
   같은 자리(WFS 결과의 메타는 Redis · 칸 기하만 DB) — Flyway · api 권한을 바꾸지 않는다, (b) redis 는 AOF(`appendonly yes`)라 재기동을 넘는다, (c) DB 표로 두면
   칸과 한 트랜잭션에 적을 수 있지만, 쓰기가 버려진 경우(큐 넘침 — 아래) 두 방식 모두 같은 값으로 되살아난다: 다음 기동에서 그 칸들은 모르는 칸이 되고
   한 칸 조회 한 번이 칸을 찾으면 그 타일을 다시 묻는다(DB 표면 그 타일이 끝나지 않은 채라서, Redis 면 아래 recheck 로). 대가: 수집기 ACL 셀렉터에 이 이름을
   더했고(`(~wakeline:traffic_grid:negative ~wakeline:traffic_grid:tiles +hset +hgetall)` — 정확한 이름, 루트 목록에 없음, DEL · HDEL · SET · EXPIRE 거부) **redis 를
   다시 띄워야 적용된다** — 그 전에는 NOPERM: 채우기는 DB 캐시처럼 기동 뒤 10분 기다린 뒤 메모리로만 하고(끝난 타일은 재기동 뒤 다시 묻는다) WARN 한 줄로
   까닭 · 고칠 곳을 적는다(읽기 · 쓰기 실패 INFO 는 까닭마다 한 번).
   **기한(TTL)**: 키 전체의 EXPIRE 는 ACL 에 없다(주면 끝난 타일을 한꺼번에 잊는다) — 항목마다 `at` 으로 논리 만료. done · split 은 기한이 없다(칸의 기하는
   바뀌지 않는다고 본다 — 한 칸 조회도 찾은 칸은 다시 묻지 않는다, 같은 규칙). incomplete(4 km 도 잘렸을 수 있음) · failed 는 1일. **주기적으로 다시 받지
   않는다** — 근거가 없다. done 을 다시 묻게 하는 것은 증거뿐이다: 한 칸 조회가 done 타일 안에서 칸을 찾으면 그 타일은 그 칸을 주지 않았다(DB 쓰기를 잃었거나
   서버가 조용히 뺐다) — 이 프로세스에서 한 번 다시 묻고(INFO), 다시 받아도 없으면 WARN · 품질 사례 `traffic_grid_tile_missing_cell`(bbox 가 칸을 빠뜨린다는
   증거 — 그 칸은 한 칸 조회가 맡는다). 되풀이하지 않는다.
8. **저장 · 성능**: 한 타일의 새 칸 · 바뀐 칸은 DB 쓰기 한 번(쓰기 큐 작업 하나 — 큐 상한 500 은 작업 수라 450칸도 작업 하나이고 499개가 차 있어도 버려지지
   않는다: `test_a_450_cell_tile_is_one_queued_write_that_a_nearly_full_queue_keeps`). 큐가 넘쳐 버려지는 경우는 여전히 있다(DB 장애 동안 가장 오래된 작업) —
   위 7 로 되살아난다. **아는 칸 지도**: 타일은 상자 안의 칸을 모두 주므로 아는 칸이 스냅샷 크기가 아니라 넓이만큼 는다(시뮬레이션 90분에 25,299 —
   모형에서는 육지 칸도, 위 끝: 32–39 N × 124–132 E 상자 609타일 × 약 200 ≈ 12만). 잰 값(tracemalloc, 합성 칸 10만): 고치기 전 25.4 MB(254 B/칸) →
   Cell 을 slots 로 · 격자점 float 을 공유해 11.9 MB(119 B/칸). 수집기 한도 512 MiB. marine_grid4 읽기(10만 행 약 0.3 s — 잰 값)와 아는 칸의 타일 셈
   (칸마다 투영 약 3 µs — 잰 값)은 스레드에서.
9. **관측**: 채우기 요약 줄에 타일 절 — `…; t tiles: c cells listed (k new), x split as possibly truncated, y errors; tiles queued q, done d; …`(타일 공급자가
   있을 때만), 끝 까닭에 `; no tile queued (d done)` · `nothing due — n ids and t tiles waiting for a retry …`. 기동 줄 `bbox tiles — N tile states loaded (…)` ·
   `bbox tiles — N tiles queued from K known cells (d tiles done)` — **운영의 실제 타일 수는 이 줄이 말한다**. 나눔 INFO `tile … possibly truncated (…) — split
   into 4`, incomplete · failed · 빠진 칸은 WARN. heartbeat `traffic_grid_tiles_done` · `traffic_grid_tiles_queued` · `traffic_grid_fill_pass_{tiles,tile_cells,
   tile_new,tile_splits,tile_errors}`(타일 공급자가 없으면 빈 값), 채우기 상태에 `waiting_tiles`. /ops 줄(웹 `lib/traffic-grid-fill.ts` — 값 그대로): 'bbox 타일 끝 N ·
   대기 M' 과 마지막 채우기의 '타일 n → 칸 c(새 k) · 나눔 s · 오류 e' — 수로 알렸을 때만(0 으로 채우지 않는다). 설명서 · /about 은 '칸마다 한 번'을 '약
   32 km 상자 하나에 그 안의 칸을 모두 — 상자가 주지 않은 칸만 한 칸씩'으로, 한도는 '시간당 290번 · 하루 6,000번'으로 고쳤고 여전히 끝나는 때는 적지 않는다.

**시뮬레이션(잰 값이 아니다 — `apps/collector/tests/test_traffic_grid_tile_sim.py`, 합성 분포 `tests/coast_sim.py`: 한반도 해안을 손으로 찍은 점 몇 개로
이은 꺾은선 · 40 km 띠 · 항로 넷, 서버는 위 3 의 모형)**
- 오늘의 아는 칸 수(8,216)를 합성 분포에서 무게 비례로 뽑으면 그 칸들이 든 32 km 타일은 **147개 → 시간 몫 290 으로 약 0.5시간 · 하루 예산 6,000 의 2.5%**
  (25 km 225 · 40 km 104). 가장자리로 넓히는 이웃은 많아야 둘레 한 겹(111). **분포와 상관없는 위 끝**: 32–39 N × 124–132 E 상자 전체(육지 포함) 609타일 =
  약 2.1시간 · 하루 예산의 10%.
- 채우기 모형 90분(같은 아는 칸 · 같은 규칙 · 첫 스냅샷 약 4,000칸): 스냅샷의 '위치 모르는 칸' 몫 — 한 칸 조회만 17.7% → 16.3%(30분) → 15.6%(90분),
  시간당 290 을 다 쓰고 아는 칸 8,796. 타일 먼저 30분부터 0%, 첫 시 151호출 · 둘째 시 2호출, 아는 칸 25,299. 둘 다 어느 UTC 시에도 290 이하.
- 운영에서 미리 셀 수 있다(PostGIS — 버리는 컨테이너에서 문장을 확인했다, 운영 DB 에는 돌리지 않았다):
  `SELECT count(DISTINCT (floor(ST_X(p) / 32000), floor(ST_Y(p) / 32000))) FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint((lon_min + lon_max) / 2,
  (lat_min + lat_max) / 2), 4326), 5179) AS p FROM marine_grid4) s;` — 배포 직후(끝난 타일이 없을 때) 기동 줄의 N 과 같아야 한다.

**확인하지 않은 것**
- `maxFeatures` 의 상한 · 서버의 응답 크기 상한 · 서버가 조용히 자르는지 — 450 까지는 다 왔다. 32 km 타일(≤ 약 200)은 그 아래에 머물도록 고른 크기다.
- `numberOfFeatures` 가 '돌려준 수'인지 '맞는 전체 수'인지 — 어느 쪽이든 지물 수와 다르면 나눈다. 서버가 maxFeatures 보다 적게 조용히 자르고
  numberOfFeatures 도 같이 줄이면 응답만으로는 알 수 없다 — 위 7 의 recheck 가 증거(WARN)로 잡는다.
- bbox 가 상자와 '겹치는' 칸을 주는지 '안에 든' 칸만 주는지 — 확인한 두 수(28 · 450)는 겹침 모형과 맞는다(가장자리 칸이 두 타일에 나온다 — 같은 값 upsert).
  안에 든 칸만이라면 가장자리 칸 일부는 한 칸 조회가 맡는다(틀린 값이 되지는 않는다).
- 쉼표 · 쌍점을 인코딩한 요청(%2C · %3A)을 서버가 받는지 — 보내지 않는다(기록한 모양 그대로).
- 격자가 육지에도 깔렸는지 — 50 km 상자의 450 은 상자를 빈틈없이 덮는 수와 같다(모형). 그렇다면 아는 칸이 바다보다 넓게 는다 — 메모리 계산(위 8)은
  그 경우로 했다.
- WFS 기술문서(첨부 .docx) — 읽지 않았다. 실제 칸 분포 — 타일 수는 시뮬레이션이고, 실제 수는 배포 뒤 기동 줄이 말한다.

**버린 대안**
- 더 큰 타일(48–50 km, 약 430–450지물): 확인한 450 에 너무 가깝다 — 숨은 상한이 있으면 곧바로 닿는다. 더 작은 타일(25 km): 호출이 약 1.5배, 얻는 것 없음.
- 칸 번호로 이웃 · 위치 계산: 번호 체계를 확인하지 않았다(사용자 규칙).
- 타일 상태를 DB 표(Flyway V18)로: 위 7 — 되살아나는 길이 같고 스키마 · api 권한 · 되돌리기 SQL 을 더한다.
- 끝난 타일을 정해진 주기로 다시 받기: 격자 기하가 바뀐다는 증거가 없다 — 다시 묻는 것은 증거(recheck)로만.
- maxFeatures 를 타일 크기에 맞춰 줄이기(예: 500): 받아들인 값으로 확인한 것은 100 · 1000 뿐이다 — 확인한 1000 을 쓰고 크기 상한으로 막는다.

**검증(자동 시험 — 외부 호출 없음)**: 수집기 `tests/test_traffic_grid_tile_parse.py`(모형이 확인한 두 호출을 재현 · 지물 641 B · 32 km 타일과 크기 상한 · 여러 지물 ·
빈 타일 · maxFeatures 에 닿음 · 수가 다름 · numberOfFeatures 없음 · 나쁜 지물 하나 · 번호 형식 · 모두 거절이면 오류 · 중복 · DOCTYPE · 오류 문서 · 밖의 지물) ·
`test_traffic_grid_tile_plan.py`(타일 · 키 · 기하에서만 · 순서 · 한 번만 · split 따라 내려가기 · 물러나기 · failed 1일 · 다시 묻기 한 번 · 상태 재기동) ·
`test_traffic_grid_tile_job.py`(타일 먼저 · 예산 1(하루 · 시간 창) · 시간 몫에서 멈춤 · 속도 상한 반환 · 한 칸 조회가 찾은 칸의 타일 · 가장자리(받은 기하 ·
스냅샷의 모르는 칸만) · 나눔 · incomplete · 크기 초과 · 오류 · 차단기 · 재기동 뒤 다시 묻지 않음 · 타일 상태 기다림 → 메모리 · 로그 한 번 · 타일은 '없음'을
만들지 않음 · recheck · 요약 줄 · heartbeat · 스레드 · main 연결) · `test_traffic_grid_tile_sim.py`(시뮬레이션) · `test_traffic_grid_providers.py`(bbox 요청 모양 ·
스레드 해석 · 틀린 상자 · 크기 초과 · 가림) · `test_traffic_grid_geo.py`(float 공유 · 10만 칸 메모리) · `test_traffic_grid_db.py`(450칸 = 쓰기 하나) ·
`test_redis_integration.py`(실 Redis — 수집기 ACL 로 타일 상태 HSET/HGETALL · DEL/HDEL/SET/EXPIRE 거부, 선택 실행 — 버리는 redis:8-alpine 에서 통과), 인프라
`test_redis_acl_rules.py` · `redis_acl_test.sh`(버리는 컨테이너에서 297 통과), 웹 `tests/ops-traffic-grid-fill.test.ts` · `tests/guide-page.test.ts`.

