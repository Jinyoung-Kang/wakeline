#!/bin/sh
# Wakeline redis 기동 스크립트 — 서비스별 ACL 사용자를 만들고 redis-server 를 직접 실행한다(계약 §6 · 계약 v2 §C · 계약 v5 §C3).
#
#   default          관리용(헬스체크·운영 redis-cli). 비밀번호 REDIS_PASSWORD. api·collector·ais 는 쓰지 않는다.
#   wakeline_api        비밀번호 REDIS_API_PASSWORD.        키 wakeline:* · rl:*  (스트림 소비·DLQ·세션·설정·요청 제한)
#   wakeline_collector  비밀번호 REDIS_COLLECTOR_PASSWORD.  수집기가 실제로 쓰는 키만 — 세션(wakeline:session:*)·요청 제한(rl:*)·DLQ 는 못 건드린다.
#                    wakeline:settings 는 읽기 전용(%R~), 소비자 그룹 명령(XGROUP·XACK 등)·키 이름 열람(SCAN·RANDOMKEY)은 없음. 수집기가 뚫려도 운영 세션 위조·설정 변경·제한 초기화가 불가능하다.
#                    수요 임대(ADR-013, 계약 v2 §A1·§C): wakeline:demand:{hot,focus}(+:meta)는 읽기 전용 — 임대는 api 만 만든다. 상태 wakeline:demand:status 만 쓴다.
#                    노선 캐시(ADR-016, 계약 v4 §A): wakeline:route:{CALLSIGN} 을 SET EX 로 쓰고 EXISTS 로 확인한다(api 는 wakeline:* 로 읽는다). ais 에는 주지 않는다.
#   wakeline_ais        비밀번호 REDIS_AIS_PASSWORD(ADR-014, 계약 v2 §C). 선박 스트림 wakeline:ships 와 wakeline:ais:* 만 쓰고 wakeline:settings 는 읽기 전용.
#                    항공기 스트림·예산·수요 임대·세션에는 접근하지 못한다. 소비자 그룹 명령·키 이름 열람 금지는 수집기와 같다.
#   시스템 로그(ADR-018, 계약 v5 §C3): collector·ais 는 wakeline:logs 에 XADD(MAXLEN ~ 3000)만 한다 — 키 규칙은 쓰기 전용 %W~.
#                    ~(읽기·쓰기)로 주면 수집기의 XREVRANGE(루트 규칙이라 모든 키에 적용)로 api · web-client 로그를 읽을 수 있다 — 조회는 운영 세션 전용.
#                    DEL·XTRIM·RENAME·EXPIRE 는 허용 목록에 없어 이 키에도 닿지 않는다. api 는 wakeline:* 로 싣고 읽는다.
#                    여러 건을 한 번에 보낼 때는 pipeline(transaction=False) — MULTI·EXEC 는 허용 목록에 없다(demand · kma_radar 와 같다).
#                    남는 위험(ACL 은 명령 인자를 보지 않는다): XADD … MAXLEN 0 / MINID 로 스트림을 비울 수 있고(api 가 실은 항목 포함),
#                    service 를 다른 이름으로 적어 실을 수 있다 — 읽는 쪽(api)은 스키마 검증·가림만 하고 출처를 증명하지 못한다.
#                    다른 생산자 스트림(wakeline:aircraft · wakeline:ships …)의 XADD 트리밍도 같은 한계다.
#                    REDIS_AIS_PASSWORD 가 비어 있으면 이 사용자를 만들지 않는다(빈 비밀번호로 열린 사용자를 만들지 않기 위해).
#                    compose 는 ${REDIS_AIS_PASSWORD:?} 로 값이 없으면 기동을 거부한다 — 비어 있는 경우는 이 스크립트를 쓰는 api 통합 테스트(ItStack)뿐이다.
#
# api 명령 권한(COMMON): +@all -@dangerous (KEYS·FLUSHALL·CONFIG·MONITOR·REPLICAOF·MIGRATE·RESTORE·DEBUG·SHUTDOWN·ACL 변경·CLIENT KILL 등 제외)
#   + 클라이언트가 접속·상태 확인에 쓰는 것만 다시 허용: INFO(Spring 헬스 인디케이터), PING, CLIENT SETINFO/SETNAME/ID(Lettuce·redis-py 접속 시).
# 생산자(collector·ais) 명령 권한(R-86 · ADR-017 §4): 허용 목록 — -@all 에서 시작해 코드가 실제로 쓰는 명령만 더한다.
#   거부 목록(+@all -@dangerous)이면 DEL·UNLINK·RENAME·XTRIM·EXPIRE·SET 덮어쓰기·*STORE 로 스트림을 지워 api 소비자 그룹과 PEL 을 없앨 수 있었다.
#   키를 지우거나 덮어쓰거나 만료시키는 명령(SET·DEL·EXPIRE)은 셀렉터로 그 명령을 쓰는 키에만 준다 — 스트림·해시에는 닿지 않는다.
#   스크립트 안의 redis.call 도 같은 규칙을 따른다(예산 Lua 의 EXPIRE 는 budget:* 에서만). 목록은 infra/tests/redis_acl_test.sh 가 확정한다.
#   pub/sub 채널 권한 없음(resetchannels) — 서비스 클라이언트(api·collector·ais) 모두 pub/sub 를 쓰지 않는다.
#   CLIENT TRACKING·CACHING 금지(계약 v3 §D): 출시된 Redis 8.x 의 BCAST 무효화 알림은 키 권한을 보지 않고 바뀐 키 *이름*을 보낸다 —
#   세션 키 이름이 곧 세션 ID 라서 SCAN·RANDOMKEY 와 같은 이유로 막는다. 서비스 클라이언트는 클라이언트 측 캐시를 쓰지 않는다.
#
# 비밀번호는 compose 파일·명령행(docker inspect 의 Cmd)에 쓰지 않고 이 컨테이너의 환경변수로만 받는다.
# redis-server 는 기동 직후 프로세스 제목을 바꿔(set-proc-title) argv 가 ps 에 남지 않는다.
# 공식 엔트리포인트를 거치지 않는다: 이 컨테이너는 처음부터 redis(999) 사용자로 돌므로 권한 강하가 필요 없고,
# 이미지에 들어 있는 모듈(검색·JSON·시계열·블룸)은 Wakeline 가 쓰지 않으므로 싣지 않는다(공격 면 축소).
set -eu
set -f   # 키 패턴의 * 가 셸 글롭으로 펼쳐지지 않게

