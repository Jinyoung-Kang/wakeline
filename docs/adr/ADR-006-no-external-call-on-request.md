# ADR-006 api 는 요청 처리 중 외부 API 를 호출하지 않는다

**상태** 채택

METAR/TAF 도 collector 가 관심 지역 bbox 의 관측소를 10분마다 선제 수집해 `airport`·`metar_obs` 에 넣고, api 는 DB 만 읽는다. 공항 목록은 별도 공급자가 아니라 METAR 응답의 관측소 좌표에서 만든다(AWC `airport` API 는 한국 공항이 1곳뿐이었음 — 실측). 항공기 정적 정보(등록·기종)도 공급자 응답 값만 저장하며 추정하지 않는다.
