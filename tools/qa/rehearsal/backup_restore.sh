#!/usr/bin/env bash
# QA 2026-10 AWS 리허설(R) 항목 1: AWS 백업 방식(aws-deploy rds/backup.sh — pg_dump -Fc --no-owner --no-privileges, 마스터 계정)으로 뜬 덤프를
# 같은 bootstrap(aws-deploy rds/bootstrap.sh · bootstrap.sql)으로 만든 '새' RDS 흉내에 복원했을 때 wakeline 이 정상으로 뜨고 읽고 쓰는가.
#
#   tools/qa/rehearsal/backup_restore.sh backup  <증거 폴더>          원본(실행 중인 wlqa-aws)에서 쓰는 컨테이너를 멈추고 행 수 · 권한을 적은 뒤
#                                                                     ① backup.sh 그대로 ② 비교용: 같은 pg_dump 에서 --no-owner --no-privileges 만 뺀 것
#   tools/qa/rehearsal/backup_restore.sh restore <방식> <증거 폴더>    새 RDS(wlqa-rds 를 down -v → up → bootstrap.sh) → 복원 → wlqa-aws 새로(down -v → up) → 판정
#     방식  readme   README '데이터 이전'의 BuildRisk 복원 줄을 wakeline 에 그대로(소유 역할 wakeline_migrator 로 --no-owner --no-privileges --exit-on-error -j 2)
#           owner    같은 계정 · 옵션에서 --exit-on-error 만 뺌(오류가 나도 끝까지)
#           master   backup.sh 와 같은 마스터 계정으로 --no-owner --no-privileges -j 2(--exit-on-error 없음)
#           keepacl  제안 ①(앞으로 받을 덤프): --no-owner --no-privileges 없이 뜬 덤프에서 postgis 확장 항목(EXTENSION · COMMENT · spatial_ref_sys 자료)을 빼고
#                    마스터로 --exit-on-error --single-transaction — 받을 때 pg_dump --exclude-extension=postgis 를 쓰는 것과 같은 목록
#           aclfix   제안 ②(이미 받은 backup.sh 덤프): 확장 항목을 뺀 목록으로 wakeline_migrator 가 --no-owner --no-privileges --exit-on-error --single-transaction,
#                    뒤에 같은 판 migrate 로 만든 빈 참조 DB 의 권한(ACL) 항목만 pg_restore -L 로 덧입힘
#   판정: 복원 직후 행 수가 원본과 같고 · 소유자/권한/SECURITY DEFINER 구조가 원본과 같고 · app_probe.py probe 가 통과하면 0, 아니면 1.
# 비밀번호는 컨테이너 안에서 env 파일을 읽어 쓰고 출력하지 않는다. aws-deploy 는 읽기만(스크립트를 읽기 전용으로 마운트해 그대로 실행).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"
RS="$HERE/r.sh"
log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/run.log"; }
tools() { "$RS" rds run --rm -T tools -c "$1"; }   # wlqa-rds 의 tools 컨테이너(bash -c) — RDS_HOST=rds · PGPASSWORD=마스터
DUMP_AWS=/backups/aws; DUMP_KEEP=/backups/keepacl

