#!/usr/bin/env bash
# PostgreSQL 복원(R-13) — tools/db-backup.sh 가 만든 pg_dump 사용자 지정 형식 파일을 '빈' wakeline DB 에 넣는다.
#
#   tools/db-restore.sh --file backups/X.dump --confirm wakeline                 개발 스택(make restore f=… confirm=wakeline)
#   WAKELINE_PROJECT=wakeline-e2e tools/db-restore.sh --file … --confirm wakeline-e2e
#   tools/db-restore.sh --container NAME --file … --confirm NAME                 임의 컨테이너(infra/tests/db_backup_test.sh)
#
# 안전장치 — 하나라도 어기면 아무것도 바꾸지 않고 멈춘다:
#   1) --confirm 값이 대상 이름(compose 프로젝트 또는 --container 이름)과 같아야 한다
#   2) (프로젝트 모드) DB 에 쓰는 컨테이너(api·collector·ais·migrate)가 멈춰 있어야 한다
#   3) 대상 wakeline DB 에 확장(PostGIS) 소유가 아닌 표·뷰·시퀀스가 하나도 없어야 한다 — 새 볼륨에서 initdb 가 만든 빈 DB 에만 복원한다(덮어쓰기 없음)
#   4) 파일이 pg_restore --list 로 읽혀야 한다
# 복원은 한 트랜잭션(--single-transaction --exit-on-error)이라 중간에 실패하면 빈 DB 그대로 남는다.
# 역할(wakeline_migrator·api·collector)과 비밀번호는 새 볼륨의 initdb(infra/db/init/01-roles.sh — 지금 .env 값)가 만든다. 덤프에는 역할이 없고 소유자·권한만 있다.
# 복원 뒤 `make up`: migrate 가 백업 이후 추가된 마이그레이션만 적용한다(flyway_schema_history 도 복원된다). 비밀번호를 쓰거나 출력하지 않는다(로컬 소켓).
set -euo pipefail
FILE=""; CONFIRM=""; CID=""; NAME=""; PROJECT_MODE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --file) FILE="${2-}"; shift 2 ;;
    --confirm) CONFIRM="${2-}"; shift 2 ;;
    --container) CID="${2:?--container NAME}"; NAME="$2"; shift 2 ;;
    *) echo "usage: $0 --file BACKUP.dump --confirm TARGET [--container NAME]" >&2; exit 2 ;;
  esac
done
if [ -z "$CID" ]; then
  PROJECT_MODE=1
  NAME="${WAKELINE_PROJECT:-wakeline}"
fi
refuse() { echo "restore refused: $*" >&2; exit 1; }

[ -n "$FILE" ] || refuse "복원할 파일이 없습니다 (make restore f=backups/<파일>.dump confirm=$NAME)"
[ -f "$FILE" ] && [ -r "$FILE" ] || refuse "파일을 읽을 수 없습니다: $FILE"
[ "$CONFIRM" = "$NAME" ] || refuse "확인 문구가 필요합니다 — 대상 이름을 그대로 적으세요: confirm=$NAME (받은 값: '${CONFIRM}')"

if [ "$PROJECT_MODE" = 1 ]; then
  for s in api collector ais migrate; do
    running="$(docker ps -q --filter "label=com.docker.compose.project=$NAME" --filter "label=com.docker.compose.service=$s")"
    [ -z "$running" ] || refuse "$s 가 실행 중입니다 — 먼저 멈추세요: tools/dc stop edge web api collector ais (README '백업·복원')"
  done
  CID="$(docker ps -q --filter "label=com.docker.compose.project=$NAME" --filter "label=com.docker.compose.service=db")"
  [ -n "$CID" ] || refuse "db 컨테이너가 없습니다 — tools/dc up -d --wait db 로 db 만 띄우세요"
  [ "$(wc -l <<<"$CID")" -eq 1 ] || refuse "db 컨테이너가 여러 개입니다"
fi

in_db() { docker exec -i -u postgres "$CID" "$@"; }
docker exec "$CID" pg_isready -q -U postgres -d wakeline || refuse "대상 db 가 준비되지 않았습니다(wakeline DB 없음?)"
in_db pg_restore --list < "$FILE" > /dev/null 2>&1 || refuse "pg_dump 사용자 지정 형식 파일이 아닙니다: $FILE"
existing="$(in_db psql -X -v ON_ERROR_STOP=1 -U postgres -d wakeline -Atc "
  SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')")" \
  || refuse "대상 DB 를 확인하지 못했습니다"
[ "$existing" = 0 ] || refuse "대상 wakeline DB 가 비어 있지 않습니다(표·뷰·시퀀스 $existing개) — 기존 데이터를 덮어쓰지 않습니다. 새 볼륨에만 복원합니다(README '백업·복원')"

echo "restoring $FILE → $NAME (한 트랜잭션)…"
in_db pg_restore --dbname=wakeline --no-password --single-transaction --exit-on-error < "$FILE"
in_db psql -X -q -v ON_ERROR_STOP=1 -U postgres -d wakeline -c "ANALYZE"
n="$(in_db psql -X -U postgres -d wakeline -Atc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'spatial_ref_sys'")"
v="$(in_db psql -X -U postgres -d wakeline -Atc "SELECT version FROM flyway_schema_history WHERE success ORDER BY installed_rank DESC LIMIT 1" 2>/dev/null || true)"
echo "restored: 표 ${n}개, 마지막 마이그레이션 ${v:+V}${v:-—} — 다음: make up (migrate 가 이후 마이그레이션을 적용)"
