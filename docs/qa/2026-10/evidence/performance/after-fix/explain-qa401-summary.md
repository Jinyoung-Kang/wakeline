# QA-401 고친 뒤 EXPLAIN (ANALYZE, BUFFERS) — 스택 A(합성 알림 약 120만 행 · 30일), tools/qa/perf_explain_qa401.sql 3번(r1 · r2 · r3, 2026-10-02 00:37 UTC 무렵)

| 문장(고친 뒤 AlertRepository.history) | 실행 ms r1 · r2 · r3 | alert_event 에서 읽은 행(인덱스가 낸 행 + 필터로 버린 행) | 버퍼(r1, 맨 위) | 인덱스 |
|---|---|---|---|---|
| 첫 쪽 · 25일 전 1 h(QA-401 의 오래된 창) | 2.24 · 0.25 · 0.26 | 52 · 52 · 52 | hit=57 read=12 | alert_event_entered |
| 첫 쪽 · 29일 전 1 h | 1.99 · 0.24 · 0.25 | 52 · 52 · 52 | hit=62 read=11 | alert_event_entered |
| 커서 쪽(둘째 쪽) · 25일 전 1 h | 1.90 · 0.57 · 0.38 | 54 · 54 · 54(커서 행 찾기 1 + 52 + 필터로 버린 커서 행 1) | hit=214 read=7 | alert_event_pkey(InitPlan) · alert_event_entered |
| 첫 쪽 · 기본 24 h | 1.59 · 1.41 · 1.32 | 203 · 203 · 203(같은 시각 묶음 — 아래) | hit=210 | alert_event_entered |
| 첫 쪽 · 30일 창 · hex f10000 | 4.67 · 0.84 · 0.45 | 52 · 52 · 52 | hit=195 read=68 | alert_event_hex |
| 일반 계획(force_generic_plan) · 25일 전 1 h | 0.24 · 0.29 · 0.23 | 52 · 52 · 52 | hit=69 | alert_event_entered |
| 일반 계획 · 30일 창 | 0.87 · 0.96 · 0.90 | 203 · 203 · 203 | hit=200 | alert_event_entered |

고치기 전(findings/performance.md QA-401 · evidence/performance/explain-r{1,2,3}.txt): 25일 전 1 h 창 **8,128 · 8,773 · 9,506 ms**, `Index Scan Backward using alert_event_pkey`,
Rows Removed by Filter 1,009,071, Buffers shared hit=9,815 read=106,229.

같은 시각 묶음: 이 스택의 엔진이 실제로 만든 최근 알림은 한 판정 틱의 같은 entered_at 에 최대 698건이 있다(합성 SIGMET 132 × 전세계 1만 대 — `SELECT entered_at, count(*) …` 최대 698 · 687 · 675).
첫 쪽은 그 묶음을 끝까지 읽어야 id 순서를 맞춘다(Incremental Sort) — 24 h 창의 203행이 그것이고 여전히 1.3–1.6 ms 다. 합성 알림(2.16 s 간격)은 시각이 모두 달라 52행.
