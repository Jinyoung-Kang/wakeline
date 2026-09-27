#!/bin/bash
# 일회성: 이름 변경(skywx → wakeline) 때 기존 개발 데이터를 새 프로젝트로 옮긴다. ADR-015 참조.
#  1) Docker 볼륨 skywx_* → wakeline_* 복사(원본은 남긴다)  2) DB 이름·역할 이름 변경(SCRAM 비밀번호 유지)
#  3) Redis 키 skywx:* → wakeline:* (세션은 폐기)          4) Flyway 체크섬 재정렬(마이그레이션 파일의 역할 이름이 바뀌었으므로)
set -euo pipefail
cd "$(dirname "$0")/.."
DC="docker compose -f infra/compose.yml --env-file .env"
for v in db_data redis_data raw; do
  if docker volume inspect "wakeline_$v" >/dev/null 2>&1; then echo "wakeline_$v exists — skip copy"; continue; fi
  # compose 라벨을 붙여 만든다 — 없으면 compose 가 매번 "not created by Docker Compose" 경고를 낸다
  docker volume create --label com.docker.compose.project=wakeline --label "com.docker.compose.volume=$v" \
    --label "com.docker.compose.version=$(docker compose version --short)" "wakeline_$v" >/dev/null
  docker run --rm -v "skywx_$v:/from:ro" -v "wakeline_$v:/to" alpine:3.22 sh -c 'cp -a /from/. /to/'
  echo "copied skywx_$v → wakeline_$v"
done
$DC up -d --wait db
docker compose -f infra/compose.yml --env-file .env exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = 'skywx') THEN EXECUTE 'ALTER DATABASE skywx RENAME TO wakeline'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skywx_migrator') THEN EXECUTE 'ALTER ROLE skywx_migrator RENAME TO wakeline_migrator'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skywx_api') THEN EXECUTE 'ALTER ROLE skywx_api RENAME TO wakeline_api'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skywx_collector') THEN EXECUTE 'ALTER ROLE skywx_collector RENAME TO wakeline_collector'; END IF;
END $$;
SELECT rolname, left(rolpassword, 13) AS pw_kind FROM pg_authid WHERE rolname LIKE 'wakeline_%' ORDER BY 1;
SQL
$DC up -d --wait redis
RP=$(grep '^REDIS_PASSWORD=' .env | cut -d= -f2-)
rc() { docker compose -f infra/compose.yml --env-file .env exec -T -e REDISCLI_AUTH="$RP" redis redis-cli --no-auth-warning "$@"; }
n=0
for k in $(rc --scan --pattern 'skywx:*'); do
  case "$k" in skywx:session:*) rc DEL "$k" >/dev/null ;; *) rc RENAME "$k" "wakeline:${k#skywx:}" >/dev/null; n=$((n+1)) ;; esac
done
echo "redis keys renamed: $n"; rc --scan --pattern 'spring:session:*' | xargs -r -n 50 sh -c 'true' >/dev/null
# Flyway: 파일 체크섬을 현재 파일에 맞춘다(스키마는 바꾸지 않음). 비밀번호는 환경변수로만 넘긴다.
MP=$(grep '^DB_MIGRATOR_PASSWORD=' .env | cut -d= -f2-)
docker run --rm --network wakeline_wakeline -e FLYWAY_PASSWORD="$MP" \
  -v "$PWD/apps/api/src/main/resources/db/migration:/flyway/sql:ro" flyway/flyway:11-alpine \
  -url=jdbc:postgresql://db:5432/wakeline -user=wakeline_migrator repair 2>&1 | grep -E "Repair|Successfully|ERROR" || true
