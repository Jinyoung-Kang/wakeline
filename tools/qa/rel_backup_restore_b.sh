#!/bin/bash
# QA 2026-10 AWS(계획 §3.4 '백업 → 복원'): 스택 B(wlqa-b · 8702)에서 README '백업·복원' 절차를 tools/db-backup.sh · tools/db-restore.sh 로 그대로 —
# compose 명령은 make 대신 tools/qa/wlqa.sh B(시험 env — 사용자의 .env 를 읽지 않는다). 새 표(wx_warning · retained_track · airspace · port_call 등)까지
# 표마다 행 수 · 지문(tools/qa/db_snapshot.py) · 권한(역할별 표 권한 · SECURITY DEFINER 함수 실행 권한) · 기동 뒤 api 응답 · 운영자 로그인을 견준다.
#
#   WLQA_ENV=<시험 env> bash tools/qa/rel_backup_restore_b.sh [증거 폴더] [default|full|aws]
#     default: 기본 백업(원해상도 파티션은 구조만) · full: FULL=1 · aws: pg_dump -Fc --no-owner --no-privileges(QA 계획 §1.2 의 AWS backup.sh 옵션)
#   QA_OPS_CREDS=<{"username","password"} JSON 파일> 이면 복원 뒤 운영자 로그인을 확인한다(값을 출력하지 않는다).
# 백업 파일은 세션 임시 폴더(BACKUP_DIR, 0700)에만 둔다 — 저장소 backups/ 를 쓰지 않는다. 되돌릴 수 없는 일: 스택 B 의 db 볼륨(wlqa-b_db_data)을 지우고 복원본으로 바꾼다.
set -uo pipefail
cd "$(dirname "$0")/../.."
: "${WLQA_ENV:?WLQA_ENV 필요}"
P=wlqa-b
B=http://localhost:8702
OUT="${1:-docs/qa/2026-10-aws/evidence/reliability/backup-restore-$(date +%H%M%S)}"
MODE="${2:-default}"
BACKUP_DIR="${BACKUP_DIR:-/private/tmp/claude-501/-Users-jinyoung-Projects-wakeline/3b40667d-7c26-4f92-9be9-6efb0a86ebea/scratchpad/qa-backups}"
mkdir -p "$OUT"; umask 077; mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
c() { echo "$P-$1-1"; }
wl() { tools/qa/wlqa.sh B "$@"; }
psqlq() { docker exec "$(c db)" psql -X -U postgres -d wakeline -v ON_ERROR_STOP=1 -Atc "$1"; }
log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/run.log"; }
grants() {  # 역할별 public 표 권한 · 함수 실행 권한 · 소유자 — 복원 전후 비교용(값이 아니라 구조)
  psqlq "SELECT 'table', c.relname, pg_get_userbyid(c.relowner), coalesce(array_to_string(array(SELECT unnest(c.relacl)::text ORDER BY 1), ','), '-')
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v') AND c.relname <> 'spatial_ref_sys'
         UNION ALL
         SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_userbyid(p.proowner),
                (CASE WHEN p.prosecdef THEN 'definer ' ELSE '' END) || coalesce(array_to_string(array(SELECT unnest(p.proacl)::text ORDER BY 1), ','), '-')
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname ~ '^(track_point|ship_position|stats|wakeline)'
         ORDER BY 1, 2"
}

log "backup → restore on stack B (mode $MODE)"
# 1) 쓰는 컨테이너를 멈춘다(스냅샷 · 백업 · 복원본이 같은 시점) — README: 복원 전 api·collector·ais·migrate 정지
wl stop edge web api collector ais > "$OUT/compose-stop.log" 2>&1
WLQA_PROJECT=$P python3 tools/qa/db_snapshot.py > "$OUT/before.json"
grants > "$OUT/grants-before.txt"
log "snapshot before: $(python3 -c "import json;d=json.load(open('$OUT/before.json'));print(len([k for k in d if not k.startswith('_')]),'tables, flyway V'+str(d['_flyway']))")"

# 2) 백업
case "$MODE" in
  default) WAKELINE_PROJECT=$P KEEP=0 bash tools/db-backup.sh --out "$BACKUP_DIR" | tee -a "$OUT/run.log" ;;
  full)    WAKELINE_PROJECT=$P KEEP=0 FULL=1 bash tools/db-backup.sh --out "$BACKUP_DIR" | tee -a "$OUT/run.log" ;;
  aws)
    f="$BACKUP_DIR/$P-aws-$(date -u +%Y%m%dT%H%M%SZ).dump"
    docker exec -u postgres "$(c db)" pg_dump --format=custom --no-owner --no-privileges --dbname=wakeline --no-password > "$f"
    log "backup(aws options --no-owner --no-privileges): $f ($(du -h "$f" | cut -f1))" ;;
esac
FILE=$(ls -t "$BACKUP_DIR"/$P-*.dump | head -1)
stat -f '%Sp %N' "$FILE" | sed "s#$BACKUP_DIR#<BACKUP_DIR>#" | tee -a "$OUT/run.log"

