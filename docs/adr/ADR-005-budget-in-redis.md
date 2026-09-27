# ADR-005 외부 호출 예산은 Redis Lua 한 곳에서

**상태** 채택

`budget:{provider}:{yyyymmdd}` 해시에 `used/limit` 를 두고 Lua 스크립트가 "한도 검사 → 증가 → TTL" 을 원자적으로 수행한다. 연결 실패처럼 호출이 실제로 나가지 않은 경우만 되돌린다. 하루 한도는 자체 상한(adsb.lol/adsb.fi 10,000 · AWC 2,000 · RainViewer 2,000 · OpenSky 4,000 크레딧)이며, OpenSky 는 응답 헤더 `X-Rate-Limit-Remaining` 이 400 미만이면 다음 날까지 전세계 수집을 멈춘다. 매시 `provider_budget_day` 로 스냅샷을 남긴다.

**사용자 트래픽과의 분리**: 공개 API 제한(IP당 분당 120)은 `rl:*` 키, 외부 예산은 `budget:*` 키로 완전히 다르다. 요청 시 외부 호출이 없으므로(ADR-006) 사용자 폭주로 외부 한도가 소진되는 경로는 없다.
