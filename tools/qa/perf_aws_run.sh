#!/usr/bin/env bash
# QA 2026-10 AWS 성능(docs/qa/2026-10-aws QA-PLAN §3.5): 한 번의 측정 — api 를 새 JVM 으로 다시 만들고(제한 상향 — perf_api_up.sh lifted, 이미지의 JVM 옵션
# 그대로) 실시간 상태가 찬 뒤 단계를 차례로 돈다. tools/qa/perf_jvm_run.sh(PERF §14.2)와 같은 순서 · 같은 k6 스크립트 · 같은 자원 표본(perf_sample.py 5 s)이고,
# 단계 목록 · 스택 · 데움 기준을 고를 수 있다.
#   WLQA_ENV=<시험 env> PERF_PROJECT=wlqa-a PERF_EV=<증거 폴더> PHASES="R20 R100 S I" WARM_SHIPS=2900 SHIP_N=3000 tools/qa/perf_aws_run.sh aws 1
# 단계: W(늘 처음 — WARM_S 지나고 전세계 ≥ WARM_GLOBAL · 선박 ≥ WARM_SHIPS 일 때까지, 마지막 60 s = 기동 뒤 쉼)
#       R<rps>(REST perf/qa/rest-routes.js 도착률 고정 DURATION, 기본 3m) · S(WS CONN 연결 · 선박 레이어 — perf/ws.js 1분 램프 + 3분)
#       B(몰림 계단 BURST_STEPS, 기본 300,400 각 60 s) · I(쉼 IDLE_S, 기본 300 s — 마지막 60 s = 평탄)
# 단계마다 앞뒤로 공개 조회 격벽 503 누계(wakeline_db_public_reads_rejected_total)를 적고, REST · 몰림 단계는 pg_stat_statements 를 비운 뒤 상위 문장을 남긴다
# (확장이 있을 때 — pgss-<태그>-<단계>.txt).
# 결과(PERF_EV): phases-<태그>.txt · stats-<태그>.csv · k6-<태그>-<단계>.{json,log} · pgss-<태그>-<단계>.txt, 태그 = <이름표>-r<n>. 요약 tools/qa/perf_aws_summary.py.
# 끝나면 api 는 제한 상향 그대로다 — 측정을 모두 마치면 perf_api_up.sh default 로 되돌린다. 다른 compose 프로젝트는 건드리지 않는다(<PERF_PROJECT>-* 만).
set -euo pipefail
label=$1; n=$2
root=$(cd "$(dirname "$0")/../.." && pwd)
P=${PERF_PROJECT:-wlqa-a}; export PERF_PROJECT=$P
API=${PERF_API:-10.78.0.30:8000}
ev="${PERF_EV:?PERF_EV 에 증거 폴더가 필요하다}"
mkdir -p "$ev" "$root/perf/results"
PHASES=${PHASES:-"R100 S B I"}
WARM_S=${WARM_S:-180}; IDLE_S=${IDLE_S:-300}; DURATION=${DURATION:-3m}; CONN=${CONN:-200}
WARM_GLOBAL=${WARM_GLOBAL:-0}; WARM_SHIPS=${WARM_SHIPS:-0}; SHIP_N=${SHIP_N:-12000}
BURST_STEPS=${BURST_STEPS:-300,400}; ORIGIN=${ORIGIN:-http://localhost:8701}
K6_IMAGE="grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34"
tag="$label-r$n"
phases="$ev/phases-$tag.txt"
now() { date -u +%FT%TZ; }
mark() { echo "$1 $2 $3" >> "$phases"; }   # 단계 시작 끝
k6() { # $1 = 단계 이름, $2 = 스크립트, 나머지 = -e …
  local ph=$1 script=$2; shift 2
  docker run --rm --network "${P}_wakeline" -v "$root/perf:/perf" -w /perf -e BASE_URL="http://$API" -e SHIP_N="$SHIP_N" \
    -e OUT="results/k6-$tag-$ph.json" "$@" "$K6_IMAGE" run --quiet "$script" 2>&1 | grep --line-buffered -v "VU iteration was interrupted" > "$ev/k6-$tag-$ph.log" || true
  if [ "$script" = ws.js ]; then cp -f "$root/perf/results/ws-summary.json" "$ev/k6-$tag-$ph.json" || true; else cp -f "$root/perf/results/k6-$tag-$ph.json" "$ev/" || true; fi
}
state() { docker exec "$P-api-1" curl -s localhost:8000/api/v1/status \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['global']['aircraft'], d['sources']['ais']['ships'])" 2>/dev/null || echo "0 0"; }
rejected() { docker exec "$P-api-1" curl -s localhost:9000/actuator/prometheus | awk '/^wakeline_db_public_reads_rejected_total/ {print $2}' || echo "?"; }
psql_db() { docker exec "$P-db-1" psql -X -U postgres -d wakeline "$@"; }
has_pgss() { [ "$(psql_db -Atc "SELECT count(*) FROM pg_extension WHERE extname = 'pg_stat_statements'" 2>/dev/null)" = 1 ]; }
pgss_reset() { has_pgss && psql_db -Atc "SELECT pg_stat_statements_reset()" > /dev/null || true; }
pgss_dump() { # $1 = 단계
  has_pgss || return 0
  psql_db -c "SELECT calls, round(total_exec_time::numeric, 1) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms, round(max_exec_time::numeric, 1) AS max_ms,
    rows, shared_blks_hit AS hit, shared_blks_read AS read, temp_blks_written AS tmp_w, left(regexp_replace(query, '\s+', ' ', 'g'), 220) AS query
    FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'wakeline') ORDER BY total_exec_time DESC LIMIT 30" > "$ev/pgss-$tag-$1.txt" 2>&1 || true
}
secs_of() { # 단계의 대략 길이(표본 길이 계산용)
  case "$1" in R*) echo 200 ;; S) echo 270 ;; B) echo $(( $(echo "$BURST_STEPS" | tr ',' '\n' | wc -l) * 60 + 20 )) ;; I) echo "$IDLE_S" ;; *) echo 0 ;; esac
}

