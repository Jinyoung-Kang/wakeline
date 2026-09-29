#!/usr/bin/env bash
# Redis ACL 회귀 시험 (SEC-5 · 계약 §6 · 계약 v2 §C · 계약 v3 §D · 계약 v5 §C3 · §G2).
# compose 와 같은 방식(redis 사용자 999·read-only 루트 FS·cap_drop ALL·no-new-privileges·infra/redis/start.sh)으로
# 버리는 redis 컨테이너를 띄우고, wakeline_api / wakeline_collector / wakeline_ais 가 필요한 명령·키만 쓸 수 있는지 확인한다.
# 마지막으로 REDIS_AIS_PASSWORD 없이 한 번 더 띄워 wakeline_ais 가 빈 비밀번호로 열리지 않는지 본다.
# 개발·E2E 스택은 건드리지 않는다. 사용: bash infra/tests/redis_acl_test.sh   (docker 필요)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# compose 에 고정된 것과 같은 이미지로 시험한다
IMAGE="${REDIS_IMAGE:-$(awk '/^  redis:/{f=1} f && $1=="image:"{print $2; exit}' "$ROOT/infra/compose.yml")}"
C="wakeline-acltest-$$"; C2="wakeline-acltest-noais-$$"
ADMIN_PW="adm-$(openssl rand -hex 12)"; API_PW="api-$(openssl rand -hex 12)"; COL_PW="col-$(openssl rand -hex 12)"; AIS_PW="ais-$(openssl rand -hex 12)"
fails=0; passes=0

cleanup() { docker rm -f "$C" "$C2" >/dev/null 2>&1 || true; }
trap cleanup EXIT

start_redis() { # start_redis <컨테이너 이름> <추가 docker run 인자...>
  local name=$1; shift
  docker run -d --name "$name" \
    --user 999:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    -v /data \
    -v "$ROOT/infra/redis/redis.conf:/etc/redis/redis.conf:ro" \
    -v "$ROOT/infra/redis/start.sh:/etc/redis/start.sh:ro" \
    -e REDIS_PASSWORD="$ADMIN_PW" -e REDIS_API_PASSWORD="$API_PW" -e REDIS_COLLECTOR_PASSWORD="$COL_PW" "$@" \
    --entrypoint sh "$IMAGE" /etc/redis/start.sh >/dev/null
  for _ in $(seq 1 50); do
    docker exec -e REDISCLI_AUTH="$ADMIN_PW" "$name" redis-cli --no-auth-warning ping 2>/dev/null | grep -q PONG && return 0
    sleep 0.2
  done
  echo "redis $name did not start:"; docker logs "$name" 2>&1 | tail -20; return 1
}
start_redis "$C" -e REDIS_AIS_PASSWORD="$AIS_PW"

cli() { # cli <user> <password> <redis args...>
  local u=$1 p=$2; shift 2
  docker exec -e REDISCLI_AUTH="$p" "${TARGET:-$C}" redis-cli --no-auth-warning --user "$u" "$@" 2>&1 || true
}
ok() { # ok <설명> <기대 문자열(정규식)> <user> <pw> <args...>
  local what=$1 want=$2; shift 2
  local out; out="$(cli "$@")"
  if grep -Eq -- "$want" <<<"$out" && ! grep -Eq "NOPERM|ERR|WRONGPASS|NOAUTH" <<<"$out"; then passes=$((passes+1)); echo "  ok    $what"
  else fails=$((fails+1)); echo "  FAIL  $what → $out"; fi
}
denied() { # denied <설명> <user> <pw> <args...>  — NOPERM(ACL) 또는 이름 바꾼 명령(unknown command) 이어야 한다
  # 스크립트 안 redis.call 이 막히면 "ERR ACL failure in script: … has no permissions to run the 'x' command"(소문자) 로 온다
  local what=$1; shift
  local out; out="$(cli "$@")"
  if grep -Eq "NOPERM|No permissions|has no permissions|ACL failure in script|unknown command" <<<"$out"; then passes=$((passes+1)); echo "  ok    denied: $what"
  else fails=$((fails+1)); echo "  FAIL  not denied: $what → $out"; fi
}

