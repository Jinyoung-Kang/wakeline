#!/usr/bin/env bash
# QA 2026-10 AWS: 격리 QA 스택을 부르는 한 줄짜리 — 프로젝트 · 포트 · 망 · 이미지 태그 · 시험 env 를 고정한다.
#   WLQA_ENV=<시험 env 파일> tools/qa/wlqa.sh <A|A1|B> <docker compose 인자...>
#   A  = 격리 표준(공개 데모 끔)        -p wlqa-a · 8701 · 10.78.0
#   A1 = A + AWS 흉내(공개 데모 · 풀 6/3/2) -p wlqa-a · 8701 · 10.78.0 (A 를 다시 만든다)
#   B  = 장애 주입 전용                  -p wlqa-b · 8702 · 10.80.0
# 모두 fixture 모드(서버의 외부 호출 0) · 외부 키 빈 값 · 이미지 wakeline-*:${WLQA_TAG:-qa}. 사용자의 .env 는 쓰지 않는다(WLQA_ENV 필수).
# 셸 환경이 --env-file 보다 우선이므로, 아래 변수는 env 파일에 무엇이 있든 이 값으로 든다.
set -euo pipefail
stack=${1:?스택 A, A1, B 중 하나}; shift
: "${WLQA_ENV:?WLQA_ENV 에 시험 env 파일 경로가 필요하다(tools/qa/make_qa_env.py 로 만든다)}"
root=$(cd "$(dirname "$0")/../.." && pwd)
case "$(cd "$(dirname "$WLQA_ENV")" && pwd)/$(basename "$WLQA_ENV")" in "$root/.env") echo "사용자의 .env 는 쓰지 않는다" >&2; exit 2 ;; esac
files=(-f "$root/infra/compose.yml" -f "$root/tools/qa/compose.qa-tag.yml")
case "$stack" in
  A)  proj=wlqa-a; port=8701; net=10.78.0 ;;
  A1) proj=wlqa-a; port=8701; net=10.78.0; files+=(-f "$root/tools/qa/compose.aws-sim.yml") ;;
  B)  proj=wlqa-b; port=8702; net=10.80.0 ;;
  *) echo "스택은 A, A1, B 중 하나" >&2; exit 2 ;;
esac
cd "$root"
exec env WAKELINE_FIXTURE_MODE=1 WAKELINE_PORT="$port" WAKELINE_NET_PREFIX="$net" \
  aisstream_key= OPENSKY_CLIENT_ID= OPENSKY_CLIENT_SECRET= KMA_APIHUB_KEY= DATA_GO_KR_SERVICE_KEY= EXTRA_ALLOWED_ORIGINS= \
  WLQA_TAG="${WLQA_TAG:-qa}" \
  docker compose -p "$proj" "${files[@]}" --env-file "$WLQA_ENV" "$@"
