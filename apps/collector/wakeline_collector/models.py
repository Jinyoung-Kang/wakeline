"""스트림에 싣는 정규화 모델. schemas/*.json 과 같은 계약이다(계약 테스트가 대조)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr


class AircraftState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    hex: str = Field(pattern=r"^[0-9a-f]{6}$")
    callsign: str | None = Field(default=None, max_length=8)
    registration: str | None = Field(default=None, max_length=16)
    type_code: str | None = Field(default=None, max_length=8)
    category: str | None = Field(default=None, max_length=4)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    alt_ft: int | None = Field(default=None, ge=-2000, le=100000)
    gs_kt: float | None = Field(default=None, ge=0)
    track_deg: float | None = Field(default=None, ge=0, le=360)
    vrate_fpm: float | None = None
    on_ground: bool = False
    squawk: str | None = Field(default=None, pattern=r"^[0-7]{4}$")
    seen_at: datetime
    provider: str
    fetched_at: datetime
    quality: int = 0
    estimated: bool = False


class Sigmet(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    fir_id: str
    fir_name: str | None = None
    issuer: str | None = None
    series_id: str
    hazard: str
    qualifier: str | None = None
    base_ft: int = 0
    # 고도대 출처(계약 §4). assumed_surface = 하한 미발표(판정은 SFC 가정), unknown = 상한 미발표(판정은 무제한 가정)
    base_source: Literal["json", "assumed_surface"] = "json"
    top_ft: int | None = None
    top_source: Literal["json", "raw_text", "raw_text_lower_bound", "unknown"] = "unknown"
    valid_from: datetime
    valid_to: datetime
    geometry: dict[str, Any] | None = None
    excluded_reason: str | None = None
    move_dir: str | None = None
    move_spd: str | None = None
    chng: str | None = None
    raw_text: str
    provider: str
    fetched_at: datetime
    # 스트림에 싣지 않는 품질 메모(JSON 상한이 잘못돼 쓰지 않은 경우 등). model_dump 에 포함되지 않는다.
    _band_note: str | None = PrivateAttr(default=None)

    @property
    def band_note(self) -> str | None:
        return self._band_note

    @band_note.setter
    def band_note(self, v: str | None) -> None:
        self._band_note = v


@dataclass
class BudgetInfo:
    remaining: int | None = None
    limit: int | None = None


@dataclass
class ProviderResult:
    """공급자 어댑터가 돌려주는 결과. raw 는 원천 본문(바이트) — 원천 보관·재처리용."""

    provider: str
    raw: bytes
    fetched_at: datetime
    http_status: int
    latency_ms: int
    data: Any = None
    budget: BudgetInfo | None = None
    extra: dict[str, Any] = field(default_factory=dict)
