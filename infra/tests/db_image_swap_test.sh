#!/usr/bin/env bash
# R-63 · ADR-004 재결정: 이전 db 이미지(imresamu/postgis:18-3.6)로 만든 데이터 디렉터리를 새 이미지(infra/db — 공식 postgres:18-trixie + PGDG PostGIS 3.6)가
# 그대로 여는지 — 배포가 실제로 밟는 경로(같은 볼륨 · 이미지만 교체)를 버리는 컨테이너 · 볼륨으로 재현한다. 네트워크 없음.
#  1) 이전 이미지로 초기화(infra/db/init) · 문자열 정렬에 민감한 btree 색인(한글 · 대소문자 · 기호 섞인 글자) · PostGIS 도형 행
#  2) 멈추고 같은 볼륨으로 새 이미지(추가 권한 없이 postgres(999)) — 18.x 부 버전만 오름
#  3) 행 수 · amcheck bt_index_check(heapallindexed) — glibc 정렬이 바뀌었으면 여기서 깨진다 · tools/db-postgis-update.sh 로 확장 3.6.x 갱신 · 도형 연산
# 되돌리기 경로(새 → 이전)는 같은 메이저라 가능하지만 이 시험은 앞 방향만 본다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OLD="${DB_OLD_IMAGE:-imresamu/postgis:18-3.6@sha256:b5766ee720aca09c61b9a868abefbf273348a4b90ad4cf146b4f8c9ac85d48e4}"
NEW="${DB_IMAGE:-$(awk '/^  db:/{f=1} f && $1=="image:"{print $2; exit}' "$ROOT/infra/compose.yml")}"
ID="wakeline-dbswap-$$"; VOL="$ID-data"
fails=0; passes=0
cleanup() { docker rm -f "$ID" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT
check() { if [ "$2" = 0 ]; then passes=$((passes+1)); echo "  ok    $1"; else fails=$((fails+1)); echo "  FAIL  $1 → $3"; fi; }
is()  { if [ "$2" = "$3" ]; then check "$1" 0; else check "$1" 1 "$2"; fi; }
has() { if grep -q -- "$3" <<<"$2"; then check "$1" 0; else check "$1" 1 "$2"; fi; }
ENVS=(-e POSTGRES_PASSWORD=root-test-pw -e DB_MIGRATOR_PASSWORD=mig-test-pw -e DB_API_PASSWORD=api-test-pw -e DB_COLLECTOR_PASSWORD=col-test-pw)
COMMON=(--network none --security-opt no-new-privileges:true --read-only --tmpfs /var/run/postgresql --tmpfs /tmp --shm-size 256m
  -v "$VOL:/var/lib/postgresql" -v "$ROOT/infra/db/init:/docker-entrypoint-initdb.d:ro")
wait_ready() {
  for _ in $(seq 1 120); do
    if docker exec "$ID" sh -c 'pg_isready -q -U postgres -d wakeline && [ "$(cat /proc/1/comm)" = postgres ]' 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  docker logs "$ID" 2>&1 | tail -30; return 1
}
q() { docker exec -u postgres "$ID" psql -X -v ON_ERROR_STOP=1 -U postgres -d wakeline -Atc "$1" 2>&1 || true; }

echo "old: $OLD"; echo "new: $NEW"
docker volume create "$VOL" >/dev/null
# 1) 이전 이미지 — 엔트리포인트가 root 로 시작해 gosu 로 내려가므로 그때 쓰던 권한 그대로(compose 의 이전 설정)
docker run -d --name "$ID" --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETGID --cap-add SETUID \
  "${COMMON[@]}" "${ENVS[@]}" "$OLD" >/dev/null
wait_ready
q "CREATE TABLE swap_t (id serial PRIMARY KEY, name text NOT NULL, geom geometry(Point, 4326) NOT NULL)" >/dev/null
q "INSERT INTO swap_t (name, geom) SELECT n, ST_SetSRID(ST_MakePoint(126 + (g % 50) * 0.1, 33 + (g % 60) * 0.1), 4326)
   FROM generate_series(1, 20000) g,
   LATERAL (SELECT (ARRAY['부산','Busan','busan','BUSAN','인천-항','incheon','Äpfel','apple','a-b','a b','ab','A_b','z','Z','ㄱ','가','각'])[1 + g % 17] || ' ' || g AS n) s" >/dev/null
q "CREATE INDEX swap_t_name ON swap_t (name)" >/dev/null
before_rows="$(q "SELECT count(*) FROM swap_t")"
before_ver="$(q "SELECT extversion FROM pg_extension WHERE extname = 'postgis'")"
before_pg="$(q "SHOW server_version")"
echo "old image: rows=$before_rows postgis=$before_ver server=$before_pg"
docker stop -t 30 "$ID" >/dev/null && docker rm "$ID" >/dev/null

# 2) 새 이미지 — compose 와 같게 추가 권한 없이(이미지 USER postgres)
docker run -d --name "$ID" --cap-drop ALL "${COMMON[@]}" "${ENVS[@]}" "$NEW" >/dev/null
wait_ready
check "새 이미지가 이전 데이터 디렉터리로 기동" 0 ""
is  "프로세스 사용자 = postgres(999)" "$(docker exec "$ID" id -u)" "999"
has "서버 18.x" "$(q "SHOW server_version")" "^18\."
is  "행 수 그대로" "$(q "SELECT count(*) FROM swap_t")" "$before_rows"
q "CREATE EXTENSION IF NOT EXISTS amcheck" >/dev/null
is  "정렬 색인 무결성(amcheck bt_index_check · heapallindexed)" "$(q "SELECT bt_index_check('swap_t_name'::regclass, true)")" ""
has "갱신 전 확장 = 이전 판" "$(q "SELECT extversion FROM pg_extension WHERE extname = 'postgis'")" "^3\.6\."
out="$(bash "$ROOT/tools/db-postgis-update.sh" --container "$ID" 2>&1)"; rc=$?
check "tools/db-postgis-update.sh" "$rc" "$out"
avail="$(q "SELECT default_version FROM pg_available_extensions WHERE name = 'postgis'")"
is  "확장 = 이미지의 PostGIS" "$(q "SELECT extversion FROM pg_extension WHERE extname = 'postgis'")" "$avail"
if grep -q "need upgrade" <<<"$(q "SELECT postgis_full_version()")"; then check "postgis_full_version() 갱신 대기 없음" 1 "need upgrade"; else check "postgis_full_version() 갱신 대기 없음" 0 ""; fi
is  "도형 연산(ST_DWithin)" "$(q "SELECT count(*) > 0 FROM swap_t WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(126.5, 33.5), 4326)::geography, 50000)")" "t"
out2="$(bash "$ROOT/tools/db-postgis-update.sh" --container "$ID" 2>&1)"; has "다시 돌리면 멱등" "$out2" "already current"

echo "db image swap test: $passes passed, $fails failed"
[ "$fails" -eq 0 ]