A=(wakeline_api "$API_PW"); K=(wakeline_collector "$COL_PW"); S=(wakeline_ais "$AIS_PW"); D=(default "$ADMIN_PW")
NOW_MS="$(($(date +%s) * 1000))"
BUDGET_LUA="local used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0') redis.call('HINCRBY', KEYS[1], 'used', 1) redis.call('EXPIRE', KEYS[1], 60) return used"
RL_LUA="local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return {n, redis.call('TTL', KEYS[1])}"
# 계약 v5 §C1: wakeline:logs 항목은 필드 하나 e = JSON 문자열. 값은 합성 자료(서비스 이름만 확인에 쓴다).
# level 은 WARN — ok() 가 출력의 "ERR" 를 오류로 보므로 ERROR 를 쓰지 않는다
log_event() { printf '{"v":1,"ts":"2026-01-01T00:00:00Z","service":"%s","instance":"acltest","level":"WARN","logger":"acltest","message":"acltest","fp":"0000000000000000"}' "$1"; }

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
# 계약 v2 §A1: 수요 임대의 유일한 작성자 · §B3: 선박 스트림 소비자
ok "ZADD wakeline:demand:hot(임대)"     "^[01]$"   "${A[@]}" zadd wakeline:demand:hot "$((NOW_MS + 60000))" 35.5:139.5:150
ok "HSET wakeline:demand:hot:meta"      "^[01]$"   "${A[@]}" hset wakeline:demand:hot:meta 35.5:139.5:150 '{"lat":35.5,"lon":139.5,"radius_nm":150,"sessions":1}'
ok "ZADD wakeline:demand:focus(임대)"   "^[01]$"   "${A[@]}" zadd wakeline:demand:focus "$((NOW_MS + 60000))" 71c011
ok "HSET wakeline:demand:focus:meta"    "^[01]$"   "${A[@]}" hset wakeline:demand:focus:meta 71c011 '{"sessions":1}'
ok "ZREMRANGEBYSCORE 만료 임대"          "^[0-9]+$" "${A[@]}" zremrangebyscore wakeline:demand:focus -inf "$((NOW_MS - 1))"
ok "HGETALL wakeline:demand:status(읽기)" ""       "${A[@]}" hgetall wakeline:demand:status
ok "XGROUP CREATE wakeline:ships"       OK         "${A[@]}" xgroup create wakeline:ships api '$' mkstream
ok "HGETALL wakeline:ais:status(읽기)"  ""         "${A[@]}" hgetall wakeline:ais:status
# 계약 v4 §A: 노선 캐시는 수집기가 쓰고 api 가 읽는다(값 확인은 수집기 절에서)
ok "GET wakeline:route:*(읽기, 없음)"    ""         "${A[@]}" get wakeline:route:ZZX000
# 계약 v5 §C: api 는 자기 로그 · 브라우저 오류(client-errors)를 싣고 운영 조회로 읽는다(읽기 확인은 ais 절 뒤에)
ok "XADD wakeline:logs MAXLEN ~ 3000(api 로그)" "^[0-9]+-[0-9]+$" "${A[@]}" xadd wakeline:logs maxlen '~' 3000 '*' e "$(log_event api)"
# 계약 v5 §G2: 브라우저 오류는 따로 자르는 스트림 — api 만 싣는다
ok "XADD wakeline:logs:client MAXLEN ~ 1000(브라우저 오류)" "^[0-9]+-[0-9]+$" "${A[@]}" xadd wakeline:logs:client maxlen '~' 1000 '*' e "$(log_event web-client)"

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
# 계약 v3 §D: BCAST 무효화는 키 권한과 무관하게 바뀐 키 이름(세션 ID)을 보낸다 — 모든 서비스 사용자에서 금지
denied "CLIENT TRACKING BCAST"      "${A[@]}" client tracking on bcast
denied "CLIENT TRACKING(RESP3)"     "${A[@]}" -3 client tracking on bcast
denied "CLIENT CACHING"             "${A[@]}" client caching yes

echo "[wakeline_collector — 허용]"
ok "PING"                      PONG           "${K[@]}" ping
ok "INFO"                      redis_version  "${K[@]}" info server
ok "CLIENT SETINFO(redis-py)"  OK             "${K[@]}" client setinfo lib-name redis-py
ok "HELLO 3 AUTH(redis-py 8 은 RESP3 로 접속)" "proto" "${K[@]}" hello 3 auth wakeline_collector "$COL_PW"
for s in wakeline:aircraft wakeline:sigmet wakeline:radar wakeline:events; do
  ok "XADD $s MAXLEN ~ 200"    "^[0-9]+-[0-9]+$" "${K[@]}" xadd "$s" maxlen '~' 200 '*' payload x
