"""ais 프로세스 설정(환경변수). 항공기 수집기 Settings 와 분리 — 이 컨테이너가 받는 값만 안다(DB·OpenSky·기상청 없음).

AISSTREAM_API_KEY 는 SecretStr 이라 repr·로그·예외에 값이 나오지 않는다. 쓰는 곳은 구독 메시지 하나뿐이다.
"""

from __future__ import annotations

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from wakeline_collector.ais.bbox import DEFAULT_BBOXES, parse_shards


class AisSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    redis_host: str = "redis"
    redis_port: int = Field(default=6379, ge=1, le=65535)
    redis_username: str = ""  # 계약 v2 §C: wakeline_ais
    redis_password: SecretStr = SecretStr("")
    aisstream_api_key: SecretStr = SecretStr("")  # compose 가 .env 의 aisstream_key 를 이 이름으로 넘긴다

    ais_bboxes: str = DEFAULT_BBOXES  # 런타임에는 wakeline:settings.ais_bboxes 가 덮어쓴다('|' 로 구역 나누기, 계약 v4 §D)
    http_user_agent: str = "wakeline-dev/0.2"
    fixtures_dir: str = "/app/fixtures"
    wakeline_fixture_mode: int = 0

    ais_queue_max: int = Field(default=20_000, ge=100, le=200_000)
    ais_flush_s: float = Field(default=10.0, ge=1.0, le=60.0)
    ais_idle_timeout_s: float = Field(default=120.0, ge=30.0, le=3600.0)
    ais_max_ships: int = Field(default=50_000, ge=100, le=500_000)

    @field_validator("ais_bboxes")
    @classmethod
    def _bboxes(cls, v: str) -> str:
        parse_shards(v)  # 잘못된 기본값은 기동 거부(설정 오류를 숨기지 않는다)
        return v

    @field_validator("http_user_agent")
    @classmethod
    def _ua(cls, v: str) -> str:
        v = "".join(ch for ch in v if ch.isprintable()).strip()[:200]
        return v or "wakeline"

    @property
    def fixture_mode(self) -> bool:
        return self.wakeline_fixture_mode == 1
