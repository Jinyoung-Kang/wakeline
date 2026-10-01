"""기상청 레이더 합성 프레임 저장소(Redis 어댑터) — 키 · 직렬화 · TTL 을 여기서만 안다. 무엇을 언제 쓸지는 작업(jobs/kma_radar.py)이 정한다.

키(계약 — api 가 읽는다):
- KEY_META(hash): latest_tm · fetched_at(latest_tm 을 처음 저장한 시각 = STALE 시계) · 헤더 값 · 지점 필드 · 상태 · note · '파일 없음' 연속(missing_*) ·
  알린 공백(missing_gap_*).
- KEY_FRAMES(JSON list, 오래된 → 최신): 프레임 항목. 키 TTL = 가장 새 이미지의 남은 TTL(expires_at) — 수집기가 멈추면 이미지와 함께 만료된다.
- KEY_FRAME(base64 PNG, TTL FRAME_TTL_S): 프레임 이미지.

Redis 오류(RedisError · OSError)는 삼키지 않고 올린다 — 작업이 단계별로 'error' 실행 하나로 적는다(D2 · collector-review F1: 전에는 redis-py 예외가
스케줄러까지 올라가 그 주기의 실행 기록 · 품질 사례를 잃었다). 쓰는 순서(이미지 → meta → 목록)도 작업이 정한다(_store · _note_refetch).
"""

from __future__ import annotations

import base64
from datetime import UTC, datetime
from typing import Any

import orjson
from redis.asyncio import Redis

from wakeline_collector.kma_rules import FRAME_TTL_S, parse_iso, tm_dt

KEY_META = "wakeline:radar_kr:meta"  # hash
KEY_FRAMES = "wakeline:radar_kr:frames"  # JSON list (오래된 → 최신)
KEY_FRAME = "wakeline:radar_kr:frame:{tm}"  # base64 PNG, TTL


class KmaStore:
    def __init__(self, redis: Redis) -> None:
        self._r = redis

    async def frames(self) -> list[dict]:
        """프레임 목록(항목은 tm 이 있는 dict 만). 없거나 JSON 이 아니면 []."""
        raw = await self._r.get(KEY_FRAMES)
        try:
            frames = orjson.loads(raw) if raw else []
        except orjson.JSONDecodeError:
            return []
        return [f for f in frames if isinstance(f, dict) and isinstance(f.get("tm"), str)] if isinstance(frames, list) else []

    async def save_frames(self, frames: list[dict]) -> None:
        """목록 저장 + 일관성: 목록 키 TTL = 가장 새 이미지의 남은 TTL(expires_at). 비면 키를 지우고 available=0."""
        r = self._r
        if not frames:
            await r.delete(KEY_FRAMES)
            await r.hset(KEY_META, "available", "0")
            return
        ttl = FRAME_TTL_S
        try:
            exp = datetime.fromisoformat(str(frames[-1].get("expires_at", "")).replace("Z", "+00:00"))
            ttl = max(1, min(FRAME_TTL_S, int((exp - datetime.now(UTC)).total_seconds())))
        except ValueError:
            pass  # 옛 항목(expires_at 없음) — 최대 TTL
        await r.set(KEY_FRAMES, orjson.dumps(frames).decode(), ex=ttl)

    async def images_exist(self, frames: list[dict]) -> list[bool]:
        """항목마다 이미지가 아직 있는가(파이프라인 EXISTS 한 번 — 트랜잭션 없음: 수집기 ACL 에 MULTI 가 없다)."""
        pipe = self._r.pipeline(transaction=False)
        for f in frames:
            pipe.exists(KEY_FRAME.format(tm=f["tm"]))
        return [bool(x) for x in await pipe.execute()]

    async def latest_stored(self) -> tuple[str, datetime | None]:
        """meta 해시의 (latest_tm — 이 작업이 저장한 가장 새 tm, 프레임이 모두 만료돼도 남는다 · 다시 띄워도 읽는다, fetched_at — 그 tm 을 처음 저장한
        시각 = STALE 시계). 없거나 틀리면 (빈 글자, None)."""
        v, f = await self._r.hmget(KEY_META, "latest_tm", "fetched_at")
        latest = v if isinstance(v, str) and tm_dt(v) is not None else ""
        return latest, parse_iso(f) if latest else None

    async def latest_raw(self) -> tuple[Any, Any]:
        """meta 해시의 latest_tm · fetched_at 그대로(검사 전 — 저장이 STALE 시계를 옮길지 정할 때)."""
        v, f = await self._r.hmget(KEY_META, "latest_tm", "fetched_at")
        return v, f

    async def put_image(self, tm: str, png: bytes) -> None:
        await self._r.set(KEY_FRAME.format(tm=tm), base64.b64encode(png).decode("ascii"), ex=FRAME_TTL_S)

    async def drop_images(self, tms: list[str]) -> None:
        await self._r.delete(*[KEY_FRAME.format(tm=tm) for tm in tms])

    async def write_meta(self, mapping: dict[str, str]) -> None:
        await self._r.hset(KEY_META, mapping=mapping)  # type: ignore[arg-type]

    async def read_meta(self) -> dict[Any, Any]:
        """meta 해시 전체(연속 · 알린 공백을 이어받을 때 — 상한은 부르는 쪽이 건다)."""
        return await self._r.hgetall(KEY_META)

    async def write_streak(self, fields: dict[str, str], gap: dict[str, str], provider_key: str | None) -> None:
        """연속 필드를 meta 해시에 알린 공백과 함께 쓰고, provider_key 가 있으면 공급자 해시(wakeline:provider:kma_radar)에도 쓴다."""
        await self._r.hset(KEY_META, mapping=fields | gap)  # type: ignore[arg-type]
        if provider_key is not None:
            await self._r.hset(provider_key, mapping=fields)  # type: ignore[arg-type]
