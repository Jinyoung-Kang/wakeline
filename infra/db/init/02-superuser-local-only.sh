#!/bin/sh
# SEC-R3 · SEC-1(잔여): postgres 슈퍼유저는 컨테이너 안의 로컬 소켓으로만 접속한다 — TCP(다른 컨테이너·127.0.0.1 모두)는 거부.
#
# 왜: DB_ROOT_PASSWORD 가 새어도(.env 유출·백업·환경변수 실수) 같은 브리지 네트워크의 다른 컨테이너가 슈퍼유저로 붙어
#     역할 분리(wakeline_migrator/api/collector)와 INSERT 전용 audit_log 를 우회하지 못하게 한다(심층 방어).
# 영향 없음: 헬스체크(pg_isready)·운영 psql(tools/dc exec db psql -U postgres)·초기화 스크립트는 모두 로컬 소켓이다.
#     서비스 계정(wakeline_*)의 TCP 로그인 규칙은 그대로다(맨 뒤 `host all all all scram-sha-256`).
#
# 적용 시점: docker-entrypoint-initdb.d 는 데이터 디렉터리가 비어 있을 때(최초 초기화) 한 번만 돈다.
#     이미 초기화된 볼륨에는 tools/db-superuser-local-only.sh 가 이 파일을 컨테이너 안에서 그대로 실행한다(멱등).
# 켜기: compose 의 db 서비스가 WAKELINE_PG_SUPERUSER_TCP=reject 를 준다. 값이 없으면(= allow) 아무것도 바꾸지 않는다 —
#     api 통합 테스트(DbTestSupport)가 같은 초기화 디렉터리를 쓰면서 Testcontainers 포트로 postgres 에 접속하기 때문이다.
#
# 동작: pg_hba.conf 맨 앞에 reject 규칙을 넣는다(pg_hba 는 첫 일치 규칙을 쓴다; local 규칙은 host 규칙과 겹치지 않는다).
#     0600 임시 파일 → 원자적 교체, pg_hba_file_rules 로 구문 검증 후 실패하면 원래 파일로 되돌리고, 성공하면 설정을 다시 읽는다.
set -eu

case "${WAKELINE_PG_SUPERUSER_TCP:-allow}" in
  reject) ;;
  allow) echo "02-superuser-local-only: WAKELINE_PG_SUPERUSER_TCP=allow — pg_hba.conf 를 바꾸지 않습니다"; exit 0 ;;
  *) echo "02-superuser-local-only: WAKELINE_PG_SUPERUSER_TCP 는 reject 또는 allow 여야 합니다" >&2; exit 2 ;;
esac

: "${PGDATA:?PGDATA 가 없습니다}"
SU="${POSTGRES_USER:-postgres}"
case "$SU" in *[!A-Za-z0-9_]*|'') echo "02-superuser-local-only: 슈퍼유저 이름이 올바르지 않습니다" >&2; exit 2 ;; esac
HBA="$PGDATA/pg_hba.conf"
MARK="# wakeline: superuser local-socket only (SEC-R3)"

if grep -qxF "$MARK" "$HBA"; then
  echo "02-superuser-local-only: 이미 적용됨 ($HBA)"
  exit 0
fi

umask 077
TMP="$PGDATA/.pg_hba.conf.wakeline.tmp"
BAK="$PGDATA/.pg_hba.conf.wakeline.bak"
cp -p "$HBA" "$BAK"
{
  printf '%s\n' "$MARK" \
    "host    all             $SU             all                     reject" \
    "host    replication     $SU             all                     reject" \
    ""
  cat "$HBA"
} > "$TMP"
mv -f "$TMP" "$HBA"

# 로컬 소켓(슈퍼유저)으로 검증: pg_hba_file_rules 는 디스크의 파일을 다시 해석한다
psql_su() { psql -X -v ON_ERROR_STOP=1 --username "$SU" --dbname postgres -Atc "$1"; }
errors="$(psql_su "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL")" || errors="query-failed"
if [ "$errors" != 0 ]; then
  mv -f "$BAK" "$HBA"
  echo "02-superuser-local-only: 검증 실패($errors) — 원래 pg_hba.conf 로 되돌렸습니다" >&2
  exit 1
fi
psql_su "SELECT pg_reload_conf()" >/dev/null
rm -f "$BAK"
echo "02-superuser-local-only: 적용 — $SU 의 TCP 접속 거부, 로컬 소켓만 허용"
