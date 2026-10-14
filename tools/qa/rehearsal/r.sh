#!/usr/bin/env bash
# QA 2026-10 AWS 리허설(R): 세 compose 프로젝트를 고정된 이름 · 파일 · 시험 env 로 부르는 한 줄짜리(setup.py 를 먼저).
#   tools/qa/rehearsal/r.sh rds   <docker compose 인자…>   RDS 흉내   -p wlqa-rds   (호스트 127.0.0.1:55432, max_connections 78, 시험 CA A 서버 인증서)
#   tools/qa/rehearsal/r.sh aws   <docker compose 인자…>   wakeline   -p wlqa-aws   (infra/compose.yml + compose.aws.yml + :qa 태그, 18710 · 10.81.0, fixture)
#   tools/qa/rehearsal/r.sh front <docker compose 인자…>   앞단        -p wlqa-front (aws-deploy rehearsal/compose.edge.yml + portfolio-gate:wlqa, 8101–8103)
#   tools/qa/rehearsal/r.sh sql <db> <SQL>                RDS 흉내 안 로컬 소켓 슈퍼유저 psql(관찰 전용 — 탭 구분)
# aws 의 RDS CA 묶음은 WLQA_RDS_CA(기본: 시험 CA A), RDS 이름은 env 의 RDS_HOST(셸에서 RDS_HOST=… 로 바꿀 수 있다 — 셸이 --env-file 보다 우선).
# 모두 fixture 모드 · 외부 키 빈 값. 사용자의 .env · aws-deploy 의 .env 는 쓰지 않는다(aws-deploy 는 compose 파일 · 스크립트를 읽기만).
set -euo pipefail
R="${WLQA_R_DIR:-/private/tmp/claude-501/-Users-jinyoung-Projects-wakeline/3b40667d-7c26-4f92-9be9-6efb0a86ebea/scratchpad/qa/rehearsal}"
AWS_DEPLOY="${AWS_DEPLOY_DIR:-/Users/jinyoung/Projects/aws-deploy}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
[ -f "$R/rds.env" ] || { echo "먼저: python3 -B tools/qa/rehearsal/setup.py" >&2; exit 2; }
what=${1:?rds · aws · front · sql 중 하나}; shift
case "$what" in
  rds)
    exec docker compose -p wlqa-rds -f "$AWS_DEPLOY/rehearsal/compose.rds-emu.yml" -f "$R/compose.rds.yml" --env-file "$R/rds.env" "$@" ;;
  aws)
    cd "$ROOT"
    exec env WAKELINE_FIXTURE_MODE=1 WAKELINE_PORT=18710 WAKELINE_NET_PREFIX=10.81.0 \
      aisstream_key= OPENSKY_CLIENT_ID= OPENSKY_CLIENT_SECRET= KMA_APIHUB_KEY= DATA_GO_KR_SERVICE_KEY= EXTRA_ALLOWED_ORIGINS= \
      WLQA_TAG="${WLQA_TAG:-qa}" WLQA_RDS_CA="${WLQA_RDS_CA:-$R/certs/ca-a.pem}" \
      docker compose -p wlqa-aws -f "$ROOT/infra/compose.yml" -f "$ROOT/infra/compose.aws.yml" -f "$ROOT/tools/qa/compose.qa-tag.yml" \
        -f "$R/compose.aws-r.yml" --env-file "$R/wakeline.env" "$@" ;;
  front)
    exec docker compose -p wlqa-front -f "$AWS_DEPLOY/rehearsal/compose.edge.yml" -f "$R/compose.front.yml" --env-file "$R/front.env" "$@" ;;
  sql)
    db=${1:?db}; shift
    exec docker exec wlqa-rds-rds-1 psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" -At -F $'\t' -c "$1" ;;
  *) echo "rds · aws · front · sql 중 하나" >&2; exit 2 ;;
esac
