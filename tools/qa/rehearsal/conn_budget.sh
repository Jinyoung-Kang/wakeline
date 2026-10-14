#!/usr/bin/env bash
# QA 2026-10 AWS 리허설(R) 항목 3: 공유 RDS 연결 수 여유 — max_connections 78(슈퍼유저 예약 3 → 일반 계정 75)에서
# 다른 두 프로젝트 몫 14 연결을 더미(holder)로 붙잡은 채 wakeline 이 뜨고 도는지, 자리가 모자라면 어떻게 되는지(503 · 회복).
#   tools/qa/rehearsal/conn_budget.sh deploy        <증거 폴더>   더미 14 + wakeline 전부 다시 만들기(배포 흉내) — 계정별 최대 동시 연결
#   tools/qa/rehearsal/conn_budget.sh runtime       <증거 폴더>   운영 중 남은 자리를 모두 채움 → 공개 읽기 → api 재시작 → 풀기 → 저절로 회복?
#   tools/qa/rehearsal/conn_budget.sh boot          <증거 폴더>   wakeline 정지 → 자리를 채운 채 start-stack.sh 처럼 up --wait(300 s) → 90 s 뒤 풀기
#   tools/qa/rehearsal/conn_budget.sh boot-long     <증거 폴더>   같은데 up --wait 가 끝날 때(300 s 초과)까지 풀지 않음 → 그 뒤 풀고 3분 — 스스로 뜨는가
# 실행 중인 wlqa-rds(bootstrap 끝) · wlqa-aws 가 필요하다. 연결 표본은 conn_sampler.sh(1 s). 요청은 적게(몇 초 간격).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; RS="$HERE/r.sh"
phase=${1:?deploy · runtime · boot · boot-long}; OUT=${2:?증거 폴더}; mkdir -p "$OUT"
log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/$phase.log"; }
holder() {  # $1 = 0(14개) | 1(남은 자리 모두 + 놓인 자리도 계속 가져감 — 연결을 새는 다른 프로젝트)
  "$RS" rds --profile holder rm -sf holder > /dev/null 2>&1
  HOLD_FILL=$1 HOLD_GREEDY=$1 "$RS" rds --profile holder up -d holder > /dev/null 2>&1
  for _ in $(seq 1 60); do docker logs wlqa-rds-holder-1 2>&1 | grep -qE "held (base|total)=" && { [ "$1" = 0 ] || docker logs wlqa-rds-holder-1 2>&1 | grep -q 'held total='; } && break; sleep 1; done
  log "holder fill=$1: $(docker logs wlqa-rds-holder-1 2>&1 | tr '\n' ' ' | cut -c1-260)"
}
sampler_start() { "$HERE/conn_sampler.sh" "$OUT/$phase-conn.tsv" > /dev/null 2>&1 & SAMPLER=$!; }
sampler_stop() { kill "$SAMPLER" 2> /dev/null; pkill -f "conn_sampler.sh $OUT/$phase-conn.tsv" 2> /dev/null
  pkill -f 'docker exec -i wlqa-rds-rds-1 psql' 2> /dev/null; sleep 1
  "$HERE/conn_sampler.sh" --peak "$OUT/$phase-conn.tsv" > "$OUT/$phase-conn-peak.txt"; }
probe() {  # 한 줄: 시각 · api 상태 · /healthz · 공개 읽기 셋(상태 코드, 503 이면 Retry-After)
  local h a s w
  h=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:18710/healthz)
  a=$(curl -s -m 12 -D - -o /dev/null 'http://127.0.0.1:18710/api/v1/alerts/history?limit=1' | awk 'NR==1{c=$2} tolower($1)=="retry-after:"{r=$2} END{gsub("\r","",r); print c (r? "(RA " r ")":"")}')
  s=$(curl -s -m 12 -D - -o /dev/null 'http://127.0.0.1:18710/api/v1/stats/traffic' | awk 'NR==1{c=$2} tolower($1)=="retry-after:"{r=$2} END{gsub("\r","",r); print c (r? "(RA " r ")":"")}')
  w=$(curl -s -m 12 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:18710/api/v1/warnings/history')
  echo "$(date -u +%H:%M:%SZ) api=$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}/r{{.RestartCount}}' wlqa-aws-api-1 2>/dev/null) healthz=$h alerts_history=$a stats_traffic=$s warnings_history=$w" | tee -a "$OUT/$phase-probe.txt"
}
wl_conns() { "$RS" sql postgres "SELECT usename, count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1 ORDER BY 1" | tr '\t\n' '= '; }

