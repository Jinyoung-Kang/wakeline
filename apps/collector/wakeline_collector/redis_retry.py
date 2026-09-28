"""수집기·ais 의 비동기 Redis 클라이언트 재시도(R-43).

redis-py 8 기본값(ExponentialWithJitterBackoff(base=0.01, cap=1) × 10회, ConnectionError·TimeoutError)은 Redis 장애 중
오류를 삼키는 호출 하나를 수 초(연결 거부 실측 3–4 s)에서 1분 가까이(응답 없음, socket_timeout 5 s × 11) 붙잡는다.
발행 경로는 로컬 큐로 넘기고 부가 경로는 오류를 삼키므로 짧게 두 번만 다시 시도한다.
"""

from __future__ import annotations

from redis.asyncio.retry import Retry
from redis.backoff import ExponentialBackoff

REDIS_RETRIES = 2


def short_retry() -> Retry:
    return Retry(ExponentialBackoff(cap=0.5, base=0.05), REDIS_RETRIES)
