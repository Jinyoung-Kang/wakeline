-- 출시 QA 2차 성능(docs/qa/2026-10-release QA-PLAN §3.5): seed_perf.sql 위에 앞선 QA 뒤 더한 표를 운영 규모로 채운다. 격리 스택 A(wakeline-e2e)만.
--
--   docker exec -i wakeline-e2e-db-1 psql -U postgres -d wakeline -v ON_ERROR_STOP=1 < tools/qa/seed_perf_r2.sql
--
-- 규모의 근거:
--   wx_warning    90일 보존(ADR-036) — 한국 특보 구역 약 414곳 × 하루 평균 3건(여름 · 겨울 집중을 고르게 펴서 넉넉히) ≈ 112,000행. 행 수가 커질수록
--                 이력 조회(겹치는 창 · 처음 받은 시각 최신순)가 어떻게 되는지 보려는 것 — 실제는 이보다 적다.
--   retained_track 지정 대상 상한 20개(ADR-038 · 계획 결정 D7) × 1분 × 120일 ≈ 3,456,000행(1년 최악의 약 1/3 — 조회는 기본 키 범위라 행 수에 둔감한지 본다).
-- 합성 행의 표식: wx_warning.provider · retained_track.provider = 'qa_synthetic'.
\set ON_ERROR_STOP on
SET synchronous_commit = off;
SET TimeZone = 'UTC';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM wx_warning WHERE provider = 'qa_synthetic' LIMIT 1) THEN RAISE EXCEPTION 'already seeded (wx_warning.provider = qa_synthetic)'; END IF;
END $$;

INSERT INTO wx_warning (zone_code, zone_name, parent_code, parent_name, sea, kind, level, command, preliminary, issued_at, effective_at,
                        raw, provider, first_seen, last_seen, ended_at)
SELECT z.code, 'QA 구역 ' || z.code, NULL, NULL, z.code LIKE 'S%', k.kind, 'Q' || (g % 4), '발표', false,
       t, t + interval '30 minutes', 'qa synthetic', 'qa_synthetic', t, t + interval '6 hours',
       CASE WHEN t + interval '6 hours' < now() THEN t + interval '6 hours' END
FROM generate_series(0, 111999) g
CROSS JOIN LATERAL (SELECT CASE WHEN g % 2 = 0 THEN 'S' ELSE 'L' END || lpad(((g % 414) + 1000000)::text, 7, '0') AS code) z
CROSS JOIN LATERAL (SELECT (ARRAY['풍랑', '강풍', '호우', '대설', '건조', '한파', '폭염', '태풍'])[(g % 8) + 1] AS kind) k
CROSS JOIN LATERAL (SELECT now() - interval '89 days' + (g * interval '89 days' / 112000) AS t) tt
ON CONFLICT DO NOTHING;

INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, alt_ft, gs_kt, track_deg, sog_kn, cog_deg, provider)
SELECT CASE WHEN t.i < 10 THEN 'aircraft' ELSE 'ship' END,
       CASE WHEN t.i < 10 THEN lpad(to_hex(15794176 + t.i * 64), 6, '0') ELSE (300000000 + t.i)::text END,
       m, m + interval '7 seconds',
       ST_SetSRID(ST_MakePoint(124 + (extract(epoch FROM m)::bigint % 8000) / 1000.0, 33 + t.i * 0.25), 4326),
       CASE WHEN t.i < 10 THEN 30000 END, CASE WHEN t.i < 10 THEN 450 END, CASE WHEN t.i < 10 THEN 90 END,
       CASE WHEN t.i >= 10 THEN 12.5 END, CASE WHEN t.i >= 10 THEN 180 END, 'qa_synthetic'
FROM generate_series(0, 19) AS t(i)
CROSS JOIN generate_series(date_trunc('minute', now() - interval '125 days'), date_trunc('minute', now() - interval '5 days'), interval '1 minute') AS m
ON CONFLICT DO NOTHING;

ANALYZE wx_warning;
ANALYZE retained_track;
SELECT 'wx_warning' t, count(*) FROM wx_warning UNION ALL SELECT 'retained_track', count(*) FROM retained_track;
