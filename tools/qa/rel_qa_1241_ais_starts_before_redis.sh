#!/bin/bash
# QA-1241 재현(QA 2026-10 AWS · 신뢰성 · AIS 공백 기록): ais 가 정상 종료된 뒤(상태 해시에 '멈춤' 기록) 다시 일어날 때 Redis 가 아직 답하지 않으면
# (AWS 데모의 매일 아침 부팅 — dockerd 가 depends_on 없이 ais · redis 를 동시에 띄운다) 정지 동안의 수신 공백이 ingest_gap 에 남지 않는다.
# 스택 B(wlqa-b · 8702)만: ais 정지 STOP_S → redis 정지 → ais 기동 → REDIS_LATE_S 뒤 redis 기동 → 60 s 뒤 ingest_gap 확인.
# 비교: 같은 절차에서 redis 를 멈추지 않으면 'ais process stopped' 공백이 남는다(CONTROL=1).
#
#   bash tools/qa/rel_qa_1241_ais_starts_before_redis.sh [증거 폴더]      # 공백이 없으면(결함) 종료 코드 1
set -uo pipefail
cd "$(dirname "$0")/../.."
P=wlqa-b
OUT="${1:-docs/qa/2026-10-aws/evidence/reliability/qa-1241-live-$(date +%H%M%S)}"
STOP_S="${STOP_S:-60}"
REDIS_LATE_S="${REDIS_LATE_S:-5}"
CONTROL="${CONTROL:-0}"
mkdir -p "$OUT"
c() { echo "$P-$1-1"; }
psqlq() { docker exec "$(c db)" psql -X -U postgres -d wakeline -Atc "SET TIME ZONE 'UTC'" -c "$1" | grep -v '^SET$'; }
log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/run.log"; }
trap 'docker start "$(c redis)" "$(c ais)" >/dev/null 2>&1' EXIT

T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
log "QA-1241 — ais stop ${STOP_S}s, redis late ${REDIS_LATE_S}s at ais start, control=$CONTROL"
docker stop "$(c ais)" >/dev/null; TSTOP=$(date -u +%Y-%m-%dT%H:%M:%SZ); log "ais stopped (graceful — status hash records the stop)"
sleep "$STOP_S"
if [ "$CONTROL" = 1 ]; then
  docker start "$(c ais)" >/dev/null; log "ais started (redis up — control)"
else
  docker stop "$(c redis)" >/dev/null; log "redis stopped (boot: not ready yet)"
  docker start "$(c ais)" >/dev/null; log "ais started before redis"
  sleep "$REDIS_LATE_S"; docker start "$(c redis)" >/dev/null; log "redis started ${REDIS_LATE_S}s later"
fi
sleep 60
docker logs --since "$T0" "$(c ais)" 2>&1 | grep -E 'previous|gap|starting|stopped' | cut -c1-240 | tee "$OUT/ais-log.txt"
gaps=$(psqlq "SELECT started_at || ' → ' || ended_at || ' (' || reason || ')' FROM ingest_gap WHERE source = 'ais' AND ended_at >= '$TSTOP' AND started_at <= '$TSTOP'::timestamptz + interval '${STOP_S} seconds' ORDER BY started_at")
log "ingest_gap covering the ${STOP_S}s stop (from $TSTOP): ${gaps:-NONE}"
if [ -z "$gaps" ]; then log "QA-1241 DEFECT: the reception gap of the stop was not recorded"; exit 1; fi
log "gap recorded"
