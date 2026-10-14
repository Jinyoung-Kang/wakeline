#!/usr/bin/env bash
# QA 2026-10 AWS 성능(QA-PLAN §3.5 '느린 쿼리'): 기동 뒤 첫 따라잡기(MaintenanceJobs.catchUpTick — 기동 60 s 뒤)의 DB 비용을 잰다. 격리 QA 스택만.
#   WLQA_ENV=<시험 env> PERF_PROJECT=wlqa-a tools/qa/perf_catchup.sh <출력 파일> [lifted|default]
# 1) '아침 기동' 흉내: 어제(KST)의 일 통계 완료 표식을 지운다(AWS 데모는 03:30 KST 정시 집계 때 꺼져 있어 아침 따라잡기가 어제를 센다 — ADR-039)
# 2) pg_stat_statements 를 비우고 api 를 새 컨테이너로(perf_api_up.sh — PERF_FORCE_RECREATE=1) → WAIT_S(기본 150 s) 기다린다
# 3) 따라잡기 문장(1분 요약 INSERT · 요약 확인 EXISTS · 지정 보존 복사 · 파티션 카탈로그 · 일 통계 · 옛 날 채우기)의 횟수 · 합 · 최대를 남긴다 + api 로그의 따라잡기 줄
# 자료를 지우는 것은 1) 의 표식 행뿐이다(따라잡기가 같은 값으로 다시 쓴다).
set -euo pipefail
out=$1; mode=${2:-lifted}
root=$(cd "$(dirname "$0")/../.." && pwd)
P=${PERF_PROJECT:-wlqa-a}; export PERF_PROJECT=$P
WAIT_S=${WAIT_S:-150}
psql_db() { docker exec "$P-db-1" psql -X -U postgres -d wakeline "$@"; }
{
  echo "# perf_catchup $(date -u +%FT%TZ) project=$P mode=$mode wait=${WAIT_S}s"
  psql_db -Atc "DELETE FROM stats_daily WHERE metric = 'aggregated_at' AND day = (now() AT TIME ZONE 'Asia/Seoul')::date - 1 RETURNING day, dim" | sed 's/^/marker_deleted /'
  psql_db -Atc "SELECT pg_stat_statements_reset()" > /dev/null
  t0=$(date -u +%FT%TZ)
  PERF_FORCE_RECREATE=1 "$root/tools/qa/perf_api_up.sh" "$mode" 2>&1 | grep -E '^sha256' | sed 's/^/image /'
  started=$(docker inspect -f '{{.State.StartedAt}}' "$P-api-1")
  echo "reset=$t0 api_started=$started"
  sleep "$WAIT_S"
  echo "## 따라잡기 문장(pg_stat_statements — 비운 뒤 ${WAIT_S}s, 기동 · 저장기 문장은 뺐다)"
  psql_db -c "SELECT calls, round(total_exec_time::numeric, 1) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms, round(max_exec_time::numeric, 1) AS max_ms,
      rows, shared_blks_hit AS hit, shared_blks_read AS read, temp_blks_written AS tmp_w, left(regexp_replace(query, '\s+', ' ', 'g'), 200) AS query
    FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'wakeline')
      AND (query ~* 'INSERT INTO track_point_1m|FROM track_point_1m WHERE ts_minute|INSERT INTO retained_track|pg_inherits|stats_daily|min\(valid_from\)|alerts_by_kind|traffic_by_hour|sigmet_by_|alert_dwell|LOCK TABLE track_point|_ensure_partitions|app_setting WHERE key = .retain_targets.')
    ORDER BY total_exec_time DESC"
  psql_db -Atc "SELECT 'catch-up statements total_ms=' || round(sum(total_exec_time)::numeric, 1) || ' calls=' || sum(calls) FROM pg_stat_statements
    WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'wakeline')
      AND (query ~* 'INSERT INTO track_point_1m|FROM track_point_1m WHERE ts_minute|INSERT INTO retained_track|pg_inherits|stats_daily|min\(valid_from\)|alerts_by_kind|traffic_by_hour|sigmet_by_|alert_dwell|LOCK TABLE track_point')"
  echo "## api 로그(따라잡기 · 보존 · 요약)"
  docker logs --since "$started" "$P-api-1" 2>&1 | grep -E 'catch-up|retained track|1-minute summary|aggregat|partition' | cut -c1-300 || true
  echo "## WARN · ERROR"
  docker logs --since "$started" "$P-api-1" 2>&1 | grep -E ' (WARN|ERROR) ' | cut -c1-300 | head -20 || true
} > "$out" 2>&1
cat "$out"