done
ok "HSET wakeline:provider:*"     "^[0-9]+$"     "${K[@]}" hset wakeline:provider:adsb_fi disabled 0 ok 1
ok "HGET wakeline:provider:*"     "^0$"          "${K[@]}" hget wakeline:provider:adsb_fi disabled
ok "HINCRBY wakeline:provider:*"  "^[0-9]+$"     "${K[@]}" hincrby wakeline:provider:adsb_fi consecutive_failures 1
# R-17 보존: 429 이력 해시(chain_store.py) — HSET 뒤 EXPIRE 로 논리 만료와 같은 때에 지워지게 한다(EXPIRE 는 이 키 셀렉터에만)
ok "HSET wakeline:provider:*:ratelimit:*"   "^[0-9]+$" "${K[@]}" hset wakeline:provider:adsb_lol:ratelimit:region v 1 stage 2
ok "EXPIRE wakeline:provider:*:ratelimit:*" "^1$"      "${K[@]}" expire wakeline:provider:adsb_lol:ratelimit:region 1500
ok "429 이력 TTL 이 걸렸다(관리자로 확인)" "^1[0-9]{3}$" "${D[@]}" ttl wakeline:provider:adsb_lol:ratelimit:region
ok "HGETALL wakeline:provider:*:ratelimit:*" "stage"   "${K[@]}" hgetall wakeline:provider:adsb_lol:ratelimit:region
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
# 수집기는 SCRIPT LOAD + EVALSHA 만 쓴다(budget.py). 스크립트 안 EXPIRE 는 budget:* 셀렉터로만 허용된다(R-86)
ok "SCRIPT LOAD(예산)"          "^[0-9a-f]{40}$" "${K[@]}" script load "$BUDGET_LUA"
BUDGET_SHA="$(cli "${K[@]}" script load "$BUDGET_LUA")"
ok "EVALSHA 예산 Lua(HGET·HINCRBY·EXPIRE) budget:*" "^[0-9]+$" "${K[@]}" evalsha "$BUDGET_SHA" 1 budget:adsb_lol:20260101
ok "예산 키 TTL 이 걸렸다(관리자로 확인)" "^[1-9][0-9]*$" "${D[@]}" ttl budget:adsb_lol:20260101
ok "HINCRBY budget:*"          "^-?[0-9]+$"   "${K[@]}" hincrby budget:adsb_lol:20260101 used -1
ok "HGETALL budget:*"          "used"         "${K[@]}" hgetall budget:adsb_lol:20260101
# 계약 v2 §A2 · §C: 임대는 읽기(1 s 폴링), 조회 상태는 쓰기
ok "ZRANGEBYSCORE wakeline:demand:hot"   "35.5:139.5:150" "${K[@]}" zrangebyscore wakeline:demand:hot "$NOW_MS" +inf withscores
ok "ZRANGEBYSCORE wakeline:demand:focus" "71c011"   "${K[@]}" zrangebyscore wakeline:demand:focus "$NOW_MS" +inf
ok "HGETALL wakeline:demand:hot:meta"    "radius_nm" "${K[@]}" hgetall wakeline:demand:hot:meta
ok "HMGET wakeline:demand:focus:meta"    "sessions" "${K[@]}" hmget wakeline:demand:focus:meta 71c011
ok "HSET wakeline:demand:status"         "^[01]$"   "${K[@]}" hset wakeline:demand:status focus:71c011 '{"state":"active","interval_s":5}'
ok "HGETALL wakeline:demand:status"      "active"   "${K[@]}" hgetall wakeline:demand:status
ok "HDEL wakeline:demand:status(임대 끝)" "^[01]$"  "${K[@]}" hdel wakeline:demand:status hot:gone
# 계약 v4 §A: 노선 캐시 — EXISTS 로 확인하고 SET EX 로 쓴다(found·not_found 1,800 s · error 120 s). 값은 합성 자료.
ok "EXISTS wakeline:route:*(없음)"       "^0$"      "${K[@]}" exists wakeline:route:ZZX123
ok "SET wakeline:route:* EX 1800"        OK         "${K[@]}" set wakeline:route:ZZX123 '{"v":1,"status":"not_found","callsign":"ZZX123"}' ex 1800
ok "SET wakeline:route:* EX 120"         OK         "${K[@]}" set wakeline:route:ZZX124 '{"v":1,"status":"error","callsign":"ZZX124"}' ex 120
ok "EXISTS wakeline:route:*"             "^1$"      "${K[@]}" exists wakeline:route:ZZX123
ok "GET wakeline:route:*"                "not_found" "${K[@]}" get wakeline:route:ZZX123
ok "TTL wakeline:route:*(관리자로 확인)"  "^(1[0-7][0-9]{2}|1800)$" "${D[@]}" ttl wakeline:route:ZZX123
ok "api GET wakeline:route:*(수집기가 쓴 값)" "not_found" "${A[@]}" get wakeline:route:ZZX123

