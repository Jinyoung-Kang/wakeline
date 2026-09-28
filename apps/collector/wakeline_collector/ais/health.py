"""ais 컨테이너 헬스체크(계약 v2 §B1): `python -m wakeline_collector.ais.health` → 0 정상 / 1 비정상.

정상 = 프로세스가 살아 있고(상태 해시 updated_at 이 60 s 안 — 발행 태스크가 5 s 마다 쓴다) 다음 중 하나:
  1. 마지막 메시지(last_msg_at)가 120 s 안,
  2. 공백이 열린 채 다시 붙는 중(state connecting · subscribed · backoff) — 끊김은 화면이 공백으로 보여 준다,
  3. 키가 없어 꺼 둔 상태(state disabled) — 고장이 아니라 설정이다(상태 해시·화면에 이유가 보인다).
구역이 있으면(상태 해시 shards, 계약 v4 §D) 1·2 를 구역별로 본다: 한 구역이라도 120 s 안에 받고 있거나, 공백이 열린 구역이 모두
다시 붙는 중이면 정상. shards 가 없거나 읽을 수 없으면 합계 필드로 v4 이전 규칙을 쓴다.
무거운 모듈(websockets·수신 코드)은 불러오지 않는다. 비밀값은 출력하지 않는다.
"""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from typing import Any

KEY = "wakeline:ais:status"
HEARTBEAT_MAX_AGE_S = 60.0
MSG_MAX_AGE_S = 120.0
FUTURE_SKEW_S = 30.0
RETRYING = frozenset({"connecting", "subscribed", "backoff"})


def _age_s(v: str | None, now: datetime) -> float | None:
    if not v:
        return None
    try:
        at = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    if at.tzinfo is None:
        return None
    return (now - at).total_seconds()


def _fresh(age: float | None, limit: float) -> bool:
    return age is not None and -FUTURE_SKEW_S <= age <= limit


def _shards(raw: str | None) -> list[dict[str, Any]]:
    """상태 해시 shards(JSON 배열) → 항목 목록. 없거나 형식이 틀리면 빈 목록(합계 필드로 판단)."""
    if not raw:
        return []
    try:
        doc = json.loads(raw)
    except ValueError:
        return []
    if not isinstance(doc, list) or not all(isinstance(e, dict) for e in doc):
        return []
    return doc


def _str(v: Any) -> str | None:
    return v if isinstance(v, str) else None


def _evaluate_shards(shards: list[dict[str, Any]], now: datetime) -> tuple[bool, str]:
    n = len(shards)
    ages: list[float] = []
    for s in shards:
        age = _age_s(_str(s.get("last_msg_at")), now)
        if age is not None and _fresh(age, MSG_MAX_AGE_S):
            ages.append(age)
    if ages:
        return True, f"{len(ages)}/{n} shard(s) receiving, last message {min(ages):.0f} s ago"
    opened = [s for s in shards if s.get("gap_open_since")]
    if opened and all(s.get("state") in RETRYING for s in opened):
        return True, f"gap open in {len(opened)}/{n} shard(s), reconnecting"
    states = ",".join(_str(s.get("state")) or "?" for s in shards)
    return False, f"no shard received a message in {MSG_MAX_AGE_S:.0f} s and not all open gaps are reconnecting (states {states})"


def evaluate(h: dict[str, str], now: datetime | None = None) -> tuple[bool, str]:
    now = now or datetime.now(UTC)
    h = h or {}
    hb = _age_s(h.get("updated_at"), now)
    if not _fresh(hb, HEARTBEAT_MAX_AGE_S):
        return False, "ais status heartbeat " + ("missing" if hb is None else f"{hb:.0f} s old")
    state = h.get("state", "")
    if state == "disabled":
        return True, "disabled (no API key)"
    shards = _shards(h.get("shards"))
    if shards:
        return _evaluate_shards(shards, now)
    msg = _age_s(h.get("last_msg_at"), now)
    if _fresh(msg, MSG_MAX_AGE_S):
        return True, f"last message {msg:.0f} s ago ({state})"
    if h.get("gap_open_since") and state in RETRYING:
        return True, f"gap open since {h['gap_open_since']}, {state}"
    return False, f"no message for {'ever' if msg is None else f'{msg:.0f} s'} and not reconnecting (state {state or '?'})"


def main() -> int:
    from redis import Redis
    from redis.backoff import NoBackoff
    from redis.retry import Retry

    from wakeline_collector.ais.config import AisSettings

    s = AisSettings()
    r = Redis(
        host=s.redis_host,
        port=s.redis_port,
        username=s.redis_username or None,
        password=s.redis_password.get_secret_value() or None,
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
    ok, why = evaluate(h)
    print(("ok: " if ok else "unhealthy: ") + why, file=sys.stdout if ok else sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
