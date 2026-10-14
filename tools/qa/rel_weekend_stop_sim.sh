#!/bin/bash
# QA 2026-10 AWS(계획 §3.4 '평일 정지 흉내 · 데몬 재시작'): 스택 B(wlqa-b · 8702) 전체를 EC2 정지처럼 한꺼번에 멈추고, DB 에 '주말이 지난' 상태를 만든 뒤
# 데몬 재시작처럼 db 를 뺀 모든 컨테이너를 순서 없이 동시에 띄우고 DB_LATE_S 뒤 db 를 띄운다(RDS 가 EC2 보다 늦게 준비되는 AWS 아침). 시계는 바꾸지 않는다.
#
# 만드는 상태(합성 항적 — hex qa12d0..qa12d9 · 관심 지역 안 · 기존 행과 겹치지 않음):
#   F = 지금(UTC) − 96 h 의 KST 날짜('금요일'): 그날 첫 순간이 든 UTC 파티션의 끝이 now − 72 h 보다 앞 — 시계로는 다시 셀 수 없고 파티션이 남아 있어야 센다
#       (MaintenanceJobs.trafficRecountable · 독립 리뷰 M3). 교통량 완료 표식(aggregated_at · traffic)을 지워 둔다.
#   H = 지금 − 30 h 의 닫힌 한 시간('멈추기 직전 시간'): 원해상도만 있고 1분 요약이 없다 → 따라잡기가 요약해야 한다(70 h 창 안).
#   O = 보존 기준보다 오래된 UTC 날 파티션(지금 − 5일) 하나: 첫 따라잡기가 성공하기 전 :02 에는 지우지 않는다(DROP_HOLD) — :02 를 지나야 보인다(WAIT_DROP=1).
# 확인: 기동 뒤 첫 따라잡기(1분 뒤 · 실패하면 1분 · 2분 …)가 F 의 교통량(traffic_by_hour · 표식)과 H 의 1분 요약을 채우는가, 모든 컨테이너가 스스로 healthy 가 되는가,
#   migrate 없이 이어지는가(데몬은 restart:"no" 인 migrate 를 띄우지 않는다), 새 항적 · 선박 행이 다시 쌓이는가.
#
#   bash tools/qa/rel_weekend_stop_sim.sh [증거 폴더]
# psql 은 db 컨테이너 안 로컬 소켓(postgres — 비밀번호 없음). 사용자의 .env 를 읽지 않는다.
set -uo pipefail
cd "$(dirname "$0")/../.."
P=wlqa-b
B=http://localhost:8702
OUT="${1:-docs/qa/2026-10-aws/evidence/reliability/weekend-sim-$(date +%H%M%S)}"
DB_LATE_S="${DB_LATE_S:-30}"
mkdir -p "$OUT"
c() { echo "$P-$1-1"; }
psqlq() { docker exec "$(c db)" psql -X -U postgres -d wakeline -v ON_ERROR_STOP=1 -Atc "$1"; }
log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/run.log"; }
health() { curl -s -m 3 "$B/healthz" | python3 -c 'import sys,json
try: d=json.load(sys.stdin); print(d.get("status"), ",".join(d.get("reasons") or []))
except Exception: print("down")'; }
restore() { docker start "$(c db)" "$(c redis)" "$(c api)" "$(c collector)" "$(c ais)" "$(c web)" "$(c edge)" >/dev/null 2>&1; true; }
trap restore EXIT

read -r F H O FIRST_UTC_DAY <<<"$(python3 - <<'PY'
import datetime as d
now = d.datetime.now(d.UTC)
kst = d.timezone(d.timedelta(hours=9))
f = (now - d.timedelta(hours=96)).astimezone(kst).date()                 # '금요일'(KST 날짜)
h = (now - d.timedelta(hours=30)).replace(minute=0, second=0, microsecond=0)
o = (now - d.timedelta(days=5)).date()
first = (d.datetime.combine(f, d.time(), kst)).astimezone(d.UTC).date()  # F 의 첫 순간이 든 UTC 날
print(f.isoformat(), h.strftime("%Y-%m-%dT%H:%M:%SZ"), o.isoformat(), first.isoformat())
PY
)"
log "weekend sim — F(KST day)=$F (first UTC day $FIRST_UTC_DAY), H(hour)=$H, O(old partition day)=$O, db late ${DB_LATE_S}s; health=$(health)"

