#!/usr/bin/env bash
# Redis ACL 회귀 시험 (SEC-5 · 계약 §6).
# compose 와 같은 방식(redis 사용자 999·read-only 루트 FS·cap_drop ALL·no-new-privileges·infra/redis/start.sh)으로
# 버리는 redis 컨테이너를 띄우고, wakeline_api / wakeline_collector 가 필요한 명령·키만 쓸 수 있는지 확인한다.
# 개발·E2E 스택은 건드리지 않는다. 사용: bash infra/tests/redis_acl_test.sh   (docker 필요)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# compose 에 고정된 것과 같은 이미지로 시험한다
IMAGE="${REDIS_IMAGE:-$(awk '/^  redis:/{f=1} f && $1=="image:"{print $2; exit}' "$ROOT/infra/compose.yml")}"
C="wakeline-acltest-$$"
ADMIN_PW="adm-$(openssl rand -hex 12)"; API_PW="api-$(openssl rand -hex 12)"; COL_PW="col-$(openssl rand -hex 12)"
fails=0; passes=0

cleanup() { docker rm -f "$C" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$C" \
  --user 999:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -v /data \
  -v "$ROOT/infra/redis/redis.conf:/etc/redis/redis.conf:ro" \
  -v "$ROOT/infra/redis/start.sh:/etc/redis/start.sh:ro" \
  -e REDIS_PASSWORD="$ADMIN_PW" -e REDIS_API_PASSWORD="$API_PW" -e REDIS_COLLECTOR_PASSWORD="$COL_PW" \
  --entrypoint sh "$IMAGE" /etc/redis/start.sh >/dev/null

for _ in $(seq 1 50); do
  docker exec -e REDISCLI_AUTH="$ADMIN_PW" "$C" redis-cli --no-auth-warning ping 2>/dev/null | grep -q PONG && break
  sleep 0.2
done

cli() { # cli <user> <password> <redis args...>
  local u=$1 p=$2; shift 2
  docker exec -e REDISCLI_AUTH="$p" "$C" redis-cli --no-auth-warning --user "$u" "$@" 2>&1 || true
}
ok() { # ok <설명> <기대 문자열(정규식)> <user> <pw> <args...>
  local what=$1 want=$2; shift 2
  local out; out="$(cli "$@")"
  if grep -Eq -- "$want" <<<"$out" && ! grep -Eq "NOPERM|ERR|WRONGPASS|NOAUTH" <<<"$out"; then passes=$((passes+1)); echo "  ok    $what"
  else fails=$((fails+1)); echo "  FAIL  $what → $out"; fi
}
denied() { # denied <설명> <user> <pw> <args...>  — NOPERM(ACL) 또는 이름 바꾼 명령(unknown command) 이어야 한다
  local what=$1; shift
  local out; out="$(cli "$@")"
  if grep -Eq "NOPERM|No permissions|unknown command" <<<"$out"; then passes=$((passes+1)); echo "  ok    denied: $what"
  else fails=$((fails+1)); echo "  FAIL  not denied: $what → $out"; fi
}

A=(wakeline_api "$API_PW"); K=(wakeline_collector "$COL_PW"); D=(default "$ADMIN_PW")
BUDGET_LUA="local used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0') redis.call('HINCRBY', KEYS[1], 'used', 1) redis.call('EXPIRE', KEYS[1], 60) return used"
RL_LUA="local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return {n, redis.call('TTL', KEYS[1])}"

echo "image: $IMAGE"
echo "[auth]"
out="$(docker exec "$C" redis-cli ping 2>&1 || true)"
if grep -q NOAUTH <<<"$out"; then passes=$((passes+1)); echo "  ok    unauthenticated ping → NOAUTH"; else fails=$((fails+1)); echo "  FAIL  unauthenticated ping → $out"; fi
out="$(cli wakeline_api wrong-password ping)"
if grep -Eq "WRONGPASS|invalid" <<<"$out"; then passes=$((passes+1)); echo "  ok    wrong password rejected"; else fails=$((fails+1)); echo "  FAIL  wrong password → $out"; fi
ok "default(관리) PING" PONG "${D[@]}" ping

echo "[wakeline_api — 허용]"
ok "HELLO 3 AUTH"              "proto"        "${A[@]}" hello 3 auth wakeline_api "$API_PW"
ok "PING"                      PONG           "${A[@]}" ping
ok "INFO server(헬스 인디케이터)" redis_version "${A[@]}" info server
ok "CLIENT SETINFO"            OK             "${A[@]}" client setinfo lib-name Lettuce
ok "CLIENT SETNAME"            OK             "${A[@]}" client setname wakeline-api
ok "SET/GET wakeline:*"           OK             "${A[@]}" set wakeline:acltest v
ok "GET wakeline:*"               "^v$"          "${A[@]}" get wakeline:acltest
ok "HSET 세션 해시"             "^[01]$"       "${A[@]}" hset wakeline:session:sessions:t a b
ok "HSET wakeline:settings"       "^[01]$"       "${A[@]}" hset wakeline:settings region_poll_s 10
ok "XADD wakeline:aircraft"       "^[0-9]+-[0-9]+$" "${A[@]}" xadd wakeline:aircraft '*' payload x
ok "XGROUP CREATE"             OK             "${A[@]}" xgroup create wakeline:aircraft api 0 mkstream
ok "XREADGROUP"                "payload"      "${A[@]}" xreadgroup group api c1 count 1 streams wakeline:aircraft '>'
id="$(cli "${A[@]}" xrange wakeline:aircraft - + count 1 | head -1)"
ok "XACK"                      "^1$"          "${A[@]}" xack wakeline:aircraft api "$id"
ok "XINFO GROUPS"              "name"         "${A[@]}" xinfo groups wakeline:aircraft
ok "XADD wakeline:dlq"            "^[0-9]+-[0-9]+$" "${A[@]}" xadd wakeline:dlq '*' reason x
ok "EVAL(요청 제한 Lua) rl:*"   "^1$"          "${A[@]}" eval "$RL_LUA" 1 rl:public:1.2.3.4:1 60
ok "SCRIPT LOAD + EVALSHA"     "^[0-9a-f]{40}$" "${A[@]}" script load "$RL_LUA"
ok "HGETALL wakeline:provider:*"  ""             "${A[@]}" hgetall wakeline:provider:adsb_lol

echo "[wakeline_api — 거부]"
denied "FLUSHALL"             "${A[@]}" flushall
denied "FLUSHDB"              "${A[@]}" flushdb
denied "KEYS *"               "${A[@]}" keys '*'
denied "CONFIG GET"           "${A[@]}" config get '*'
denied "DEBUG"                "${A[@]}" debug sleep 0
denied "SHUTDOWN"             "${A[@]}" shutdown
denied "REPLICAOF"            "${A[@]}" replicaof 203.0.113.1 6379
denied "MIGRATE"              "${A[@]}" migrate 203.0.113.1 6379 wakeline:acltest 0 1000
denied "RESTORE"              "${A[@]}" restore wakeline:x 0 junk
denied "ACL SETUSER"          "${A[@]}" acl setuser evil on '>x' '~*' '+@all'
denied "ACL LIST"             "${A[@]}" acl list
denied "CLIENT LIST"          "${A[@]}" client list
denied "CLIENT KILL"          "${A[@]}" client kill id 1
denied "MODULE LOAD"          "${A[@]}" module list
denied "SAVE"                 "${A[@]}" save
denied "SORT"                 "${A[@]}" sort wakeline:acltest
denied "다른 키 GET other:key" "${A[@]}" get other:key
denied "budget:* (수집기 전용)" "${A[@]}" hgetall budget:adsb_lol:20260101
denied "스크립트로 다른 키 접근" "${A[@]}" eval "return redis.call('GET', KEYS[1])" 1 other:key
denied "스크립트로 선언 안 한 키 접근" "${A[@]}" eval "return redis.call('GET', 'other:key')" 0
denied "PUBLISH"              "${A[@]}" publish ch x

echo "[wakeline_collector — 허용]"
ok "PING"                      PONG           "${K[@]}" ping
ok "INFO"                      redis_version  "${K[@]}" info server
ok "CLIENT SETINFO(redis-py)"  OK             "${K[@]}" client setinfo lib-name redis-py
for s in wakeline:aircraft wakeline:sigmet wakeline:radar wakeline:events; do
  ok "XADD $s MAXLEN ~ 200"    "^[0-9]+-[0-9]+$" "${K[@]}" xadd "$s" maxlen '~' 200 '*' payload x
done
ok "HSET wakeline:provider:*"     "^[0-9]+$"     "${K[@]}" hset wakeline:provider:adsb_fi disabled 0 ok 1
ok "HGET wakeline:provider:*"     "^0$"          "${K[@]}" hget wakeline:provider:adsb_fi disabled
ok "HINCRBY wakeline:provider:*"  "^[0-9]+$"     "${K[@]}" hincrby wakeline:provider:adsb_fi consecutive_failures 1
ok "HSET wakeline:active"         "^[0-9]+$"     "${K[@]}" hset wakeline:active region adsb_lol
ok "HSET wakeline:collector"      "^[0-9]+$"     "${K[@]}" hset wakeline:collector region_at 2026-01-01T00:00:00Z
ok "HGET wakeline:collector(health)" "2026"      "${K[@]}" hget wakeline:collector region_at
ok "SET wakeline:radar_kr:frame:* EX" OK         "${K[@]}" set wakeline:radar_kr:frame:202601010000 x ex 60
ok "SET/GET wakeline:radar_kr:frames" OK         "${K[@]}" set wakeline:radar_kr:frames '[]'
ok "HSET wakeline:radar_kr:meta"  "^[0-9]+$"     "${K[@]}" hset wakeline:radar_kr:meta available 0
ok "HGETALL wakeline:settings(읽기)" "region_poll_s" "${K[@]}" hgetall wakeline:settings
ok "XREVRANGE wakeline:sigmet(마지막 발행 확인)" "payload" "${K[@]}" xrevrange wakeline:sigmet + - count 1
ok "EXISTS wakeline:radar_kr:frame:*" "^1$"      "${K[@]}" exists wakeline:radar_kr:frame:202601010000
ok "DEL wakeline:radar_kr:frame:*" "^1$"         "${K[@]}" del wakeline:radar_kr:frame:202601010000
ok "예산 Lua budget:*"          "^[0-9]+$"     "${K[@]}" eval "$BUDGET_LUA" 1 budget:adsb_lol:20260101
ok "SCRIPT LOAD(예산)"          "^[0-9a-f]{40}$" "${K[@]}" script load "$BUDGET_LUA"
ok "HINCRBY budget:*"          "^-?[0-9]+$"   "${K[@]}" hincrby budget:adsb_lol:20260101 used -1
ok "HGETALL budget:*"          "used"         "${K[@]}" hgetall budget:adsb_lol:20260101

echo "[wakeline_collector — 거부]"
denied "세션 읽기 wakeline:session:*"   "${K[@]}" hgetall wakeline:session:sessions:t
denied "세션 위조 wakeline:session:*"   "${K[@]}" hset wakeline:session:sessions:forged sessionAttr:SPRING_SECURITY_CONTEXT x
denied "세션 삭제"                   "${K[@]}" del wakeline:session:sessions:t
denied "요청 제한 초기화 rl:*"        "${K[@]}" del rl:public:1.2.3.4:1
denied "요청 제한 INCR rl:*"          "${K[@]}" incr rl:x
denied "설정 쓰기 wakeline:settings"     "${K[@]}" hset wakeline:settings region_poll_s 1
denied "설정 삭제 wakeline:settings"     "${K[@]}" del wakeline:settings
denied "DLQ wakeline:dlq"               "${K[@]}" xadd wakeline:dlq '*' x y
denied "소비자 그룹 삭제(XGROUP DESTROY)" "${K[@]}" xgroup destroy wakeline:aircraft api
denied "XREADGROUP"                  "${K[@]}" xreadgroup group api c9 count 1 streams wakeline:aircraft '>'
denied "XACK"                        "${K[@]}" xack wakeline:aircraft api 0-1
denied "XAUTOCLAIM"                  "${K[@]}" xautoclaim wakeline:aircraft api c9 0 0-0
denied "다른 키"                     "${K[@]}" set other:key x
denied "스크립트로 세션 접근"          "${K[@]}" eval "return redis.call('HGETALL', 'wakeline:session:sessions:t')" 0
denied "KEYS *"                      "${K[@]}" keys '*'
denied "SCAN(세션 키 이름 = 세션 ID 열람)" "${K[@]}" scan 0 match 'wakeline:session:*'
denied "RANDOMKEY(키 이름 열람)"       "${K[@]}" randomkey
denied "TYPE 세션 키"                 "${K[@]}" type wakeline:session:sessions:t
denied "FLUSHALL"                    "${K[@]}" flushall
denied "CONFIG SET"                  "${K[@]}" config set appendonly no
denied "REPLICAOF"                   "${K[@]}" replicaof 203.0.113.1 6379
denied "MONITOR"                     "${K[@]}" monitor
denied "ACL SETUSER"                 "${K[@]}" acl setuser wakeline_collector '~*'
denied "SUBSCRIBE"                   "${K[@]}" subscribe ch

echo "[컨테이너 권한]"
uid="$(docker exec "$C" sh -c 'awk "/^Uid:/{print \$2}" /proc/1/status')"
caps="$(docker exec "$C" sh -c 'awk "/^CapEff:/{print \$2}" /proc/1/status')"
nnp="$(docker exec "$C" sh -c 'awk "/^NoNewPrivs:/{print \$2}" /proc/1/status')"
# 이미지의 선택 모듈(검색·JSON·시계열·블룸)은 싣지 않는다 — 내장 vectorset 만 보인다
mods="$(cli "${D[@]}" module list | grep -Eio 'search|ReJSON|timeseries|bf' | tr '\n' ' ' || true)"
if [ "$uid" = 999 ] && [ "$caps" = 0000000000000000 ] && [ "$nnp" = 1 ] && [ -z "$mods" ]; then passes=$((passes+1)); echo "  ok    uid=999 CapEff=0 NoNewPrivs=1 modules=none"
else fails=$((fails+1)); echo "  FAIL  uid=$uid CapEff=$caps NoNewPrivs=$nnp modules=$mods"; fi
out="$(docker exec "$C" sh -c 'touch /etc/x 2>&1; echo rc=$?')"
if grep -q "Read-only" <<<"$out"; then passes=$((passes+1)); echo "  ok    root FS read-only"; else fails=$((fails+1)); echo "  FAIL  root FS writable: $out"; fi
ok "AOF 기록(/data 볼륨 쓰기)" "aof_enabled:1" "${D[@]}" info persistence

echo "redis ACL test: $passes passed, $fails failed"
[ "$fails" -eq 0 ]
