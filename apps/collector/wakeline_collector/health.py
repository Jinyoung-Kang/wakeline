"""컨테이너 헬스체크(계약 §8): `python -m wakeline_collector.health` → 종료 코드 0(정상) / 1(비정상).

정상 = Redis 해시 wakeline:collector 의 region_at(관심 지역 작업의 마지막 heartbeat)이 기준 시간 안.
기준 = max(90 s, 2.5 × region_poll_s + 10 s) — region_poll_s 는 수집기가 heartbeat 에 함께 쓰는 실제 주기(운영 설정 5–120 s).
주기를 120 s 로 늘려도 수집 1회 실패(간격 2배)까지는 정상으로 본다(COL-5). 값이 없거나 이상하면 90 s.
fixture 모드도 같은 기준이다(fixture 도 region 작업이 heartbeat 를 쓴다). 비밀값은 출력하지 않는다.
무거운 모듈(수집 작업·HTTP·DB)은 불러오지 않는다 — 설정과 동기 Redis 클라이언트만 쓴다.
"""

from __future__ import annotations

import sys
from datetime import UTC, datetime

MAX_AGE_S = 90.0  # 최소 기준(기본 주기 10 s)
POLL_FACTOR, POLL_MARGIN_S = 2.5, 10.0
POLL_S_RANGE = (1, 120)  # RuntimeSettings.region_poll_s 가 5–120 으로 자른다
FUTURE_SKEW_S = 30.0
KEY = "wakeline:collector"


def region_age_s(h: dict[str, str], now: datetime) -> float | None:
    """region_at 의 나이(초). 없거나 해석할 수 없으면 None."""
    t = (h or {}).get("region_at") or ""
    try:
        at = datetime.fromisoformat(t.replace("Z", "+00:00"))
    except ValueError:
        return None
    if at.tzinfo is None:
        return None
    return (now - at).total_seconds()


def max_age_s(h: dict[str, str]) -> float:
    """heartbeat 에 실린 region_poll_s 로 정한 기준(초)."""
    v = (h or {}).get("region_poll_s") or ""
    try:
        poll = int(v)
    except ValueError:
        return MAX_AGE_S
    if not POLL_S_RANGE[0] <= poll <= POLL_S_RANGE[1]:
        return MAX_AGE_S
    return max(MAX_AGE_S, POLL_FACTOR * poll + POLL_MARGIN_S)


def is_healthy(h: dict[str, str], now: datetime | None = None) -> bool:
    age = region_age_s(h, now or datetime.now(UTC))
    return age is not None and -FUTURE_SKEW_S <= age <= max_age_s(h)


def main() -> int:
    from redis import Redis
    from redis.backoff import NoBackoff
    from redis.retry import Retry

    from wakeline_collector.config import settings

    r = Redis(
        host=settings.redis_host,
        port=settings.redis_port,
        username=settings.redis_username or None,
        password=settings.redis_password or None,
        decode_responses=True,
        socket_timeout=2,
        socket_connect_timeout=2,
        retry=Retry(NoBackoff(), 0),  # 헬스체크 타임아웃(5 s) 안에 끝나도록 재시도하지 않는다
    )
    try:
        h: dict[str, str] = r.hgetall(KEY)  # type: ignore[assignment]  # decode_responses=True → str
    except Exception as e:  # noqa: BLE001
        print(f"unhealthy: redis {type(e).__name__}", file=sys.stderr)
        return 1
    finally:
        r.close()
    now = datetime.now(UTC)
    age = region_age_s(h, now)
    if is_healthy(h, now):
        print(f"ok: region heartbeat {age:.0f} s ago (fixture={h.get('fixture', '?')})")
        return 0
    print(
        f"unhealthy: region heartbeat {'missing' if age is None else f'{age:.0f} s ago'} (> {max_age_s(h):.0f} s)",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
