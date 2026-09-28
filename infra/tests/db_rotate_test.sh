#!/usr/bin/env bash
# DB 서비스 계정 비밀번호 교체 회귀 시험(R-80) — 버리는 db 컨테이너 하나(compose 와 같은 권한 축소·initdb). 개발·E2E 스택은 건드리지 않는다.
#  1) tools/db_rotate_passwords.py: 세 역할의 비밀번호가 바뀌고 새 값으로 로그인·옛 값은 거부, .env 는 세 값만 바뀌고 0600, 임시 파일 없음,
#     DB 에는 SCRAM 검증값만 저장, 출력에 비밀번호 없음
#  2) --sync: .env 값이 DB 와 어긋난 상태(make init 이 새로 채운 경우)를 .env 값으로 맞춘다 — .env 는 바꾸지 않는다
#  3) 실패(없는 컨테이너)면 .env 를 바꾸지 않는다
# 사용: bash infra/tests/db_rotate_test.sh   (docker · python3 필요, 약 30초)
set -uo pipefail   # -e 없음: 실패도 모두 보고한 뒤 끝에서 종료 코드로 알린다
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${DB_IMAGE:-$(awk '/^  db:/{f=1} f && $1=="image:"{print $2; exit}' "$ROOT/infra/compose.yml")}"
ID="wakeline-rottest-$$"; NET="$ID-net"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/wakeline-rottest.XXXXXX")"
fails=0; passes=0
cleanup() { docker rm -f "$ID" >/dev/null 2>&1 || true; docker volume rm "$ID-data" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
check() { if [ "$2" = 0 ]; then passes=$((passes+1)); echo "  ok    $1"; else fails=$((fails+1)); echo "  FAIL  $1 → $3"; fi; }
is() { if [ "$2" = "$3" ]; then check "$1" 0; else check "$1" 1 "$2 (기대: $3)"; fi; }
file_mode() { python3 -c 'import os,sys; print(format(os.stat(sys.argv[1]).st_mode & 0o7777, "o"))' "$1"; }  # BSD·GNU stat 형식 차이 없이 권한(8진)
val() { sed -n "s/^$1=//p" "$ENVF"; }
# login <역할> <비밀번호> → current_user 또는 오류. 같은 망의 다른 컨테이너에서 TCP 로(서비스와 같은 경로 — scram-sha-256).
# 컨테이너 안 127.0.0.1 은 이미지 기본 pg_hba 가 trust 라 비밀번호를 보지 않는다. 비밀번호는 -e 이름으로만(값은 이 함수의 환경).
login() {
  PGPASSWORD="$2" docker run --rm --network "$NET" --user 999:999 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    -e PGPASSWORD -e PGCONNECT_TIMEOUT=5 --entrypoint psql "$IMAGE" -X -w -h "$ID" -U "$1" -d wakeline -tAc 'SELECT current_user' 2>&1 || true
}

docker volume create "$ID-data" >/dev/null
docker network create "$NET" >/dev/null
docker run -d --name "$ID" --network "$NET" \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETGID --cap-add SETUID \
  --security-opt no-new-privileges:true --read-only --tmpfs /var/run/postgresql --tmpfs /tmp --shm-size 256m \
  -e POSTGRES_PASSWORD=root-test-pw -e DB_MIGRATOR_PASSWORD=mig-test-pw -e DB_API_PASSWORD=api-test-pw -e DB_COLLECTOR_PASSWORD=col-test-pw \
  -e WAKELINE_PG_SUPERUSER_TCP=reject \
  -v "$ID-data:/var/lib/postgresql" -v "$ROOT/infra/db/init:/docker-entrypoint-initdb.d:ro" "$IMAGE" >/dev/null
for _ in $(seq 1 120); do
  docker exec "$ID" sh -c 'pg_isready -q -U postgres -d wakeline && [ "$(cat /proc/1/comm)" = postgres ]' 2>/dev/null && break
  sleep 0.5
done

ENVF="$TMP/.env"
( umask 077; printf '%s\n' "# test" "DB_ROOT_PASSWORD=root-test-pw" "DB_MIGRATOR_PASSWORD=mig-test-pw" "DB_API_PASSWORD=api-test-pw" \
  "DB_COLLECTOR_PASSWORD=col-test-pw" "REDIS_PASSWORD=keep-me-test" "aisstream_key=" > "$ENVF" )
echo "image: $IMAGE"
is "교체 전 wakeline_api 로그인" "$(login wakeline_api api-test-pw)" wakeline_api

echo "[교체]"
rc=0; out="$(python3 "$ROOT/tools/db_rotate_passwords.py" --container "$ID" --env-file "$ENVF" 2>&1)" || rc=$?
check "도구 종료 코드 0" "$rc" "$out"
for pair in wakeline_migrator:DB_MIGRATOR_PASSWORD:mig-test-pw wakeline_api:DB_API_PASSWORD:api-test-pw wakeline_collector:DB_COLLECTOR_PASSWORD:col-test-pw; do
  role="${pair%%:*}"; rest="${pair#*:}"; key="${rest%%:*}"; old="${rest#*:}"; new="$(val "$key")"
  [ -n "$new" ] && [ "$new" != "$old" ]; check "$key 새 값(.env)" $? "$new"
  is "$role 새 비밀번호로 로그인" "$(login "$role" "$new")" "$role"
  grep -q "password authentication failed" <<<"$(login "$role" "$old")"; check "$role 옛 비밀번호 거부" $? "$(login "$role" "$old")"
  ! grep -qF -- "$new" <<<"$out"; check "$role 비밀번호가 출력에 없음" $? "$out"
done
is "다른 값은 그대로(DB_ROOT_PASSWORD)" "$(val DB_ROOT_PASSWORD)" root-test-pw
is "다른 값은 그대로(REDIS_PASSWORD)" "$(val REDIS_PASSWORD)" keep-me-test
is ".env 권한 600" "$(file_mode "$ENVF")" 600
is "임시 파일 없음" "$(find "$TMP" -mindepth 1 ! -name .env | wc -l | tr -d ' ')" 0
is "DB 에는 SCRAM 검증값만(4096회)" \
  "$(docker exec -u postgres "$ID" psql -X -U postgres -d postgres -tAc "SELECT count(*) FROM pg_authid WHERE rolname LIKE 'wakeline\_%' AND rolpassword LIKE 'SCRAM-SHA-256\$4096:%'")" 3

echo "[--sync: .env 값이 DB 와 어긋난 경우]"
api_now="$(val DB_API_PASSWORD)"
sed -i.bak "s/^DB_API_PASSWORD=.*/DB_API_PASSWORD=sync-test-value-0123456789/" "$ENVF" && rm -f "$ENVF.bak"
grep -q "password authentication failed" <<<"$(login wakeline_api sync-test-value-0123456789)"; check "어긋난 값으로는 로그인 실패(재현)" $? ""
before="$(cksum < "$ENVF")"
rc=0; out="$(python3 "$ROOT/tools/db_rotate_passwords.py" --container "$ID" --env-file "$ENVF" --sync 2>&1)" || rc=$?
check "--sync 종료 코드 0" "$rc" "$out"
is "--sync 뒤 .env 값으로 로그인" "$(login wakeline_api sync-test-value-0123456789)" wakeline_api
is "--sync 는 .env 를 바꾸지 않음" "$(cksum < "$ENVF")" "$before"
grep -q "password authentication failed" <<<"$(login wakeline_api "$api_now")"; check "--sync 뒤 이전 DB 값 거부" $? ""

echo "[실패하면 .env 를 바꾸지 않는다]"
before="$(cksum < "$ENVF")"
rc=0; out="$(python3 "$ROOT/tools/db_rotate_passwords.py" --container "$ID-missing" --env-file "$ENVF" 2>&1)" || rc=$?
[ "$rc" -ne 0 ]; check "없는 컨테이너 → 실패" $? "rc=$rc"
is ".env 그대로" "$(cksum < "$ENVF")" "$before"
is "임시 파일 없음" "$(find "$TMP" -mindepth 1 ! -name .env | wc -l | tr -d ' ')" 0

echo "db rotate test: $passes passed, $fails failed"
[ "$fails" -eq 0 ]
