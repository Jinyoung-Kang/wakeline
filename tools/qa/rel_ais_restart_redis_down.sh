#!/bin/bash
# QA 2026-10 AWS(계획 §3.4 'Redis 장애 중 AIS 재시작'): 스택 B(wlqa-b · 8702)에서 Redis 를 멈춘 동안 ais 를 재시작하면, 장애 동안 ais 가 메모리에 모은
# 분당 위치(ADR-033 · ShipBook backfill)와 공백 기록이 어떻게 되는가 — 분마다 저장된 선박 위치 행 수와 ingest_gap(source ais)을 장애 앞뒤로 센다.
#
#   bash tools/qa/rel_ais_restart_redis_down.sh <A|B|N> [증거 폴더]
#     A: Redis 정지 → OUT_BEFORE_S 뒤 ais 재시작(Redis 는 아직 멈춤) → OUT_AFTER_S 뒤 Redis 시작          (새 ais 가 Redis 없이 시작)
#     B: Redis 정지 → OUT_BEFORE_S 뒤 Redis 시작 → 곧바로 ais 재시작                                   (새 ais 가 Redis 와 함께 시작)
#     N: Redis 정지 → OUT_BEFORE_S + OUT_AFTER_S 뒤 Redis 시작(재시작 없음 — 비교 기준: 모은 위치를 다시 보내는가)
# 출력: 분마다 ship_position 행 수(fixture 재생은 분마다 비슷하다 — 평소 값과 견준다) · 그 구간의 ingest_gap · ais 로그의 backfill 줄.
# psql · redis-cli 는 컨테이너 안(비밀번호가 명령행에 없다).
set -uo pipefail
cd "$(dirname "$0")/../.."
P=wlqa-b
MODE="${1:?A|B|N}"
OUT="${2:-docs/qa/2026-10-aws/evidence/reliability/ais-redis-$MODE-$(date +%H%M%S)}"
OUT_BEFORE_S="${OUT_BEFORE_S:-150}"
OUT_AFTER_S="${OUT_AFTER_S:-90}"
mkdir -p "$OUT"
c() { echo "$P-$1-1"; }
psqlq() { docker exec "$(c db)" psql -X -U postgres -d wakeline -Atc "SET TIME ZONE 'UTC'" -c "$1" | grep -v '^SET$'; }
log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/run.log"; }
trap 'docker start "$(c redis)" "$(c ais)" >/dev/null 2>&1' EXIT

T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
log "mode $MODE — before ${OUT_BEFORE_S}s after ${OUT_AFTER_S}s; t0=$T0"
sleep 120   # 장애 앞 기준 2분
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker stop "$(c redis)" >/dev/null; log "redis stopped"
sleep "$OUT_BEFORE_S"
case "$MODE" in
  A) docker restart "$(c ais)" >/dev/null; log "ais restarted (redis still down)"; sleep "$OUT_AFTER_S"; docker start "$(c redis)" >/dev/null; log "redis started" ;;
  B) docker start "$(c redis)" >/dev/null; log "redis started"; sleep 5; docker restart "$(c ais)" >/dev/null; log "ais restarted (redis up)"; sleep "$OUT_AFTER_S" ;;
  N) sleep "$OUT_AFTER_S"; docker start "$(c redis)" >/dev/null; log "redis started (no ais restart)" ;;
  *) echo "mode A|B|N" >&2; exit 2 ;;
esac
TE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sleep 150   # 회복 · 저장 · 장애 뒤 기준 2분
log "outage $TS .. $TE"
{
  echo "# minute | ship_position rows | distinct mmsi (fixture 재생 — 평소 값과 견준다)"
  psqlq "SELECT to_char(date_trunc('minute', ts), 'HH24:MI'), count(*), count(DISTINCT mmsi) FROM ship_position WHERE ts >= '$T0' AND ts < now() - interval '30 seconds' GROUP BY 1 ORDER BY 1"
  echo "# ingest_gap(source ais) created since t0"
  psqlq "SELECT started_at, ended_at, coalesce(scope, '-'), reason FROM ingest_gap WHERE source = 'ais' AND created_at >= '$T0' ORDER BY started_at"
} | tee "$OUT/minutes.txt"
docker logs --since "$T0" "$(c ais)" 2>&1 | grep -E 'backfill|redis|gap|restart|previous|starting|xadd' | cut -c1-260 > "$OUT/ais-log.txt"
log "ais log lines: $(wc -l < "$OUT/ais-log.txt")"