ok "DEL wakeline:radar_kr:frames(목록 비움 — kma_radar._save_frames)" "^[01]$" "${K[@]}" del wakeline:radar_kr:frames
# 계약 v5 §C2 · §C3: 로그 싱크 — XADD wakeline:logs MAXLEN ~ 3000 * e <json>
ok "XADD wakeline:logs MAXLEN ~ 3000(로그 싱크)" "^[0-9]+-[0-9]+$" "${K[@]}" xadd wakeline:logs maxlen '~' 3000 '*' e "$(log_event collector)"

echo "[wakeline_collector — 거부]"
# R-86: 허용 목록 — 스트림(api 소비자 그룹·PEL)을 지우거나 덮어쓰거나 만료시키거나 이름을 바꾸는 명령은 어느 키에도 없다
cli "${D[@]}" xadd wakeline:aircraft '*' payload keep >/dev/null
denied "DEL 스트림 wakeline:aircraft"            "${K[@]}" del wakeline:aircraft
denied "UNLINK 스트림 wakeline:aircraft"         "${K[@]}" unlink wakeline:aircraft
denied "RENAME 스트림"                           "${K[@]}" rename wakeline:aircraft wakeline:events
denied "XTRIM 스트림 MAXLEN 0"                   "${K[@]}" xtrim wakeline:aircraft maxlen 0
denied "XDEL 스트림"                             "${K[@]}" xdel wakeline:aircraft 0-1
denied "SET 으로 스트림 덮어쓰기"                  "${K[@]}" set wakeline:aircraft x
denied "SUNIONSTORE 로 스트림 덮어쓰기"            "${K[@]}" sunionstore wakeline:aircraft wakeline:nokey
denied "COPY … REPLACE 로 스트림 덮어쓰기"          "${K[@]}" copy wakeline:events wakeline:aircraft replace
denied "EXPIRE 스트림"                           "${K[@]}" expire wakeline:aircraft 1
denied "PEXPIRE 스트림"                          "${K[@]}" pexpire wakeline:aircraft 1
denied "DEL 해시 wakeline:provider:*"            "${K[@]}" del wakeline:provider:adsb_fi
denied "EXPIRE 공급자 상태 해시(429 이력만)"        "${K[@]}" expire wakeline:provider:adsb_fi 1
denied "DEL 429 이력(HDEL · EXPIRE 만)"          "${K[@]}" del wakeline:provider:adsb_lol:ratelimit:region
denied "DEL 예산 budget:*"                       "${K[@]}" del budget:adsb_lol:20260101
denied "EXPIRE 노선 캐시(SET EX 만)"              "${K[@]}" expire wakeline:route:ZZX123 1
denied "UNLINK 레이더 목록(DEL 만)"               "${K[@]}" unlink wakeline:radar_kr:frames
denied "GETDEL 노선 캐시"                        "${K[@]}" getdel wakeline:route:ZZX123
denied "SELECT 1"                              "${K[@]}" select 1
denied "FUNCTION FLUSH"                        "${K[@]}" function flush
denied "SCRIPT FLUSH(api 의 요청 제한 스크립트 캐시)" "${K[@]}" script flush
denied "EVAL(임의 스크립트)"                     "${K[@]}" eval "return 1" 0
DEL_SHA="$(cli "${D[@]}" script load "return redis.call('DEL', KEYS[1])")"
denied "EVALSHA 로도 스트림 DEL 불가"              "${K[@]}" evalsha "$DEL_SHA" 1 wakeline:aircraft
ok "스트림은 그대로(관리자로 확인)" "^[1-9][0-9]*$" "${D[@]}" xlen wakeline:aircraft
# 계약 v5 §C3: 로그 스트림은 쓰기 전용(%W~) — XADD 만. 다른 서비스(api · web-client)의 로그를 읽거나 지우거나 줄이지 못한다.
# (남는 위험: ACL 은 XADD 의 인자를 보지 않는다 — XADD … MAXLEN 0 으로 비우기 · 다른 service 이름으로 쓰기는 막지 못한다. start.sh 머리 주석)
denied "XREVRANGE wakeline:logs(쓰기 전용 — 다른 서비스 로그 읽기)" "${K[@]}" xrevrange wakeline:logs + - count 1
denied "DEL wakeline:logs"                     "${K[@]}" del wakeline:logs
denied "UNLINK wakeline:logs"                  "${K[@]}" unlink wakeline:logs
denied "RENAME wakeline:logs"                  "${K[@]}" rename wakeline:logs wakeline:events
denied "XTRIM wakeline:logs MAXLEN 0"          "${K[@]}" xtrim wakeline:logs maxlen 0
denied "XDEL wakeline:logs"                    "${K[@]}" xdel wakeline:logs 0-1
denied "SET 으로 wakeline:logs 덮어쓰기"         "${K[@]}" set wakeline:logs x
denied "EXPIRE wakeline:logs"                  "${K[@]}" expire wakeline:logs 1
denied "XGROUP CREATE wakeline:logs"           "${K[@]}" xgroup create wakeline:logs c9 0
# 스크립트: 키를 선언하면(numkeys 1) EVALSHA 자체의 키 검사(읽기·쓰기)에서 먼저 막힌다 — 스크립트 안 redis.call 검사는
# 키를 선언하지 않고(numkeys 0) 이름을 박아 넣은 스크립트로 따로 본다(거부 문구 "ERR ACL failure in script: …")
denied "EVALSHA 로도 wakeline:logs DEL 불가(선언한 키)"     "${K[@]}" evalsha "$DEL_SHA" 1 wakeline:logs
XTRIM_SHA="$(cli "${D[@]}" script load "return redis.call('XTRIM', KEYS[1], 'MAXLEN', 0)")"
denied "EVALSHA 로도 wakeline:logs XTRIM 불가(선언한 키)"   "${K[@]}" evalsha "$XTRIM_SHA" 1 wakeline:logs
LOGS_READ_SHA="$(cli "${D[@]}" script load "return redis.call('XREVRANGE', 'wakeline:logs', '+', '-', 'COUNT', 1)")"
LOGS_TRIM_SHA="$(cli "${D[@]}" script load "return redis.call('XTRIM', 'wakeline:logs', 'MAXLEN', 0)")"
LOGS_DEL_SHA="$(cli "${D[@]}" script load "return redis.call('DEL', 'wakeline:logs')")"
denied "EVALSHA 안 XREVRANGE wakeline:logs(선언 안 한 키 — 스크립트 안 검사)" "${K[@]}" evalsha "$LOGS_READ_SHA" 0
denied "EVALSHA 안 XTRIM wakeline:logs(선언 안 한 키 — 스크립트 안 검사)"     "${K[@]}" evalsha "$LOGS_TRIM_SHA" 0
denied "EVALSHA 안 DEL wakeline:logs(선언 안 한 키 — 스크립트 안 검사)"       "${K[@]}" evalsha "$LOGS_DEL_SHA" 0
ok "로그 스트림은 그대로(관리자로 확인)" "^[1-9][0-9]*$" "${D[@]}" xlen wakeline:logs
denied "비슷한 이름 wakeline:logs:x"            "${K[@]}" xadd wakeline:logs:x '*' e x
denied "브라우저 오류 스트림 XADD(api 전용, §G2)"  "${K[@]}" xadd wakeline:logs:client maxlen '~' 1000 '*' e x
denied "브라우저 오류 스트림 XREVRANGE(§G2)"       "${K[@]}" xrevrange wakeline:logs:client + - count 1
denied "비슷한 이름 wakeline:logsx"             "${K[@]}" xadd wakeline:logsx '*' e x
denied "DLQ 읽기 wakeline:dlq(XREVRANGE)"       "${K[@]}" xrevrange wakeline:dlq + - count 1
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
denied "CLIENT TRACKING BCAST(키 이름 = 세션 ID 열람)" "${K[@]}" client tracking on bcast
denied "CLIENT TRACKING(RESP3)"      "${K[@]}" -3 client tracking on bcast
denied "CLIENT CACHING"              "${K[@]}" client caching yes
# 수요 임대는 api 만 쓴다 — 수집기가 뚫려도 임의 지역·항공기 조회를 스스로 만들 수 없다(호출 상한 우회 방지)
denied "ZADD wakeline:demand:hot"          "${K[@]}" zadd wakeline:demand:hot 9999999999999 0.0:0.0:250
denied "ZADD wakeline:demand:focus"        "${K[@]}" zadd wakeline:demand:focus 9999999999999 abcdef
denied "ZREMRANGEBYSCORE 임대 삭제"          "${K[@]}" zremrangebyscore wakeline:demand:focus -inf +inf
denied "HSET wakeline:demand:hot:meta"     "${K[@]}" hset wakeline:demand:hot:meta x y
denied "HDEL wakeline:demand:focus:meta"   "${K[@]}" hdel wakeline:demand:focus:meta 71c011
denied "DEL wakeline:demand:hot"           "${K[@]}" del wakeline:demand:hot
denied "허용 목록 밖 wakeline:demand:*"      "${K[@]}" hgetall wakeline:demand:other
denied "선박 스트림 wakeline:ships"          "${K[@]}" xadd wakeline:ships '*' payload x
denied "AIS 상태 wakeline:ais:status"       "${K[@]}" hset wakeline:ais:status connected 1
denied "노선 캐시와 비슷한 이름 wakeline:routes" "${K[@]}" set wakeline:routes x

