#!/usr/bin/env bash
# QA-400 재측정(NFR-03 api 메모리 ≤ 512 MB · NFR-02 REST 100 rps): JVM 설정 하나를 한 번 잰다. api 를 새 JVM 으로 다시 만들고(제한 상향 · 고친 이미지 ·
# 측정 전용 JVM 옵션 tools/qa/compose.qa-jvm.yml) 운영 규모 실시간 상태(perf_feed.py 가 돌고 있어야 한다)에서 차례로:
#   W  기동 뒤 데움 — 전세계 ≥ 9,900대 · 선박 ≥ 14,900척이 되고 WARM_S(기본 180 s)가 지날 때까지. api 는 기동 때 실시간 상태를 곧바로 되찾는다
#      (잰 값: 다시 만든 1분 뒤 전세계 10,000 · 선박 15,375). 마지막 60 s 를 '기동 뒤 쉼'으로 본다(기동 1분 뒤 따라잡기 약 18 s 는 이 안에서 끝난다).
#   R  REST 100 rps × 3분(perf/qa/rest-routes.js — 성능 단계와 같은 경로 16개 섞음)
#   S  WS 200 연결 · 선박 레이어(perf/ws.js — 1분 램프 + 3분 유지)
#   B  몰림: 계단 300 → 400 rps 각 60 s(성능 단계에서 힙 커밋을 상한까지 올린 꼴)
#   I  쉼 IDLE_S(기본 300 s) — 몰림 뒤 평탄(마지막 60 s 의 가운데)
# 같은 동안 perf_sample.py 가 5 s 마다 자원을 뜬다(stats-qa400-<설정>-r<n>.csv), 단계 경계는 phases-qa400-<설정>-r<n>.txt, k6 요약은 k6-qa400-<설정>-r<n>-{rest,ws,burst}.json.
#   tools/qa/perf_jvm_run.sh <설정 이름> <n> "<덧붙일 JVM 옵션>"     예: tools/qa/perf_jvm_run.sh p30 1 "-XX:MaxRAMPercentage=30"
# 요약: python3 tools/qa/perf_jvm_summary.py <설정 이름> …. 끝나면 api 는 이 설정으로 남는다 — 측정을 마치면 tools/qa/perf_api_up.sh default 로 되돌린다.
# 결과 폴더: PERF_EV(기본 docs/qa/2026-10/evidence/performance/after-fix). 운영 스택 · 스택 B 는 건드리지 않는다.
set -euo pipefail
setting=$1; n=$2; extra=${3:-}
root=$(cd "$(dirname "$0")/../.." && pwd)
ev="${PERF_EV:-$root/docs/qa/2026-10/evidence/performance/after-fix}"
mkdir -p "$ev" "$root/perf/results"
WARM_S=${WARM_S:-180}; IDLE_S=${IDLE_S:-300}
K6_IMAGE="grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34"
tag="qa400-$setting-r$n"
phases="$ev/phases-$tag.txt"
now() { date -u +%FT%TZ; }
mark() { echo "$1 $2 $3" >> "$phases"; }   # 단계 시작 끝
k6() { # $1 = 단계 이름, $2 = 스크립트, 나머지 = -e …
  local ph=$1 script=$2; shift 2
  docker run --rm --network wakeline-e2e_wakeline -v "$root/perf:/perf" -w /perf -e BASE_URL=http://10.78.0.30:8000 \
    -e OUT="results/k6-$tag-$ph.json" "$@" "$K6_IMAGE" run --quiet "$script" 2>&1 | grep --line-buffered -v "VU iteration was interrupted" > "$ev/k6-$tag-$ph.log" || true
  if [ "$script" = ws.js ]; then cp -f "$root/perf/results/ws-summary.json" "$ev/k6-$tag-$ph.json" || true; else cp -f "$root/perf/results/k6-$tag-$ph.json" "$ev/" || true; fi
}
state() { docker exec wakeline-e2e-api-1 curl -s localhost:8000/api/v1/status \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['global']['aircraft'], d['sources']['ais']['ships'])" 2>/dev/null || echo "0 0"; }

