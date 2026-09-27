#!/bin/sh
# Wakeline redis 기동 스크립트 — 서비스별 ACL 사용자를 만들고 redis-server 를 직접 실행한다(계약 §6 · 계약 v2 §C).
#
#   default          관리용(헬스체크·운영 redis-cli). 비밀번호 REDIS_PASSWORD. api·collector·ais 는 쓰지 않는다.
#   wakeline_api        비밀번호 REDIS_API_PASSWORD.        키 wakeline:* · rl:*  (스트림 소비·DLQ·세션·설정·요청 제한)
#   wakeline_collector  비밀번호 REDIS_COLLECTOR_PASSWORD.  수집기가 실제로 쓰는 키만 — 세션(wakeline:session:*)·요청 제한(rl:*)·DLQ 는 못 건드린다.
#                    wakeline:settings 는 읽기 전용(%R~), 소비자 그룹 명령(XGROUP·XACK 등)·키 이름 열람(SCAN·RANDOMKEY)은 없음. 수집기가 뚫려도 운영 세션 위조·설정 변경·제한 초기화가 불가능하다.
#                    수요 임대(ADR-013, 계약 v2 §A1·§C): wakeline:demand:{hot,focus}(+:meta)는 읽기 전용 — 임대는 api 만 만든다. 상태 wakeline:demand:status 만 쓴다.
#   wakeline_ais        비밀번호 REDIS_AIS_PASSWORD(ADR-014, 계약 v2 §C). 선박 스트림 wakeline:ships 와 wakeline:ais:* 만 쓰고 wakeline:settings 는 읽기 전용.
#                    항공기 스트림·예산·수요 임대·세션에는 접근하지 못한다. 소비자 그룹 명령·키 이름 열람 금지는 수집기와 같다.
#                    REDIS_AIS_PASSWORD 가 비어 있으면 이 사용자를 만들지 않는다(빈 비밀번호로 열린 사용자를 만들지 않기 위해).
#                    compose 는 ${REDIS_AIS_PASSWORD:?} 로 값이 없으면 기동을 거부한다 — 비어 있는 경우는 이 스크립트를 쓰는 api 통합 테스트(ItStack)뿐이다.
#
# 공통 명령 권한: +@all -@dangerous (KEYS·FLUSHALL·CONFIG·MONITOR·REPLICAOF·MIGRATE·RESTORE·DEBUG·SHUTDOWN·ACL 변경·CLIENT KILL 등 제외)
#   + 클라이언트가 접속·상태 확인에 쓰는 것만 다시 허용: INFO(Spring 헬스 인디케이터), PING, CLIENT SETINFO/SETNAME/ID(Lettuce·redis-py 접속 시).
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
# 수집기는 스트림 생산자다 — api 의 소비자 그룹을 지우거나 대기 목록(PEL)을 조작하는 명령은 필요 없다.
# SCAN·RANDOMKEY 는 키 권한과 무관하게 키 *이름*을 돌려준다: 세션 키 이름이 곧 세션 ID(쿠키 값)라서 수집기에서는 막는다.
COLLECTOR_DENY='-xgroup -xreadgroup -xack -xclaim -xautoclaim -xsetid -scan -randomkey'

AIS_KEYS='~wakeline:ships ~wakeline:ais:* %R~wakeline:settings'
AIS_DENY="$COLLECTOR_DENY"

umask 0077
# shellcheck disable=SC2086 # 규칙 문자열은 의도적으로 단어 분리한다(글롭은 set -f 로 꺼 두었다)
if [ -n "${REDIS_AIS_PASSWORD:-}" ]; then
  set -- --user wakeline_ais on ">$REDIS_AIS_PASSWORD" $AIS_KEYS $COMMON $AIS_DENY "$@"
else
  echo "start.sh: REDIS_AIS_PASSWORD 가 비어 있어 wakeline_ais 사용자를 만들지 않습니다(선박 수신 불가)" >&2
fi
# shellcheck disable=SC2086
exec redis-server "${REDIS_CONF:-/etc/redis/redis.conf}" \
  --requirepass "$REDIS_PASSWORD" \
  --user wakeline_api on ">$REDIS_API_PASSWORD" $API_KEYS $COMMON \
  --user wakeline_collector on ">$REDIS_COLLECTOR_PASSWORD" $COLLECTOR_KEYS $COMMON $COLLECTOR_DENY \
  "$@"
