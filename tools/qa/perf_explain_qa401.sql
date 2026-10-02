-- QA-401 고친 뒤(계약 v5 §G36): 격리 스택 A 의 합성 알림(seed_perf.sql — 약 117만 행 · 30일) 위에서 AlertRepository.history 가 고친 뒤 보내는 문장의 실행 계획.
--   docker exec -i wakeline-e2e-db-1 psql -U postgres -d wakeline < tools/qa/perf_explain_qa401.sql
-- 문장은 api 코드의 SQL 그대로(파라미터는 리터럴 — 맞춤 계획). 끝에 같은 문장을 준비 문장 + plan_cache_mode = force_generic_plan 으로 실행한다(같은 연결에서
-- 여러 번 실행된 뒤의 일반 계획). 고치기 전 문장과 그 결과는 perf_explain.sql 의 'alerts.history' 절 · findings/performance.md QA-401.
\timing on
SET TimeZone = 'UTC';
SET statement_timeout = '120s';

\echo '== alerts.history 첫 쪽 — 기본 24 h'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT e.id, e.hex, e.callsign, e.sigmet_id, s.fir_id, s.hazard, s.qualifier, e.kind, e.entered_at, e.left_at, e.close_reason, e.eta_s,
       CASE WHEN e.kind = 'PREDICTED' AND e.eta_s IS NOT NULL AND e.evidence->>'entry' IS NOT NULL AND e.evidence->>'judged_at' IS NOT NULL
            THEN (e.evidence->>'judged_at')::timestamptz + make_interval(secs => e.eta_s) END eta_at,
       e.alt_ft_at_entry, e.evidence::text evidence
FROM alert_event e JOIN sigmet s ON s.id = e.sigmet_id
WHERE e.entered_at BETWEEN now() - interval '1 day' AND now()
ORDER BY e.entered_at DESC, e.id DESC LIMIT 51;

\echo '== alerts.history 첫 쪽 — 25일 전 1 h(QA-401 의 오래된 창)'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT e.id, e.hex, e.callsign, e.sigmet_id, s.fir_id, s.hazard, s.qualifier, e.kind, e.entered_at, e.left_at, e.close_reason, e.eta_s,
       CASE WHEN e.kind = 'PREDICTED' AND e.eta_s IS NOT NULL AND e.evidence->>'entry' IS NOT NULL AND e.evidence->>'judged_at' IS NOT NULL
            THEN (e.evidence->>'judged_at')::timestamptz + make_interval(secs => e.eta_s) END eta_at,
       e.alt_ft_at_entry, e.evidence::text evidence
FROM alert_event e JOIN sigmet s ON s.id = e.sigmet_id
WHERE e.entered_at BETWEEN now() - interval '25 days' AND now() - interval '25 days' + interval '1 hour'
ORDER BY e.entered_at DESC, e.id DESC LIMIT 51;

\echo '== alerts.history 첫 쪽 — 29일 전 1 h'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT e.id, e.hex, e.callsign, e.sigmet_id, s.fir_id, s.hazard, s.qualifier, e.kind, e.entered_at, e.left_at, e.close_reason, e.eta_s,
       CASE WHEN e.kind = 'PREDICTED' AND e.eta_s IS NOT NULL AND e.evidence->>'entry' IS NOT NULL AND e.evidence->>'judged_at' IS NOT NULL
            THEN (e.evidence->>'judged_at')::timestamptz + make_interval(secs => e.eta_s) END eta_at,
       e.alt_ft_at_entry, e.evidence::text evidence
FROM alert_event e JOIN sigmet s ON s.id = e.sigmet_id
WHERE e.entered_at BETWEEN now() - interval '29 days' AND now() - interval '29 days' + interval '1 hour'
ORDER BY e.entered_at DESC, e.id DESC LIMIT 51;

\echo '== alerts.history 커서 쪽(둘째 쪽) — 25일 전 1 h'
SELECT id AS cur FROM alert_event WHERE entered_at BETWEEN now() - interval '25 days' AND now() - interval '25 days' + interval '1 hour'
ORDER BY entered_at DESC, id DESC OFFSET 49 LIMIT 1 \gset
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT e.id, e.hex, e.callsign, e.sigmet_id, s.fir_id, s.hazard, s.qualifier, e.kind, e.entered_at, e.left_at, e.close_reason, e.eta_s,
       CASE WHEN e.kind = 'PREDICTED' AND e.eta_s IS NOT NULL AND e.evidence->>'entry' IS NOT NULL AND e.evidence->>'judged_at' IS NOT NULL
            THEN (e.evidence->>'judged_at')::timestamptz + make_interval(secs => e.eta_s) END eta_at,
       e.alt_ft_at_entry, e.evidence::text evidence
FROM alert_event e JOIN sigmet s ON s.id = e.sigmet_id
WHERE e.entered_at BETWEEN now() - interval '25 days' AND now() - interval '25 days' + interval '1 hour'
  AND (e.entered_at, e.id) < ((SELECT c.entered_at FROM alert_event c WHERE c.id = :cur), :cur)
ORDER BY e.entered_at DESC, e.id DESC LIMIT 51;

\echo '== alerts.history 첫 쪽 — 30일 창 전체 · hex f10000'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT e.id, e.hex, e.callsign, e.sigmet_id, s.fir_id, s.hazard, s.qualifier, e.kind, e.entered_at, e.left_at, e.close_reason, e.eta_s,
       CASE WHEN e.kind = 'PREDICTED' AND e.eta_s IS NOT NULL AND e.evidence->>'entry' IS NOT NULL AND e.evidence->>'judged_at' IS NOT NULL
            THEN (e.evidence->>'judged_at')::timestamptz + make_interval(secs => e.eta_s) END eta_at,
       e.alt_ft_at_entry, e.evidence::text evidence
FROM alert_event e JOIN sigmet s ON s.id = e.sigmet_id
WHERE e.entered_at BETWEEN now() - interval '30 days' AND now() AND e.hex = 'f10000'::bpchar
ORDER BY e.entered_at DESC, e.id DESC LIMIT 51;

\echo '== 일반 계획(force_generic_plan) — 25일 전 1 h 첫 쪽 · 30일 창 첫 쪽'
PREPARE qa401_hist(timestamptz, timestamptz, int) AS
SELECT e.id, e.hex, e.callsign, e.sigmet_id, s.fir_id, s.hazard, s.qualifier, e.kind, e.entered_at, e.left_at, e.close_reason, e.eta_s,
       CASE WHEN e.kind = 'PREDICTED' AND e.eta_s IS NOT NULL AND e.evidence->>'entry' IS NOT NULL AND e.evidence->>'judged_at' IS NOT NULL
            THEN (e.evidence->>'judged_at')::timestamptz + make_interval(secs => e.eta_s) END eta_at,
       e.alt_ft_at_entry, e.evidence::text evidence
FROM alert_event e JOIN sigmet s ON s.id = e.sigmet_id
WHERE e.entered_at BETWEEN $1 AND $2
ORDER BY e.entered_at DESC, e.id DESC LIMIT $3;
SET plan_cache_mode = force_generic_plan;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) EXECUTE qa401_hist(now() - interval '25 days', now() - interval '25 days' + interval '1 hour', 51);
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) EXECUTE qa401_hist(now() - interval '30 days', now(), 51);
RESET plan_cache_mode;
DEALLOCATE qa401_hist;
