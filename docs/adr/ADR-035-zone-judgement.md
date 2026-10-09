# ADR-035 판정 구역 일반화 — SIGMET 엔진을 구역(Zone)으로 넓히고, 공역은 같은 코드의 두 번째 상태 머신으로 판정한다

**상태** 채택 · 2026-10-09 · 사용자 승인("권장안대로" — [계획](../plans/features-2026-10/PLAN.md) §9 결정 D2 · D3 · D4) · [SPEC](../plans/features-2026-10/SPEC.md) F2 ·
계약 [v5 §G48](../audit/change-contract-v5.md) · 함께 보는 기록: [ADR-034](ADR-034-airspace-data.md) · [ADR-028](ADR-028-api-package-boundaries.md)(패키지 ·
로그 지문) · [VERIFICATION](../VERIFICATION.md) #118 · [PERF](../PERF.md) §16

## 맥락
- 판정 엔진(관측 교차 · 10분 예측 · 알림 상태 머신 · 근거)은 SIGMET 전용이었다(`SigmetIndex` · `Hit(sigmet)` · 열쇠 (hex, sigmet id) · 근거 키).
  공역 진입(금지 · 원전 · 제한)도 같은 규칙(2회 진입 · 3회 이탈 · 신호 끊김 · 예측)으로 판정하고 싶다.
- 공역의 고도 한계는 기준이 섞여 있다(해면 · FL · 지면 기준). 항공기 고도는 기압고도(표준 기압)뿐이다. 지면 기준 한계는 지형 높이를 모르면 비교할 수 없다.
- 비행제한구역은 86개라 사건이 얼마나 생길지 모른다.

## 결정
1. **`Zone` 인터페이스(weather.core)**: 다각형 · 고도대 · 유효 시간 · 근거에 적을 것(고도대와 가정 · 유효 시간이나 차수 · 고도 주석) · 알림 머리.
   `SigmetRecord` 가 구현하고 `SigmetIndex` 는 `ZoneIndex` 가 됐다. SIGMET 의 동작 · 근거 키 순서 · JSON 은 그대로(동작 불변 리팩터링 커밋을 먼저 — WS 표본 ·
   OpenAPI 스냅샷 같음). **로그를 남기는 클래스의 이름 · 패키지는 바꾸지 않는다**(로그 지문 — ADR-028 §5-4). 엔진을 중립 패키지로 옮기는 것은 하지 않았다.
2. **공역은 두 번째 상태 머신**: `ZoneSource`(weather.core 인터페이스)를 `airspace.core.AirspaceZones` 가 구현한다(core → core 한 방향 · 순환 없음).
   엔진은 같은 주기에 SIGMET 판정 뒤 공역을 판정하고, 공역 쪽 예외는 SIGMET 을 막지 않는다. SIGMET 상태 머신의 상태 · 사건은 섞이지 않는다.
3. **판정 대상 · 수준(D2)**: 금지 · 원전 · 안보 임시비행금지 = 알림(alert), 비행제한 = 정보(info — 목록 · 카드에만, 배너 · 브라우저 알림 없음). 하한 · 상한 중
   하나라도 기준을 비교할 수 없으면(지면 기준 · 모름) 판정하지 않는다(실제 차수: 비행제한 86 중 1). 위험구역(상한 지면 기준)은 항공기 카드에 '고도 판정 안 함 —
   수평만'으로만 보인다(요청 때 계산 — 사건 아님). 그 밖의 종류는 표시만.
4. **고도(D3)**: 기압고도를 해면 고도로 본다(QNH 보정 없음) — 근거에 `assumption: pressure_altitude_as_msl`. 전이고도(14,000 ft) 아래에서 한계와 500 ft 안이면
   `altitude_uncertain`(판정은 원래 값). 무제한 상한은 `top_unlimited`.
5. **모드(D4)**: 운영 설정 `airspace_alerts` = off · shadow · on(V19 기본 shadow). shadow 는 따로 둔 상태 머신으로 판정하고 사건 수만
   `wakeline_zone_events_total{zone_type,mode,level,event}` 로 센다 — 저장 · 방송 없음. on 은 SIGMET 사건과 같은 묶음으로 발행(저장 · WS · REST).
   on 에서 벗어나면 열린 공역 알림을 구역 종료(`zone_ended`, end_cause `judging_off`)로 닫는다. 차수가 바뀌면 새 판에 없는 구역의 알림은 `edition_replaced`.
   api 는 설정을 60 s 안에 따른다(공역 읽기와 같은 주기).
6. **저장(V19)**: `alert_event` 에 `zone_type` · `level` · `airspace_id`(FK — 옛 차수의 행도 남는다), `sigmet_id` NULL 허용, 구역 CHECK, 공역 자연키는 부분
   유일 색인. 닫힘 사유 `zone_ended`. SIGMET 알림의 문장 · 자연키는 그대로. 알림 일 통계는 SIGMET 알림만 센다(뜻이 다르다).

## 버린 대안
- **공역을 SIGMET 처럼 꾸며 같은 상태 머신에 넣기**: FK · 근거 · 종료 판단(철회 · 공급자 누락)이 SIGMET 의 뜻이라 거짓이 된다.
- **한 상태 머신에 두 종류를 함께**: 열쇠를 종류로 나누면 되지만, SIGMET 경로(조회 · 통계 · 'inside_sigmets')가 모두 거르기를 더해야 한다. 둘로 두면 SIGMET 은
  그대로다.
- **METAR QNH 로 기압 보정**: '어느 공항의 값을 썼나'라는 새 가정이 생긴다. 먼저 단순한 가정 + 경계 표시로 사건 양을 본다.
- **위험구역을 수평만으로 사건화**: 상한이 지면 기준이라 그 위를 지나는 순항기가 모두 걸린다.

## 결과
- 시험: api `AirspaceJudgementTest`(대상 · 수준 · FL250 은 FL180 위 · 근거 · 경계 근처 · shadow 는 세기만 · on → shadow 종료 · 차수 교체 · 예측 · 카드 조회) ·
  `WeatherPersistDbTest`(공역 저장 · 자연키 · 이력의 구역 필드 — SIGMET 행 그대로) · `QueryPlanDbTest`(이력이 여전히 hex 색인) · `WsSchemaContractTest`
  (공역 표본 · 틀린 표본 셋) · REST 계약(공역 알림 · 들어 있는 공역) · `RegionSettingsTest`(모드 값) · web `airspace-alerts.test.ts`.
- 성능: [PERF §16](../PERF.md) — 같은 자료로 엔진 한 주기를 쟀다.
- 남은 한계: 기압 보정 없음(경계 근처 표시로만), 지면 기준 한계는 판정 안 함, 공역에 유효 시간(NOTAM 활성화)이 없다 — 늘 유효로 본다. 공역 툴팁의
  '안에 있는 항공기 수'는 이번에 하지 않았다.
