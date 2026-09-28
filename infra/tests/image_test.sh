#!/usr/bin/env bash
# 빌드한 앱 이미지 검사(R-25 · R-29) — 버리는 컨테이너(--network none, 권한 없음)로 실행 이미지 안을 본다. 개발 스택은 건드리지 않는다.
#   - web: 쓰지 않는 패키지 관리자(npm·npx·corepack·yarn)가 없다 — HIGH 취약점 전부의 출처였다. node 는 그대로 돈다
#   - collector(ais 같은 이미지): 시스템 pip 가 없다(pip 가 품은 msgpack·setuptools 가 HIGH 의 출처). 앱 .venv 는 그대로 import 된다
#   - api: 컨테이너 한도 1g 에서 힙 상한이 약 410 MiB(40 %) · 헬스체크용 curl 은 있다
#   - 셋 다 비root 사용자
# 사용: bash infra/tests/image_test.sh                      # wakeline-{api,web,collector}:local (make build 뒤)
#       API_IMAGE=… WEB_IMAGE=… COLLECTOR_IMAGE=… bash infra/tests/image_test.sh
set -uo pipefail   # -e 없음: 실패도 모두 보고한 뒤 끝에서 종료 코드로 알린다
API_IMAGE="${API_IMAGE:-wakeline-api:local}"; WEB_IMAGE="${WEB_IMAGE:-wakeline-web:local}"; COLLECTOR_IMAGE="${COLLECTOR_IMAGE:-wakeline-collector:local}"
fails=0; passes=0
check() { if [ "$2" = 0 ]; then passes=$((passes+1)); echo "  ok    $1"; else fails=$((fails+1)); echo "  FAIL  $1 → $3"; fi; }
in_img() { local img=$1; shift; docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true --entrypoint "$1" "$img" "${@:2}" 2>&1 || true; }

echo "[web: $WEB_IMAGE]"
left="$(in_img "$WEB_IMAGE" sh -c 'for p in /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-*; do [ -e "$p" ] && echo "$p"; done; true')"
[ -z "$left" ]; check "패키지 관리자 없음(npm·npx·corepack·yarn)" $? "$(tr '\n' ' ' <<<"$left")"
out="$(in_img "$WEB_IMAGE" node -e 'console.log(process.version)')"; grep -q '^v24\.' <<<"$out"; check "node 실행($out)" $? "$out"
out="$(in_img "$WEB_IMAGE" sh -c 'test -f /app/server.js && echo present')"; [ "$out" = present ]; check "Next standalone server.js" $? "$out"

echo "[collector: $COLLECTOR_IMAGE]"
out="$(in_img "$COLLECTOR_IMAGE" /usr/local/bin/python3 -c 'import pip' )"; grep -q "No module named 'pip'" <<<"$out"; check "시스템 python 에 pip 없음" $? "$out"
left="$(in_img "$COLLECTOR_IMAGE" sh -c 'ls /usr/local/bin/pip* /usr/local/lib/python3*/site-packages/pip 2>/dev/null; true')"
[ -z "$left" ]; check "pip 실행 파일·패키지 없음" $? "$left"
out="$(in_img "$COLLECTOR_IMAGE" python -c 'import wakeline_collector.ais, wakeline_collector.health, redis, httpx; print("ok")')"; [ "$out" = ok ]; check "앱 .venv import(collector·ais·health)" $? "$out"

echo "[api: $API_IMAGE]"
heap="$(docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true --memory 1g --entrypoint java "$API_IMAGE" -XX:+PrintFlagsFinal -version 2>/dev/null | awk '$2=="MaxHeapSize"{print $4}')"
mib=$(( ${heap:-0} / 1048576 ))
[ "$mib" -ge 380 ] && [ "$mib" -le 420 ]; check "한도 1g 에서 힙 상한 ${mib} MiB(40 % ≈ 410)" $? "${heap:-없음}"
out="$(in_img "$API_IMAGE" curl --version | head -1)"; grep -q '^curl ' <<<"$out"; check "헬스체크용 curl" $? "$out"

echo "[비root]"
for img in "$WEB_IMAGE" "$COLLECTOR_IMAGE" "$API_IMAGE"; do
  u="$(docker image inspect -f '{{.Config.User}}' "$img")"
  case "$u" in ''|0|root|0:0) check "$img USER" 1 "'$u'" ;; *) check "$img USER=$u" 0 "" ;; esac
done

echo "image test: $passes passed, $fails failed"
[ "$fails" -eq 0 ]