: > "$phases"
echo "setting=$setting run=$n extra='$extra' start=$(now)" >> "$phases"
QA_JVM_EXTRA="$extra" "$root/tools/qa/perf_api_up.sh" lifted jvm 2>&1 | grep -E "^sha256|^JAVA_TOOL|^WAKELINE|^MALLOC" >> "$phases"
started=$(docker inspect -f '{{.State.StartedAt}}' wakeline-e2e-api-1)
echo "container_started=$started" >> "$phases"
total=$((WARM_S + 200 + 270 + 140 + IDLE_S + 120))
python3 "$root/tools/qa/perf_sample.py" "$ev/stats-$tag.csv" 5 "$total" 2>>"$ev/stats-$tag.err" &
sampler=$!

# W — 상태가 다 차고 WARM_S 가 지날 때까지
w0=$(now); t0=$(date +%s)
while :; do
  read -r g s < <(state)
  el=$(( $(date +%s) - t0 ))
  if [ "$el" -ge "$WARM_S" ] && [ "$g" -ge 9900 ] && [ "$s" -ge 14900 ]; then break; fi
  if [ "$el" -ge $((WARM_S + 300)) ]; then echo "warm timeout: global=$g ships=$s" >> "$phases"; break; fi
  sleep 10
done
mark W "$w0" "$(now)"; echo "state global=$g ships=$s" >> "$phases"

r0=$(now); k6 rest qa/rest-routes.js -e RPS=100 -e DURATION=3m; mark R "$r0" "$(now)"
sleep 10
s0=$(now); k6 ws ws.js -e CONN=200 -e SHIPS=1 -e ORIGIN=http://localhost:8701; mark S "$s0" "$(now)"
sleep 10
b0=$(now); k6 burst qa/rest-routes.js -e MODE=step -e STEPS=300,400 -e STEP_S=60; mark B "$b0" "$(now)"
i0=$(now); sleep "$IDLE_S"; mark I "$i0" "$(now)"

kill "$sampler" 2>/dev/null || true; wait "$sampler" 2>/dev/null || true
# 다시 시작 · OOM · 힙 소진 종료가 있었나(ExitOnOutOfMemoryError → 컨테이너 재시작)
{
  echo "inspect $(docker inspect -f 'restarts={{.RestartCount}} oom_killed={{.State.OOMKilled}} started={{.State.StartedAt}} status={{.State.Status}}' wakeline-e2e-api-1)"
  echo "oom_lines $(docker logs --since "$started" wakeline-e2e-api-1 2>&1 | grep -v 'Picked up JAVA_TOOL_OPTIONS' | grep -c -E 'OutOfMemoryError|Terminating due to' || true)"
  echo "jvm_line $(docker logs --since "$started" wakeline-e2e-api-1 2>&1 | grep -m1 'Picked up JAVA_TOOL_OPTIONS' || true)"
  # GC 원인별 횟수 · 합(주기 GC 'G1 Periodic Collection' 이 실제로 돌았나)
  docker exec wakeline-e2e-api-1 curl -s localhost:9000/actuator/prometheus | grep -E '^jvm_gc_pause_seconds_(count|sum)\{' | sed 's/^/gc /' || true
  # 그 JVM 의 WARN · ERROR(다음 실행이 컨테이너를 바꾸면 로그가 사라진다) — 숫자는 N 으로 묶어 종류마다 센다
  docker logs --since "$started" wakeline-e2e-api-1 2>&1 | grep -E '^[0-9TZ:.-]+ +(WARN|ERROR) ' \
    | sed -E 's/^[^ ]+ +(WARN|ERROR) [0-9]+ --- \[[^]]*\] \[[^]]*\] +(\[rid:[^]]*\] +)?/\1 /; s/ request_id=[^ ]+//; s/ (query|elapsed_ms)=.*//; s/(path=\/api\/v1\/[a-z_]+).*/\1/; s/[0-9]+/N/g' \
    | cut -c1-150 | sort | uniq -c | sort -rn | head -12 | sed 's/^/warn /' || true
  echo "end=$(now)"
} >> "$phases"
cat "$phases"
