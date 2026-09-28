"""구독 영역(bounding box) 설정 — `lat1,lon1,lat2,lon2` 상자를 ';' 로 잇고, 구역(연결)을 '|' 로 나눈 문자열
(계약 v2 §B1 · v4 §D: AIS_BBOXES · wakeline:settings.ais_bboxes).

- 구역 = WebSocket 연결 하나. 최대 3개(aisstream 키당 연결 수). '|' 가 없으면 구역 하나(v4 이전과 같다).
- 구역마다 상자 1–16개, 빈 조각(끝의 ';')은 건너뛴다. 빈 구역('a||b' · 끝의 '|')은 오류다(구역마다 상자 1개 이상).
- 전체 1,024자 이하. 정규화한 문자열(상태 해시 bbox)도 1,024자를 넘지 않아야 한다(지수 표기 1e-6 같은 값은 정규화하면 길어진다).
aisstream.io 구독 형식은 상자마다 두 모서리 `[[lat, lon], [lat, lon]]`(문서 확인 2026-09-28). 값은 그대로 넘기고 모서리 순서를 바꾸지 않는다.
검증 실패는 ValueError — 환경변수 값은 기동을 거부하고(설정 오류를 빨리 드러냄), 런타임 설정 값은 무시하고 현재 구독을 유지한다.
"""

from __future__ import annotations

import asyncio
import math

BBox = tuple[float, float, float, float]  # lat1, lon1, lat2, lon2
Shards = tuple[tuple[BBox, ...], ...]  # 구역마다 상자 튜플

DEFAULT_BBOXES = "18,105,46,150"  # 동아시아(ADR-014 실측 범위)
GLOBAL_BBOXES = "-90,-180,90,180"
MAX_BOXES = 16  # 구역 하나의 상자 수
MAX_TEXT = 1024
MAX_SHARDS = 3  # aisstream 키·IP 당 연결 수
SHARD_SEP = "|"


def parse_bboxes(text: str) -> tuple[BBox, ...]:
    """구역 하나의 설정 문자열 → 상자 튜플. 빈 조각(끝의 ';')은 건너뛴다. 형식·범위가 틀리면 ValueError('|' 도 형식 오류)."""
    if not isinstance(text, str):
        raise ValueError("bbox setting must be a string")
    if len(text) > MAX_TEXT:
        raise ValueError(f"bbox setting longer than {MAX_TEXT} chars")
    boxes: list[BBox] = []
    for raw in text.split(";"):
        part = raw.strip()
        if not part:
            continue
        nums = part.split(",")
        if len(nums) != 4:
            raise ValueError(f"box needs 4 numbers lat1,lon1,lat2,lon2: {part[:40]!r}")
        try:
            lat1, lon1, lat2, lon2 = (float(x) for x in nums)
        except ValueError as e:
            raise ValueError(f"box has a non-number: {part[:40]!r}") from e
        if not all(math.isfinite(v) for v in (lat1, lon1, lat2, lon2)):
            raise ValueError(f"box has a non-finite number: {part[:40]!r}")
        if not (-90.0 <= lat1 <= 90.0 and -90.0 <= lat2 <= 90.0):
            raise ValueError(f"latitude out of range [-90, 90]: {part[:40]!r}")
        if not (-180.0 <= lon1 <= 180.0 and -180.0 <= lon2 <= 180.0):
            raise ValueError(f"longitude out of range [-180, 180]: {part[:40]!r}")
        if lat1 == lat2 or lon1 == lon2:
            raise ValueError(f"box has zero area: {part[:40]!r}")
        boxes.append((lat1, lon1, lat2, lon2))
    if not boxes:
        raise ValueError("no bounding box")
    if len(boxes) > MAX_BOXES:
        raise ValueError(f"more than {MAX_BOXES} boxes")
    return tuple(boxes)


def parse_shards(text: str) -> Shards:
    """설정 문자열 전체 → 구역 튜플(구역마다 parse_bboxes 규칙). 형식·범위·개수가 틀리면 ValueError."""
    if not isinstance(text, str):
        raise ValueError("bbox setting must be a string")
    if len(text) > MAX_TEXT:
        raise ValueError(f"bbox setting longer than {MAX_TEXT} chars")
    parts = text.split(SHARD_SEP)
    if len(parts) > MAX_SHARDS:
        raise ValueError(f"more than {MAX_SHARDS} shards ('{SHARD_SEP}'-separated)")
    shards: list[tuple[BBox, ...]] = []
    for i, part in enumerate(parts, 1):
        try:
            shards.append(parse_bboxes(part))
        except ValueError as e:
            if len(parts) == 1:
                raise
            raise ValueError(f"shard {i}: {e}") from e
    out = tuple(shards)
    if len(format_shards(out)) > MAX_TEXT:
        raise ValueError(f"normalized bbox setting longer than {MAX_TEXT} chars")
    return out


def _num(v: float) -> str:
    s = f"{v:.6f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def format_bboxes(boxes: tuple[BBox, ...]) -> str:
    """구역 하나의 정규화한 문자열(공백 이벤트 scope · 상태 해시 shards[].scope · 로그). parse_bboxes 의 역.
    숫자는 '-ddd.dddddd' 이하(최대 11자)라 상자 16개여도 767자를 넘지 않는다."""
    return ";".join(",".join(_num(v) for v in b) for b in boxes)


def format_shards(shards: Shards) -> str:
    """설정 전체의 정규화한 문자열(구역을 '|' 로). parse_shards 의 역."""
    return SHARD_SEP.join(format_bboxes(s) for s in shards)


def to_subscription(boxes: tuple[BBox, ...]) -> list[list[list[float]]]:
    """aisstream.io BoundingBoxes 형식: [[[lat1, lon1], [lat2, lon2]], ...]."""
    return [[[b[0], b[1]], [b[2], b[3]]] for b in boxes]


class Watched[T]:
    """바뀌면 버전이 오르는 값. 설정 감시가 바꾸고(set), 기다리는 쪽(재구독 · 구역 관리)이 wait_change 로 깬다."""

    def __init__(self, value: T):
        self._value = value
        self.version = 0
        self._changed = asyncio.Event()

    def snapshot(self) -> tuple[T, int]:
        return self._value, self.version

    def set(self, value: T) -> bool:
        if value == self._value:
            return False
        self._value = value
        self.version += 1
        self._changed.set()
        return True

    async def wait_change(self, seen_version: int) -> None:
        while self.version == seen_version:
            self._changed.clear()
            await self._changed.wait()


class BboxState(Watched[tuple[BBox, ...]]):
    """연결(구역) 하나가 지금 원하는 구독 영역. 구역 관리가 바꾸고, 그 연결의 재구독 태스크가 기다린다."""


class ShardsState(Watched[Shards]):
    """설정 전체(구역 목록). 설정 감시(BboxWatcher)가 바꾸고, 구역 관리(AisStreamPool)가 기다린다."""
