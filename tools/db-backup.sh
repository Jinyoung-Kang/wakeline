#!/usr/bin/env bash
# PostgreSQL 백업(R-13) — db 컨테이너 안에서 로컬 소켓 슈퍼유저(SEC-R3: 슈퍼유저 TCP 는 막혀 있다)로 pg_dump -Fc 를 받아 호스트 파일에 쓴다.
#
#   tools/db-backup.sh                                   개발 스택(compose 프로젝트 wakeline) → backups/wakeline-<UTC>.dump
#   WAKELINE_PROJECT=wakeline-e2e tools/db-backup.sh     격리 스택
#   tools/db-backup.sh --container NAME [--out DIR]      임의 컨테이너(infra/tests/db_backup_test.sh)
#
# 담는 것: 기본은 72 h 원해상도 파티션(track_point_YYYYMMDD · ship_position_YYYYMMDD)의 '행'만 뺀다 — 구조는 담는다.
#   영구 표(SIGMET·알림·통계·감사·운영자·설정)와 30일 1분 요약(track_point_1m)·flyway_schema_history 는 모두 담는다. FULL=1 이면 원해상도 행까지.
# 파일: backups/(0700, .gitignore) 안에 0600. 임시 이름으로 쓰고 pg_restore --list 로 읽히는지 확인한 뒤 이름을 바꾼다.
# 보관(R-13): 새 백업을 확인한 뒤 같은 대상(<이름>-<UTC>.dump 형식)의 최신 KEEP 개(기본 10)만 남기고 오래된 것부터 지운다. KEEP=0 이면 지우지 않는다.
#   백업에는 운영자 비밀번호 해시·감사 로그가 들어 있어 무기한 쌓아 두지 않는다. 다른 대상·다른 이름의 파일(손으로 옮긴 것 등)은 건드리지 않는다.
# pg_dump 는 한 스냅샷으로 읽으므로 스택을 멈추지 않아도 일관된다. 비밀번호를 쓰거나 출력하지 않는다(로컬 소켓).
# 복원: tools/db-restore.sh (make restore) — 절차는 README '백업·복원'.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/backups"; CID=""; NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --container) CID="${2:?--container NAME}"; NAME="$2"; shift 2 ;;
    --out) OUT="${2:?--out DIR}"; shift 2 ;;
    *) echo "usage: $0 [--container NAME] [--out DIR]   (FULL=1: 72 h 원해상도 행 포함)" >&2; exit 2 ;;
  esac
done
if [ -z "$CID" ]; then
  NAME="${WAKELINE_PROJECT:-wakeline}"
  CID="$(docker ps -q --filter "label=com.docker.compose.project=$NAME" --filter "label=com.docker.compose.service=db")"
  [ -n "$CID" ] || { echo "db container of compose project '$NAME' is not running" >&2; exit 1; }
  [ "$(wc -l <<<"$CID")" -eq 1 ] || { echo "more than one db container in project '$NAME'" >&2; exit 1; }
fi
case "$NAME" in *[!A-Za-z0-9_.-]*|'') echo "invalid name: $NAME" >&2; exit 2 ;; esac
KEEP="${KEEP:-10}"
case "$KEEP" in ''|*[!0-9]*) echo "KEEP must be a non-negative integer (0 = keep all): $KEEP" >&2; exit 2 ;; esac

umask 077
mkdir -p "$OUT"; chmod 700 "$OUT"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
file="$OUT/$NAME-$ts.dump"; tmp="$OUT/.$NAME-$ts.dump.partial"
[ ! -e "$file" ] || { echo "already exists: $file" >&2; exit 1; }
trap 'rm -f "$tmp"' EXIT

# psql 패턴은 이름 전체에 맞춘다 — 날짜 8자리 파티션만(track_point_1m 은 요약 표라 담는다)
D8='[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
mode="72 h 원해상도 행 제외(track_point_YYYYMMDD · ship_position_YYYYMMDD — 구조는 포함)"
excl=(--exclude-table-data="public.track_point_$D8" --exclude-table-data="public.ship_position_$D8")
if [ "${FULL:-0}" = 1 ]; then mode="전체(원해상도 행 포함)"; excl=(); fi

docker exec -u postgres "$CID" pg_dump --format=custom --dbname=wakeline --no-password ${excl[@]+"${excl[@]}"} > "$tmp"
entries="$(docker exec -i -u postgres "$CID" pg_restore --list < "$tmp" | grep -vc '^;')" \
  || { echo "backup verification failed (pg_restore --list)" >&2; exit 1; }
mv -f "$tmp" "$file"
chmod 600 "$file"
trap - EXIT
echo "backup: $file ($(du -h "$file" | cut -f1 | tr -d ' '), 항목 $entries개, $mode)"
if [ "$KEEP" -gt 0 ]; then
  # 이름의 UTC 시각이 정렬 순서다. 이 도구가 만든 형식(<이름>-YYYYMMDDTHHMMSSZ.dump)만 — 방금 만든 파일은 가장 새것이라 남는다
  old_files="$(find "$OUT" -maxdepth 1 -type f -name "$NAME-*.dump" | grep -E "/$NAME-[0-9]{8}T[0-9]{6}Z\.dump$" | sort | awk -v k="$KEEP" '{a[NR]=$0} END{for(i=1;i<=NR-k;i++) print a[i]}')"
  if [ -n "$old_files" ]; then
    while IFS= read -r f; do rm -f -- "$f"; echo "rotate: removed $(basename "$f") (KEEP=$KEEP)"; done <<<"$old_files"
  fi
fi
echo "restore: make restore f=${file#"$ROOT"/} confirm=$NAME   (빈 새 볼륨에만 — README '백업·복원')"