echo "[wakeline_ais — 허용]"
ok "PING"                                PONG           "${S[@]}" ping
ok "INFO"                                redis_version  "${S[@]}" info server
ok "CLIENT SETINFO(redis-py)"            OK             "${S[@]}" client setinfo lib-name redis-py
ok "HELLO 3 AUTH(redis-py 8 은 RESP3 로 접속)" "proto"   "${S[@]}" hello 3 auth wakeline_ais "$AIS_PW"
ok "XADD wakeline:ships MAXLEN ~ 200"    "^[0-9]+-[0-9]+$" "${S[@]}" xadd wakeline:ships maxlen '~' 200 '*' kind ships payload x
ok "XADD wakeline:ships(ais_gap)"        "^[0-9]+-[0-9]+$" "${S[@]}" xadd wakeline:ships maxlen '~' 200 '*' kind ais_gap payload x
ok "HSET wakeline:ais:status"            "^[0-9]+$"     "${S[@]}" hset wakeline:ais:status connected 1 last_msg_at 2026-01-01T00:00:00Z gap_open_since ''
ok "HGETALL wakeline:ais:status(health)" "last_msg_at"  "${S[@]}" hgetall wakeline:ais:status
ok "HSET wakeline:ais:*(다른 필드)"       "^[0-9]+$"     "${S[@]}" hset wakeline:ais:stats msgs 1
ok "HGET wakeline:settings ais_bboxes(읽기)" ""         "${S[@]}" hget wakeline:settings ais_bboxes
ok "HGETALL wakeline:settings(읽기)"     "region_poll_s" "${S[@]}" hgetall wakeline:settings
ok "XADD wakeline:logs MAXLEN ~ 3000(로그 싱크)" "^[0-9]+-[0-9]+$" "${S[@]}" xadd wakeline:logs maxlen '~' 3000 '*' e "$(log_event ais)"