cmd=${1:?backup · restore}; shift
case "$cmd" in
backup)
  OUT=${1:?증거 폴더}; mkdir -p "$OUT"
  log "원본: 쓰는 컨테이너 정지(행 수가 덤프와 같은 시점이 되게)"
  "$RS" aws stop api collector ais > /dev/null 2>&1
  python3 -B "$HERE/app_probe.py" rows > "$OUT/rows-source.json"
  python3 -B "$HERE/app_probe.py" acl > "$OUT/acl-source.txt"
  log "① aws-deploy rds/backup.sh 그대로(BACKUP_DIR=$DUMP_AWS)"
  tools "BACKUP_DIR=$DUMP_AWS bash /aws-deploy-rds/backup.sh" > "$OUT/backup-sh.txt" 2>&1; log "backup.sh rc=$?: $(tr '\n' ' ' < "$OUT/backup-sh.txt")"
  log "② 비교용: 같은 pg_dump 에서 --no-owner --no-privileges 만 뺌"
  tools "install -d -m 0700 $DUMP_KEEP && pg_dump \"host=\$RDS_HOST port=\$RDS_PORT dbname=wakeline user=\$RDS_MASTER_USER sslmode=require\" -Fc -f $DUMP_KEEP/wakeline.dump && ls -l $DUMP_KEEP" > "$OUT/backup-keepacl.txt" 2>&1
  log "keepacl rc=$?"
  tools "f=\$(ls -1t $DUMP_AWS/wakeline-*.dump | head -1); pg_restore -l \"\$f\" | grep -E 'EXTENSION|SCHEMA|ACL|OWNER|COMMENT' | head -20; echo '--- entries:'; pg_restore -l \"\$f\" | grep -vc '^;'; echo '--- ACL entries:'; pg_restore -l \"\$f\" | grep -c ' ACL ' ; echo '--- keepacl ACL entries:'; pg_restore -l $DUMP_KEEP/wakeline.dump | grep -c ' ACL '" > "$OUT/dump-toc.txt" 2>&1
  log "덤프 목차 → dump-toc.txt"
  ;;
