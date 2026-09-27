"""구독 영역(bounding box) 설정 — `lat1,lon1,lat2,lon2` 상자를 ';' 로 이어 쓴 문자열(계약 v2 §B1: AIS_BBOXES · wakeline:settings.ais_bboxes).

aisstream.io 구독 형식은 상자마다 두 모서리 `[[lat, lon], [lat, lon]]`(문서 확인 2026-09-28). 값은 그대로 넘기고 모서리 순서를 바꾸지 않는다.
검증 실패는 ValueError — 환경변수 값은 기동을 거부하고(설정 오류를 빨리 드러냄), 런타임 설정 값은 무시하고 현재 구독을 유지한다.
"""

from __future__ import annotations

import asyncio
import math

BBox = tuple[float, float, float, float]  # lat1, lon1, lat2, lon2

DEFAULT_BBOXES = "18,105,46,150"  # 동아시아(ADR-014 실측 범위)
GLOBAL_BBOXES = "-90,-180,90,180"
MAX_BOXES = 16
MAX_TEXT = 1024


def parse_bboxes(text: str) -> tuple[BBox, ...]:
    """설정 문자열 → 상자 튜플. 빈 조각(끝의 ';')은 건너뛴다. 형식·범위가 틀리면 ValueError."""
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


def _num(v: float) -> str:
    s = f"{v:.6f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def format_bboxes(boxes: tuple[BBox, ...]) -> str:
    """정규화한 설정 문자열(상태 해시·로그용). parse_bboxes 의 역."""
    return ";".join(",".join(_num(v) for v in b) for b in boxes)


def to_subscription(boxes: tuple[BBox, ...]) -> list[list[list[float]]]:
    """aisstream.io BoundingBoxes 형식: [[[lat1, lon1], [lat2, lon2]], ...]."""
    return [[[b[0], b[1]], [b[2], b[3]]] for b in boxes]


class BboxState:
    """현재 원하는 구독 영역. 설정 감시가 바꾸고(set), 연결 세션의 재구독 태스크가 기다린다(wait_change)."""

    def __init__(self, boxes: tuple[BBox, ...]):
        self._boxes = boxes
        self.version = 0
        self._changed = asyncio.Event()

    def snapshot(self) -> tuple[tuple[BBox, ...], int]:
        return self._boxes, self.version

    def set(self, boxes: tuple[BBox, ...]) -> bool:
        if boxes == self._boxes:
            return False
        self._boxes = boxes
        self.version += 1
        self._changed.set()
        return True

    async def wait_change(self, seen_version: int) -> None:
        while self.version == seen_version:
            self._changed.clear()
            await self._changed.wait()
