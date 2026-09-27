# 변경 계약 v3 — 리뷰(2026-09-28) 결함 수정 · AIS 수신 범위 (v2 를 고치는 부분만)

v2(`change-contract-v2.md`)는 그대로 유효하다. 아래 항목만 v2 를 대체·추가한다. 근거: `docs/audit/review-2026-09-28b.json`(적대적 리뷰 19건, 모두 검증 통과)과
이 문서 §0 의 실측.

## 0. 실측(2026-09-28, 이 기계)
- 전세계 1연결(`-90,-180,90,180`) 10분: 평균 72 msg/s(최대 140). 서버 자원은 여유(ais CPU 평균 1.9 % · 메모리 43→70 MiB, api +108 MiB RSS,
  Redis 스트림 2.5 MiB, ship_position 분당 2,000~5,700 행 · 행당 약 179 B). 그러나 연결 11회 끊김·공백 합계 87 s.
- 끊김 원인: 우리 쪽 keepalive ping timeout(1011). 소켓 수신 대기열은 0(우리는 즉시 읽음) — aisstream 쪽 연결별 지연이
  13→17→22 s 로 커지다가 pong 이 20 s 안에 오지 않았다.
- 반구·지역별 1연결 150~180 s: 서경(−180~0) 지연 2 s 안정 · 동경(0~180) 4→53 s 증가 · 유럽(0~45°E) 단독도 2→33 s 증가 후 서버가
  프레임 없이 끊음 · 아시아·태평양(45~180°E) 1.8 s 안정 · **아메리카+아시아·태평양 1연결(`-90,-180,90,0;-90,45,90,180`) 2~5 s(순간 11 s) 안정**.

## A. AIS 수신 범위(결정)
- 운영 설정 `ais_bboxes` 를 `-90,-180,90,0;-90,45,90,180`(0~45°E 제외 전 해역)으로 둔다. `.env` 기본값(동아시아)은 그대로.
  0~45°E(유럽·아프리카·중동 서부)는 이 공급자의 연결 하나로 실시간 전달이 되지 않아 뺀다(§0). 여러 연결로 나누는 것은 후속 과제(ADR-014 부록).
- **수신 범위를 화면에 보인다.** `status.sources.ais.coverage` = `[[lat1, lon1, lat2, lon2], ...]`(ais 상태 해시 `bbox` 를 api 가 파싱·검증, 1~16개,
  범위 밖·형식 오류면 null). 웹은 선박 레이어가 켜져 있을 때 수신 범위 밖을 옅게 가리거나 경계를 점선으로 그리고, 범례에 "선박 수신 범위" 를 적는다.
- `status.sources.ais.state` = ais 상태 해시의 `state`(starting·connecting·subscribed·receiving·backoff·replaying·disabled·stopped 중 하나, 그 밖이면 null).
  heartbeat 가 오래되면(기존 heartbeat_stale 규칙) state 는 키 없음.
- 공백 시각은 **수신 시각 기준**이다(v2 와 같음): started_at = 끊기기 전 마지막으로 받은 메시지의 수신 시각, ended_at = 다시 연결한 뒤 첫 **데이터**
  메시지 수신 시각. 공급자 쪽 지연(status `lag_p50_s`) 만큼 데이터 시각 구멍은 더 길 수 있다 — ADR-014 에 적는다(추정해 넓히지 않는다).

## B. position_source (v2 §B1·B2 대체)
- 값: Timestamp 0~59 → `"epfs"`(전자 위치 장치가 낸 위치의 UTC 초), 61 → `"manual"`, 62 → `"estimated"`, 63 → `"inoperative"`,
  60(값 없음 기본값)·필드 없음·범위 밖 → **null**. `"gnss"` 는 더 이상 만들지 않는다(장치 종류를 단정할 근거가 없다).
- 스키마 `ship_state.v1.json`: `position_source` 는 `["string","null"]`, enum `["epfs","manual","estimated","inoperative","gnss", null]` —
  `"gnss"` 는 배포 전환 중 스트림에 남은 옛 항목을 받기 위한 **레거시 값**이고, api 는 받자마자 null 로 바꾼다(0~60·누락이 섞여 있어 모름).
- DB V7: `ship_position.position_source` NOT NULL 해제, CHECK 를 `IN ('epfs','manual','estimated','inoperative')` 또는 NULL 로, 기존 `'gnss'` 행은 NULL.
- 웹: epfs → "전자 위치 장치(EPFS) · 선박 보고", manual/estimated/inoperative 는 기존 배지, null·gnss → "—".

## C. 수요 추적 남용 방지(v2 §A 추가)
- api(문지기): 세션마다 **새로 등장하는** 집중 추적 hex 는 60 s 창에 6개까지, 새 핫 셀은 60 s 창에 6개까지만 임대에 반영한다. 넘으면 그 세션의
  같은 종류 직전 임대를 유지하고(새 키 무시) `demand` 메시지의 해당 항목에 `state:"limited"` 를 싣는다. 종류가 바뀌는 변화(선택·선택 해제)가
  막히면 직전 키는 빼고 새 키만 막는다. 제한은 세션 단위이며 연결을 끊지 않는다.
- collector(방어 심층): 새 hex 의 빠른 첫 조회(fast path)는 5 s 에 1회까지, 새 핫 셀의 즉시 조회는 30 s 에 2개까지. 나머지는 정규 일정.
- collector 는 운영자가 끈 공급자(`wakeline:provider:adsb_fi` disabled=1)에 수요 조회를 하지 않는다. 이미 속도 상한 대기열에 들어간 조회도 취소한다.
  상태 해시에는 state **`disabled`**(호출 상한 `throttled` 와 구분 — 화면이 원인을 잘못 말하지 않게), interval_s null,
  last_error `"provider disabled by operator"`. api 는 `disabled` 를 그대로 전하고, 웹은 "공급자 꺼짐(운영자)" 로 보인다. (리뷰 후속으로 개정)

## D. 기타 계약 영향
- `/api/v1/ships/{mmsi}/track`: 선을 끊는 공백은 **60 s 이상 끝난 공백 또는 열린 공백**만(저장 간격이 60 s 라 더 짧은 수신 공백은 저장점을 없애지
  못한다). `properties.gap_break_min_s = 60`. 응답 `gaps` 는 창과 겹치는 공백 중 **최신 200개**(오래된 것부터 정렬), 넘으면 `properties.gaps_truncated = true`.
  선 끊기 판정용 긴 공백은 따로 조회해 잘림의 영향을 받지 않는다.
- `/api/v1/ais/gaps`: LIMIT 을 넘으면 **최신** 500개(오래된 것부터 정렬) + `truncated:true`.
- 웹 항적: 끝난 공백은 60 s 이상일 때만 선을 끊는다(열린 공백은 항상). 같은 started_at 의 열린 공백은 끝난 공백이 오면 대체한다.
- `/api/v1/ships` ETag 에 stale 여부·ais connected·gap_open_since·heartbeat_stale 를 넣는다.
- Redis ACL: 모든 서비스 사용자에서 `CLIENT TRACKING`·`CLIENT CACHING` 금지.
