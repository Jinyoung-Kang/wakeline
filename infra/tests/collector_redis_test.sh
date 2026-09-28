#!/usr/bin/env bash
# 수집기의 실제 Redis 대조 시험(R-41) — 가짜 Redis(tests/fakes.py)로는 확인할 수 없는 것:
#   예산 Lua(여유분·EXPIRE) · 임대 읽기(ZRANGEBYSCORE·HMGET 파이프라인) · 수요 상태 HSET/HKEYS/HDEL · 노선 캐시 SET EX/EXISTS ·
#   infra/redis/start.sh 가 실제로 주는 ACL 규칙(tests/acl_rules.py 가 스크립트를 실행해 읽는다) 아래에서 ais 프로세스 전체.
# compose 에 고정된 redis 이미지로 버리는 컨테이너(127.0.0.1 임의 포트, 임의 비밀번호)를 띄운다. 개발·E2E 스택은 건드리지 않는다.
# 두 시험 파일은 WAKELINE_TEST_REDIS_URL 이 없으면 건너뛰므로(선택 실행), 여기서는 건너뛴 시험이 하나라도 있으면 실패로 본다.
# 사용: bash infra/tests/collector_redis_test.sh   (docker · uv 필요 — CI collector job 이 단위 시험 뒤에 돌린다)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${REDIS_IMAGE:-$(awk '/^  redis:/{f=1} f && $1=="image:"{print $2; exit}' "$ROOT/infra/compose.yml")}"
C="wakeline-colredis-$$"
# 비밀번호는 docker CLI 의 argv 에 두지 않는다: -e 이름만 넘기고(값은 이 셸의 환경), 컨테이너 안 sh 가 redis-server 에 넘긴다(redis 는 프로세스 제목을 바꿔 argv 를 숨긴다)
REDIS_TEST_PW="t-$(openssl rand -hex 16)"; REDISCLI_AUTH="$REDIS_TEST_PW"; export REDIS_TEST_PW REDISCLI_AUTH
cleanup() { docker rm -f "$C" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "image: $IMAGE"
docker run -d --name "$C" -p 127.0.0.1::6379 --user 999:1000 --read-only --tmpfs /data --cap-drop ALL --security-opt no-new-privileges:true \
  -e REDIS_TEST_PW --entrypoint sh "$IMAGE" -c 'exec redis-server --requirepass "$REDIS_TEST_PW" --save "" --appendonly no' >/dev/null
PORT="$(docker port "$C" 6379/tcp | head -1 | awk -F: '{print $NF}')"
for _ in $(seq 1 50); do
  docker exec -e REDISCLI_AUTH "$C" redis-cli --no-auth-warning ping 2>/dev/null | grep -q PONG && break
  sleep 0.2
done

cd "$ROOT/apps/collector"
rc=0
out="$(WAKELINE_TEST_REDIS_URL="redis://:$REDIS_TEST_PW@127.0.0.1:$PORT/0" uv run pytest -q -rs -p no:cacheprovider \
  tests/test_redis_integration.py tests/test_ais_redis_integration.py 2>&1)" || rc=$?
echo "$out" | tail -n 25
if grep -q "skipped" <<<"$out"; then echo "FAIL: 실제 Redis 대조 시험이 건너뛰어졌다" >&2; exit 1; fi
exit "$rc"
