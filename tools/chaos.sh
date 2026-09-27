#!/bin/bash
# Wakeline 장애 주입 시험 — NFR-07/08, FR-19. 개발 스택(8700)에서 실행. 각 시나리오의 복귀 시간과 불변식을 기록한다.
set -uo pipefail
cd /Users/jinyoung/Projects/wakeline
C="docker compose -f infra/compose.yml --env-file .env"
B=http://localhost:8700
now() { python3 -c 'import time; print(f"{time.time():.1f}")'; }
status() { curl -s -m 3 "$B/api/v1/status" 2>/dev/null; }
field() { python3 -c "import sys,json
try:
  d=json.load(sys.stdin); print(eval('d'+sys.argv[1]))
except Exception: print('ERR')" "$1"; }
redis() { $C exec -T redis redis-cli -a "$(grep ^REDIS_PASSWORD= .env | cut -d= -f2)" --no-auth-warning "$@"; }
psqlq() { $C exec -T db psql -U postgres -d wakeline -Atc "$1"; }
wait_until() { local deadline=$(( $(date +%s) + $1 )); shift; while [ $(date +%s) -lt $deadline ]; do if eval "$@" >/dev/null 2>&1; then return 0; fi; sleep 1; done; return 1; }
echo "=== baseline"; status | field "['region']['aircraft']"; redis XPENDING wakeline:aircraft api | head -1

echo; echo "=== 1. kill -9 api (NFR-08: recover ≤ 60 s, PEL reprocessed, no duplicate track rows)"
tp0=$(psqlq "SELECT count(*) FROM track_point"); dup0=$(psqlq "SELECT count(*) - count(DISTINCT (hex, ts)) FROM track_point")
t0=$(now); docker kill -s KILL wakeline-api-1 >/dev/null
wait_until 120 '[ "$(status | field "[\"region\"][\"aircraft\"]")" -gt 0 ]' && t1=$(now) || t1=FAIL
echo "api back with aircraft after: $(python3 -c "print(round($t1-$t0,1) if '$t1'!='FAIL' else 'FAIL')") s"
echo "pending after recovery: $(redis XPENDING wakeline:aircraft api | head -1)"
sleep 25; dup1=$(psqlq "SELECT count(*) - count(DISTINCT (hex, ts)) FROM track_point"); tp1=$(psqlq "SELECT count(*) FROM track_point")
echo "track rows +$((tp1-tp0)), duplicate (hex,ts): $dup0 → $dup1"
echo "open alerts closed as restart: $(psqlq "SELECT count(*) FROM alert_event WHERE close_reason='restart'")"

echo; echo "=== 2. kill -9 collector (restart ≤ 60 s, fresh data resumes)"
v0=$(status | field "['snapshot_version']"); t0=$(now); docker kill -s KILL wakeline-collector-1 >/dev/null
wait_until 120 '[ "$(status | field "[\"snapshot_version\"]")" -gt '"$v0"' ] && [ "$(status | field "[\"region\"][\"lag_s\"]")" != "None" ]' && t1=$(now) || t1=FAIL
echo "new snapshot after: $(python3 -c "print(round($t1-$t0,1) if '$t1'!='FAIL' else 'FAIL')") s"

echo; echo "=== 3. kill -9 redis (AOF; api keeps serving last state; recovers)"
t0=$(now); docker kill -s KILL wakeline-redis-1 >/dev/null; sleep 3
echo "during redis outage /api/v1/aircraft: $(curl -s -o /dev/null -w '%{http_code}' "$B/api/v1/aircraft?bbox=124,33,132,39")"
v0=$(status | field "['snapshot_version']")
wait_until 120 '[ "$(status | field "[\"snapshot_version\"]")" != "ERR" ] && [ "$(status | field "[\"snapshot_version\"]")" -gt '"${v0/ERR/0}"' ]' && t1=$(now) || t1=FAIL
echo "ingest resumed after: $(python3 -c "print(round($t1-$t0,1) if '$t1'!='FAIL' else 'FAIL')") s"
echo "stream group intact: $(redis XINFO GROUPS wakeline:aircraft | head -2 | tr '\n' ' ')"

echo; echo "=== 4. stop db 40 s (live path continues; DB endpoints 503; track queue flushes after)"
$C stop db >/dev/null 2>&1; sleep 5
echo "live /aircraft: $(curl -s -o /dev/null -w '%{http_code}' "$B/api/v1/aircraft?bbox=124,33,132,39")  history /alerts/history: $(curl -s -o /dev/null -w '%{http_code}' "$B/api/v1/alerts/history")  retry-after: $(curl -s -D - -o /dev/null "$B/api/v1/alerts/history" | grep -i retry-after | tr -d '\r')"
H=$(status | field "['region']['aircraft']"); echo "aircraft during db outage: $H"
sleep 35; tp0=$(date +%s); $C start db >/dev/null 2>&1
wait_until 90 '[ "$(psqlq "SELECT count(*) FROM track_point WHERE ts > now() - interval '"'"'30 seconds'"'"'")" -gt 0 ]' && echo "track writes resumed" || echo "track writes NOT resumed"
echo "rows written for the outage window: $(psqlq "SELECT count(*) FROM track_point WHERE fetched_at > now() - interval '3 minutes'")"

echo; echo "=== 5. all region providers disabled (FR-19: last snapshot kept, stale flag)"
echo "(done via ops API in the orchestrator session — needs login)"