# 1) EC2 정지처럼 한꺼번에(각 컨테이너의 유예 — api · collector 30 s · ais 20 s)
docker stop "$(c edge)" "$(c web)" "$(c api)" "$(c collector)" "$(c ais)" "$(c redis)" >/dev/null &
SP=$!
docker stop "$(c db)" >/dev/null; wait "$SP"
log "all containers stopped"

# 2) 주말이 지난 DB 상태(db 만 잠깐 띄워 쓴다 — 쓰는 컨테이너는 모두 멈춰 있다)
docker start "$(c db)" >/dev/null
for i in $(seq 1 60); do docker exec "$(c db)" pg_isready -q -U postgres -d wakeline && break; sleep 1; done
docker exec -i "$(c db)" psql -X -U postgres -d wakeline -v ON_ERROR_STOP=1 -v F="$F" -v H="$H" -v O="$O" -v FU="$FIRST_UTC_DAY" > "$OUT/inject.log" 2>&1 <<'SQL'
SET TIME ZONE 'UTC';
SET ROLE wakeline_migrator;   -- 운영 파티션과 같은 소유자 · 기본 권한
SELECT format('CREATE TABLE IF NOT EXISTS track_point_%s PARTITION OF track_point FOR VALUES FROM (%L) TO (%L)', to_char(d, 'YYYYMMDD'), d, d + 1)
FROM generate_series(:'O'::date, (:'H'::timestamptz)::date, interval '1 day') g(x), LATERAL (SELECT x::date d) s \gexec
RESET ROLE;
-- F: KST 날짜 하루 내내(00–23 KST) 한 시간에 하나씩, 항공기 10대(hex qa12d0..9) — 관심 지역(36.5,127.8 · 250 NM) 안
INSERT INTO track_point (hex, ts, geom, alt_ft, gs_kt, track_deg, provider, fetched_at)
SELECT 'qa12d' || i, t, ST_SetSRID(ST_MakePoint(127.0 + i * 0.05, 36.0 + h * 0.02), 4326), 30000, 420, 90, 'fixture', t
FROM generate_series(0, 9) i, generate_series(0, 23) h, LATERAL (SELECT (:'F'::date + make_interval(hours => h, mins => 7)) AT TIME ZONE 'Asia/Seoul' AS t) z ON CONFLICT DO NOTHING;
-- -- H: 닫힌 한 시간, 1분마다(1분 요약 따라잡기 대상)
INSERT INTO track_point (hex, ts, geom, alt_ft, gs_kt, track_deg, provider, fetched_at)
SELECT 'qa12d' || i, t, ST_SetSRID(ST_MakePoint(128.0 + m * 0.01, 35.0 + i * 0.05), 4326), 20000, 300, 45, 'fixture', t
FROM generate_series(0, 9) i, generate_series(0, 59) m, LATERAL (SELECT :'H'::timestamptz + make_interval(mins => m, secs => 5) AS t) z ON CONFLICT DO NOTHING;
-- O: 보존보다 오래된 파티션의 행 하나
INSERT INTO track_point (hex, ts, geom, alt_ft, gs_kt, track_deg, provider, fetched_at)
VALUES ('qa12d0', :'O'::date + interval '12 hours', ST_SetSRID(ST_MakePoint(127.5, 36.5), 4326), 10000, 250, 0, 'fixture', :'O'::date + interval '12 hours') ON CONFLICT DO NOTHING;
DELETE FROM track_point_1m WHERE ts_minute >= :'H'::timestamptz AND ts_minute < :'H'::timestamptz + interval '1 hour';
DELETE FROM stats_daily WHERE day = :'F'::date AND (metric IN ('traffic_by_hour', 'traffic_region') OR (metric = 'aggregated_at' AND dim = 'traffic'));
SELECT 'injected', (SELECT count(*) FROM track_point WHERE hex LIKE 'qa12d%'), to_regclass('track_point_' || to_char(:'O'::date, 'YYYYMMDD')) IS NOT NULL;
SQL
log "state injected: $(tail -1 "$OUT/inject.log")"
docker stop "$(c db)" >/dev/null
log "db stopped again"