: "${REDIS_PASSWORD:?REDIS_PASSWORD 가 비어 있습니다 — make init}"
: "${REDIS_API_PASSWORD:?REDIS_API_PASSWORD 가 비어 있습니다 — make init}"
: "${REDIS_COLLECTOR_PASSWORD:?REDIS_COLLECTOR_PASSWORD 가 비어 있습니다 — make init}"

COMMON='resetchannels +@all -@dangerous +info +ping +client|setinfo +client|setname +client|id -client|tracking -client|caching'

API_KEYS='~wakeline:* ~rl:*'
COLLECTOR_KEYS='~wakeline:aircraft ~wakeline:sigmet ~wakeline:radar ~wakeline:events ~wakeline:collector ~wakeline:active ~wakeline:provider:* ~wakeline:radar_kr:* %R~wakeline:settings ~budget:*'
# 수요 임대는 읽기만(api 가 유일한 작성자), 조회 상태는 쓰기 — 계약 v2 §C 의 목록 그대로(와일드카드로 넓히지 않는다)
COLLECTOR_KEYS="$COLLECTOR_KEYS %R~wakeline:demand:hot %R~wakeline:demand:focus %R~wakeline:demand:hot:meta %R~wakeline:demand:focus:meta ~wakeline:demand:status"
# 노선 캐시(계약 v4 §A): 수집기가 유일한 작성자(adsbdb 조회 결과, TTL 만 — 약관상 다른 곳에 저장하지 않는다)
COLLECTOR_KEYS="$COLLECTOR_KEYS ~wakeline:route:*"
# 시스템 로그(계약 v5 §C3): 쓰기 전용 — XADD 만, 다른 서비스 로그는 읽지 못한다
COLLECTOR_KEYS="$COLLECTOR_KEYS %W~wakeline:logs"
# 생산자 공통: 접속(redis-py 8 은 HELLO 3 AUTH 로 붙는다)·헬스 체크(PING, health_check_interval)·클라이언트 정보만.
# 소비자 그룹 명령(XGROUP·XREADGROUP·XACK …)·키 이름 열람(SCAN·RANDOMKEY·KEYS)·CLIENT TRACKING 은 목록에 없어서 거부된다.
PRODUCER_BASE='resetchannels -@all +hello +ping +info +client|setinfo +client|setname +client|id'
# 수집기가 쓰는 명령(wakeline_collector 코드 전체): 스트림 XADD(MAXLEN ~ · 로그 싱크 포함)·XREVRANGE, 해시 HSET·HGET·HGETALL·HMGET·HINCRBY·HDEL·HKEYS,
# EXISTS·GET, 임대 ZRANGEBYSCORE, 예산 Lua SCRIPT LOAD + EVALSHA
COLLECTOR_CMDS='+xadd +xrevrange +hset +hget +hgetall +hmget +hincrby +hdel +hkeys +exists +get +zrangebyscore +script|load +evalsha'
# 셀렉터(괄호 한 덩어리 = 인자 하나): SET 은 문자열 키(노선 캐시 SET EX · 레이더 목록·이미지)에만, DEL 은 레이더 목록·이미지에만, EXPIRE 는 예산 키(Lua)에만
COLLECTOR_SEL_SET='(~wakeline:route:* ~wakeline:radar_kr:frames ~wakeline:radar_kr:frame:* +set)'
COLLECTOR_SEL_DEL='(~wakeline:radar_kr:frames ~wakeline:radar_kr:frame:* +del)'
COLLECTOR_SEL_EXPIRE='(~budget:* +expire)'

