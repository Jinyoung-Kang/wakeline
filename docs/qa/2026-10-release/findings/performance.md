# 성능 — 출시 QA 2차(2026-10-10)

**성능 결함(QA-900–) 없음.** 목표: 공개 REST p95 ≤ 300 ms · 오류율 < 1 %(앞선 QA · `perf/qa/rest-routes.js` 의 경로마다 기준), 첫 화면 JS ≤ 550,000 B(ADR-026).

## 조건
- 격리 스택 A(`wakeline-e2e`, fixture 모드)의 api 를 **직접**(edge 를 거치지 않음 — IP 당 제한을 빼고 api 자체를 잰다). 측정 동안 api 의 공개 요청 제한을 풀었다
  (스택을 다시 만들며 되돌림).
- 데이터: 앞선 QA 의 `tools/qa/seed_perf.sql`(항적 · 선박 위치 · 알림 · SIGMET 운영 규모) + 이번 `tools/qa/seed_perf_r2.sql` — `wx_warning` 112,012행(90일 보존 ×
  구역 414 × 하루 3건) · `retained_track` 3,456,022행(지정 대상 20 × 1분 × 120일). 실시간 부하 `tools/qa/perf_feed.py` — 전세계 항공기 10,000대(2분마다) · 선박 15,000척.
- 같은 Mac 의 Docker Desktop VM — 운영 스택(8700)도 함께 돌고 있었다(다른 부하는 기록하지 않았다). 자원은 `stats-rest100-r*.csv`(5 s 간격).

## REST 100 rps × 3분 × 3회(도착률 고정 · 21경로 섞음 — 새 경로 5개 포함)
| 실행 | 요청 | 실패 | 전체 p50 / p95 / p99 | 가장 느린 경로 p95 | VM CPU 중앙 / 최대 | api RSS |
|---|---|---|---|---|---|---|
| r1 | 17,995(놓친 반복 7) | 0 % | 4.0 / 83.1 / 904.7 ms | replay_72h 270.9 · replay_1m 270.0 · aircraft_track 208.2 | 150 / 371 % | 452–488 MiB |
| r2 | 18,002 | 0 % | 3.3 / 30.5 / 99.1 ms | replay_72h 83.1 · ship_track 57.3 · replay_1m 53.0 | 143 / 250 % | 488–529 MiB |
| r3 | 18,002 | 0 % | 3.6 / 39.6 / 172.6 ms | replay_72h 96.2 · ship_track 81.4 · ships_region 73.8 | 144 / 336 % | 529–553 MiB |

새 경로(p95 ms, r1 · r2 · r3): `watch_50`(관심 대상 50 · 공항 20) 84.6 · 16.2 · 17.4 · `alert_one` 49.9 · 20.0 · 34.4 · `warnings` 30.6 · 7.9 · 12.2 ·
`warnings_history` 179.8 · 20.4 · 28.5 · `airspace` 37.8 · 7.6 · 10.5. **모든 실행 · 모든 경로가 p95 ≤ 300 ms, 오류 0.**
- r1 의 긴 꼬리(p99 0.9 s · 최대 2.6 s)는 씨앗을 넣은 직후의 첫 실행(DB 캐시 · JIT 예열 — VM CPU 최대 371 %)이다. r2 · r3 은 p99 ≤ 173 ms. 히카리 대기 0 · GC 최대 0.125 s.
- 앞선 QA(2026-10-02)와 같은 기준을 지킨다. 경로 수 · 데이터가 달라 수치를 그대로 견주지 않는다.
- 증거: `evidence/performance/k6-rest100-r{1,2,3}.{log,json}` · `stats-rest100-r{1,2,3}.csv`. 재현: `tools/qa/perf_k6.sh rest100-r1 qa/rest-routes.js 200 -e RPS=100 -e DURATION=3m`(앞선 QA 와 같은 방식).

