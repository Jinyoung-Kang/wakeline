#!/bin/bash
# Wakeline 장애 주입 시험 — NFR-07/08, FR-19, ADR-014(AIS 공백). 개발 스택(8700)에서 실행. 각 시나리오의 복귀 시간과 불변식을 기록한다.
#
#   tools/chaos.sh                 # 전부(api collector redis db providers ais)
#   tools/chaos.sh ais             # AIS 네트워크 단절만 (AIS_CUT_S=60 기본)
#   tools/chaos.sh api redis       # 고른 것만
#
# 컨테이너는 compose 라벨(WAKELINE_PROJECT, 기본 wakeline)로 찾는다 — 이름을 박아 두지 않고 compose 파일도 해석하지 않는다.
# Redis·psql 은 각 컨테이너 안에서 그 컨테이너의 환경변수·로컬 소켓으로 실행한다: 비밀번호가 이 호스트의 명령행(ps)에 나오지 않는다.
# 주의: 실제로 컨테이너를 죽이고 네트워크를 끊는다. ais 시나리오는 aisstream.io 에 한 번 더 접속한다(재연결 1회).
set -uo pipefail
cd "$(dirname "$0")/.."
PROJECT="${WAKELINE_PROJECT:-wakeline}"
B="${WAKELINE_BASE_URL:-http://localhost:8700}"
AIS_CUT_S="${AIS_CUT_S:-60}"
case "$AIS_CUT_S" in ''|*[!0-9]*) echo "AIS_CUT_S must be seconds" >&2; exit 2 ;; esac

