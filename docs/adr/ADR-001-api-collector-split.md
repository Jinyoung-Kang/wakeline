# ADR-001 api(Java)와 collector(Python) 분리, Redis Streams 로 연결

**상태** 채택 · 2026-09-27

## 배경
외부 공급자(adsb.lol·adsb.fi·OpenSky·AWC·RainViewer)는 지연·429·정책 변경이 잦다. 사용자 요청을 받는 프로세스가 외부 호출과 같은 이벤트 루프를 쓰면 외부 장애가 사용자 경로로 번진다.

## 결정
- collector(Python 3.13, asyncio)가 외부 호출·정규화·품질 게이트·원천 보관·예산 예약을 맡고, 결과를 Redis Streams(`wakeline:aircraft/sigmet/radar`)에 gzip+base64 JSON 으로 XADD 한다.
- api(Java 25, Spring Boot 4.1)는 소비자 그룹 `api` 로 XREADGROUP → 스키마 검증 → 인메모리 스냅샷 교체 → 엔진 → XACK. 외부 API 는 절대 직접 부르지 않는다(ADR-006).
- 두 언어는 `schemas/*.json`(JSON Schema 2020-12) 하나로 계약한다. Python 은 `jsonschema`, Java 는 `networknt json-schema-validator` 로 같은 파일을 읽고, `tools/contract_check.py` 와 `SchemaContractTest` 가 CI 에서 양쪽을 대조한다.

## 대안과 기각 이유
- FastAPI 단일 프로세스(v0.1): 단순하지만 격리가 없고 실행 계획을 분리할 수 없다.
- Java 단일: 어댑터 작성·실험 속도가 Python 보다 느리다.

## 결과
언어 2개·계약 테스트 유지 비용. 대신 collector 가 죽어도 api 는 마지막 스냅샷을 stale 로 서비스하고, api 가 죽어도 PEL 로 재처리된다(실측: 5.3절 재시작 시 마지막 엔트리 복원 ≤ 5 s).

## 이후 변경(R-50, 리뷰 v1 — 현재 값)
- **PEL 재처리의 한계**: api 가 멈춰 있는 동안의 메시지는 스트림 보존 창 안에서만 남는다. 항공기·선박 스트림은 개수(MAXLEN)가 아니라 시간으로 자른다 — `XADD MINID ~ (지금 − 2.5 h)`
  (collector `publisher.py` `STREAM_RETENTION_S`, R-14) + 메모리 상한(보존 창 안 발행 바이트, `STREAM_BUDGET_BYTES` 항공기 80 MiB · 선박 32 MiB — 선박은 2026-09-29 실측으로 16 MiB 에서 올렸다, ADR-011). 창보다 오래 멈추면 잘려 나간 구간은 영구 손실이며,
  api 가 이어 읽을 때 이를 감지해 손실 구간을 기록한다(`GET /api/v1/ops/pipeline` 의 `stream_trim_loss_events` · `last_stream_trim_loss`, R-14 · R-18). "api 가 죽어도 PEL 로 재처리" 는 이 창 안에서만 참이다.