restore)
  mode=${1:?readme · master · keepacl · aclfix}; OUT=${2:?증거 폴더}; mkdir -p "$OUT"
  SRC="$(dirname "$OUT")"   # backup 의 증거 폴더(rows-source.json · acl-source.txt)
  log "=== restore mode=$mode"
  "$RS" aws down -v > /dev/null 2>&1
  "$RS" rds --profile holder stop holder > /dev/null 2>&1; "$RS" rds --profile holder rm -f holder > /dev/null 2>&1
  log "새 RDS: wlqa-rds down -v → up"
  "$RS" rds down -v > /dev/null 2>&1   # 덤프는 호스트 폴더(backups)에 있어 남는다
  "$RS" rds up -d --wait > /dev/null 2>&1 || { log "rds up 실패"; exit 1; }
  tools "bash /aws-deploy-rds/bootstrap.sh" > "$OUT/bootstrap.txt" 2>&1; log "bootstrap.sh rc=$?"
  # 흉내의 차이 하나를 RDS 쪽으로 맞춘다: RDS 에서는 bootstrap.sql 의 CREATE EXTENSION 을 마스터가 실행해 확장 소유자 = 마스터(추정 — RDS 에서 확인 못 함).
  # 흉내는 template1 에 슈퍼유저가 미리 넣어 소유자가 postgres 다(rds-emu-init.sh 주석) — 그대로 두면 마스터 복원의 COMMENT ON EXTENSION 이 흉내에서만 실패한다.
  "$RS" sql wakeline "UPDATE pg_extension SET extowner = 'rdsmaster'::regrole WHERE extname = 'postgis'" > /dev/null && log "흉내 보정: postgis 확장 소유자 → 마스터"
  EXT_OUT="grep -v -E ' EXTENSION - postgis | COMMENT - EXTENSION postgis | TABLE DATA public spatial_ref_sys '"   # 확장은 bootstrap 이 이미 만든다
  MIG_PW="PGPASSWORD=\$(grep -E '^DB_MIGRATOR_PASSWORD=' /apps/wakeline/.env | cut -d= -f2-)"
  AS_MIG="\"host=\$RDS_HOST port=\$RDS_PORT dbname=wakeline user=wakeline_migrator sslmode=require\""
  AS_MASTER="\"host=\$RDS_HOST port=\$RDS_PORT dbname=wakeline user=\$RDS_MASTER_USER sslmode=require\""
  AWS_FILE="\$(ls -1t $DUMP_AWS/wakeline-*.dump | head -1)"
  case "$mode" in
    readme)   # README '데이터 이전' 의 BuildRisk 복원 줄과 같은 옵션 — 계정만 wakeline DB 의 소유 역할(wakeline_migrator)
      tools "$MIG_PW pg_restore -d $AS_MIG --no-owner --no-privileges --exit-on-error -j 2 $AWS_FILE" > "$OUT/restore.txt" 2>&1 ;;
    owner)
      tools "$MIG_PW pg_restore -d $AS_MIG --no-owner --no-privileges -j 2 $AWS_FILE" > "$OUT/restore.txt" 2>&1 ;;
    master)
      tools "pg_restore -d $AS_MASTER --no-owner --no-privileges -j 2 $AWS_FILE" > "$OUT/restore.txt" 2>&1 ;;
    keepacl)
      tools "pg_restore -l $DUMP_KEEP/wakeline.dump | $EXT_OUT > /tmp/list && pg_restore -d $AS_MASTER --exit-on-error --single-transaction -L /tmp/list $DUMP_KEEP/wakeline.dump" > "$OUT/restore.txt" 2>&1 ;;
    aclfix)
      tools "pg_restore -l $AWS_FILE | $EXT_OUT > /tmp/list && $MIG_PW pg_restore -d $AS_MIG --no-owner --no-privileges --exit-on-error --single-transaction -L /tmp/list $AWS_FILE" > "$OUT/restore.txt" 2>&1 ;;
    *) echo "방식: readme · owner · master · keepacl · aclfix" >&2; exit 2 ;;
  esac
  rrc=$?; log "pg_restore rc=$rrc: $(grep -cE 'error|ERROR' "$OUT/restore.txt") error lines — $(grep -E 'error|ERROR' "$OUT/restore.txt" | head -3 | tr '\n' ' ' | cut -c1-300)"
  if [ "$mode" = aclfix ]; then
    log "aclfix: 참조 DB wakeline_aclref 를 bootstrap 과 같게 만들고 같은 판 migrate 로 스키마 → 그 ACL 항목만 복원본에"
    tools "psql \"host=\$RDS_HOST port=\$RDS_PORT dbname=postgres user=\$RDS_MASTER_USER sslmode=require\" -X -q -v ON_ERROR_STOP=1 -c 'CREATE DATABASE wakeline_aclref OWNER wakeline_migrator' -c 'GRANT CONNECT ON DATABASE wakeline_aclref TO wakeline_api, wakeline_collector' && psql \"host=\$RDS_HOST port=\$RDS_PORT dbname=wakeline_aclref user=\$RDS_MASTER_USER sslmode=require\" -X -q -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS postgis' -c 'SET ROLE wakeline_migrator' -c 'REVOKE ALL ON SCHEMA public FROM PUBLIC' -c 'GRANT ALL ON SCHEMA public TO wakeline_migrator' -c 'GRANT USAGE ON SCHEMA public TO wakeline_api, wakeline_collector'" > "$OUT/aclref-create.txt" 2>&1
    log "aclref create rc=$?"
    "$RS" aws run --rm --no-deps -T -e DB_NAME=wakeline_aclref migrate > "$OUT/aclref-migrate.txt" 2>&1; log "aclref migrate rc=$?: $(tail -1 "$OUT/aclref-migrate.txt")"
    tools "pg_dump \"host=\$RDS_HOST port=\$RDS_PORT dbname=wakeline_aclref user=\$RDS_MASTER_USER sslmode=require\" -s -Fc -f /tmp/aclref.dump && pg_restore -l /tmp/aclref.dump | grep -E '^[0-9]+; [0-9]+ [0-9]+ (ACL|DEFAULT ACL) ' > /tmp/acl.list && echo \"ACL 항목 \$(wc -l < /tmp/acl.list)개\" && PGPASSWORD=\$(grep -E '^DB_MIGRATOR_PASSWORD=' /apps/wakeline/.env | cut -d= -f2-) pg_restore -d \"host=\$RDS_HOST port=\$RDS_PORT dbname=wakeline user=wakeline_migrator sslmode=require\" -L /tmp/acl.list /tmp/aclref.dump; echo \"acl apply rc=\$?\"; psql \"host=\$RDS_HOST port=\$RDS_PORT dbname=postgres user=\$RDS_MASTER_USER sslmode=require\" -X -q -c 'DROP DATABASE wakeline_aclref'" > "$OUT/aclfix.txt" 2>&1
    log "aclfix rc=$?: $(tr '\n' ' ' < "$OUT/aclfix.txt" | cut -c1-300)"
  fi
  python3 -B "$HERE/app_probe.py" rows > "$OUT/rows-restored.json" 2> "$OUT/rows-restored.err"
  python3 -B - "$SRC/rows-source.json" "$OUT/rows-restored.json" > "$OUT/rows-compare.txt" <<'PY'