cid() { docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" | head -1; }
now() { python3 -c 'import time; print(f"{time.time():.1f}")'; }
elapsed() { python3 -c "import sys; a,b=sys.argv[1:]; print('FAIL' if b=='FAIL' else round(float(b)-float(a),1))" "$1" "$2"; }
status() { curl -s -m 3 "$B/api/v1/status" 2>/dev/null; }
# field <점 경로> — stdin 의 JSON 에서 값 하나(없으면 None, 해석 실패 ERR). eval 을 쓰지 않는다.
field() { python3 -c "import sys,json
try:
  d=json.load(sys.stdin)
  for k in sys.argv[1].split('.'):
    d=d[int(k)] if isinstance(d,list) else (d or {}).get(k)
  print(d)
except Exception: print('ERR')" "$1"; }
redis() { docker exec "$(cid redis)" sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli --no-auth-warning "$@"' sh "$@"; }
psqlq() { docker exec -u postgres "$(cid db)" psql -X -U postgres -d wakeline -Atc "$1"; }
wait_until() { local deadline=$(( $(date +%s) + $1 )); shift; while [ "$(date +%s)" -lt "$deadline" ]; do if eval "$@" >/dev/null 2>&1; then return 0; fi; sleep 1; done; return 1; }
# crash <서비스> — 앱 프로세스를 SIGKILL(실제 비정상 종료와 같다). `docker kill` 은 도커가 '수동 정지' 로 보고 재시작 정책을 건너뛰므로 쓰지 않는다
# (Docker 29 실측: api·collector·redis 가 Exited(137) 로 남음). PID 1 은 docker-init(compose init: true)이라, 그 밖의 모든 프로세스를 죽이면
# init 이 137 로 끝나고 unless-stopped 정책이 컨테이너를 다시 띄운다.
crash() { docker exec "$(cid "$1")" sh -c 'kill -9 -1' >/dev/null 2>&1 || true; }
restarts() { docker inspect -f '{{.RestartCount}}' "$(cid "$1")" 2>/dev/null; }
health() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null; }
# ts_after <값> <ISO> — 값(ISO-8601 또는 epoch 초/밀리초)이 ISO 시각보다 뒤인가. 해석할 수 없으면 거짓.
ts_after() { python3 -c "import sys
from datetime import datetime, timezone
def p(v):
    v = v.strip()
    try:
        x = float(v); return datetime.fromtimestamp(x / 1000 if x > 1e11 else x, timezone.utc)
    except ValueError:
        t = datetime.fromisoformat(v.replace('Z', '+00:00').replace(' +0000 UTC', '+00:00'))
        return t if t.tzinfo else None
try:
    a, b = p(sys.argv[1]), p(sys.argv[2]); sys.exit(0 if a and b and a > b else 1)
except Exception:
    sys.exit(1)" "$1" "$2"; }

# 끊거나 멈춘 동안 스크립트가 끝나면(Ctrl-C·TERM·오류) 원상 복구한다: 복구 명령을 EXIT 트랩에 걸고, INT/TERM 은 exit 로 EXIT 트랩을 부른다.
# 정상 복구 뒤에는 트랩을 지운다(untrap). hold 는 sleep 을 백그라운드로 두고 wait 한다 — TERM 트랩이 sleep 이 끝나기를 기다리지 않는다.
trap_restore() { trap "$1" EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; }
untrap() { trap - EXIT INT TERM; }
hold() { sleep "$1" & wait "$!"; }

for s in api redis db; do [ -n "$(cid "$s")" ] || { echo "no '$s' container in compose project '$PROJECT' — is the stack up?" >&2; exit 2; }; done
SCENARIOS=("$@"); [ ${#SCENARIOS[@]} -gt 0 ] || SCENARIOS=(api collector redis db providers ais)
wants() { local x; for x in "${SCENARIOS[@]}"; do [ "$x" = "$1" ] && return 0; done; return 1; }

echo "=== baseline (project $PROJECT)"; status | field region.aircraft; redis XPENDING wakeline:aircraft api | head -1

if wants api; then
echo; echo "=== 1. kill -9 api (NFR-08: recover ≤ 60 s, PEL reprocessed, no duplicate track rows)"
tp0=$(psqlq "SELECT count(*) FROM track_point"); dup0=$(psqlq "SELECT count(*) - count(DISTINCT (hex, ts)) FROM track_point")
t0=$(now); crash api
wait_until 120 '[ "$(status | field region.aircraft)" -gt 0 ]' && t1=$(now) || t1=FAIL
echo "api back with aircraft after: $(elapsed "$t0" "$t1") s"
echo "pending after recovery: $(redis XPENDING wakeline:aircraft api | head -1)"
sleep 25; dup1=$(psqlq "SELECT count(*) - count(DISTINCT (hex, ts)) FROM track_point"); tp1=$(psqlq "SELECT count(*) FROM track_point")
echo "track rows +$((tp1-tp0)), duplicate (hex,ts): $dup0 → $dup1"
echo "open alerts closed as restart: $(psqlq "SELECT count(*) FROM alert_event WHERE close_reason='restart'")"
fi

if wants collector; then
echo; echo "=== 2. kill -9 collector (restart ≤ 60 s, fresh data resumes)"
v0=$(status | field snapshot_version); t0=$(now); crash collector
wait_until 120 '[ "$(status | field snapshot_version)" -gt '"$v0"' ] && [ "$(status | field region.lag_s)" != "None" ]' && t1=$(now) || t1=FAIL
echo "new snapshot after: $(elapsed "$t0" "$t1") s"
fi

if wants redis; then
echo; echo "=== 3. kill -9 redis (AOF; api keeps serving last state; recovers)"
t0=$(now); crash redis; sleep 3
echo "during redis outage /api/v1/aircraft: $(curl -s -o /dev/null -w '%{http_code}' "$B/api/v1/aircraft?bbox=124,33,132,39")"
v0=$(status | field snapshot_version)
wait_until 120 '[ "$(status | field snapshot_version)" != "ERR" ] && [ "$(status | field snapshot_version)" -gt '"${v0/ERR/0}"' ]' && t1=$(now) || t1=FAIL
echo "ingest resumed after: $(elapsed "$t0" "$t1") s"
echo "stream group intact: $(redis XINFO GROUPS wakeline:aircraft | head -2 | tr '\n' ' ')"
fi

if wants db; then
echo; echo "=== 4. stop db 40 s (live path continues; DB endpoints 503; track queue flushes after)"
DB="$(cid db)"
db_restore() { echo "chaos: restarting db ($DB)" >&2; docker start "$DB" >/dev/null 2>&1 || true; }
trap_restore db_restore
docker stop "$DB" >/dev/null 2>&1; hold 5
echo "live /aircraft: $(curl -s -o /dev/null -w '%{http_code}' "$B/api/v1/aircraft?bbox=124,33,132,39")  history /alerts/history: $(curl -s -o /dev/null -w '%{http_code}' "$B/api/v1/alerts/history")  retry-after: $(curl -s -D - -o /dev/null "$B/api/v1/alerts/history" | grep -i retry-after | tr -d '\r')"
echo "aircraft during db outage: $(status | field region.aircraft)"
hold 35; docker start "$DB" >/dev/null 2>&1
untrap
wait_until 90 '[ "$(psqlq "SELECT count(*) FROM track_point WHERE ts > now() - interval '"'"'30 seconds'"'"'")" -gt 0 ]' && echo "track writes resumed" || echo "track writes NOT resumed"
echo "rows written for the outage window: $(psqlq "SELECT count(*) FROM track_point WHERE fetched_at > now() - interval '3 minutes'")"
fi

if wants providers; then
echo; echo "=== 5. all region providers disabled (FR-19: last snapshot kept, stale flag)"
echo "(done via ops API in the orchestrator session — needs login)"
fi

if wants ais; then
echo; echo "=== 6. AIS network cut ${AIS_CUT_S} s (docker network disconnect/connect of the ais container — ADR-014: gap recorded, reconnect with backoff)"
A="$(cid ais)"
if [ -z "$A" ]; then echo "no ais container — skipped"; else
  # 끊으면 ais 컨테이너는 aisstream.io 와 redis 둘 다 못 본다: 공백 기록(ais_gap)은 다시 붙은 뒤에 발행된다(계약 v2 §B1).
  # ais 는 wakeline(내부 — redis) · egress(인터넷 — aisstream.io) 두 망에 있다(R-64) — 모두 끊어야 둘 다 못 본다.
  NETS="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$A" | sed '/^$/d' | tr '\n' ' ')"
  st() { redis HGET wakeline:ais:status "$1" 2>/dev/null | tr -d '\r'; }
  echo "before: connected=$(st connected) last_msg_at=$(st last_msg_at) msgs_per_s=$(st msgs_per_s) gap_open_since='$(st gap_open_since)' health=$(health "$A") restarts=$(docker inspect -f '{{.RestartCount}}' "$A")"
  gaps0=$(psqlq "SELECT count(*) FROM ingest_gap" 2>/dev/null || echo "?")
  t0=$(now); since_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # 끊긴 채로 끝나면 ais 는 docker restart 로도 다시 붙지 않는다 — 중단되면 다시 붙이고 끝낸다
  ais_restore() { echo "chaos: reconnecting ais ($A) to $NETS" >&2; for n in $NETS; do docker network connect --alias ais "$n" "$A" >/dev/null 2>&1 || true; done; }
  trap_restore ais_restore
  for n in $NETS; do docker network disconnect "$n" "$A" || { echo "disconnect failed ($n)"; exit 1; }; done
  echo "disconnected from $NETS at $since_iso; holding ${AIS_CUT_S} s …"
  hold "$AIS_CUT_S"
  echo "health while cut: $(health "$A") (redis is also unreachable from ais during the cut)"
  for n in $NETS; do docker network connect --alias ais "$n" "$A" || { echo "reconnect failed — run: docker network connect $n $A"; exit 1; }; done
  untrap
  t1=$(now)
  # 복귀 = 다시 연결되어(connected=1) 공백이 닫히고(gap_open_since 비어 있음) 끊은 뒤의 메시지를 받음
  ais_ok() { local c; c="$(st connected)"; { [ "$c" = 1 ] || [ "$c" = true ]; } && [ -z "$(st gap_open_since)" ] && ts_after "$(st last_msg_at)" "$since_iso"; }
  wait_until 180 ais_ok && t2=$(now) || t2=FAIL
  echo "reconnected and receiving after network restore: $(elapsed "$t1" "$t2") s (backoff 1→60 s ±20 %)"
  echo "after: connected=$(st connected) last_msg_at=$(st last_msg_at) msgs_per_s=$(st msgs_per_s) dropped_total=$(st dropped_total) health=$(health "$A") restarts=$(docker inspect -f '{{.RestartCount}}' "$A")"
  sleep 12   # 다음 10 s 배치로 ais_gap 이 api 에 도착·저장될 시간
  echo "ingest_gap rows: $gaps0 → $(psqlq "SELECT count(*) FROM ingest_gap" 2>/dev/null || echo "?")"
  echo "latest gap: $(psqlq "SELECT source || ' ' || started_at || ' → ' || coalesce(ended_at::text, 'open') || ' (' || coalesce(reason, '—') || ')' FROM ingest_gap ORDER BY started_at DESC LIMIT 1" 2>/dev/null || echo "—")"
  echo "cut window (host clock): $since_iso + ${AIS_CUT_S} s"
  echo "REST /api/v1/ais/gaps: $(curl -s -o /dev/null -w '%{http_code}' "$B/api/v1/ais/gaps?from=$since_iso")  status.sources.ais.gap_open_since: $(status | field sources.ais.gap_open_since)"
fi
fi
