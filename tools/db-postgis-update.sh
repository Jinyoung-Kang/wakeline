#!/usr/bin/env bash
# R-63 · ADR-004 재결정 뒤 일회성: db 이미지의 PostGIS 부 버전이 오르면(예: 3.6.1 → 3.6.4) 확장의 SQL 쪽을 새 라이브러리에 맞춘다.
# 확장은 슈퍼유저(postgres)가 만들었으므로(infra/db/init/01-roles.sh) migrator 가 아니라 로컬 소켓 슈퍼유저로 ALTER EXTENSION … UPDATE 한다.
# 같은 3.6 안의 갱신만 한다(이미지가 3.6.* 로 묶여 있다 — infra/db/Dockerfile). 멱등: 이미 최신이면 NOTICE 만.
#
#   tools/db-postgis-update.sh                        # 개발 스택(compose 프로젝트 wakeline)의 db
#   WAKELINE_PROJECT=wakeline-e2e tools/db-postgis-update.sh
#   tools/db-postgis-update.sh --container <이름>     # 임의 컨테이너(시험)
#
# 비밀번호를 읽거나 출력하지 않는다. 되돌리기: 필요 없음(같은 부 버전 안의 갱신 — 이전 이미지로 돌아가면 그 라이브러리의 postgis_full_version()
# 이 'procs need upgrade' 를 알린다; 그때는 이전 이미지에서 같은 명령으로 다시 맞춘다).
set -euo pipefail

if [ "${1:-}" = "--container" ]; then
  [ -n "${2:-}" ] || { echo "usage: $0 [--container NAME]" >&2; exit 2; }
  CID="$2"
else
  PROJECT="${WAKELINE_PROJECT:-wakeline}"
  CID="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=db")"
  [ -n "$CID" ] || { echo "db container of compose project '$PROJECT' is not running" >&2; exit 1; }
  [ "$(wc -l <<<"$CID")" -eq 1 ] || { echo "more than one db container in project '$PROJECT'" >&2; exit 1; }
fi

q() { docker exec -u postgres "$CID" psql -X -v ON_ERROR_STOP=1 -U postgres -d wakeline -Atc "$1"; }

before="$(q "SELECT extversion FROM pg_extension WHERE extname = 'postgis'")"
avail="$(q "SELECT default_version FROM pg_available_extensions WHERE name = 'postgis'")"
[ -n "$before" ] || { echo "postgis extension is not installed in database wakeline" >&2; exit 1; }
case "$avail" in 3.6.*) ;; *) echo "refusing: the image offers postgis $avail — only 3.6.x updates are done here (ADR-004)" >&2; exit 1;; esac
echo "postgis: installed $before · image $avail"
if [ "$before" = "$avail" ]; then
  echo "already current — nothing to do"
else
  q "ALTER EXTENSION postgis UPDATE" >/dev/null
  echo "postgis: updated to $(q "SELECT extversion FROM pg_extension WHERE extname = 'postgis'")"
fi
q "SELECT postgis_full_version()" | grep -q "need upgrade" && { echo "postgis_full_version() still reports procs that need an upgrade" >&2; exit 1; }
echo "postgis_full_version(): $(q "SELECT postgis_lib_version()") — no pending upgrade"