# 3) 데몬 재시작처럼: db 를 뺀 모든 컨테이너를 순서 없이 동시에(depends_on 없음 — migrate 는 restart:no 라 데몬이 띄우지 않는다), db 는 늦게
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker start "$(c edge)" "$(c web)" "$(c api)" "$(c collector)" "$(c ais)" "$(c redis)" >/dev/null
log "edge · web · api · collector · ais · redis started at once (db down)"
sleep "$DB_LATE_S"
docker start "$(c db)" >/dev/null
log "db started ${DB_LATE_S}s later"

# 4) 회복: 모든 컨테이너 healthy + /healthz ok + 첫 따라잡기 성공(로그) — 최대 6분
ok_at=""
for i in $(seq 1 180); do
  states=$(docker ps --filter "label=com.docker.compose.project=$P" --format '{{.Names}}={{.Status}}' | sort | tr '\n' ' ')
  if [ "$(health | cut -d' ' -f1)" = ok ] && ! grep -qE 'starting|unhealthy|Restarting' <<<"$states" \
     && docker logs --since "$T0" "$(c api)" 2>&1 | grep -qE 'catch-up: summarized|catch-up succeeded'; then ok_at=$(date -u +%H:%M:%SZ); break; fi
  sleep 2
done
log "recovered at ${ok_at:-NEVER (6 min)}: $(docker ps -a --filter "label=com.docker.compose.project=$P" --format '{{.Names}}={{.Status}}' | sort | tr '\n' ' ')"
docker logs --since "$T0" "$(c api)" 2>&1 | grep -E 'Started Wakeline|catch-up|retention|ensure|partition|daily stats|1-minute|ERROR' | cut -c1-330 > "$OUT/api-log.txt"
docker logs --since "$T0" "$(c collector)" 2>&1 | grep -E 'WARNING|ERROR|db:' | cut -c1-250 | head -40 > "$OUT/collector-log.txt"
docker inspect -f '{{.Name}} restarts={{.RestartCount}}' $(docker ps -aq --filter "label=com.docker.compose.project=$P") > "$OUT/restarts.txt"

# 5) 확인
{
  echo "F traffic_by_hour rows: $(psqlq "SELECT count(*) FROM stats_daily WHERE day = '$F' AND metric = 'traffic_by_hour'") (synthetic hours 24, each ≥ 10 aircraft)"
  echo "F traffic marker: $(psqlq "SELECT count(*) FROM stats_daily WHERE day = '$F' AND metric = 'aggregated_at' AND dim = 'traffic'")"
  echo "F traffic sum(min per hour): $(psqlq "SELECT coalesce(min(value),0) FROM stats_daily WHERE day = '$F' AND metric = 'traffic_by_hour'")"
  echo "H 1-minute summary rows for qa12d*: $(psqlq "SELECT count(*) FROM track_point_1m WHERE hex LIKE 'qa12d%' AND ts_minute >= '$H' AND ts_minute < '$H'::timestamptz + interval '1 hour'") (expected 600)"
  echo "O partition track_point_$(date -u -j -f %Y-%m-%d "$O" +%Y%m%d 2>/dev/null || echo "$O") exists: $(psqlq "SELECT to_regclass('track_point_' || to_char('$O'::date, 'YYYYMMDD')) IS NOT NULL")"
  echo "new rows since restart: track_point=$(psqlq "SELECT count(*) FROM track_point WHERE ts >= '$T0'") ship_position=$(psqlq "SELECT count(*) FROM ship_position WHERE ts >= '$T0'") ingest_run=$(psqlq "SELECT count(*) FROM ingest_run WHERE started_at >= '$T0'")"
  echo "health: $(health)"
} | tee -a "$OUT/run.log"
trap - EXIT
