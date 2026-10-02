#!/usr/bin/env bash
# QA-401 의 edge 경유 측정(기본 제한 — api IP 당 분당 120 = 2 r/s · edge IP 당 10 r/s): 공격 k6 컨테이너(IP 하나, 오래된 창 2 r/s)와 피해 k6 컨테이너
# (다른 IP, 재생 · 통계 · 항적 · 알림 1 r/s)를 같은 60 s 동안 함께 돌린다. 기준선은 피해 컨테이너만. 같은 동안 자원 표본(perf_sample.py).
#   tools/qa/perf_qa401_edge.sh r1          # → k6-qa401-edge-attacker-r1 · k6-qa401-edge-victim-r1 · stats-qa401-edge-attack-r1.csv
#   tools/qa/perf_qa401_edge.sh r1 base     # 피해 요청만(기준선) → k6-qa401-edge-base-r1 · stats-qa401-edge-base-r1.csv
# 결과 폴더: PERF_EV(기본 docs/qa/2026-10/evidence/performance). api 는 기본 제한이어야 한다(tools/qa/perf_api_up.sh default).
set -euo pipefail
run_id=$1; mode=${2:-attack}
root=$(cd "$(dirname "$0")/../.." && pwd)
ev="${PERF_EV:-$root/docs/qa/2026-10/evidence/performance}"
mkdir -p "$ev" "$root/perf/results"
K6_IMAGE="grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34"
run() { # $1 = 역할(attacker · victim · base), 나머지 = k6 -e
  local name="qa401-edge-$1-$run_id"; shift
  docker run --rm --network wakeline-e2e_wakeline -v "$root/perf:/perf" -w /perf -e BASE_URL=http://10.78.0.10:8700 -e HOST=localhost:8701 \
    -e OUT="results/k6-$name.json" "$@" "$K6_IMAGE" run --quiet qa/qa-401-alerts-history-old-window.js > "$ev/k6-$name.log" 2>&1 || true
  cp -f "$root/perf/results/k6-$name.json" "$ev/" 2>/dev/null || true
}
python3 "$root/tools/qa/perf_sample.py" "$ev/stats-qa401-edge-$mode-$run_id.csv" 5 75 &
sampler=$!
start=$(date -u +%FT%TZ)
if [ "$mode" = base ]; then
  run base -e ATTACK_RPS=0 -e VICTIM_RPS=1
  roles="base"
else
  run attacker -e ATTACK_RPS=2 -e VICTIM_RPS=0 &
  a=$!
  run victim -e ATTACK_RPS=0 -e VICTIM_RPS=1
  wait $a
  roles="attacker victim"
fi
end=$(date -u +%FT%TZ)
wait $sampler 2>/dev/null || true
echo "run=$run_id mode=$mode start=$start end=$end" >> "$ev/qa401-edge-runs.txt"
for r in $roles; do
  printf '%-9s ' "$r" >> "$ev/qa401-edge-runs.txt"
  grep -h -E "^(alerts_history_old|victim) " "$ev/k6-qa401-edge-$r-$run_id.log" | grep -v " n=0 " >> "$ev/qa401-edge-runs.txt" || echo "(no summary)" >> "$ev/qa401-edge-runs.txt"
done
tail -3 "$ev/qa401-edge-runs.txt"
