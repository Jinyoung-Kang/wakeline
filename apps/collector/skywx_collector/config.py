"""환경변수 설정. 외부 키는 이 프로세스에만 존재한다."""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # 연결
    redis_host: str = "redis"
    redis_port: int = 6379
    redis_password: str = ""
    db_host: str = "db"
    db_port: int = 5432
    db_name: str = "skywx"
    db_collector_password: str = ""

    # 외부 공급자
    http_user_agent: str = "skywx-dev/0.2 (contact: you@example.com)"
    opensky_client_id: str = ""
    opensky_client_secret: str = ""
    aircraft_providers: str = "adsb_lol,adsb_fi,opensky"
    kma_apihub_key: str = ""  # 기상청 API허브(레이더 합성자료 활용신청 필요)
    kma_radar_poll_s: int = 600
    kma_radar_cmp: str = "HSR"

    # 관심 지역·주기 (운영 설정이 덮어씀)
    region_center: str = "36.5,127.8"
    region_radius_nm: int = 250
    region_poll_s: int = 10
    global_poll_s: int = 120
    sigmet_poll_s: int = 300
    radar_poll_s: int = 60
    metar_poll_s: int = 600

    # 하루 예산 (호출 수 또는 크레딧). 0 = 한도 없음(카운트만)
    budget_adsb_lol: int = 10000
    budget_adsb_fi: int = 10000
    budget_opensky: int = 4000
    budget_awc: int = 2000
    budget_rainviewer: int = 2000
    budget_kma_radar: int = 1000
    opensky_reserve_credits: int = 400  # 남은 크레딧이 이 아래면 전세계 수집 중단

    # 경로
    raw_dir: str = "/data/raw"
    fixtures_dir: str = "/app/fixtures"
    schemas_dir: str = "/app/schemas"
    raw_retention_h: int = 72

    skywx_fixture_mode: int = Field(default=0)
    http_timeout_s: float = 8.0
    http_max_bytes: int = 20 * 1024 * 1024

    @property
    def region_lat(self) -> float:
        return float(self.region_center.split(",")[0])

    @property
    def region_lon(self) -> float:
        return float(self.region_center.split(",")[1])

    @property
    def fixture_mode(self) -> bool:
        return self.skywx_fixture_mode == 1

    @property
    def provider_order(self) -> list[str]:
        return [p.strip() for p in self.aircraft_providers.split(",") if p.strip()]


settings = Settings()
