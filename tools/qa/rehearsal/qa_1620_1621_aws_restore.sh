#!/usr/bin/env bash
# QA-1620 · QA-1621 재현(처음부터): AWS 백업 방식(aws-deploy rds/backup.sh)으로 받은 wakeline 덤프를 같은 bootstrap 으로 만든 새 RDS 흉내에 복원하면
#   QA-1620  소유 역할(wakeline_migrator)로 복원 → 권한(GRANT)이 없어 api 의 DB 읽기 500 · 운영 로그인 500 · api/collector 쓰기 권한 오류(/healthz ok)
#            마스터로 복원 → migrate 가 flyway_schema_history 권한 오류로 실패 → api · collector 가 뜨지 않음
#   QA-1621  README '데이터 이전' 의 복원 옵션(--exit-on-error) → 첫 항목(COMMENT ON EXTENSION postgis)에서 멈춰 0행, 이어서 up 하면 빈 스키마로 정상처럼 뜸
# 대조(통과해야 함): keepacl(소유자 · 권한을 담아 받은 덤프) · aclfix(받은 덤프 + 같은 판 migrate 의 ACL 덧입히기).
#
#   tools/qa/rehearsal/qa_1620_1621_aws_restore.sh [증거 폴더]     # 결함이 있으면 종료 코드 1, 고쳐지면 0(aws-deploy 의 backup.sh 를 그대로 쓴다)
# 쓰는 것: setup.py 가 만든 세션 임시 폴더의 시험 비밀값 · CA, 프로젝트 wlqa-rds · wlqa-aws(둘 다 down -v 로 새로 시작한다), 이미지 wakeline-*:qa.
# 걸리는 시간: 약 15분. aws-deploy 는 읽기만(backup.sh · bootstrap.sh 를 읽기 전용 마운트로 그대로 실행).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"; RS="$HERE/r.sh"
OUT=${1:-$ROOT/docs/qa/2026-10-aws/evidence/rehearsal/qa-1620-repro}; mkdir -p "$OUT"
R="${WLQA_R_DIR:-/private/tmp/claude-501/-Users-jinyoung-Projects-wakeline/3b40667d-7c26-4f92-9be9-6efb0a86ebea/scratchpad/qa/rehearsal}"
log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/repro.log"; }
python3 -B "$HERE/setup.py" > /dev/null

log "원본 만들기: wlqa-aws · wlqa-rds 를 지우고 새로(RDS 흉내 → bootstrap.sh → wakeline up → 90 s 수집 → 운영자 계정)"
"$RS" aws down -v > /dev/null 2>&1; "$RS" rds --profile holder --profile tools down -v > /dev/null 2>&1
rm -rf "$R/backups/aws" "$R/backups/keepacl"
"$RS" rds up -d --wait > /dev/null 2>&1 || { log "rds up 실패"; exit 2; }
"$RS" rds run --rm -T tools -c "bash /aws-deploy-rds/bootstrap.sh" > "$OUT/bootstrap.txt" 2>&1 || { log "bootstrap 실패"; exit 2; }
"$RS" aws up -d --wait --wait-timeout 300 > "$OUT/source-up.txt" 2>&1 || { log "wakeline up 실패"; exit 2; }
sleep 90
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["password"])' "$R/ops-creds.json" \
  | docker exec -i -e WAKELINE_OPS_USER="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["username"])' "$R/ops-creds.json")" \
      wlqa-aws-api-1 java -jar /app/app.jar --create-ops-user --password-stdin 2>&1 | grep -E 'ops user' > "$OUT/ops-user.txt"
python3 -B "$HERE/app_probe.py" probe --wait 30 --json "$OUT/source-probe.json" > /dev/null 2>&1 || { log "원본이 정상이 아님 — 중단"; exit 2; }
log "원본 정상(probe 통과) → 백업"
"$HERE/backup_restore.sh" backup "$OUT" > /dev/null

# 판정(고친 뒤 — aws-deploy fix/qa-aws-2026-10 55ccc4c): 지금의 backup.sh 덤프가 ① 권한(ACL) 항목을 담고 postgis 확장 항목을 빼며
# ② README '백업에서 복원' 절차(documented)로 복원한 뒤 wakeline 이 정상이어야 한다. 옛 절차(owner · master · readme)는 옛 덤프의 재현이라
# 여기서는 돌리지 않는다(증거: evidence/rehearsal/qa-1620-repro — 고치기 전 실행). aclfix(옛 덤프 절차)는 대조로 남긴다.
toc=$("$RS" rds run --rm -T tools -c "f=\$(ls -1t /backups/aws/wakeline-*.dump | head -1); echo acl=\$(pg_restore -l \"\$f\" | grep -c ' ACL '); echo ext=\$(pg_restore -l \"\$f\" | grep -cE ' EXTENSION - postgis | COMMENT - EXTENSION postgis ')" 2>/dev/null | tr '\n' ' ')
log "backup.sh 덤프 목차: $toc"
for m in documented aclfix; do
  "$HERE/backup_restore.sh" restore "$m" "$OUT/$m" > /dev/null 2>&1; eval "rc_$m=$?"
  log "restore $m → $(grep 'verdict mode' "$OUT/$m/run.log" | tail -1 | sed 's/^\[[^]]*\] //') (rc=$(eval echo \$rc_$m))"
done
fail=0
case "$toc" in *"acl=0"*) log "QA-1620: backup.sh 덤프에 권한 항목이 없다"; fail=1 ;; esac
case "$toc" in *"ext=0"*) ;; *) log "QA-1621: backup.sh 덤프에 postgis 확장 항목이 남아 있다"; fail=1 ;; esac
[ "$rc_documented" = 0 ] || { log "QA-1620: README 절차로 복원한 뒤 wakeline 이 정상이 아님 — $(tail -1 "$OUT/documented/probe.txt" 2>/dev/null | cut -c1-220)"; fail=1; }
[ "$rc_aclfix" = 0 ] && log "대조: aclfix(옛 덤프 절차) 통과" || log "대조 실패: aclfix=$rc_aclfix"
log "결과: $([ $fail = 0 ] && echo '결함 없음(종료 0)' || echo '결함 재현(종료 코드 1)')"
exit $fail
