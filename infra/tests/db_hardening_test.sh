#!/usr/bin/env bash
# db(PostGIS) 컨테이너 권한 축소 회귀 시험 (SEC-4).
# compose 와 같은 방식(cap_drop ALL + 엔트리포인트에 필요한 CHOWN·DAC_OVERRIDE·FOWNER·SETGID·SETUID 만, no-new-privileges,
# read-only 루트 FS + tmpfs /var/run/postgresql·/tmp)으로 버리는 db 를 새 볼륨에 초기화(initdb + infra/db/init)하고,
# 같은 볼륨으로 재기동한 뒤 역할·PostGIS·권한 강하를 확인한다. 개발·E2E 스택과 볼륨은 건드리지 않는다.
# 사용: bash infra/tests/db_hardening_test.sh   (docker 필요, 약 30초)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${DB_IMAGE:-$(awk '/^  db:/{f=1} f && $1=="image:"{print $2; exit}' "$ROOT/infra/compose.yml")}"
ID="wakeline-dbtest-$$"; VOL="$ID-data"
fails=0; passes=0
cleanup() { docker rm -f "$ID" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT
check() { if [ "$2" = 0 ]; then passes=$((passes+1)); echo "  ok    $1"; else fails=$((fails+1)); echo "  FAIL  $1 → $3"; fi; }

run_db() {
  docker run -d --name "$ID" \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETGID --cap-add SETUID \
    --security-opt no-new-privileges:true --read-only --tmpfs /var/run/postgresql --tmpfs /tmp --shm-size 256m \
    -e POSTGRES_PASSWORD=root-test-pw -e DB_MIGRATOR_PASSWORD=mig-test-pw -e DB_API_PASSWORD=api-test-pw -e DB_COLLECTOR_PASSWORD=col-test-pw \
    -v "$VOL:/var/lib/postgresql" -v "$ROOT/infra/db/init:/docker-entrypoint-initdb.d:ro" "$IMAGE" >/dev/null
}
wait_ready() { # 초기화 중의 임시 서버가 아니라 최종 서버(프로세스 1)가 준비될 때까지
  for _ in $(seq 1 120); do
    if docker exec "$ID" sh -c 'pg_isready -q -U postgres -d wakeline && [ "$(cat /proc/1/comm)" = postgres ]' 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  docker logs "$ID" 2>&1 | tail -30; return 1
}
psql_as() { docker exec -e PGPASSWORD="$2" "$ID" psql -h 127.0.0.1 -U "$1" -d wakeline -tAc "$3" 2>&1 || true; }

echo "image: $IMAGE"
echo "[첫 기동: initdb + infra/db/init]"
docker volume create "$VOL" >/dev/null
run_db
wait_ready; check "첫 기동(초기화) 후 준비" $? "not ready"
out="$(psql_as wakeline_api api-test-pw "select current_user")"; [ "$out" = wakeline_api ]; check "wakeline_api 로그인" $? "$out"
out="$(psql_as wakeline_migrator mig-test-pw "select extname from pg_extension where extname='postgis'")"; [ "$out" = postgis ]; check "PostGIS 확장" $? "$out"
docker rm -f "$ID" >/dev/null

echo "[재기동: 기존 볼륨]"
run_db
wait_ready; check "재기동 후 준비" $? "not ready"
out="$(psql_as wakeline_collector col-test-pw "select 1")"; [ "$out" = 1 ]; check "wakeline_collector 로그인" $? "$out"

echo "[컨테이너 권한]"
# docker exec 로 들어간 sh 자신(root·엔트리포인트용 권한)은 빼고 postgres 프로세스만 본다
st="$(docker exec "$ID" sh -c 'for p in /proc/[0-9]*; do [ -r $p/status ] && awk "/^(Name|Uid|CapEff|NoNewPrivs):/{printf \"%s \", \$2}" $p/status && echo; done; true' 2>/dev/null | grep -E '^postgres ' || true)"
[ -n "$st" ] && ! grep -vqE '^postgres 999 0000000000000000 1 $' <<<"$st"; check "모든 postgres 프로세스 uid=999 CapEff=0 NoNewPrivs=1" $? "$st"
out="$(docker exec "$ID" sh -c 'touch /etc/x 2>&1 || true')"; grep -q "Read-only" <<<"$out"; check "root FS read-only" $? "$out"
out="$(docker inspect -f '{{.HostConfig.CapDrop}} {{.HostConfig.CapAdd}} {{.HostConfig.SecurityOpt}}' "$ID")"
grep -q "ALL" <<<"$out" && ! grep -qiE "NET_RAW|SYS_" <<<"$out"; check "cap_drop ALL · 추가 권한은 엔트리포인트용 5개뿐" $? "$out"

echo "db hardening test: $passes passed, $fails failed"
[ "$fails" -eq 0 ]