# 3) 안전장치(아무것도 바꾸지 않아야 한다): 틀린 확인 문구 · 비어 있지 않은 DB
WAKELINE_PROJECT=$P bash tools/db-restore.sh --file "$FILE" --confirm wrong > "$OUT/refuse-confirm.txt" 2>&1; echo "wrong confirm rc=$?" | tee -a "$OUT/run.log"
WAKELINE_PROJECT=$P bash tools/db-restore.sh --file "$FILE" --confirm $P > "$OUT/refuse-nonempty.txt" 2>&1; echo "non-empty db rc=$?" | tee -a "$OUT/run.log"

# 4) 새 볼륨 → db 만 → 복원
wl down > "$OUT/compose-down.log" 2>&1
docker volume rm ${P}_db_data | tee -a "$OUT/run.log"
wl up -d --wait db > "$OUT/compose-db-up.log" 2>&1
WAKELINE_PROJECT=$P bash tools/db-restore.sh --file "$FILE" --confirm $P 2>&1 | tee "$OUT/restore.txt"
rrc=${PIPESTATUS[0]}
log "restore rc=$rrc"
WLQA_PROJECT=$P python3 tools/qa/db_snapshot.py > "$OUT/after.json"
grants > "$OUT/grants-after.txt"
expect=""; [ "$MODE" = full ] || expect="--expect-empty track_point_2*,ship_position_2*"
WLQA_PROJECT=$P python3 tools/qa/db_snapshot.py --compare "$OUT/before.json" "$OUT/after.json" $expect > "$OUT/compare.txt" 2>&1; crc=$?
log "compare rc=$crc: $(grep -c '^DIFF\|^MISSING' "$OUT/compare.txt") differences"
grep -E '^(DIFF|MISSING)' "$OUT/compare.txt" | head -20 | tee -a "$OUT/run.log"
if diff "$OUT/grants-before.txt" "$OUT/grants-after.txt" > "$OUT/grants-diff.txt"; then log "grants/owners: same"; else log "grants/owners: DIFFER ($(grep -c '^[<>]' "$OUT/grants-diff.txt") lines) — see grants-diff.txt"; fi

# 5) 전체 기동(migrate 가 이후 마이그레이션만) → api 응답 · 로그인
wl up -d --wait > "$OUT/compose-up.log" 2>&1; urc=$?
log "compose up --wait rc=$urc; migrate: $(docker logs "$(c migrate)" 2>&1 | grep -iE 'Successfully|up to date|applied|ERROR' | tail -2 | tr '\n' ' ')"
for i in $(seq 1 60); do [ "$(curl -s -m 3 $B/healthz | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("status"))
except Exception: print("down")')" = ok ] && break; sleep 2; done
log "health: $(curl -s -m 3 $B/healthz)"
for p in /api/v1/status /api/v1/warnings /api/v1/warnings/history /api/v1/airspace "/api/v1/alerts/history?limit=5" /api/v1/stats/traffic "/api/v1/aircraft?bbox=124,33,132,39"; do
  echo "$p $(curl -s -o /dev/null -w '%{http_code}' -m 10 -H 'Accept: application/json, application/geo+json' "$B$p")"
done | tee -a "$OUT/run.log"
if [ -n "${QA_OPS_CREDS:-}" ]; then
  python3 - "$QA_OPS_CREDS" <<'PY' | tee -a "$OUT/run.log"
import http.cookiejar, json, sys, urllib.request, urllib.error
cred = json.load(open(sys.argv[1]))
base = "http://localhost:8702"
jar = http.cookiejar.CookieJar(); op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def req(m, path, body=None):
    h = {"Accept": "application/json, application/problem+json"}
    if m != "GET":
        h.update({"Origin": base, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json"})
        tok = next((c.value for c in jar if c.name == "WAKELINE_CSRF"), None)
        if tok: h["X-CSRF-Token"] = tok
    r = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, method=m, headers=h)
    try:
        with op.open(r, timeout=20) as x: return x.status
    except urllib.error.HTTPError as e: return e.code
req("GET", "/api/v1/status"); req("GET", "/api/v1/ops/session")
st = req("POST", "/api/v1/ops/session", {"username": cred["username"], "password": cred["password"]})
print(f"ops login after restore: {st}; /ops/providers {req('GET', '/api/v1/ops/providers')}; /ops/settings {req('GET', '/api/v1/ops/settings')}; /ops/audit {req('GET', '/api/v1/ops/audit')}")
PY
fi
docker logs --since 3m "$(c api)" 2>&1 | grep -E 'ERROR|permission denied|42501' | cut -c1-300 | head -20 > "$OUT/api-errors.txt"
log "api ERROR/permission lines after start: $(wc -l < "$OUT/api-errors.txt")"
[ "$rrc" = 0 ] && [ "$crc" = 0 ] && [ "$urc" = 0 ]
