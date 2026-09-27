#!/usr/bin/env bash
# SEC-R3 일회성 적용: 이미 초기화된 db 볼륨의 pg_hba.conf 에 "postgres 슈퍼유저는 로컬 소켓만" 규칙을 넣는다.
# (infra/db/init/02-superuser-local-only.sh 는 새 데이터 디렉터리에서만 돈다 — 기존 개발 볼륨에는 이 스크립트로 한 번 적용한다.)
#
#   tools/db-superuser-local-only.sh                     # 개발 스택(compose 프로젝트 wakeline)의 db 컨테이너
#   WAKELINE_PROJECT=wakeline-e2e tools/db-superuser-local-only.sh
#   tools/db-superuser-local-only.sh --container <이름>  # 임의 컨테이너(infra/tests/db_hardening_test.sh 가 쓴다)
#
# 같은 파일(infra/db/init/02-...)을 컨테이너 안에서 postgres 사용자로 실행한다 — 규칙·검증·원복 로직이 한 곳에만 있다. 멱등.
# 재시작 불필요(pg_reload_conf). 비밀번호를 읽거나 출력하지 않는다. compose 파일을 해석하지 않으므로(.env 에 새 변수가 없어도) 동작한다.
# 되돌리기: 컨테이너 안 $PGDATA/pg_hba.conf 맨 앞의 표시 줄(# wakeline: superuser local-socket only …)과 reject 두 줄을 지우고
#   psql -U postgres -c 'SELECT pg_reload_conf()'.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/infra/db/init/02-superuser-local-only.sh"

if [ "${1:-}" = "--container" ]; then
  [ -n "${2:-}" ] || { echo "usage: $0 [--container NAME]" >&2; exit 2; }
  CID="$2"
else
  PROJECT="${WAKELINE_PROJECT:-wakeline}"
  CID="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=db")"
  [ -n "$CID" ] || { echo "db container of compose project '$PROJECT' is not running" >&2; exit 1; }
  [ "$(wc -l <<<"$CID")" -eq 1 ] || { echo "more than one db container in project '$PROJECT'" >&2; exit 1; }
fi

in_db() { docker exec -u postgres "$CID" "$@"; }

# 스크립트는 stdin 으로 넘긴다 — 컨테이너에 마운트된 init 디렉터리가 이 체크아웃과 달라도 같은 내용을 실행한다
docker exec -i -u postgres "$CID" env WAKELINE_PG_SUPERUSER_TCP=reject sh -s < "$SCRIPT"

# 확인 1: 규칙이 해석된 결과(pg_hba_file_rules)의 맨 앞이 슈퍼유저 reject 인지
first="$(in_db psql -X -U postgres -d postgres -Atc "SELECT database[1] || ' ' || user_name[1] || ' ' || auth_method FROM pg_hba_file_rules WHERE type = 'host' ORDER BY rule_number LIMIT 1")"
[ "$first" = "all postgres reject" ] || { echo "unexpected first host rule: $first" >&2; exit 1; }
# 확인 2: TCP 로 슈퍼유저 접속이 pg_hba 에서 거부되는지(비밀번호를 묻기 전에 거부된다)
out="$(in_db psql -X -h 127.0.0.1 -U postgres -d postgres -w -Atc 'SELECT 1' 2>&1 || true)"
grep -q 'rejects connection' <<<"$out" || { echo "superuser TCP login was not rejected: $out" >&2; exit 1; }
# 확인 3: 로컬 소켓은 그대로(헬스체크·운영 psql)
[ "$(in_db psql -X -U postgres -d postgres -Atc 'SELECT 1')" = 1 ] || { echo "local socket login failed" >&2; exit 1; }
echo "ok: superuser is local-socket only (TCP rejected by pg_hba, socket works) — container $CID"
