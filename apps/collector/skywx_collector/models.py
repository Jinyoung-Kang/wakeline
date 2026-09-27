"""스트림에 싣는 정규화 모델. schemas/*.json 과 같은 계약이다(계약 테스트가 대조)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


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
    top_ft: int | None = None
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
