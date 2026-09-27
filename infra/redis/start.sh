#!/bin/sh
# Wakeline redis 기동 스크립트 — 서비스별 ACL 사용자를 만들고 redis-server 를 직접 실행한다(계약 §6).
#
#   default          관리용(헬스체크·운영 redis-cli). 비밀번호 REDIS_PASSWORD. api·collector 는 쓰지 않는다.
#   wakeline_api        비밀번호 REDIS_API_PASSWORD.        키 wakeline:* · rl:*  (스트림 소비·DLQ·세션·설정·요청 제한)
#   wakeline_collector  비밀번호 REDIS_COLLECTOR_PASSWORD.  수집기가 실제로 쓰는 키만 — 세션(wakeline:session:*)·요청 제한(rl:*)·DLQ 는 못 건드린다.
#                    wakeline:settings 는 읽기 전용(%R~), 소비자 그룹 명령(XGROUP·XACK 등)·키 이름 열람(SCAN·RANDOMKEY)은 없음. 수집기가 뚫려도 운영 세션 위조·설정 변경·제한 초기화가 불가능하다.
#
# 공통 명령 권한: +@all -@dangerous (KEYS·FLUSHALL·CONFIG·MONITOR·REPLICAOF·MIGRATE·RESTORE·DEBUG·SHUTDOWN·ACL 변경·CLIENT KILL 등 제외)
#   + 클라이언트가 접속·상태 확인에 쓰는 것만 다시 허용: INFO(Spring 헬스 인디케이터), PING, CLIENT SETINFO/SETNAME/ID(Lettuce·redis-py 접속 시).
#   pub/sub 채널 권한 없음(resetchannels) — 두 클라이언트 모두 pub/sub 를 쓰지 않는다.
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

COMMON='resetchannels +@all -@dangerous +info +ping +client|setinfo +client|setname +client|id'

API_KEYS='~wakeline:* ~rl:*'
COLLECTOR_KEYS='~wakeline:aircraft ~wakeline:sigmet ~wakeline:radar ~wakeline:events ~wakeline:collector ~wakeline:active ~wakeline:provider:* ~wakeline:radar_kr:* %R~wakeline:settings ~budget:*'
# 수집기는 스트림 생산자다 — api 의 소비자 그룹을 지우거나 대기 목록(PEL)을 조작하는 명령은 필요 없다.
# SCAN·RANDOMKEY 는 키 권한과 무관하게 키 *이름*을 돌려준다: 세션 키 이름이 곧 세션 ID(쿠키 값)라서 수집기에서는 막는다.
COLLECTOR_DENY='-xgroup -xreadgroup -xack -xclaim -xautoclaim -xsetid -scan -randomkey'

umask 0077
# shellcheck disable=SC2086 # 규칙 문자열은 의도적으로 단어 분리한다(글롭은 set -f 로 꺼 두었다)
exec redis-server "${REDIS_CONF:-/etc/redis/redis.conf}" \
  --requirepass "$REDIS_PASSWORD" \
  --user wakeline_api on ">$REDIS_API_PASSWORD" $API_KEYS $COMMON \
  --user wakeline_collector on ">$REDIS_COLLECTOR_PASSWORD" $COLLECTOR_KEYS $COMMON $COLLECTOR_DENY \
  "$@"