AIS_KEYS='~wakeline:ships ~wakeline:ais:* %R~wakeline:settings %W~wakeline:logs'
# ais 가 쓰는 명령: 선박 스트림 XADD, 로그 스트림 XADD(쓰기 전용), 상태 해시 HSET·HGETALL, 설정 HGET·HGETALL — 지우거나 덮어쓰는 명령은 없다
AIS_CMDS='+xadd +hset +hget +hgetall'

umask 0077
# shellcheck disable=SC2086 # 규칙 문자열은 의도적으로 단어 분리한다(글롭은 set -f 로 꺼 두었다)
if [ -n "${REDIS_AIS_PASSWORD:-}" ]; then
  set -- --user wakeline_ais on ">$REDIS_AIS_PASSWORD" $AIS_KEYS $PRODUCER_BASE $AIS_CMDS "$@"
else
  echo "start.sh: REDIS_AIS_PASSWORD 가 비어 있어 wakeline_ais 사용자를 만들지 않습니다(선박 수신 불가)" >&2
fi
# shellcheck disable=SC2086
exec redis-server "${REDIS_CONF:-/etc/redis/redis.conf}" \
  --requirepass "$REDIS_PASSWORD" \
  --user wakeline_api on ">$REDIS_API_PASSWORD" $API_KEYS $COMMON \
  --user wakeline_collector on ">$REDIS_COLLECTOR_PASSWORD" $COLLECTOR_KEYS $PRODUCER_BASE $COLLECTOR_CMDS \
    "$COLLECTOR_SEL_SET" "$COLLECTOR_SEL_DEL" "$COLLECTOR_SEL_EXPIRE" \
  "$@"