case "$phase" in
deploy)
  holder 0; sampler_start
  log "배포 흉내: wlqa-aws up -d --force-recreate --wait (더미 14 유지)"
  "$RS" aws up -d --force-recreate --wait --wait-timeout 300 > "$OUT/deploy-up.txt" 2>&1; log "up rc=$?"
  for _ in 1 2 3 4 5 6; do probe > /dev/null; sleep 8; done   # 기동 30 s 뒤 수신 범위 부트스트랩 연결까지 지난다
  sampler_stop; log "peak →"; cat "$OUT/deploy-conn-peak.txt" | tee -a "$OUT/$phase.log"
  ;;
runtime)
  holder 0; sampler_start; probe
  holder 1; log "가득: $(wl_conns)"
  for _ in 1 2 3; do probe; sleep 5; done
  log "api 재시작(자리가 없는 채)"; docker restart wlqa-aws-api-1 > /dev/null
  for _ in $(seq 1 18); do sleep 5; probe; done
  docker logs --since 2m wlqa-aws-api-1 2>&1 | grep -E 'WARN|ERROR' | cut -c1-300 | head -20 > "$OUT/runtime-api-log.txt"
  log "풀기(더미 14 로)"; holder 0; t0=$(date +%s)
  for _ in $(seq 1 36); do sleep 5; line=$(probe); case "$line" in *"api=running/healthy"*"healthz=200"*"alerts_history=200"*"stats_traffic=200"*) log "회복: $(( $(date +%s) - t0 )) s 뒤"; break;; esac; done
  log "연결: $(wl_conns)"; sampler_stop
  ;;
boot|boot-long)
  log "wakeline 정지(EC2 정지 흉내)"; "$RS" aws stop > /dev/null 2>&1
  holder 1; sampler_start; log "가득: $(wl_conns)"
  log "start-stack.sh 처럼: up -d --wait --wait-timeout 300"
  ( "$RS" aws up -d --wait --wait-timeout 300 > "$OUT/$phase-up.txt" 2>&1; echo "rc=$?" >> "$OUT/$phase-up.txt" ) & UP=$!
  if [ "$phase" = boot ]; then sleep 90; log "풀기(더미 14 로)"; holder 0; fi
  wait $UP; log "up 끝: $(tail -1 "$OUT/$phase-up.txt")"
  docker ps -a --filter label=com.docker.compose.project=wlqa-aws --format '{{.Names}} {{.Status}}' | tee -a "$OUT/$phase.log"
  if [ "$phase" = boot-long ]; then
    log "이제 풀기(더미 14 로) → 3분 관찰(아무것도 다시 부르지 않음)"; holder 0
    for _ in $(seq 1 18); do sleep 10; probe; done
    docker ps -a --filter label=com.docker.compose.project=wlqa-aws --format '{{.Names}} {{.Status}}' | tee -a "$OUT/$phase.log"
  else
    for _ in 1 2 3; do probe; sleep 5; done
  fi
  docker logs wlqa-aws-migrate-1 2>&1 | grep -E 'Connection error|Retrying|migrations applied|migration failed|up to date' | cut -c1-260 > "$OUT/$phase-migrate.txt"
  sampler_stop
  ;;
*) echo "deploy · runtime · boot · boot-long" >&2; exit 2 ;;
esac
