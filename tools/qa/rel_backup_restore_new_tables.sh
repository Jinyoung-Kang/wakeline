#!/usr/bin/env bash
# 출시 QA 2차 신뢰성(docs/qa/2026-10-release QA-PLAN §3.4 · 백업 → 복원): 격리 스택 A(wakeline-e2e)에서 README '백업·복원' 절차 그대로 —
# make backup → api·collector·ais 정지 → db 컨테이너 · 볼륨 삭제(격리 스택 — 버리는 자료) → db 만 새 볼륨 → make restore → 다시 기동.
# 앞선 QA 뒤 더한 표(V18 공역 · V19 알림 구역 · V20 특보 이력 · V21 지정 보존 · 설정 두 키)의 행이 복원 뒤 같은지 대조한다. 운영 스택(wakeline)은 건드리지 않는다.
#   tools/qa/rel_backup_restore_new_tables.sh      # 다르면 종료 코드 1, 기록은 evidence/reliability/backup_restore.txt
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
P=wakeline-e2e
ev="$root/docs/qa/2026-10-release/evidence/reliability"; mkdir -p "$ev"; out="$ev/backup_restore.txt"; : > "$out"
iso() { WAKELINE_FIXTURE_MODE=1 WAKELINE_PORT=8701 WAKELINE_NET_PREFIX=10.78.0 docker compose -p "$P" -f infra/compose.yml --env-file .env "$@"; }
sql() { docker exec "$P-db-1" psql -X -U postgres -d wakeline -At -c "$1"; }
TABLES="wx_warning retained_track airspace airspace_edition alert_event sigmet audit_log ops_user app_setting"
counts() { for t in $TABLES; do printf '%s=%s ' "$t" "$(sql "SELECT count(*) FROM $t")"; done; printf 'retain_targets=%s airspace_alerts=%s' \
  "$(sql "SELECT value FROM app_setting WHERE key='retain_targets'")" "$(sql "SELECT value FROM app_setting WHERE key='airspace_alerts'")"; }

# 새 표마다 적어도 한 행 — 지정 보존 점 · 설정 값(복원 뒤 같은 값인지 보이게)
sql "INSERT INTO retained_track (kind, target_id, ts_minute, ts, geom, provider) VALUES ('ship','440999001', date_trunc('minute', now() - interval '100 days'), date_trunc('minute', now() - interval '100 days') + interval '7 seconds', ST_SetSRID(ST_MakePoint(129,35),4326), 'qa') ON CONFLICT DO NOTHING" >/dev/null
sql "UPDATE app_setting SET value = to_jsonb('440999001'::text) WHERE key = 'retain_targets'" >/dev/null
iso stop api collector ais >/dev/null 2>&1   # 백업 시점의 행을 고정(실행 중이어도 pg_dump 는 한 스냅샷이지만, 대조할 수를 같은 순간에 세려고)
before=$(counts); echo "before: $before" | tee -a "$out"

make -s backup P="$P" keep=0 2>&1 | tail -2 | tee -a "$out"
f=$(ls -t backups/"$P"-*.dump | head -1); echo "file: $f ($(stat -f%z "$f") B, mode $(stat -f%Sp "$f"))" | tee -a "$out"

iso rm -sf db >/dev/null 2>&1
docker volume rm "${P}_db_data" >/dev/null
iso up -d --no-build --wait db >/dev/null 2>&1
make -s restore P="$P" f="$f" confirm="$P" 2>&1 | tail -3 | tee -a "$out"
after=$(counts); echo "after:  $after   (복원 직후 — api · collector · ais 기동 전)" | tee -a "$out"
iso up -d --no-build --wait >/dev/null 2>&1
echo "stack up again: $(iso ps --format '{{.Service}}={{.Health}}' | tr '\n' ' ')" | tee -a "$out"
if [ "$before" = "$after" ]; then echo "RESULT ok — 모든 표의 행 수 · 설정 값이 같다" | tee -a "$out"; else echo "RESULT FAIL — 다르다" | tee -a "$out"; exit 1; fi