echo "[wakeline_ais — 거부]"
# R-86: 허용 목록(XADD·HSET·HGET·HGETALL) — 선박 스트림을 지우거나 덮어쓰거나 만료시킬 수 없다
denied "DEL 스트림 wakeline:ships"               "${S[@]}" del wakeline:ships
denied "UNLINK 스트림 wakeline:ships"            "${S[@]}" unlink wakeline:ships
denied "RENAME 스트림 wakeline:ships"            "${S[@]}" rename wakeline:ships wakeline:ais:x
denied "XTRIM 스트림 MAXLEN 0"                   "${S[@]}" xtrim wakeline:ships maxlen 0
denied "SET 으로 스트림 덮어쓰기"                  "${S[@]}" set wakeline:ships x
denied "EXPIRE 스트림"                           "${S[@]}" expire wakeline:ships 1
denied "DEL wakeline:ais:status"               "${S[@]}" del wakeline:ais:status
denied "SELECT 1"                              "${S[@]}" select 1
denied "FUNCTION FLUSH"                        "${S[@]}" function flush
denied "SCRIPT FLUSH"                          "${S[@]}" script flush
denied "EVAL"                                  "${S[@]}" eval "return 1" 0
denied "설정 쓰기 wakeline:settings ais_bboxes" "${S[@]}" hset wakeline:settings ais_bboxes '-90,-180,90,180'
denied "설정 삭제 wakeline:settings"     "${S[@]}" del wakeline:settings
denied "항공기 스트림 wakeline:aircraft"   "${S[@]}" xadd wakeline:aircraft '*' payload x
denied "SIGMET 스트림 wakeline:sigmet"     "${S[@]}" xadd wakeline:sigmet '*' payload x
denied "수집기 heartbeat wakeline:collector" "${S[@]}" hset wakeline:collector region_at x
denied "공급자 상태 wakeline:provider:*"    "${S[@]}" hset wakeline:provider:adsb_fi disabled 1
denied "예산 budget:*"                    "${S[@]}" hgetall budget:adsb_lol:20260101
denied "수요 임대 읽기 wakeline:demand:hot"  "${S[@]}" zrangebyscore wakeline:demand:hot 0 +inf
denied "수요 상태 wakeline:demand:status"   "${S[@]}" hset wakeline:demand:status x y
denied "노선 캐시 쓰기 wakeline:route:*"      "${S[@]}" set wakeline:route:ZZX123 x ex 1800
denied "노선 캐시 읽기 wakeline:route:*"      "${S[@]}" get wakeline:route:ZZX123
denied "노선 캐시 확인 EXISTS"               "${S[@]}" exists wakeline:route:ZZX123
denied "세션 읽기 wakeline:session:*"       "${S[@]}" hgetall wakeline:session:sessions:t
denied "세션 위조 wakeline:session:*"       "${S[@]}" hset wakeline:session:sessions:forged sessionAttr:SPRING_SECURITY_CONTEXT x
denied "요청 제한 rl:*"                    "${S[@]}" del rl:public:1.2.3.4:1
denied "DLQ wakeline:dlq"                  "${S[@]}" xadd wakeline:dlq '*' x y
# 계약 v5 §C3: 로그 스트림은 XADD 만(쓰기 전용)
denied "XREVRANGE wakeline:logs(읽기)"       "${S[@]}" xrevrange wakeline:logs + - count 1
denied "DEL wakeline:logs"                   "${S[@]}" del wakeline:logs
denied "UNLINK wakeline:logs"                "${S[@]}" unlink wakeline:logs
denied "RENAME wakeline:logs"                "${S[@]}" rename wakeline:logs wakeline:ais:x
denied "XTRIM wakeline:logs MAXLEN 0"        "${S[@]}" xtrim wakeline:logs maxlen 0
denied "XDEL wakeline:logs"                  "${S[@]}" xdel wakeline:logs 0-1
denied "SET 으로 wakeline:logs 덮어쓰기"       "${S[@]}" set wakeline:logs x
denied "EXPIRE wakeline:logs"                "${S[@]}" expire wakeline:logs 1
denied "비슷한 이름 wakeline:logs:x"          "${S[@]}" xadd wakeline:logs:x '*' e x
denied "브라우저 오류 스트림 XADD(api 전용, §G2)" "${S[@]}" xadd wakeline:logs:client '*' e x
denied "XREADGROUP wakeline:ships"          "${S[@]}" xreadgroup group api c9 count 1 streams wakeline:ships '>'
denied "XACK wakeline:ships"                "${S[@]}" xack wakeline:ships api 0-1
denied "XGROUP DESTROY wakeline:ships"      "${S[@]}" xgroup destroy wakeline:ships api
denied "XAUTOCLAIM wakeline:ships"          "${S[@]}" xautoclaim wakeline:ships api c9 0 0-0
denied "스크립트로 세션 접근"                "${S[@]}" eval "return redis.call('HGETALL', 'wakeline:session:sessions:t')" 0
denied "스크립트로 선언한 남의 키"           "${S[@]}" eval "return redis.call('XADD', KEYS[1], '*', 'x', 'y')" 1 wakeline:aircraft
denied "KEYS *"                           "${S[@]}" keys '*'
denied "SCAN"                             "${S[@]}" scan 0
denied "RANDOMKEY"                        "${S[@]}" randomkey
denied "FLUSHALL"                         "${S[@]}" flushall
denied "CONFIG SET"                       "${S[@]}" config set maxmemory 0
denied "MONITOR"                          "${S[@]}" monitor
denied "CLIENT LIST"                      "${S[@]}" client list
denied "ACL SETUSER"                      "${S[@]}" acl setuser wakeline_ais '~*'
denied "SUBSCRIBE"                        "${S[@]}" subscribe ch
denied "CLIENT TRACKING BCAST(키 이름 = 세션 ID 열람)" "${S[@]}" client tracking on bcast
denied "CLIENT TRACKING(RESP3)"           "${S[@]}" -3 client tracking on bcast
denied "CLIENT TRACKING OPTIN"            "${S[@]}" client tracking on optin
denied "CLIENT CACHING"                   "${S[@]}" client caching yes
denied "다른 키"                           "${S[@]}" set other:key x

