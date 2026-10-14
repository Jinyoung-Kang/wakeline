#!/bin/bash
# QA-1240 재현(QA 2026-10 AWS · 신뢰성 · 데이터 손실): 긴 정지(연휴 — 마지막 기동이 만든 파티션이 '오늘'을 덮지 못함) 뒤, DB 가 api 보다 늦게 준비되면
# 기동 5 s 뒤 한 번 도는 파티션 보장(MaintenanceJobs.ensurePartitions — 그다음은 6 h 뒤)이 실패하고, 그 6 h 동안 오늘(UTC) 항적 · 선박 위치 행은
# '파티션 없음'(SQLState 23514 — 영구 오류)으로 3번 시도 뒤 버려진다(영수증을 놓아 ACK — 다시 오지 않는다).
#
# 스택 B(wlqa-b · 8702)만. 시계를 바꾸지 않고 '오늘 파티션이 없는 상태'를 만든다: 쓰는 컨테이너를 멈춘 뒤 오늘(UTC) track_point · ship_position 파티션을
# DETACH 하고 이름을 바꿔 보관한다(행은 그대로) → db 를 멈춘 채 api · collector · ais 를 띄운다(데몬 재시작 — RDS 가 늦게 준비되는 AWS 아침) →
# DB_LATE_S 뒤 db 를 띄운다 → OBSERVE_S 동안 관찰 → 스트림 ↔ DB 대조(tools/qa/stream_db_integrity.py) → 보관한 파티션을 다시 붙인다(되돌리기).
#
#   bash tools/qa/rel_qa_1240_partition_after_long_stop.sh [증거 폴더]      # 결함이면(행 손실) 종료 코드 1
#
# psql · redis-cli 는 컨테이너 안 로컬 소켓(비밀번호가 명령행에 없다). 사용자의 .env 를 읽지 않는다.
set -uo pipefail
cd "$(dirname "$0")/../.."
P=wlqa-b
B=http://localhost:8702
OUT="${1:-docs/qa/2026-10-aws/evidence/reliability/qa-1240-$(date +%H%M%S)}"
DB_LATE_S="${DB_LATE_S:-40}"
OBSERVE_S="${OBSERVE_S:-150}"
mkdir -p "$OUT"
c() { echo "$P-$1-1"; }
ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
psqlq() { docker exec "$(c db)" psql -X -U postgres -d wakeline -v ON_ERROR_STOP=1 -Atc "$1"; }
log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/run.log"; }
metric() { docker exec "$(c api)" curl -s -m 5 http://localhost:9000/actuator/prometheus 2>/dev/null | grep -E "^($1)" || true; }

D0=$(date -u +%Y%m%d)
D0ISO=$(date -u +%Y-%m-%d)
D1ISO=$(python3 -c "import datetime as d; print((d.date.fromisoformat('$D0ISO')+d.timedelta(days=1)).isoformat())")
secs_to_midnight=$(python3 -c "import datetime as d; n=d.datetime.now(d.UTC); print(int((n.replace(hour=0,minute=0,second=0,microsecond=0)+d.timedelta(days=1)-n).total_seconds()))")
[ "$secs_to_midnight" -gt 900 ] || { echo "UTC 자정 15분 안 — 날이 바뀌면 다른 파티션을 본다. 자정 뒤에 다시" >&2; exit 2; }

reattach() {
  # 되돌리기: db 가 떠 있게 한 뒤 보관한 파티션을 원래 이름 · 범위로 다시 붙인다(그사이 같은 이름이 새로 생겼으면 그 행을 옮기고 지운다)
  docker start "$(c db)" >/dev/null 2>&1
  for i in $(seq 1 60); do docker exec "$(c db)" pg_isready -q -U postgres -d wakeline && break; sleep 1; done
  for t in track_point ship_position; do
    held="qa1240_${t}_$D0"
    if [ "$(psqlq "SELECT to_regclass('public.$held') IS NOT NULL")" = t ]; then
      if [ "$(psqlq "SELECT to_regclass('public.${t}_$D0') IS NOT NULL")" = t ]; then
        psqlq "BEGIN; INSERT INTO $held SELECT * FROM ${t}_$D0 ON CONFLICT DO NOTHING; DROP TABLE ${t}_$D0; COMMIT;" >/dev/null
        log "reattach: a new ${t}_$D0 had been created meanwhile — moved its rows into the held partition"
      fi
      psqlq "BEGIN; ALTER TABLE $held RENAME TO ${t}_$D0; ALTER TABLE $t ATTACH PARTITION ${t}_$D0 FOR VALUES FROM ('$D0ISO') TO ('$D1ISO'); COMMIT;" >/dev/null \
        && log "reattach: ${t}_$D0 attached again"
    fi
  done
  docker start "$(c api)" "$(c collector)" "$(c ais)" >/dev/null 2>&1
}
trap reattach EXIT
trap 'exit 130' INT TERM

log "QA-1240 — today(UTC)=$D0, db late ${DB_LATE_S}s, observe ${OBSERVE_S}s; health=$(curl -s -m 3 $B/healthz)"
psqlq "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_class p ON p.oid=i.inhparent WHERE p.relname IN ('track_point','ship_position') ORDER BY 1" \
  > "$OUT/partitions-before.txt"
log "partitions before: $(tr '\n' ' ' < "$OUT/partitions-before.txt")"

# 1) 정지(평일 정지 · 연휴) — 쓰는 컨테이너를 정상 종료
docker stop "$(c api)" "$(c collector)" "$(c ais)" >/dev/null
log "writers stopped (api · collector · ais)"
# 2) 긴 정지 흉내: 오늘(UTC) 파티션이 없다 — 마지막 기동의 ensure(어제 ~ +3일)가 오늘에 닿지 못한 상태. 행은 보관 이름으로 남긴다
for t in track_point ship_position; do
  psqlq "BEGIN; ALTER TABLE $t DETACH PARTITION ${t}_$D0; ALTER TABLE ${t}_$D0 RENAME TO qa1240_${t}_$D0; COMMIT;" >/dev/null && log "$t: today's partition detached (held as qa1240_${t}_$D0)"
done
# 3) 데몬 재시작처럼: db 는 아직(RDS 준비 전), 나머지는 순서 없이 바로
docker stop "$(c db)" >/dev/null
T0=$(ms)
docker start "$(c collector)" "$(c ais)" "$(c api)" >/dev/null
log "api · collector · ais started while db is down"
sleep "$DB_LATE_S"
docker start "$(c db)" >/dev/null
log "db started ${DB_LATE_S}s later"
sleep "$OBSERVE_S"
UNTIL=$(( $(ms) - 15000 ))

docker logs --since "$(python3 -c "import datetime;print(datetime.datetime.fromtimestamp($T0/1000,datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'))")" "$(c api)" 2>&1 \
  | grep -E "Started Wakeline|ensure .* partitions|created .* partitions|no partition|track batch|ship batch|ship .*failed|catch-up|dropped" | cut -c1-330 > "$OUT/api-log.txt"
metric 'wakeline_track_rows_total|wakeline_ship_rows_total' > "$OUT/metrics.txt"
{
  echo "today partitions after ${OBSERVE_S}s: track_point_$D0=$(psqlq "SELECT to_regclass('public.track_point_$D0') IS NOT NULL") ship_position_$D0=$(psqlq "SELECT to_regclass('public.ship_position_$D0') IS NOT NULL")"
  echo "rows written since the restart: track_point=$(psqlq "SELECT count(*) FROM track_point WHERE ts >= to_timestamp($T0/1000.0)") ship_position=$(psqlq "SELECT count(*) FROM ship_position WHERE ts >= to_timestamp($T0/1000.0)")"
} | tee -a "$OUT/run.log"
grep -E "ensure|no partition|failed permanently" "$OUT/api-log.txt" | head -8 | tee -a "$OUT/run.log"
grep -E 'result="(failed|written|dropped)"' "$OUT/metrics.txt" | tee -a "$OUT/run.log"

# 4) 스트림 ↔ DB: 다시 띄운 뒤 발행된 엔트리의 행이 있는가(되돌리기 전에 — 붙이면 보관 행이 섞인다: 보관 행은 정지 전 것뿐이라 영향 없음)
python3 tools/qa/stream_db_integrity.py --project "$P" --since-ms "$T0" --until-ms "$UNTIL" --settle-s 60 --json "$OUT/integrity.json" > /dev/null
rc=$?
python3 -c "import json; d=json.load(open('$OUT/integrity.json')); print('defects', json.dumps(d['defects'], ensure_ascii=False)); print('expected', {'aircraft_rows': d['aircraft']['expected_rows'], 'ship_windows': d['ships']['expected_windows']})" | tee -a "$OUT/run.log"
log "integrity exit=$rc (1 = rows lost)"
reattach; trap - EXIT
for i in $(seq 1 90); do [ "$(curl -s -m 3 $B/healthz | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("status"))
except Exception: print("down")')" = ok ] && break; sleep 2; done
log "after reattach: health=$(curl -s -m 3 $B/healthz)"
if [ "$rc" -ne 0 ]; then log "QA-1240 DEFECT: rows of today (UTC) were dropped while its partition was missing and the startup ensure was not retried"; exit 1; fi
log "no loss"
exit 0
