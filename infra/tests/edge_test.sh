#!/usr/bin/env bash
# edge(nginx) 회귀 시험 (SEC-4 · SEC-7).
# compose 와 같은 방식(비root uid 101·read-only 루트 FS + tmpfs /tmp·cap_drop ALL·no-new-privileges)으로 버리는 edge 를 띄우고,
# 가짜 api/web 상류(같은 이미지)를 붙여 nginx -t · Host 허용 목록(421) · XFF 덮어쓰기 · 보안 헤더 · actuator 차단을 확인한다.
# 개발·E2E 스택은 건드리지 않는다. 사용: bash infra/tests/edge_test.sh   (docker · curl 필요)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${EDGE_IMAGE:-$(awk '/^  edge:/{f=1} f && $1=="image:"{print $2; exit}' "$ROOT/infra/compose.yml")}"
ID="wakeline-edgetest-$$"; NET="$ID-net"; PUB="$ID-pub"; STUB="$ID-stub"; EDGE="$ID-edge"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/wakeline-edgetest.XXXXXX")"
fails=0; passes=0

cleanup() { docker rm -f "$EDGE" "$STUB" >/dev/null 2>&1 || true; docker network rm "$NET" "$PUB" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
check() { # check <설명> <조건 결과(0/1)> <실제 값>
  if [ "$2" = 0 ]; then passes=$((passes+1)); echo "  ok    $1"; else fails=$((fails+1)); echo "  FAIL  $1 → $3"; fi
}

# 가짜 상류: api(8000)는 받은 Host·X-Forwarded-For 를 그대로 돌려주고, web(3000)은 'web' 을 돌려준다.
cat >"$TMP/stub.conf" <<'CONF'
pid /tmp/nginx.pid;
events {}
http {
  client_body_temp_path /tmp/c; proxy_temp_path /tmp/p; fastcgi_temp_path /tmp/f; uwsgi_temp_path /tmp/u; scgi_temp_path /tmp/s;
  server { listen 8000; location / { default_type application/json; return 200 '{"host":"$http_host","xff":"$http_x_forwarded_for","xfh":"$http_x_forwarded_host","uri":"$request_uri"}'; } }
  server { listen 3000; location / { default_type text/plain; return 200 'web'; } }
}
CONF
chmod 644 "$TMP/stub.conf"

# compose 와 같은 망 구성(R-64 · ADR-017 §4): 상류(api·web)는 internal 망에만, edge 는 public(게시 포트) + internal
docker network create --internal "$NET" >/dev/null
docker network create "$PUB" >/dev/null
docker run -d --name "$STUB" --network "$NET" --network-alias api --network-alias web \
  --read-only --tmpfs /tmp -v "$TMP/stub.conf:/etc/nginx/nginx.conf:ro" "$IMAGE" >/dev/null

HARDEN=(--user 101:101 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true
  -e NGINX_ENTRYPOINT_QUIET_LOGS=1
  -v "$ROOT/infra/edge/nginx.conf:/etc/nginx/nginx.conf:ro"
  -v "$ROOT/infra/edge/proxy_headers.conf:/etc/nginx/proxy_headers.conf:ro"
  -v "$ROOT/infra/edge/security_headers.conf:/etc/nginx/security_headers.conf:ro")

echo "image: $IMAGE"
echo "[nginx -t (비root·read-only)]"
out="$(docker run --rm --network "$NET" "${HARDEN[@]}" "$IMAGE" nginx -t 2>&1 || true)"
grep -q "test is successful" <<<"$out"; check "nginx -t" $? "$out"

docker create --name "$EDGE" --network "$PUB" -p 127.0.0.1::8700 "${HARDEN[@]}" "$IMAGE" >/dev/null
docker network connect "$NET" "$EDGE"
docker start "$EDGE" >/dev/null
PORT="$(docker port "$EDGE" 8700/tcp | head -1 | awk -F: '{print $NF}')"
for _ in $(seq 1 50); do curl -fsS -o /dev/null -H "Host: localhost:8700" "http://127.0.0.1:$PORT/healthz" 2>/dev/null && break; sleep 0.2; done

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
echo "[Host 허용 목록 — DNS rebinding]"
for h in "localhost:8700" "127.0.0.1:8700" "[::1]:8700" "localhost:8701" "localhost"; do
  c="$(code -H "Host: $h" "http://127.0.0.1:$PORT/api/v1/status")"; [ "$c" = 200 ]; check "Host $h → 200" $? "$c"
done
for h in "rebind.attacker.example:8700" "evil.example" "10.77.0.10:8700" "localhost.evil.example:8700" "127.0.0.1.nip.io:8700"; do
  c="$(code -H "Host: $h" "http://127.0.0.1:$PORT/api/v1/status")"; [ "$c" = 421 ]; check "Host $h → 421" $? "$c"
  c="$(code -H "Host: $h" -H "Connection: Upgrade" -H "Upgrade: websocket" "http://127.0.0.1:$PORT/ws/v1")"; [ "$c" = 421 ]; check "WS Host $h → 421" $? "$c"
done
c="$(curl -s -o /dev/null -w '%{http_code}' --http1.0 -H "Host:" "http://127.0.0.1:$PORT/api/v1/status")"; [ "$c" = 421 ]; check "Host 없음(HTTP/1.0) → 421" $? "$c"
hdr="$(curl -s -D - -o /dev/null -H "Host: evil.example" "http://127.0.0.1:$PORT/")"
grep -qi "^x-content-type-options: nosniff" <<<"$hdr"; check "421 응답에도 보안 헤더" $? "$hdr"

echo "[프록시 헤더]"
body="$(curl -s -H "Host: localhost:8700" -H "X-Forwarded-For: 1.2.3.4" -H "X-Forwarded-Host: evil.example" "http://127.0.0.1:$PORT/api/v1/status")"
grep -q '"host":"localhost:8700"' <<<"$body"; check "Host 전달(포트 포함)" $? "$body"
! grep -q '1.2.3.4' <<<"$body"; check "위조 X-Forwarded-For 덮어쓰기" $? "$body"
grep -q '"xfh":""' <<<"$body"; check "X-Forwarded-Host 비움" $? "$body"
c="$(code -H "Host: localhost:8700" "http://127.0.0.1:$PORT/actuator/health")"; [ "$c" = 404 ]; check "/actuator → 404" $? "$c"
c="$(code -H "Host: localhost:8700" "http://127.0.0.1:$PORT/")"; [ "$c" = 200 ]; check "/ → web" $? "$c"
hdr="$(curl -s -D - -o /dev/null -H "Host: localhost:8700" "http://127.0.0.1:$PORT/_next/static/x.js")"
grep -qi "^cache-control: public, max-age=31536000, immutable" <<<"$hdr" && grep -qi "^x-frame-options: DENY" <<<"$hdr"; check "/_next/static 캐시 + 보안 헤더" $? "$hdr"

echo "[WS 핸드셰이크 제한]"
n429=0
for _ in $(seq 1 30); do c="$(code -H "Host: localhost:8700" "http://127.0.0.1:$PORT/ws/v1")"; [ "$c" = 429 ] && n429=$((n429+1)); done
[ "$n429" -gt 0 ]; check "WS 핸드셰이크 폭주 → 429 (30회 중 $n429)" $? "$n429"

echo "[망 분리 — internal 망만 있는 상류는 기본 경로(인터넷)가 없고, 게시 포트는 public 망으로 닿는다]"
route="$(docker exec "$STUB" awk '$2=="00000000"{print $1}' /proc/net/route)"
[ -z "$route" ]; check "internal 망의 상류: 기본 경로 없음" $? "$route"
c="$(code -H "Host: localhost:8700" "http://127.0.0.1:$PORT/api/v1/status")"; [ "$c" = 200 ]; check "게시 포트(public) → edge → internal 망의 api" $? "$c"

echo "[컨테이너 권한]"
st="$(docker exec "$EDGE" sh -c 'for p in $(pgrep nginx); do awk "/^(Uid|CapEff|NoNewPrivs):/{printf \"%s \", \$2}" /proc/$p/status; echo; done')"
! grep -vqE '^101 0000000000000000 1 $' <<<"$st"; check "모든 nginx 프로세스 uid=101 CapEff=0 NoNewPrivs=1" $? "$st"
out="$(docker exec "$EDGE" sh -c 'touch /etc/nginx/x 2>&1 || true')"; grep -q "Read-only" <<<"$out"; check "root FS read-only" $? "$out"
out="$(docker exec "$EDGE" wget -qO- http://127.0.0.1:8700/healthz 2>&1 || true)"; grep -q '"host":"127.0.0.1:8700"' <<<"$out"; check "compose 헬스체크(wget 127.0.0.1:8700/healthz)" $? "$out"

echo "edge test: $passes passed, $fails failed"
[ "$fails" -eq 0 ]
