#!/bin/bash
# QA 신뢰성(계획 §3.4): 격리 스택 B(wakeline-qa · 8702)에 장애를 하나 넣고, 그동안 공개 API · /healthz 를 표본으로 남긴 뒤,
# 회복 후 스트림 ↔ DB 무결성(tools/qa/stream_db_integrity.py)을 대조한다. 결함(손실 · 중복 · 남은 PEL)이면 종료 코드 1.
#
#   bash tools/qa/rel_fault.sh <시나리오> [증거 폴더]
#   시나리오: api-kill | api-restart | api-stop-<초> | api-kill-blocked | db-pause-<초> | db-stop-<초> | redis-pause-<초> | redis-restart | redis-crash | collector-restart | collector-crash | collector-stop-<초>
#
# 운영 스택(wakeline · 8700)과 스택 A(wakeline-e2e)에는 쓰지 않는다 — 프로젝트 이름을 고정한다. psql · redis-cli 는 컨테이너 안에서(비밀번호가 명령행에 없다).
set -uo pipefail
cd "$(dirname "$0")/../.."
P=wakeline-qa
B=http://localhost:8702
SC="${1:?scenario}"
OUT="${2:-docs/qa/2026-10/evidence/reliability/$SC-$(date +%H%M%S)}"
mkdir -p "$OUT"
c() { echo "$P-$1-1"; }
ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
psqlq() { docker exec "$(c db)" psql -X -U postgres -d wakeline -Atc "$1"; }
crash() { docker exec "$(c "$1")" sh -c 'kill -9 -1' >/dev/null 2>&1 || true; }  # chaos.sh 와 같다: unless-stopped 가 다시 띄운다
snapver() { curl -s -m 3 "$B/healthz" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("snapshot_version", -1))
except Exception: print(-1)'; }
health() { curl -s -m 3 "$B/healthz" | python3 -c 'import sys,json
try: d=json.load(sys.stdin); print(d.get("status"), ",".join(d.get("reasons") or []))
except Exception: print("down")'; }
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/run.log"; }

restore() {
  docker unpause "$(c db)" >/dev/null 2>&1; docker unpause "$(c redis)" >/dev/null 2>&1
  docker start "$(c db)" "$(c redis)" "$(c api)" "$(c collector)" >/dev/null 2>&1
  [ -n "${LOCKPID:-}" ] && kill "$LOCKPID" 2>/dev/null
  true
}
trap restore EXIT
trap 'exit 130' INT TERM

T0=$(ms); T0S=$(python3 -c "print($T0/1000)")
log "scenario $SC — t0=$T0 health=$(health) snapshot_version=$(snapver)"
python3 tools/qa/probe.py --base "$B" --seconds 600 --out "$OUT/probe.jsonl" &
PROBE=$!
sleep 15
FAULT_AT=$(ms)
case "$SC" in
  api-kill)
    log "kill -9 api"; crash api ;;
  api-restart)
    log "docker restart api (graceful SIGTERM — 배포 때와 같은 정상 종료 · 기동)"; docker restart "$(c api)" >/dev/null; log "api restarted" ;;
  api-stop-*)
    s=${SC#api-stop-}; log "docker stop api ${s}s (정상 종료 — 그동안 수집기는 계속 발행)"; docker stop "$(c api)" >/dev/null; sleep "$s"; docker start "$(c api)" >/dev/null; log "api started" ;;
  api-kill-blocked)
    # 기록기가 배치를 쓰는 중(잠금을 기다리며 재시도)에 api 를 죽인다: 오늘 · 내일 항적 · 선박 파티션을 ACCESS EXCLUSIVE 로 25 s 잡는다
    d0=$(date -u +%Y%m%d)
    docker exec -i "$(c db)" psql -X -U postgres -d wakeline -v ON_ERROR_STOP=1 >"$OUT/lock.log" 2>&1 <<SQL &
