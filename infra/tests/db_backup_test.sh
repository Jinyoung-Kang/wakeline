#!/usr/bin/env bash
# PostgreSQL 백업·복원 회귀 시험 (R-13). 개발·E2E 스택과 볼륨은 건드리지 않는다 — 버리는 db 컨테이너 둘만 쓴다.
#  1) compose 와 같은 방식(권한 축소·read-only·initdb + infra/db/init, 슈퍼유저 로컬 소켓 전용)으로 원본 db 를 띄우고
#     실제 마이그레이션(apps/api/.../db/migration/V*.sql)을 wakeline_migrator 로 적용 + 영구 표·72 h 파티션에 시험 행을 넣는다.
#  2) tools/db-backup.sh: 파일·디렉터리 권한(0600·0700), pg_restore --list, 기본은 72 h 원해상도 행 제외 · FULL=1 이면 포함.
#  3) tools/db-restore.sh: 확인 문구 없음·틀림 / 비어 있지 않은 DB(원본) / 깨진 파일 → 거부하고 아무것도 바꾸지 않는다.
#     새 볼륨의 빈 DB 에는 복원된다 — 행 수·소유자·권한(wakeline_api 는 audit_log 에 INSERT·SELECT 만)·서비스 계정 로그인까지 확인.
# 사용: bash infra/tests/db_backup_test.sh   (docker 필요, 약 1분)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${DB_IMAGE:-$(awk '/^  db:/{f=1} f && $1=="image:"{print $2; exit}' "$ROOT/infra/compose.yml")}"
ID="wakeline-bktest-$$"; SRC="$ID-src"; DST="$ID-dst"; NET="$ID-net"; FAKE_API="$ID-api"
PROJ="$ID"   # 복원 대상은 compose 라벨을 붙여 make restore 의 프로젝트 모드(쓰는 컨테이너가 멈췄는지 확인)로 시험한다
TMP="$(mktemp -d "${TMPDIR:-/tmp}/wakeline-bktest.XXXXXX")"
fails=0; passes=0
cleanup() {
  docker rm -f "$SRC" "$DST" "$FAKE_API" >/dev/null 2>&1 || true
  docker volume rm "$SRC-data" "$DST-data" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
check() { if [ "$2" = 0 ]; then passes=$((passes+1)); echo "  ok    $1"; else fails=$((fails+1)); echo "  FAIL  $1 → $3"; fi; }
is()  { if [ "$2" = "$3" ]; then check "$1" 0; else check "$1" 1 "$2 (기대: $3)"; fi; }
has() { if grep -q -- "$3" <<<"$2"; then check "$1" 0; else check "$1" 1 "$2"; fi; }
file_mode() { python3 -c 'import os,sys; print(format(os.stat(sys.argv[1]).st_mode & 0o7777, "o"))' "$1"; }  # BSD·GNU stat 형식 차이 없이 권한(8진)

run_db() { # run_db <이름> [추가 docker run 인자...]
  local name=$1; shift
  docker volume create "$name-data" >/dev/null
  docker run -d --name "$name" --network "$NET" "$@" \
    --cap-drop ALL \
    --security-opt no-new-privileges:true --read-only --tmpfs /var/run/postgresql --tmpfs /tmp --shm-size 256m \
    -e POSTGRES_PASSWORD=root-test-pw -e DB_MIGRATOR_PASSWORD=mig-test-pw -e DB_API_PASSWORD=api-test-pw -e DB_COLLECTOR_PASSWORD=col-test-pw \
    -e WAKELINE_PG_SUPERUSER_TCP=reject \
    -v "$name-data:/var/lib/postgresql" -v "$ROOT/infra/db/init:/docker-entrypoint-initdb.d:ro" "$IMAGE" >/dev/null
  for _ in $(seq 1 120); do
    if docker exec "$name" sh -c 'pg_isready -q -U postgres -d wakeline && [ "$(cat /proc/1/comm)" = postgres ]' 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  docker logs "$name" 2>&1 | tail -30; return 1
}
sql() { docker exec -i -u postgres "$1" psql -X -v ON_ERROR_STOP=1 -U postgres -d wakeline -tA "${@:2}"; }   # sql <컨테이너> [-c …] — 로컬 소켓 슈퍼유저
as_role() { docker exec -i -e PGPASSWORD="$3" "$1" psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$2" -d wakeline -tA "${@:4}"; }

echo "image: $IMAGE"
docker network create "$NET" >/dev/null
echo "[원본 db: initdb + 마이그레이션 + 시험 행]"
run_db "$SRC"; check "원본 db 준비" $? "not ready"
for f in $(ls "$ROOT"/apps/api/src/main/resources/db/migration/V*__*.sql | sort -V); do
  as_role "$SRC" wakeline_migrator mig-test-pw -q < "$f" >/dev/null || { check "마이그레이션 $(basename "$f")" 1 "실패"; exit 1; }
done
check "마이그레이션 $(ls "$ROOT"/apps/api/src/main/resources/db/migration/V*__*.sql | wc -l | tr -d ' ')개 적용" 0 ""
today="$(date -u +%Y%m%d)"
as_role "$SRC" wakeline_api api-test-pw -q <<SQL
INSERT INTO audit_log (action, target, request_id) VALUES ('backup-test', 't', 'bktest');
INSERT INTO app_setting (key, value, updated_by) VALUES ('bktest_key', '"v"', 'bktest');
INSERT INTO track_point (hex, ts, geom, provider, fetched_at) VALUES ('abc123', now(), ST_SetSRID(ST_MakePoint(127, 37), 4326), 'bktest', now());
INSERT INTO track_point_1m (hex, ts_minute, geom, n) VALUES ('abc123', date_trunc('minute', now()), ST_SetSRID(ST_MakePoint(127, 37), 4326), 1);
SQL
check "시험 행 입력(wakeline_api)" $? ""
is "원본 track_point_$today 행" "$(sql "$SRC" -c "SELECT count(*) FROM track_point_$today")" 1

echo "[make backup: tools/db-backup.sh]"
OUT="$TMP/backups"
rc=0; out="$(bash "$ROOT/tools/db-backup.sh" --container "$SRC" --out "$OUT" 2>&1)" || rc=$?
check "백업 종료 코드 0" "$rc" "$out"
f1="$(ls "$OUT"/*.dump 2>/dev/null | head -1)"
[ -n "$f1" ]; check "백업 파일 생성: $(basename "${f1:-없음}")" $? "$out"
is "파일 권한 600" "$(file_mode "$f1")" 600
is "디렉터리 권한 700" "$(file_mode "$OUT")" 700
[ -z "$(find "$OUT" -mindepth 1 ! -name '*.dump' | head -1)" ]; check "임시 파일이 남지 않음" $? "$(ls -A "$OUT")"
toc="$(docker exec -i -u postgres "$SRC" pg_restore --list < "$f1")"
has "pg_restore --list: audit_log 행" "$toc" "TABLE DATA public audit_log"
has "pg_restore --list: 30일 요약 track_point_1m 행" "$toc" "TABLE DATA public track_point_1m"
has "pg_restore --list: 파티션 track_point_$today 구조" "$toc" "TABLE public track_point_$today"
! grep -q "TABLE DATA public track_point_$today" <<<"$toc"; check "기본: 72 h 원해상도 행 제외" $? "$(grep "track_point_$today" <<<"$toc")"
sleep 1
rc=0; out="$(FULL=1 bash "$ROOT/tools/db-backup.sh" --container "$SRC" --out "$OUT" 2>&1)" || rc=$?
check "FULL=1 백업 종료 코드 0" "$rc" "$out"
f2="$(ls -t "$OUT"/*.dump | head -1)"
[ "$f2" != "$f1" ]; check "새 파일(덮어쓰지 않음)" $? "$f2"
has "FULL=1: 원해상도 행 포함" "$(docker exec -i -u postgres "$SRC" pg_restore --list < "$f2")" "TABLE DATA public track_point_$today"

echo "[보관 개수: KEEP — 같은 대상의 이 도구 이름 형식 파일만, 오래된 것부터]"
OUT2="$TMP/rotate"; mkdir -p "$OUT2"; chmod 700 "$OUT2"
for t in 20260101T000000Z 20260102T000000Z 20260103T000000Z; do : > "$OUT2/$SRC-$t.dump"; done
: > "$OUT2/other-20250101T000000Z.dump"; : > "$OUT2/$SRC-manual.dump"; : > "$OUT2/$SRC-20250101T000000Z.dump.txt"
rc=0; out="$(KEEP=2 bash "$ROOT/tools/db-backup.sh" --container "$SRC" --out "$OUT2" 2>&1)" || rc=$?
check "KEEP=2 백업 종료 코드 0" "$rc" "$out"
is "KEEP=2: 이 대상의 백업 2개만 남음" "$(ls "$OUT2" | grep -Ec "^$SRC-[0-9]{8}T[0-9]{6}Z\.dump$")" 2
[ ! -e "$OUT2/$SRC-20260101T000000Z.dump" ] && [ ! -e "$OUT2/$SRC-20260102T000000Z.dump" ] && [ -e "$OUT2/$SRC-20260103T000000Z.dump" ]
check "가장 오래된 것부터 지움" $? "$(ls "$OUT2")"
[ -e "$OUT2/other-20250101T000000Z.dump" ] && [ -e "$OUT2/$SRC-manual.dump" ] && [ -e "$OUT2/$SRC-20250101T000000Z.dump.txt" ]
check "다른 대상·다른 이름 형식은 지우지 않음" $? "$(ls "$OUT2")"
has "지운 파일을 알림" "$out" "$SRC-20260101T000000Z.dump"
: > "$OUT2/$SRC-20250601T000000Z.dump"
sleep 1   # 같은 초의 두 번째 백업은 이름이 같아 거부된다(덮어쓰지 않음)
rc=0; out="$(KEEP=0 bash "$ROOT/tools/db-backup.sh" --container "$SRC" --out "$OUT2" 2>&1)" || rc=$?
[ "$rc" = 0 ] && [ -e "$OUT2/$SRC-20250601T000000Z.dump" ]; check "KEEP=0: 지우지 않음" $? "$out"
rc=0; out="$(KEEP=abc bash "$ROOT/tools/db-backup.sh" --container "$SRC" --out "$OUT2" 2>&1)" || rc=$?
[ "$rc" = 2 ]; check "KEEP 형식 오류 → 백업 전에 거부" $? "rc=$rc $out"

echo "[make restore: 거부해야 하는 경우 — 아무것도 바꾸지 않는다]"
run_db "$DST" --label "com.docker.compose.project=$PROJ" --label com.docker.compose.service=db; check "새 볼륨 db 준비(빈 DB)" $? "not ready"
tables_dst() { sql "$DST" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'spatial_ref_sys'"; }
rc=0; out="$(bash "$ROOT/tools/db-restore.sh" --container "$DST" --file "$f1" 2>&1)" || rc=$?
[ "$rc" -ne 0 ]; check "확인 문구 없음 → 거부" $? "rc=$rc $out"
rc=0; out="$(bash "$ROOT/tools/db-restore.sh" --container "$DST" --file "$f1" --confirm wakeline 2>&1)" || rc=$?
[ "$rc" -ne 0 ]; check "확인 문구가 대상 이름과 다름 → 거부" $? "rc=$rc $out"
rc=0; out="$(bash "$ROOT/tools/db-restore.sh" --container "$SRC" --file "$f1" --confirm "$SRC" 2>&1)" || rc=$?
[ "$rc" -ne 0 ]; check "비어 있지 않은 DB(원본) → 거부" $? "rc=$rc $out"
has "거부 사유: 빈 DB 아님" "$out" "비어 있지 않"
is "원본은 그대로" "$(sql "$SRC" -c "SELECT count(*) FROM audit_log WHERE request_id = 'bktest'")" 1
printf 'not a dump' > "$TMP/broken.dump"
rc=0; out="$(bash "$ROOT/tools/db-restore.sh" --container "$DST" --file "$TMP/broken.dump" --confirm "$DST" 2>&1)" || rc=$?
[ "$rc" -ne 0 ]; check "깨진 파일 → 거부" $? "rc=$rc $out"
is "거부 뒤에도 대상은 빈 DB" "$(tables_dst)" 0

# 프로젝트 모드: 같은 프로젝트의 api 가 돌고 있으면 거부(복원 중 쓰기 방지)
docker run -d --name "$FAKE_API" --network none --label "com.docker.compose.project=$PROJ" --label com.docker.compose.service=api \
  --entrypoint sleep "$IMAGE" 300 >/dev/null
rc=0; out="$(WAKELINE_PROJECT="$PROJ" bash "$ROOT/tools/db-restore.sh" --file "$f1" --confirm "$PROJ" 2>&1)" || rc=$?
[ "$rc" -ne 0 ]; check "프로젝트 모드: api 실행 중 → 거부" $? "rc=$rc $out"
has "거부 사유: api 실행 중" "$out" "api 가 실행 중"
is "거부 뒤에도 대상은 빈 DB(api 실행 중)" "$(tables_dst)" 0
docker rm -f "$FAKE_API" >/dev/null

echo "[make restore: 새 볼륨의 빈 DB (프로젝트 모드 — make restore 와 같은 경로)]"
rc=0; out="$(WAKELINE_PROJECT="$PROJ" bash "$ROOT/tools/db-restore.sh" --file "$f1" --confirm "$PROJ" 2>&1)" || rc=$?
check "복원 종료 코드 0" "$rc" "$out"
has "복원 결과 요약" "$out" "restored: 표"
is "표 수가 원본과 같다" "$(tables_dst)" "$(sql "$SRC" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'spatial_ref_sys'")"
is "audit_log 시험 행" "$(sql "$DST" -c "SELECT count(*) FROM audit_log WHERE request_id = 'bktest'")" 1
is "app_setting 시험 행" "$(sql "$DST" -c "SELECT value FROM app_setting WHERE key = 'bktest_key'")" '"v"'
is "track_point_1m(30일 요약) 행" "$(sql "$DST" -c "SELECT count(*) FROM track_point_1m WHERE hex = 'abc123'")" 1
is "72 h 파티션은 구조만(행 0)" "$(sql "$DST" -c "SELECT count(*) FROM track_point_$today")" 0
is "소유자 wakeline_migrator" "$(sql "$DST" -c "SELECT tableowner FROM pg_tables WHERE tablename = 'audit_log'")" wakeline_migrator
is "권한: api 는 audit_log 에 INSERT·SELECT 만" \
  "$(sql "$DST" -c "SELECT has_table_privilege('wakeline_api','audit_log','INSERT')::text || has_table_privilege('wakeline_api','audit_log','SELECT')::text || has_table_privilege('wakeline_api','audit_log','UPDATE')::text || has_table_privilege('wakeline_api','audit_log','DELETE')::text")" \
  truetruefalsefalse
# relacl 이 NULL(= 소유자 전체 권한 기본값)과 '소유자 권한만 적은 목록'은 같은 뜻이다 — acldefault 로 맞춘 뒤 권한 단위로 비교
ACL_Q="SELECT c.relname || ' ' || a.grantee::regrole || ' ' || a.privilege_type FROM pg_class c,
         aclexplode(coalesce(c.relacl, acldefault(CASE c.relkind WHEN 'S' THEN 's'::\"char\" ELSE 'r'::\"char\" END, c.relowner))) a
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') ORDER BY 1"
acl_diff="$(diff <(sql "$SRC" -c "$ACL_Q") <(sql "$DST" -c "$ACL_Q") || true)"
is "권한이 원본과 같다(public 의 모든 표·시퀀스 ACL, 권한 단위 비교)" "$acl_diff" ""
is "기본 권한(ALTER DEFAULT PRIVILEGES)이 원본과 같다" \
  "$(sql "$DST" -c "SELECT string_agg(defaclrole::regrole::text || ':' || defaclobjtype::text || ':' || defaclacl::text, ',' ORDER BY 1) FROM pg_default_acl")" \
  "$(sql "$SRC" -c "SELECT string_agg(defaclrole::regrole::text || ':' || defaclobjtype::text || ':' || defaclacl::text, ',' ORDER BY 1) FROM pg_default_acl")"
is "서비스 계정 로그인(wakeline_api, 새 볼륨의 역할)" "$(as_role "$DST" wakeline_api api-test-pw -c 'SELECT count(*) FROM audit_log')" 1
is "PostGIS geometry 복원" "$(sql "$DST" -c "SELECT ST_AsText(geom) FROM track_point_1m LIMIT 1")" "POINT(127 37)"
rc=0; out="$(bash "$ROOT/tools/db-restore.sh" --container "$DST" --file "$f1" --confirm "$DST" 2>&1)" || rc=$?
[ "$rc" -ne 0 ]; check "두 번째 복원(이제 비어 있지 않음) → 거부" $? "rc=$rc $out"

echo "db backup test: $passes passed, $fails failed"
[ "$fails" -eq 0 ]
