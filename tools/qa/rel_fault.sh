#!/bin/bash
# QA 신뢰성(계획 §3.4): 격리 스택 B(wakeline-qa · 8702)에 장애를 하나 넣고, 그동안 공개 API · /healthz 를 표본으로 남긴 뒤,
# 회복 후 스트림 ↔ DB 무결성(tools/qa/stream_db_integrity.py)을 대조한다. 결함(손실 · 중복 · 남은 PEL)이면 종료 코드 1.
#
#   bash tools/qa/rel_fault.sh <시나리오> [증거 폴더]
#   시나리오: api-kill | api-restart | api-stop-<초> | api-kill-blocked | db-pause-<초> | db-stop-<초> | redis-pause-<초> | redis-restart | redis-crash | collector-restart | collector-crash | collector-stop-<초>
#            | ais-restart | ais-crash | ais-stop-<초> | writers-stop-<초>(api · collector · ais 함께) | db-connfull-<초>(연결 고갈 중 api · collector 재기동) | dbpaused-api-stop | dockerkill-<서비스> | redisdown-api-restart
#   QA 2026-10 AWS: WLQA_PROJECT=wlqa-b bash tools/qa/rel_fault.sh <시나리오> docs/qa/2026-10-aws/evidence/reliability/<시나리오>-<시각>
#
# 운영 스택(wakeline · 8700)과 스택 A(wakeline-e2e)에는 쓰지 않는다 — 프로젝트 이름을 고정한다. psql · redis-cli 는 컨테이너 안에서(비밀번호가 명령행에 없다).
set -uo pipefail
cd "$(dirname "$0")/../.."
# QA 2026-10 AWS: 스택 B 가 wlqa-b(8702) — WLQA_PROJECT=wlqa-b 로 부르고 증거 폴더를 둘째 인자로 준다(옛 증거를 덮지 않게)
P="${WLQA_PROJECT:-wakeline-qa}"
case "$P" in wakeline-qa|wlqa-b) ;; *) echo "격리 스택 B 만(wakeline-qa · wlqa-b): $P" >&2; exit 2 ;; esac
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
  docker start "$(c db)" "$(c redis)" "$(c api)" "$(c collector)" "$(c ais)" >/dev/null 2>&1
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
  redisdown-api-restart)
    # 부팅 순서 흉내(api 쪽): redis 를 멈춘 채 api 를 다시 띄우고 20 s 뒤 redis 기동 — 부트스트랩(항공기 · 선박) · 가드 · 소비가 스스로 이어지는가
    log "docker stop redis"; docker stop "$(c redis)" >/dev/null
    docker restart "$(c api)" >/dev/null; log "api restarted while redis is down"; sleep 20
    docker start "$(c redis)" >/dev/null; log "redis started" ;;
  dockerkill-*)
    # docker kill -s KILL <서비스>(컨테이너의 PID 1 째로 — OOM 종료와 같은 모양). unless-stopped 가 다시 띄우는지 보고, 10 s 안에 안 뜨면 손으로 띄운다
    svc=${SC#dockerkill-}; log "docker kill -s KILL $svc"; docker kill -s KILL "$(c "$svc")" >/dev/null; sleep 10
    if [ "$(docker inspect -f '{{.State.Running}}' "$(c "$svc")")" = true ]; then log "$svc restarted by the restart policy (restarts=$(docker inspect -f '{{.RestartCount}}' "$(c "$svc")"))"
    else log "$svc NOT restarted by the restart policy within 10 s (docker kill counts as a manual stop) — starting it"; docker start "$(c "$svc")" >/dev/null; fi ;;
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
  db-connfull-*)
    # 연결 고갈(공유 RDS 의 max_connections 를 다른 프로젝트가 채운 상태): api · collector 를 멈춰 연결을 놓게 한 뒤, 슈퍼유저(로컬 소켓) 세션으로
    # 남은 자리를 채운다(점검 psql 몫 2 만 남김 — 일반 역할은 max_connections − 3 에서 막힌다) → api · collector 기동(새 연결이 필요) → <초> 뒤 채운 세션이 끝난다
    s=${SC#db-connfull-}
    docker stop "$(c api)" "$(c collector)" >/dev/null
    n=$(( $(psqlq "SHOW max_connections") - $(psqlq "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend'") - 2 ))
    docker exec -d "$(c db)" sh -c "for i in \$(seq 1 $n); do psql -X -q -U postgres -d wakeline -c 'SELECT pg_sleep($s)' >/dev/null 2>&1 & done; wait"
    sleep 4
    log "api · collector stopped; filled $n connection slots for ${s}s (client backends now $(psqlq "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend'"))"
    docker start "$(c collector)" "$(c api)" >/dev/null; log "api · collector started while the slots are full"
    sleep "$s"; log "slots released" ;;
  dbpaused-api-stop)
    # 종료 유예 안에 저장기가 비우지 못하는 정지(EC2 정지 때 DB 가 느림): db 를 멈춘 채 api 를 정상 종료(유예 30 s) → db 를 풀고 api 기동.
    # 못 쓴 행의 메시지는 PEL 에 남아 다음 기동에서 다시 처리돼야 한다(ACK 는 커밋 뒤)
    log "docker pause db"; docker pause "$(c db)" >/dev/null; sleep 12
    log "docker stop api while db is paused"; docker stop "$(c api)" >/dev/null; log "api stopped"
    docker unpause "$(c db)" >/dev/null; log "db unpaused"; sleep 5; docker start "$(c api)" >/dev/null; log "api started" ;;
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
  ais-restart)
    log "docker restart ais (graceful SIGTERM)"; docker restart "$(c ais)" >/dev/null ;;
  ais-crash)
    log "kill -9 ais"; crash ais ;;
  ais-stop-*)
    s=${SC#ais-stop-}; log "docker stop ais ${s}s"; docker stop "$(c ais)" >/dev/null; sleep "$s"; docker start "$(c ais)" >/dev/null; log "ais started" ;;
  writers-stop-*)
    # 배포 · 평일 정지처럼 쓰는 세 컨테이너를 함께 정상 종료(compose stop — 유예 api · collector 30 s · ais 20 s) → 그동안 Redis 는 산다 → 다시 기동
    s=${SC#writers-stop-}; log "docker stop api collector ais together ${s}s"; docker stop "$(c api)" "$(c collector)" "$(c ais)" >/dev/null; sleep "$s"
    docker start "$(c collector)" "$(c ais)" "$(c api)" >/dev/null; log "writers started" ;;
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
python3 tools/qa/stream_db_integrity.py --project "$P" --since-ms $((T0 - 60000)) --until-ms "$UNTIL" --settle-s 120 --json "$OUT/integrity.json" > /dev/null
rc=$?
python3 -c "import json; d=json.load(open('$OUT/integrity.json')); print(json.dumps(d['defects'], ensure_ascii=False)); print({k: (v['expected_rows'] if k=='aircraft' else v.get('expected_windows', v.get('expected_ids', v.get('expected')))) for k, v in d.items() if k in ('aircraft','ships','sigmet','ais_gap')})" | tee -a "$OUT/run.log"
log "integrity exit=$rc"
exit $rc
