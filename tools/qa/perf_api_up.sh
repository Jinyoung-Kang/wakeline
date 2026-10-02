#!/usr/bin/env bash
# QA 2026-10 성능: 격리 스택 A(compose 프로젝트 wakeline-e2e · 8701)의 api 만 고친 이미지(wakeline-api:qa-fix)로 다시 만든다 — 빌드 없음, 다른 서비스는
# 그대로(--no-deps), healthy 까지 기다린다(--wait). 운영 스택 · 스택 B 는 건드리지 않는다.
#   tools/qa/perf_api_up.sh default                        # 기본 제한(공개 분당 120 · WS IP 당 5 · 전체 200) — 측정이 끝나면 이것으로 되돌린다
#   tools/qa/perf_api_up.sh lifted                         # api 직접 측정 동안: PUBLIC_RATE_LIMIT_PER_MIN=1000000 WS_MAX_CONN_PER_IP=1000 WS_MAX_CONN=1000
#   QA_JVM_EXTRA="-XX:MaxRAMPercentage=30" tools/qa/perf_api_up.sh lifted jvm   # + 측정 전용 JVM 옵션(tools/qa/compose.qa-jvm.yml)
# compose 는 스택을 만든 체크아웃(.env 가 있는 곳)에서 돈다: WAKELINE_STACK_DIR(기본 이 저장소 루트). .env 는 compose 가 읽는다(이 스크립트는 읽지 않는다).
set -euo pipefail
mode=$1; jvm=${2:-}
root=$(cd "$(dirname "$0")/../.." && pwd)
stack=${WAKELINE_STACK_DIR:-$root}
files=(-f infra/compose.yml -f tools/qa/compose.qa-fix.yml)
if [ "$jvm" = jvm ]; then files+=(-f "$root/tools/qa/compose.qa-jvm.yml"); else unset QA_JVM_EXTRA; fi
case "$mode" in
  lifted) lim=(PUBLIC_RATE_LIMIT_PER_MIN=1000000 WS_MAX_CONN_PER_IP=1000 WS_MAX_CONN=1000) ;;
  default) lim=() ;;
  *) echo "mode must be lifted or default" >&2; exit 2 ;;
esac
cd "$stack"
env -u PUBLIC_RATE_LIMIT_PER_MIN -u WS_MAX_CONN_PER_IP -u WS_MAX_CONN ${lim[@]+"${lim[@]}"} \
  WAKELINE_FIXTURE_MODE=1 WAKELINE_PORT=8701 WAKELINE_NET_PREFIX=10.78.0 aisstream_key= OPENSKY_CLIENT_ID= OPENSKY_CLIENT_SECRET= KMA_APIHUB_KEY= \
  DATA_GO_KR_SERVICE_KEY= EXTRA_ALLOWED_ORIGINS= \
  docker compose -p wakeline-e2e "${files[@]}" --env-file .env up -d --no-build --no-deps --wait api
# 실제로 든 값(비밀이 아닌 것만): 이미지 · JVM 옵션 · 제한
docker inspect wakeline-e2e-api-1 --format '{{.Image}}{{range .Config.Env}}{{"\n"}}{{.}}{{end}}' \
  | grep -E '^sha256:|^JAVA_TOOL_OPTIONS=|^WAKELINE_PUBLIC_RATE_LIMIT_PER_MIN=|^WAKELINE_WS_MAX_CONN(_PER_IP)?=|^MALLOC_ARENA_MAX='
