#!/usr/bin/env bash
# QA 성능(계획 §3.5): 격리 스택 A 망에서 k6 를 한 번 돌리며 같은 동안 자원 표본(tools/qa/perf_sample.py, 5 s)을 뜬다. 결과는 증거 폴더에.
#   tools/qa/perf_k6.sh <이름표> <스크립트(perf 아래 상대 경로)> <예상 길이 s> [-e K=V …]
# 예: tools/qa/perf_k6.sh rest100-r1 qa/rest-routes.js 200 -e RPS=100 -e DURATION=3m
#     tools/qa/perf_k6.sh ws200-r1 ws.js 260 -e CONN=200 -e SHIPS=1 -e ORIGIN=http://localhost:8701
# api 에 직접(BASE_URL=http://10.78.0.30:8000)이 기본 — edge 는 -e BASE_URL=http://10.78.0.10:8700 -e HOST=localhost:8701.
# 운영 스택 · 스택 B 는 건드리지 않는다(망 wakeline-e2e_wakeline · 컨테이너 wakeline-e2e-* 만).
set -euo pipefail
label=$1; script=$2; secs=$3; shift 3
root=$(cd "$(dirname "$0")/../.." && pwd)
ev="$root/docs/qa/2026-10/evidence/performance"
mkdir -p "$ev" "$root/perf/results"
K6_IMAGE="grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34"
python3 "$root/tools/qa/perf_sample.py" "$ev/stats-$label.csv" 5 "$((secs + 15))" &
sampler=$!

start=$(date -u +%FT%TZ)
set +e
docker run --rm --network wakeline-e2e_wakeline -v "$root/perf:/perf" -w /perf -e BASE_URL=http://10.78.0.30:8000 \
  -e OUT="results/k6-$label.json" "$@" "$K6_IMAGE" run --quiet "$script" 2>&1 \
  | grep --line-buffered -v "VU iteration was interrupted" > "$ev/k6-$label.log"
rc=${PIPESTATUS[0]}
set -e
end=$(date -u +%FT%TZ)
wait $sampler 2>/dev/null || true
{ echo "label=$label script=$script start=$start end=$end k6_exit=$rc (99 = threshold crossed)"; echo "args: $*"; } >> "$ev/k6-$label.log"
if [ "$script" = ws.js ]; then cp -f "$root/perf/results/ws-summary.json" "$ev/k6-$label.json" 2>/dev/null || true
else cp -f "$root/perf/results/k6-$label.json" "$ev/" 2>/dev/null || true; fi
tail -40 "$ev/k6-$label.log"
exit 0
