#!/usr/bin/env bash
# QA-1131 재현: aws-deploy 앞단 Caddy 이미지(compose.yml 의 고정 다이제스트 그대로 — 새 태그를 만들지 않는다)의 caddy 실행 파일에
# 고칠 수 있는 HIGH(Go 표준 라이브러리 · x/net)가 있는가(wakeline 게이트와 같은 기준), 그리고 평문 리스너가 HTTP/2(h2c)를 받는가.
#   tools/qa/qa_1131_caddy_go_cves.sh [aws-deploy 경로(기본 ~/Projects/aws-deploy)]
# aws-deploy 는 읽기만 한다. trivy 는 tools/scan_lib.sh(다이제스트 고정 · docker save · --network none), DB 는 이미 받은 캐시만(SCAN_OFFLINE=1).
# 이미지가 없으면 받지 않고 멈춘다(2). 결함이 있으면 1, 없으면 0.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
deploy=${1:-$HOME/Projects/aws-deploy}
ref=$(awk '/^  caddy:/{f=1;next} f && $1=="image:"{print $2; exit}' "$deploy/compose.yml")
case "$ref" in caddy:*@sha256:*) ;; *) echo "caddy 이미지 고정 다이제스트를 찾지 못함: '$ref'" >&2; exit 2 ;; esac
docker image inspect "$ref" >/dev/null 2>&1 || { echo "이미지 없음: $ref (docker pull 은 이 스크립트가 하지 않는다)" >&2; exit 2; }
# shellcheck source=tools/scan_lib.sh
. tools/scan_lib.sh
export SCAN_OFFLINE=1
trivy_db_update || exit 2
WORK="$(scan_tmpdir)" || exit 2
trap 'rm -rf "$WORK"; docker rm -f qa1131-caddy >/dev/null 2>&1' EXIT
echo "image $ref"
docker run --rm --network none --entrypoint caddy "$ref" build-info 2>/dev/null | grep -E '^go|golang.org/x/net'
fail=0
rc=0; trivy_image "$ref" "$WORK" --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 --format table || rc=$?
if [ "$rc" = 0 ]; then echo "PASS  trivy: 고칠 수 있는 HIGH·CRITICAL 없음"; else echo "FAIL  trivy: 고칠 수 있는 HIGH·CRITICAL 있음(rc $rc)"; fail=1; fi
# 평문 리스너 — 운영 Caddyfile 과 같이 auto_https off · protocols 미지정
printf '{\n\tauto_https off\n\tadmin off\n}\n:8103 {\n\trespond "ok" 200\n}\n' > "$WORK/Caddyfile"
chmod 644 "$WORK/Caddyfile"
docker run -d --name qa1131-caddy --network none -v "$WORK/Caddyfile:/etc/caddy/Caddyfile:ro" "$ref" >/dev/null || exit 2
sleep 2
h2=$(docker run --rm --network container:qa1131-caddy --entrypoint curl wakeline-api:qa -sS -o /dev/null -w '%{http_version}' \
  --http2-prior-knowledge http://127.0.0.1:8103/ 2>&1)
echo "h2c(사전 지식) 응답 HTTP 판: $h2"
[ "$h2" = 2 ] && echo "NOTE  평문 리스너가 HTTP/2 를 받는다 — HTTP/2 서버 CVE 가 리스너에 닿는 누구에게나 열린다(보안 그룹은 따로 확인)"
exit "$fail"