BEGIN;
LOCK TABLE track_point_$d0, ship_position_$d0 IN ACCESS EXCLUSIVE MODE;
SELECT 'locked', now();
SELECT pg_sleep(40);
COMMIT;
SQL
    LOCKPID=$!
    sleep 25
    log "track/ship partitions locked 25 s (writers retrying) — kill -9 api"; crash api
    wait "$LOCKPID"; LOCKPID=""; log "lock released" ;;
  db-pause-*)
    s=${SC#db-pause-}; log "docker pause db ${s}s"; docker pause "$(c db)" >/dev/null; sleep "$s"; docker unpause "$(c db)" >/dev/null; log "db unpaused" ;;
  db-stop-*)
    s=${SC#db-stop-}; log "docker stop db (${s}s)"; docker stop "$(c db)" >/dev/null; sleep "$s"; docker start "$(c db)" >/dev/null; log "db started" ;;
  redis-pause-*)
    s=${SC#redis-pause-}; log "docker pause redis ${s}s"; docker pause "$(c redis)" >/dev/null; sleep "$s"; docker unpause "$(c redis)" >/dev/null; log "redis unpaused" ;;
  redis-restart)
    log "docker restart redis (AOF reload)"; docker restart "$(c redis)" >/dev/null; log "redis restarted" ;;
  redis-crash)
    log "kill -9 redis"; crash redis ;;
  collector-restart)
    log "docker restart collector"; docker restart "$(c collector)" >/dev/null ;;
  collector-crash)
    log "kill -9 collector"; crash collector ;;
  collector-stop-*)
    s=${SC#collector-stop-}; log "docker stop collector ${s}s (/healthz 가 region_feed_lag 를 말하는지)"; docker stop "$(c collector)" >/dev/null; sleep "$s"; docker start "$(c collector)" >/dev/null; log "collector started" ;;
  *) echo "unknown scenario $SC" >&2; exit 2 ;;
esac
FAULT_END=$(ms)
# 회복: /healthz ok + 스냅샷 판이 앞으로
v0=$(snapver); rec=""
for i in $(seq 1 180); do
  h=$(health); v=$(snapver)
  if [ "${h%% *}" = ok ] && [ "$v" -gt "$v0" ] 2>/dev/null; then rec=$(ms); break; fi
  sleep 1
done
if [ -n "$rec" ]; then log "recovered (healthz ok + new snapshot) $(( (rec - FAULT_END) / 1000 )) s after the fault ended"; else log "NOT recovered within 180 s: $(health)"; fi
sleep 40
UNTIL=$(( $(ms) - 15000 ))
kill "$PROBE" 2>/dev/null; wait "$PROBE" 2>/dev/null
python3 tools/qa/probe.py --summary "$OUT/probe.jsonl" "$T0S" > "$OUT/probe-summary.txt"
docker logs --since "$(python3 -c "import datetime;print(datetime.datetime.fromtimestamp($T0/1000,datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'))")" "$(c api)" 2>&1 \
  | grep -E 'WARN|ERROR|re-processed|trimmed|flush|bootstrap|Started' | cut -c1-400 > "$OUT/api-log.txt"
log "fault at +$(( (FAULT_AT - T0) / 1000 )) s .. +$(( (FAULT_END - T0) / 1000 )) s; integrity window $((T0 - 60000)) .. $UNTIL"
python3 tools/qa/stream_db_integrity.py --since-ms $((T0 - 60000)) --until-ms "$UNTIL" --settle-s 120 --json "$OUT/integrity.json" > /dev/null
rc=$?
python3 -c "import json; d=json.load(open('$OUT/integrity.json')); print(json.dumps(d['defects'], ensure_ascii=False)); print({k: (v['expected_rows'] if k=='aircraft' else v.get('expected_windows', v.get('expected_ids', v.get('expected')))) for k, v in d.items() if k in ('aircraft','ships','sigmet','ais_gap')})" | tee -a "$OUT/run.log"
log "integrity exit=$rc"
exit $rc
