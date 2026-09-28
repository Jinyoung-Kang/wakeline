#!/usr/bin/env bash
# db(PostGIS) 컨테이너 권한 축소 회귀 시험 (SEC-4 · SEC-R3).
# compose 와 같은 방식(cap_drop ALL + 엔트리포인트에 필요한 CHOWN·DAC_OVERRIDE·FOWNER·SETGID·SETUID 만, no-new-privileges,
# read-only 루트 FS + tmpfs /var/run/postgresql·/tmp, WAKELINE_PG_SUPERUSER_TCP=reject)으로 버리는 db 를 새 볼륨에 초기화(initdb + infra/db/init)하고,
# 같은 볼륨으로 재기동한 뒤 역할·PostGIS·권한 강하·슈퍼유저 로컬 소켓 전용(SEC-R3)을 확인한다.
# 마지막으로 규칙 없이 초기화된 '기존 볼륨'에 tools/db-superuser-local-only.sh 를 적용해 본다(멱등).
# 슈퍼유저 거부는 같은 도커 네트워크의 다른 컨테이너에서 실제로 접속해 확인한다. 개발·E2E 스택과 볼륨은 건드리지 않는다.
# 사용: bash infra/tests/db_hardening_test.sh   (docker 필요, 약 45초)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${DB_IMAGE:-$(awk '/^  db:/{f=1} f && $1=="image:"{print $2; exit}' "$ROOT/infra/compose.yml")}"
ID="wakeline-dbtest-$$"; VOL="$ID-data"; NET="$ID-net"; VOL2="$ID-legacy"
fails=0; passes=0
cleanup() {
  docker rm -f "$ID" >/dev/null 2>&1 || true
  docker volume rm "$VOL" "$VOL2" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
check() { if [ "$2" = 0 ]; then passes=$((passes+1)); echo "  ok    $1"; else fails=$((fails+1)); echo "  FAIL  $1 → $3"; fi; }
# set -e 에서도 실패를 기록하고 계속 가는 비교(아래 SEC-R3 검사용)
is()  { if [ "$2" = "$3" ]; then check "$1" 0; else check "$1" 1 "$2"; fi; }          # is  <설명> <실제> <기대>
has() { if grep -q -- "$3" <<<"$2"; then check "$1" 0; else check "$1" 1 "$2"; fi; }  # has <설명> <출력> <패턴>

# compose 의 db command(R-24: 체크포인트·WAL·공유 버퍼 설정)를 그대로 쓴다 — compose.yml 에서 한 줄 JSON 배열로 읽는다
DB_CMD=()
cmd_json="$(awk '/^  db:/{f=1} f && $1=="command:"{sub(/^[^:]*command:[ ]*/, ""); sub(/[ ]+#.*$/, ""); print; exit}' "$ROOT/infra/compose.yml")"
if [ -n "$cmd_json" ]; then
  while IFS= read -r a; do DB_CMD+=("$a"); done < <(python3 -c 'import json,sys; print("\n".join(json.loads(sys.argv[1])))' "$cmd_json")
fi
run_db() { # run_db <볼륨> [추가 docker run 인자...]
  local vol=$1; shift
  docker run -d --name "$ID" --network "$NET" \
    --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETGID --cap-add SETUID \
    --security-opt no-new-privileges:true --read-only --tmpfs /var/run/postgresql --tmpfs /tmp --shm-size 256m \
    -e POSTGRES_PASSWORD=root-test-pw -e DB_MIGRATOR_PASSWORD=mig-test-pw -e DB_API_PASSWORD=api-test-pw -e DB_COLLECTOR_PASSWORD=col-test-pw "$@" \
    -v "$vol:/var/lib/postgresql" -v "$ROOT/infra/db/init:/docker-entrypoint-initdb.d:ro" "$IMAGE" ${DB_CMD[@]+"${DB_CMD[@]}"} >/dev/null
}
wait_ready() { # 초기화 중의 임시 서버가 아니라 최종 서버(프로세스 1)가 준비될 때까지
  for _ in $(seq 1 120); do
    if docker exec "$ID" sh -c 'pg_isready -q -U postgres -d wakeline && [ "$(cat /proc/1/comm)" = postgres ]' 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  docker logs "$ID" 2>&1 | tail -30; return 1
}
psql_as() { docker exec -e PGPASSWORD="$2" "$ID" psql -h 127.0.0.1 -U "$1" -d wakeline -tAc "$3" 2>&1 || true; }
# 같은 네트워크의 다른 컨테이너(비root·권한 0)에서 TCP 로 접속 — '다른 컨테이너가 루트 비밀번호를 얻었다'를 흉내 낸다
net_psql() {
  docker run --rm --network "$NET" --user 999:999 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    -e PGPASSWORD="$2" -e PGCONNECT_TIMEOUT=5 --entrypoint psql "$IMAGE" -X -w -h "$ID" -U "$1" -d wakeline -tAc "$3" 2>&1 || true
}
sock_psql() { docker exec -u postgres "$ID" psql -X -U postgres -d wakeline -tAc "$1" 2>&1 || true; }
marks() { docker exec -u postgres "$ID" sh -c 'grep -c "^# wakeline: superuser local-socket only" "$PGDATA/pg_hba.conf"' 2>&1 || true; }
superuser_local_only() { # superuser_local_only <단계 이름>
  has "$1: 다른 컨테이너에서 postgres(루트 비밀번호) TCP 접속 거부" "$(net_psql postgres root-test-pw "select 1")" "rejects connection"
  has "$1: 컨테이너 안 127.0.0.1 TCP 도 거부" "$(psql_as postgres root-test-pw "select 1")" "rejects connection"
  is  "$1: 로컬 소켓 슈퍼유저(운영 psql)는 가능" "$(sock_psql "select current_user")" postgres
  is  "$1: 서비스 계정 TCP 로그인은 그대로" "$(net_psql wakeline_api api-test-pw "select current_user")" wakeline_api
  is  "$1: 규칙 한 번만(멱등)" "$(marks)" 1
}

echo "image: $IMAGE"
docker network create "$NET" >/dev/null
echo "[첫 기동: initdb + infra/db/init (compose 와 같이 WAKELINE_PG_SUPERUSER_TCP=reject)]"
docker volume create "$VOL" >/dev/null
run_db "$VOL" -e WAKELINE_PG_SUPERUSER_TCP=reject
wait_ready; check "첫 기동(초기화) 후 준비" $? "not ready"
out="$(psql_as wakeline_api api-test-pw "select current_user")"; [ "$out" = wakeline_api ]; check "wakeline_api 로그인" $? "$out"
out="$(psql_as wakeline_migrator mig-test-pw "select extname from pg_extension where extname='postgis'")"; [ "$out" = postgis ]; check "PostGIS 확장" $? "$out"
superuser_local_only "첫 기동"
docker rm -f "$ID" >/dev/null

echo "[재기동: 기존 볼륨]"
run_db "$VOL" -e WAKELINE_PG_SUPERUSER_TCP=reject
wait_ready; check "재기동 후 준비" $? "not ready"
out="$(psql_as wakeline_collector col-test-pw "select 1")"; [ "$out" = 1 ]; check "wakeline_collector 로그인" $? "$out"
superuser_local_only "재기동"
# R-24: compose command 의 서버 설정이 실제로 적용됐는지(wal_compression=on 은 pglz 로 보인다)
is "checkpoint_timeout 15min" "$(sock_psql "SHOW checkpoint_timeout")" 15min
is "max_wal_size 2GB"         "$(sock_psql "SHOW max_wal_size")" 2GB
is "wal_compression on(pglz)" "$(sock_psql "SHOW wal_compression")" pglz
is "shared_buffers 256MB"     "$(sock_psql "SHOW shared_buffers")" 256MB
is "설정 출처는 명령행(compose command)" "$(sock_psql "SELECT string_agg(DISTINCT source, ',') FROM pg_settings WHERE name IN ('checkpoint_timeout','max_wal_size','wal_compression','shared_buffers')")" "command line"

echo "[컨테이너 권한]"
# docker exec 로 들어간 sh 자신(root·엔트리포인트용 권한)은 빼고 postgres 프로세스만 본다
st="$(docker exec "$ID" sh -c 'for p in /proc/[0-9]*; do [ -r $p/status ] && awk "/^(Name|Uid|CapEff|NoNewPrivs):/{printf \"%s \", \$2}" $p/status && echo; done; true' 2>/dev/null | grep -E '^postgres ' || true)"
[ -n "$st" ] && ! grep -vqE '^postgres 999 0000000000000000 1 $' <<<"$st"; check "모든 postgres 프로세스 uid=999 CapEff=0 NoNewPrivs=1" $? "$st"
out="$(docker exec "$ID" sh -c 'touch /etc/x 2>&1 || true')"; grep -q "Read-only" <<<"$out"; check "root FS read-only" $? "$out"
out="$(docker inspect -f '{{.HostConfig.CapDrop}} {{.HostConfig.CapAdd}} {{.HostConfig.SecurityOpt}}' "$ID")"
grep -q "ALL" <<<"$out" && ! grep -qiE "NET_RAW|SYS_" <<<"$out"; check "cap_drop ALL · 추가 권한은 엔트리포인트용 5개뿐" $? "$out"

docker rm -f "$ID" >/dev/null

echo "[SEC-R3 이전에 초기화된 볼륨 + tools/db-superuser-local-only.sh]"
docker volume create "$VOL2" >/dev/null
run_db "$VOL2"   # 변수 없음 = allow: 규칙 없이 초기화된 기존 개발 볼륨과 같은 상태
wait_ready; check "기존 볼륨 흉내(규칙 없음) 준비" $? "not ready"
is "적용 전: 루트 비밀번호가 있으면 다른 컨테이너에서 슈퍼유저 접속 가능(막아야 할 상태)" "$(net_psql postgres root-test-pw "select 1")" 1
is "적용 전: 규칙 없음" "$(marks)" 0
rc=0; out="$(bash "$ROOT/tools/db-superuser-local-only.sh" --container "$ID" 2>&1)" || rc=$?
check "도구 적용(검증 포함)" "$rc" "$out"
superuser_local_only "도구 적용 후"
rc=0; out="$(bash "$ROOT/tools/db-superuser-local-only.sh" --container "$ID" 2>&1)" || rc=$?
is "도구 재실행 종료 코드 0" "$rc" 0
has "도구 재실행은 아무것도 바꾸지 않음" "$out" "이미 적용됨"
is "재실행 후에도 규칙 한 번" "$(marks)" 1
rc=0; docker exec "$ID" pg_isready -q -U postgres -d wakeline || rc=$?
check "헬스체크(pg_isready, 로컬 소켓) 정상" "$rc" "pg_isready failed"

echo "db hardening test: $passes passed, $fails failed"
[ "$fails" -eq 0 ]