import json, sys
a = json.load(open(sys.argv[1]))
try:
    b = json.load(open(sys.argv[2]))
except Exception as e:
    print(f"FAIL restored rows unreadable: {e}"); sys.exit(1)
bad = [f"{t}: {a.get(t)} -> {b.get(t)}" for t in sorted(set(a) | set(b)) if a.get(t) != b.get(t)]
print(f"tables {len(a)} vs {len(b)}, rows {sum(a.values())} vs {sum(b.values())}, differences {len(bad)}")
print("\n".join(bad[:40]))
sys.exit(1 if bad else 0)
PY
  rows_rc=$?; log "rows: $(head -1 "$OUT/rows-compare.txt") (rc=$rows_rc)"
  "$RS" sql wakeline "SELECT 'indexes', count(*) FROM pg_indexes WHERE schemaname = 'public' UNION ALL SELECT 'constraints', count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' UNION ALL SELECT 'functions', count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname ~ '^(track_point|ship_position)_'" > "$OUT/schema-counts.txt" 2>&1
  log "schema: $(tr '\t\n' '= ' < "$OUT/schema-counts.txt")"
  python3 -B "$HERE/app_probe.py" acl > "$OUT/acl-restored.txt" 2>&1
  python3 -B "$HERE/app_probe.py" acl-diff "$SRC/acl-source.txt" "$OUT/acl-restored.txt" > "$OUT/acl-diff.txt"; acl_rc=$?
  log "acl/owner/SECURITY DEFINER vs 원본(소유자만 = NULL 로 맞춤): $([ $acl_rc = 0 ] && echo same || echo "DIFFER ($(grep -c '^[-+][^-+]' "$OUT/acl-diff.txt") lines)")"
  log "wakeline 새로 기동(wlqa-aws up --wait)"
  "$RS" aws up -d --wait --wait-timeout 300 > "$OUT/aws-up.txt" 2>&1; urc=$?
  log "up rc=$urc; migrate: $(docker logs wlqa-aws-migrate-1 2>&1 | grep -E 'migrations applied|up to date|migration failed|ERROR' | tail -2 | tr '\n' ' ' | cut -c1-300)"
  docker ps -a --filter label=com.docker.compose.project=wlqa-aws --format '{{.Names}} {{.Status}}' > "$OUT/aws-ps.txt"
  python3 -B "$HERE/app_probe.py" probe --wait 60 --json "$OUT/probe.json" > "$OUT/probe.txt" 2>&1; prc=$?
  log "probe rc=$prc: $(tail -1 "$OUT/probe.txt" | cut -c1-400)"
  for c in api collector; do docker logs "wlqa-aws-$c-1" 2>&1 | grep -E 'permission denied|42501|InsufficientPrivilege|must be owner' | cut -c1-300 | head -8 > "$OUT/perm-$c.txt"; done
  log "verdict mode=$mode: rows=$rows_rc acl=$acl_rc up=$urc probe=$prc"
  [ "$rows_rc" = 0 ] && [ "$acl_rc" = 0 ] && [ "$urc" = 0 ] && [ "$prc" = 0 ]
  ;;
*) echo "backup · restore" >&2; exit 2 ;;
esac
