"""선박 AIS 실시간 수신(ADR-014, 계약 v2 §B1) — 별도 프로세스 `python -m wakeline_collector.ais`.

항공기 수집기(wakeline_collector.main)와 이벤트 루프·메모리를 나누는 격벽이다: 이 패키지는 항공기 작업·HTTP 클라이언트·DB 를
불러오지 않는다. 쓰는 것은 Redis(wakeline:ships · wakeline:ais:* 쓰기, wakeline:settings 읽기)뿐이다.

흐름: 수신(pool: 구역마다 client 하나(계약 v4 §D) · replay) → 제한된 원문 대기열(queue) → 정리(worker: parse → book) →
10 s 배치(sink: XADD + 상태 해시). 구역별 연결 상태·공백은 shards.
"""