echo "[wakeline_api — 로그 조회(계약 v5 §C4): 세 서비스가 실은 항목을 읽는다]"
for svc in api collector ais; do
  ok "XREVRANGE wakeline:logs 에 $svc 항목" "\"service\":\"$svc\"" "${A[@]}" xrevrange wakeline:logs + - count 50
done
ok "로그 스트림 항목 수(관리자로 확인)" "^[3-9]$|^[1-9][0-9]+$" "${D[@]}" xlen wakeline:logs
ok "XREVRANGE wakeline:logs:client 에 web-client 항목(§G2)" '"service":"web-client"' "${A[@]}" xrevrange wakeline:logs:client + - count 5
ok "브라우저 오류 스트림 항목 수 1(수집기 · ais 는 못 실었다)" "^1$" "${D[@]}" xlen wakeline:logs:client

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

echo "[REDIS_AIS_PASSWORD 없음 — wakeline_ais 를 만들지 않는다(빈 비밀번호로 열리지 않음)]"
start_redis "$C2"
out="$(docker exec "$C2" redis-cli --no-auth-warning --user wakeline_ais --pass '' ping 2>&1 || true)"
if grep -Eq "WRONGPASS|invalid" <<<"$out"; then passes=$((passes+1)); echo "  ok    빈 비밀번호로 wakeline_ais 로그인 거부"; else fails=$((fails+1)); echo "  FAIL  wakeline_ais 빈 비밀번호 → $out"; fi
out="$(docker exec -e REDISCLI_AUTH="$ADMIN_PW" "$C2" redis-cli --no-auth-warning acl getuser wakeline_ais 2>&1 || true)"
if [ -z "$(tr -d '[:space:]' <<<"$out")" ] || grep -q "nil" <<<"$out"; then passes=$((passes+1)); echo "  ok    ACL 에 wakeline_ais 없음"; else fails=$((fails+1)); echo "  FAIL  wakeline_ais 가 만들어짐 → $out"; fi
# 로그를 먼저 받아 둔다 — `docker logs | grep -q` 는 grep 이 먼저 끝나면 SIGPIPE 로 파이프 전체가 실패한다(pipefail)
logs2="$(docker logs "$C2" 2>&1 || true)"
if grep -q "REDIS_AIS_PASSWORD 가 비어" <<<"$logs2"; then passes=$((passes+1)); echo "  ok    기동 로그에 사유 표시"; else fails=$((fails+1)); echo "  FAIL  기동 로그에 사유 없음"; fi
TARGET="$C2"
ok "나머지 사용자는 그대로(wakeline_api)"       PONG wakeline_api "$API_PW" ping
ok "나머지 사용자는 그대로(wakeline_collector)" PONG wakeline_collector "$COL_PW" ping
unset TARGET

echo "redis ACL test: $passes passed, $fails failed"
[ "$fails" -eq 0 ]
