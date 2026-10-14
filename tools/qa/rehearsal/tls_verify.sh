#!/usr/bin/env bash
# QA 2026-10 AWS 리허설(R) 항목 2: RDS 서버 인증서 검증(verify-full) — api · migrate · collector 가
#   시험 CA A + 맞는 이름(rds.wlqa.test)으로는 붙고, 다른 CA(시험 CA B · 저장소의 실제 AWS 묶음 infra/rds/global-bundle.pem) · 틀린 이름(host.docker.internal)으로는 거절하는가.
#   tools/qa/rehearsal/tls_verify.sh <증거 폴더> [migrate api collector]   # 실행 중인 wlqa-rds · wlqa-aws 가 필요하다. 끝나면 api · collector 를 CA A 로 되돌린다
#   (뒤의 이름으로 일부만 — 기본은 셋 다)
# migrate 는 `run --rm --no-deps`(Flyway connectRetries 10 — 실패까지 몇 분), api · collector 는 그 서비스만 바꿔 다시 만든다(--no-deps) → 75 s 관찰 → 되돌림.
# 기대와 다르면(붙어야 할 때 못 붙거나, 거절해야 할 때 붙으면) 종료 코드 1.
set -uo pipefail
OUT=${1:?증거 폴더}; mkdir -p "$OUT"; shift; ONLY=" ${*:-migrate api collector} "
want() { case "$ONLY" in *" $1 "*) return 0;; esac; return 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"
R="${WLQA_R_DIR:-/private/tmp/claude-501/-Users-jinyoung-Projects-wakeline/3b40667d-7c26-4f92-9be9-6efb0a86ebea/scratchpad/qa/rehearsal}"
RS="$HERE/r.sh"
CA_A="$R/certs/ca-a.pem"; CA_B="$R/certs/ca-b.pem"; AWS_BUNDLE="$ROOT/infra/rds/global-bundle.pem"
GOOD=rds.wlqa.test; WRONG=host.docker.internal
TLS_ERR='PKIX|certificate|SSLHandshake|SSLError|SSLCertVerification|CERTIFICATE_VERIFY_FAILED|hostname|does not match|SSL error|unable to find valid certification path|Hostname'
fails=0
log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/tls-summary.txt"; }

# ---- migrate: 네 경우를 함께(각자 버리는 컨테이너) ----
run_migrate() {
  local name=$1 ca=$2 host=$3 t0; t0=$(date +%s)
  WLQA_RDS_CA="$ca" RDS_HOST="$host" "$RS" aws run --rm --no-deps -T migrate > "$OUT/tls-migrate-$name.log" 2>&1
  echo "rc=$? elapsed=$(( $(date +%s) - t0 ))s" >> "$OUT/tls-migrate-$name.log"
}
if want migrate; then
  log "migrate 4 cases (병렬)"
  run_migrate ok-ca-a "$CA_A" "$GOOD" &
  run_migrate bad-ca-b "$CA_B" "$GOOD" &
  run_migrate bad-aws-bundle "$AWS_BUNDLE" "$GOOD" &
  run_migrate bad-hostname "$CA_A" "$WRONG" &
fi

# ---- api · collector: 서비스 하나씩 바꿔 다시 만들고 관찰 ----
observe() {  # $1 서비스 $2 이름
  local svc=$1 name=$2 c="wlqa-aws-$1-1" f="$OUT/tls-$1-$2.txt"
  {
    echo "# $svc $name — $(date -u +%H:%M:%SZ) 다시 만든 뒤 75 s"
    echo "state: $(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' "$c" 2>&1)"
    echo "edge /healthz: $(curl -s -m 5 -w ' [%{http_code}]' http://127.0.0.1:18710/healthz)"
    echo "GET /api/v1/alerts/history?limit=1: $(curl -s -o /dev/null -m 10 -w '%{http_code}' 'http://127.0.0.1:18710/api/v1/alerts/history?limit=1')"
    echo "--- TLS 관련 로그(앞 12줄)"
    docker logs "$c" 2>&1 | grep -E "$TLS_ERR" | cut -c1-400 | head -12
    echo "--- TLS 관련 로그 줄 수: $(docker logs "$c" 2>&1 | grep -cE "$TLS_ERR")"
    echo "--- 서버 쪽 TLS 세션(같은 계정 · application_name)"
    "$RS" sql postgres "SELECT a.usename, a.application_name, s.ssl, s.version, count(*) FROM pg_stat_activity a JOIN pg_stat_ssl s USING (pid)
                         WHERE a.backend_type = 'client backend' AND a.usename LIKE 'wakeline%' GROUP BY 1, 2, 3, 4 ORDER BY 1, 2"
  } > "$f" 2>&1
}
api_or_collector_case() {  # $1 서비스 $2 이름 $3 CA $4 호스트
  WLQA_RDS_CA="$3" RDS_HOST="$4" "$RS" aws up -d --no-deps "$1" > /dev/null 2>&1
  sleep 75
  observe "$1" "$2"
}
for svc in api collector; do
  want $svc || continue
  api_or_collector_case $svc bad-ca-b "$CA_B" "$GOOD"
  api_or_collector_case $svc bad-hostname "$CA_A" "$WRONG"
  log "$svc: 되돌림(CA A · $GOOD)"
  "$RS" aws up -d --no-deps --wait --wait-timeout 180 "$svc" > /dev/null 2>&1
  sleep 20
  observe "$svc" ok-ca-a
done
wait  # migrate 네 경우

# ---- 판정 ----
verdict() {  # $1 이름 $2 기대(accept|reject) $3 붙었는가(0/1) $4 TLS 오류 줄 수
  local ok=0
  if [ "$2" = accept ] && [ "$3" = 1 ]; then ok=1; fi
  if [ "$2" = reject ] && [ "$3" = 0 ] && [ "$4" -gt 0 ]; then ok=1; fi
  if [ $ok = 1 ]; then log "ok   $1: 기대 $2 (connected=$3, tls_err_lines=$4)"; else log "FAIL $1: 기대 $2 (connected=$3, tls_err_lines=$4)"; fails=$((fails+1)); fi
}
for m in ok-ca-a bad-ca-b bad-aws-bundle bad-hostname; do
  want migrate || break
  f="$OUT/tls-migrate-$m.log"
  conn=0; grep -qE 'migrations applied|up to date' "$f" && conn=1
  verdict "migrate $m" "$( [ $m = ok-ca-a ] && echo accept || echo reject )" $conn "$(grep -cE "$TLS_ERR" "$f")"
done
for svc in api collector; do
  want $svc || continue
  user=wakeline_$svc
  for m in bad-ca-b bad-hostname ok-ca-a; do
    f="$OUT/tls-$svc-$m.txt"
    conn=0; grep -qE "^$user"$'\t' "$f" && conn=1
    verdict "$svc $m" "$( [ $m = ok-ca-a ] && echo accept || echo reject )" $conn "$(sed -n '/^--- TLS 관련 로그 줄 수/p' "$f" | grep -oE '[0-9]+$')"
  done
done
log "fails=$fails"
[ "$fails" = 0 ]
