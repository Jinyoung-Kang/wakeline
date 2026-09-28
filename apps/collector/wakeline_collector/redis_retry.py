"""수집기·ais 의 비동기 Redis 클라이언트 재시도(R-43).

redis-py 8 기본값(ExponentialWithJitterBackoff(base=0.01, cap=1) × 10회, ConnectionError·TimeoutError)은 Redis 장애 중
오류를 삼키는 호출 하나를 수 초(연결 거부 실측 3–4 s)에서 1분 가까이(응답 없음, socket_timeout 5 s × 11) 붙잡는다.
발행 경로는 로컬 큐로 넘기고 부가 경로는 오류를 삼키므로 짧게 두 번만 다시 시도한다.

재시도는 연결 오류(거부·끊김 — 곧바로 실패한다)에만 건다. 응답 없음(TimeoutError)은 다시 해도 같은 시간을 또 기다릴 뿐이고,
redis-py 는 Retry 를 연결 핸드셰이크와 명령 두 겹에 걸기 때문에 (1+2) × (1+2) × socket_timeout 이 된다(연결은 받고 답하지 않는
Redis 에 발행 1회 실측 46 s — 발행 락을 쥔 채라 모든 작업이 뒤에 줄을 섰다). 그래서 응답 없는 Redis 에서 호출 하나는
REDIS_SOCKET_TIMEOUT_S 한 번으로 끝난다(R-43 후속).
"""

from __future__ import annotations

from redis.asyncio.retry import Retry
from redis.backoff import ExponentialBackoff
from redis.exceptions import ConnectionError as RedisConnectionError

REDIS_RETRIES = 2
REDIS_SOCKET_TIMEOUT_S = 2.0  # 연결·응답 대기 상한(로컬 Redis 의 명령은 ms 단위 — 헬스체크 클라이언트와 같은 값)


def short_retry() -> Retry:
    return Retry(ExponentialBackoff(cap=0.5, base=0.05), REDIS_RETRIES, supported_errors=(RedisConnectionError,))
