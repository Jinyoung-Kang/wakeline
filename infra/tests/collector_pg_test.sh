#!/usr/bin/env bash
# 수집기의 실제 PostgreSQL 대조 시험(collector-review F2 · PLAN C7) — 가짜 풀(tests/test_db_writer.py)로는 확인할 수 없는 것:
#   db.py 의 SQL(record_run 멱등 · marine_grid4 V14 · port_call · port_call_coverage V15)이 api 의 Flyway 스키마와 수집기 계정(wakeline_collector) 권한에서 도는지.
# 운영과 같은 db 이미지(compose 의 wakeline-db:local — make build · make infra-docker-test 가 만든다)로 버리는 컨테이너를 띄우고(127.0.0.1 임의 포트 ·
# 임의 비밀번호), infra/db/init 으로 역할 · PostGIS 를 만든 뒤 apps/api 의 마이그레이션(V*__*.sql)을 버전 순서대로 wakeline_migrator 로 적용한다 —
# api --migrate(Flyway)와 같은 계정 · 같은 순서 · 파일마다 한 트랜잭션(psql --single-transaction · ON_ERROR_STOP). Flyway 자리표시(${…})가 있는
# 파일이 생기면 그대로 적용할 수 없으므로 실패한다(검사한다). 개발 · E2E 스택은 건드리지 않는다.
# 시험 파일은 WAKELINE_TEST_PG_URL 이 없으면 건너뛰므로, 여기서는 건너뛴 시험이 하나라도 있으면 실패로 본다(collector_redis_test.sh 와 같다).
# 사용: bash infra/tests/collector_pg_test.sh   (docker · uv 필요 — make test-collector-db · make infra-docker-test)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${DB_IMAGE:-$(awk '/^  db:/{f=1} f && $1=="image:"{print $2; exit}' "$ROOT/infra/compose.yml")}"
MIG="$ROOT/apps/api/src/main/resources/db/migration"
C="wakeline-colpg-$$"
# 비밀번호는 docker CLI 의 argv 에 두지 않는다: -e 이름만 넘기고 값은 이 셸의 환경에 둔다(collector_redis_test.sh 와 같다)
POSTGRES_PASSWORD="r-$(openssl rand -hex 16)"; DB_MIGRATOR_PASSWORD="m-$(openssl rand -hex 16)"
DB_API_PASSWORD="a-$(openssl rand -hex 16)"; DB_COLLECTOR_PASSWORD="c-$(openssl rand -hex 16)"
export POSTGRES_PASSWORD DB_MIGRATOR_PASSWORD DB_API_PASSWORD DB_COLLECTOR_PASSWORD
cleanup() { docker rm -f -v "$C" >/dev/null 2>&1 || true; }  # -v: 이미지의 VOLUME(데이터 디렉터리)도 지운다
trap cleanup EXIT

files="$(cd "$MIG" && ls | grep -E '^V[0-9]+__.*\.sql$' | sed -E 's/^V([0-9]+)__/\1 &/' | sort -n | cut -d' ' -f2-)"
[ -n "$files" ] || { echo "FAIL: $MIG 에 마이그레이션이 없다" >&2; exit 1; }
if (cd "$MIG" && grep -l '\${' $files); then echo "FAIL: Flyway 자리표시가 있는 마이그레이션 — psql 로 그대로 적용할 수 없다" >&2; exit 1; fi

echo "image: $IMAGE"
docker run -d --name "$C" -p 127.0.0.1::5432 --cap-drop ALL --security-opt no-new-privileges:true --shm-size 256m \
  -e POSTGRES_PASSWORD -e DB_MIGRATOR_PASSWORD -e DB_API_PASSWORD -e DB_COLLECTOR_PASSWORD \
  -v "$ROOT/infra/db/init:/docker-entrypoint-initdb.d:ro" "$IMAGE" >/dev/null
ready=0
for _ in $(seq 1 120); do  # 초기화 중의 임시 서버가 아니라 최종 서버(프로세스 1)가 준비될 때까지(db_hardening_test.sh 와 같다)
  if docker exec "$C" sh -c 'pg_isready -q -U postgres -d wakeline && [ "$(cat /proc/1/comm)" = postgres ]' 2>/dev/null; then ready=1; break; fi
  sleep 0.5
done
[ "$ready" = 1 ] || { docker logs "$C" 2>&1 | tail -30; echo "FAIL: db 가 준비되지 않았다" >&2; exit 1; }

n=0
for f in $files; do
  PGPASSWORD="$DB_MIGRATOR_PASSWORD" docker exec -i -e PGPASSWORD "$C" \
    psql -X -q -h 127.0.0.1 -U wakeline_migrator -d wakeline -v ON_ERROR_STOP=1 --single-transaction -f - <"$MIG/$f" >/dev/null
  n=$((n + 1))
done
echo "migrations applied: $n ($(echo "$files" | tail -1))"

PORT="$(docker port "$C" 5432/tcp | head -1 | awk -F: '{print $NF}')"
cd "$ROOT/apps/collector"
rc=0
out="$(WAKELINE_TEST_PG_URL="postgresql://wakeline_collector:$DB_COLLECTOR_PASSWORD@127.0.0.1:$PORT/wakeline" uv run pytest -q -rs -p no:cacheprovider \
  tests/test_db_pg_integration.py 2>&1)" || rc=$?
echo "$out" | tail -n 25
if grep -q "skipped" <<<"$out"; then echo "FAIL: 실제 PostgreSQL 대조 시험이 건너뛰어졌다" >&2; exit 1; fi
exit "$rc"