## 느린 쿼리(EXPLAIN ANALYZE — 위 데이터 규모, `tools/qa/perf_explain_r2.sql`)
| 질의 | 실행 시간 | 계획 |
|---|---|---|
| 특보 이력 기본(24 h · 200행) | 0.44 ms | `wx_warning_first_seen` 색인 · 증분 정렬 |
| 특보 이력 옛 창(28–29일 전) | 1.6 ms | 같음 |
| 특보 이력 구역 하나 · 30일 / 옛 1 h(행 0 — 최악) | 0.15 / 2.0 ms | 구역 색인 |
| 지정 보존 항적 24 h(`aircraft.track_retained`) | 6.5 ms | 기본 키 범위 |
| 알림 한 건(`alerts.by_id`) | 0.46 ms | 기본 키 |
| 관심 대상 공항 20곳 최신 METAR(`airports.watch`) | 1.6 ms | 공항마다 색인 한 번 |
| 보존 복사 한 시간(대상 20 — 유지보수) | 30 ms | 파티션 하나 · 대상 필터 |
전부 색인을 탄다 — 순차 탐색 없음. 증거 `evidence/performance/explain_r2.txt`. QA-702 수정 뒤 보존 조회에 `ts BETWEEN` 이 더해졌다 — 같은 색인 범위(`ts_minute`) 안의 거르기라 계획은 같다.

## 큰 응답(고친 빌드 · edge 경유 · gzip · 3번 — `tools/qa/perf_large_responses.py 3 --check`)
새 경로: `/airspace`(합성 공역 전체) 8,469 B → 2,048 B · 12 ms · `/warnings` 1,972 → 637 B · `/warnings/history` 30일 × 500(상한) 192,759 → 18,078 B · 28 ms ·
`/watch` 50대상(상한) 3,665 → 635 B · 12 ms — 모두 gzip, 1 MiB 아래. 걸린 것은 `aircraft track 24h` 하나(1,064,669 B · 전송 213,804 B)로 앞선 QA 와 같은 값이다
(점 상한 5,000 — `truncated: true`, 앞선 QA findings/performance.md 의 같은 줄). 실제 공역(장소표 697 · 점 65,649)은 저장소에 넣지 않아 이번에 재지 않았다 — 2026-10-09 운영 배포 뒤 528 KB · 압축 117 KB
(VERIFICATION 배포 기록), 차수가 바뀔 때만 다시 만드는 메모리 사본(ETag)이다. 증거 `evidence/performance/large_responses.json`.

## 화면(Lighthouse 12.8.2 · 3번씩 · 가운데 값 — `QA_EVIDENCE=… tools/qa/perf_lighthouse.sh 3 /m /alerts/<id> /`)
| 화면 | 프리셋 | 점수 | LCP | TBT | CLS | 전송(JS) |
|---|---|---|---|---|---|---|
| `/alerts/[id]`(새) | 데스크톱 | 98 [75–99] | 568 ms | 0 [0–576] ms | 0 | 204 KiB(189) |
| `/alerts/[id]` | 모바일 | 91 [63–93] | 2,646 ms | 137 [136–3,950] ms | 0 | 204 KiB(189) |
| `/m`(새) | 데스크톱 | 95 [70–98] | 597 ms | 0 [0–733] ms | 0.038 | 208 KiB(189) |
| `/m` | 모바일 | 93 [65–94] | 2,635 ms | 122 [66–2,501] ms | 0.064 | 208 KiB(189) |
| `/`(회귀) | 데스크톱 | 65 [55–80] | 592 ms | 806 [339–1,636] ms | 0.009 | 1,594 KiB(658) |
| `/` | 모바일 | 63 [60–68] | 2,769 ms | 3,012 [1,128–6,208] ms | 0.018 | 1,431 KiB(658) |
- 새 화면 둘(지도 · WS 없음)은 가운데 값으로 CWV 'good'(TBT ≤ 200 ms · CLS ≤ 0.1)이고, 모바일 LCP 2.6 s 는 앞선 QA 의 지도 없는 화면(2.67–2.73 s — QA-403 에서 받아들인 값)과 같다.
- 실행마다 한 번씩 TBT 가 크게 튄다(`/alerts` 모바일 3,950 ms · `/m` 2,501 ms) — 같은 화면의 다른 두 번은 137 · 122 ms 로, 측정 환경(소프트웨어 GL · 같은 VM)의 흔들림으로 본다.
- `/` 모바일 TBT 가운데 3.0 s 는 PERF §15 의 개선 뒤 값(871 ms)보다 크다. 실행 사이 폭이 5배(1.1–6.2 s)이고 같은 조건의 기준(main 이미지) 측정을 하지 않아 회귀로
  판단하지 않았다 — '미확인'(REPORT §4). 이번 QA 의 수정은 첫 화면 JS 를 바꾸지 않았다(이미지 안 548,678 B — 전 548,679 B).