: > "$phases"
echo "label=$label run=$n project=$P api=$API phases='$PHASES' start=$(now)" >> "$phases"
PERF_FORCE_RECREATE=1 "$root/tools/qa/perf_api_up.sh" lifted 2>&1 | grep -E "^sha256|^JAVA_TOOL|^WAKELINE|^MALLOC|^SPRING" >> "$phases"
started=$(docker inspect -f '{{.State.StartedAt}}' "$P-api-1")
echo "container_started=$started" >> "$phases"
total=$((WARM_S + 300 + 120))
for ph in $PHASES; do total=$((total + $(secs_of "$ph") + 10)); done
python3 "$root/tools/qa/perf_sample.py" "$ev/stats-$tag.csv" 5 "$total" 2>>"$ev/stats-$tag.err" &
sampler=$!

# W — 상태가 다 차고 WARM_S 가 지날 때까지
w0=$(now); t0=$(date +%s)
while :; do
  read -r g s < <(state)
  el=$(( $(date +%s) - t0 ))
  if [ "$el" -ge "$WARM_S" ] && [ "$g" -ge "$WARM_GLOBAL" ] && [ "$s" -ge "$WARM_SHIPS" ]; then break; fi
  if [ "$el" -ge $((WARM_S + 300)) ]; then echo "warm timeout: global=$g ships=$s" >> "$phases"; break; fi
  sleep 10
done
mark W "$w0" "$(now)"; echo "state global=$g ships=$s" >> "$phases"

for ph in $PHASES; do
  echo "rejected_before $ph $(rejected)" >> "$phases"
  p0=$(now)
  case "$ph" in
    R*) pgss_reset; k6 "$ph" qa/rest-routes.js -e RPS="${ph#R}" -e DURATION="$DURATION"; pgss_dump "$ph" ;;
    S) k6 S ws.js -e CONN="$CONN" -e SHIPS=1 -e ORIGIN="$ORIGIN" ;;
    B) pgss_reset; k6 B qa/rest-routes.js -e MODE=step -e STEPS="$BURST_STEPS" -e STEP_S=60; pgss_dump B ;;
    I) sleep "$IDLE_S" ;;
    *) echo "unknown phase $ph" >> "$phases" ;;
  esac
  mark "$ph" "$p0" "$(now)"
  echo "rejected_after $ph $(rejected)" >> "$phases"
  [ "$ph" = I ] || sleep 10
done

kill "$sampler" 2>/dev/null || true; wait "$sampler" 2>/dev/null || true
# 다시 시작 · OOM · 힙 소진 종료가 있었나(ExitOnOutOfMemoryError → 컨테이너 재시작)
{
  echo "inspect $(docker inspect -f 'restarts={{.RestartCount}} oom_killed={{.State.OOMKilled}} started={{.State.StartedAt}} status={{.State.Status}}' "$P-api-1")"
  echo "oom_lines $(docker logs --since "$started" "$P-api-1" 2>&1 | grep -v 'Picked up JAVA_TOOL_OPTIONS' | grep -c -E 'OutOfMemoryError|Terminating due to' || true)"
  echo "jvm_line $(docker logs --since "$started" "$P-api-1" 2>&1 | grep -m1 'Picked up JAVA_TOOL_OPTIONS' || true)"
  docker exec "$P-api-1" curl -s localhost:9000/actuator/prometheus | grep -E '^jvm_gc_pause_seconds_(count|sum)\{' | sed 's/^/gc /' || true
  # 기동 뒤 따라잡기(MaintenanceJobs — 기동 1분 뒤): 걸린 시간을 로그 시각으로 본다
  docker logs --since "$started" "$P-api-1" 2>&1 | grep -E 'catch-up|retained track|1-minute summary' | cut -c1-260 | sed 's/^/catchup /' || true
  # 그 JVM 의 WARN · ERROR — 숫자는 N 으로 묶어 종류마다 센다
  docker logs --since "$started" "$P-api-1" 2>&1 | grep -E '^[0-9TZ:.-]+ +(WARN|ERROR) ' \
    | sed -E 's/^[^ ]+ +(WARN|ERROR) [0-9]+ --- \[[^]]*\] \[[^]]*\] +(\[rid:[^]]*\] +)?/\1 /; s/ request_id=[^ ]+//; s/ (query|elapsed_ms)=.*//; s/(path=\/api\/v1\/[a-z_]+).*/\1/; s/[0-9]+/N/g' \
    | cut -c1-150 | sort | uniq -c | sort -rn | head -12 | sed 's/^/warn /' || true
  echo "end=$(now)"
} >> "$phases"
cat "$phases"
