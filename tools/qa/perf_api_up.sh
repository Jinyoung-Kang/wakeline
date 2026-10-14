#!/usr/bin/env bash
# QA 2026-10 성능: 격리 스택 A(compose 프로젝트 wakeline-e2e · 8701)의 api 만 고친 이미지(wakeline-api:qa-fix)로 다시 만든다 — 빌드 없음, 다른 서비스는
# 그대로(--no-deps), healthy 까지 기다린다(--wait). 운영 스택 · 스택 B 는 건드리지 않는다.
#   tools/qa/perf_api_up.sh default                        # 기본 제한(공개 분당 120 · WS IP 당 5 · 전체 200) — 측정이 끝나면 이것으로 되돌린다
#   tools/qa/perf_api_up.sh lifted                         # api 직접 측정 동안: PUBLIC_RATE_LIMIT_PER_MIN=1000000 WS_MAX_CONN_PER_IP=1000 WS_MAX_CONN=1000
#   QA_JVM_EXTRA="-XX:MaxRAMPercentage=30" tools/qa/perf_api_up.sh lifted jvm   # + 측정 전용 JVM 옵션(tools/qa/compose.qa-jvm.yml)
# compose 는 스택을 만든 체크아웃(.env 가 있는 곳)에서 돈다: WAKELINE_STACK_DIR(기본 이 저장소 루트). .env 는 compose 가 읽는다(이 스크립트는 읽지 않는다).
# QA 2026-10 AWS: WLQA_ENV(시험 env 파일)가 있으면 tools/qa/wlqa.sh 로 그 격리 스택(WLQA_STACK, 기본 A1 — 프로젝트 wlqa-a · 이미지 :qa)의 api 를 다시 만든다.
#   사용자의 .env 는 쓰지 않는다. 컨테이너 이름은 PERF_PROJECT(기본 wlqa-a)-api-1. JVM 덧붙임(jvm)은 이 방식에서 받지 않는다(이미지의 JVM 옵션 그대로).
#   WLQA_ENV=<시험 env> PERF_PROJECT=wlqa-a tools/qa/perf_api_up.sh lifted
#   PERF_FORCE_RECREATE=1 이면 설정이 같아도 새 컨테이너(새 JVM)로 — 같은 설정을 여러 번 잴 때(perf_aws_run.sh)
set -euo pipefail
mode=$1; jvm=${2:-}
root=$(cd "$(dirname "$0")/../.." && pwd)
case "$mode" in
  lifted) lim=(PUBLIC_RATE_LIMIT_PER_MIN=1000000 WS_MAX_CONN_PER_IP=1000 WS_MAX_CONN=1000) ;;
  default) lim=() ;;
  *) echo "mode must be lifted or default" >&2; exit 2 ;;
esac
if [ -n "${WLQA_ENV:-}" ]; then
  if [ "$jvm" = jvm ] && [ -n "${QA_JVM_EXTRA:-}" ]; then echo "WLQA_ENV 방식은 JVM 덧붙임을 받지 않는다" >&2; exit 2; fi
  api="${PERF_PROJECT:-wlqa-a}-api-1"
  env -u PUBLIC_RATE_LIMIT_PER_MIN -u WS_MAX_CONN_PER_IP -u WS_MAX_CONN ${lim[@]+"${lim[@]}"} \
    "$root/tools/qa/wlqa.sh" "${WLQA_STACK:-A1}" up -d --no-build --no-deps --wait ${PERF_FORCE_RECREATE:+--force-recreate} api
else
  api=wakeline-e2e-api-1
  stack=${WAKELINE_STACK_DIR:-$root}
  files=(-f infra/compose.yml -f tools/qa/compose.qa-fix.yml)
  if [ "$jvm" = jvm ]; then files+=(-f "$root/tools/qa/compose.qa-jvm.yml"); else unset QA_JVM_EXTRA; fi
  cd "$stack"
  env -u PUBLIC_RATE_LIMIT_PER_MIN -u WS_MAX_CONN_PER_IP -u WS_MAX_CONN ${lim[@]+"${lim[@]}"} \
    WAKELINE_FIXTURE_MODE=1 WAKELINE_PORT=8701 WAKELINE_NET_PREFIX=10.78.0 aisstream_key= OPENSKY_CLIENT_ID= OPENSKY_CLIENT_SECRET= KMA_APIHUB_KEY= \
    DATA_GO_KR_SERVICE_KEY= EXTRA_ALLOWED_ORIGINS= \
    docker compose -p wakeline-e2e "${files[@]}" --env-file .env up -d --no-build --no-deps --wait api
fi
# 실제로 든 값(비밀이 아닌 것만): 이미지 · JVM 옵션 · 제한
docker inspect "$api" --format '{{.Image}}{{range .Config.Env}}{{"\n"}}{{.}}{{end}}' \
  | grep -E '^sha256:|^JAVA_TOOL_OPTIONS=|^WAKELINE_PUBLIC_RATE_LIMIT_PER_MIN=|^WAKELINE_WS_MAX_CONN(_PER_IP)?=|^MALLOC_ARENA_MAX=|^SPRING_DATASOURCE_HIKARI_MAXIMUMPOOLSIZE=|^WAKELINE_PUBLICREADS_PERMITS=|^WAKELINE_READPOOL_SIZE='
