"""환경변수 설정. 외부 키는 이 프로세스에만 존재한다."""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # 연결
    redis_host: str = "redis"
    redis_port: int = 6379
    redis_username: str = ""  # Redis ACL 사용자(계약 §6: wakeline_collector). 비우면 default 사용자
    redis_password: str = ""
    db_host: str = "db"
    db_port: int = 5432
    db_name: str = "wakeline"
    db_collector_password: str = ""

    # 외부 공급자
    http_user_agent: str = "wakeline-dev/0.2 (contact: you@example.com)"
    opensky_client_id: str = ""
    opensky_client_secret: str = ""
    # 우선순위. opensky 는 전세계(global) 전용 — 관심 지역 폴백에는 쓰지 않는다(크레딧 보호, FR-02).
    aircraft_providers: str = "adsb_lol,adsb_fi,opensky"
    kma_apihub_key: str = ""  # 기상청 API허브(레이더 합성자료 활용신청 필요)
    kma_radar_poll_s: int = 300
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
    budget_adsb_fi: int = 40000  # 계약 v2 §A2(관심 지역 폴백 + focus + hot 합계)
    budget_opensky: int = 2880  # FR-02: 계정 일일 4,000 크레딧의 72% 이하(전세계 120 s × 4 크레딧 = 2,880/일)
    budget_awc: int = 2000
    budget_rainviewer: int = 2000
    budget_kma_radar: int = 1000
    budget_adsbdb: int = 2000  # 계약 v4 §A: 노선 조회(선택한 항공기의 콜사인만)
    opensky_reserve_credits: int = 400  # OpenSky 가 알려 준 남은 크레딧이 이 아래면 UTC 자정까지 OpenSky 호출 중단

    # 호출 속도 상한(계약 v2 §A2, 프로세스 안 토큰 버킷). adsb.fi 공개 한도 초당 1회의 80 %.
    http_global_rps: float = Field(default=2.0, gt=0, le=20)
    adsb_fi_rps: float = Field(default=0.8, gt=0, le=1.0)
    # 항공기 노선(계약 v4 §A · ADR-016): adsbdb 는 한도를 문서에 적지 않았다 — 호스트 0.5 req/s(burst 2)로 보수적으로.
    adsbdb_rps: float = Field(default=0.5, gt=0, le=1.0)
    # 호스트는 api.adsbdb.com 만(HttpClient 허용 목록과 같다) — 다른 호스트는 보내지도 못하면서 예산·호출 수만 쓰게 된다
    adsbdb_base_url: str = Field(default="https://api.adsbdb.com", pattern=r"^https://api\.adsbdb\.com(:443)?/?$")

    # 수요 기반 정밀 추적(ADR-013). 임대(lease)는 api 가 쓰고 수집기는 읽기만 한다.
    demand_enabled: bool = True
    # adsb_fi 하루 예산 중 우선순위가 높은 쪽 몫: focus·hot 은 남은 예산이 이 아래로 내려가면 호출하지 않는다.
    #   관심 지역 폴백 몫 = 10 s × 1일(8,640). hot 은 여기에 focus 몫(1,000)을 더한 선에서 먼저 멈춘다(우선순위 region > focus > hot).
    demand_budget_reserve_region: int = Field(default=8640, ge=0)
    demand_budget_reserve_focus: int = Field(default=1000, ge=0)

    # 경로
    raw_dir: str = "/data/raw"
    fixtures_dir: str = "/app/fixtures"
    schemas_dir: str = "/app/schemas"
    raw_retention_h: int = 72

    wakeline_fixture_mode: int = Field(default=0)
    # 시스템 로그 싱크(계약 v5 §C2 · ADR-018): WARN·ERROR 를 가려서 wakeline:logs 로. LOG_SINK_ENABLED=0 이면 끈다(compose 에는 넣지 않는다 — 기본 켬)
    log_sink_enabled: bool = True
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
        return self.wakeline_fixture_mode == 1

    @property
    def provider_order(self) -> list[str]:
        return [p.strip() for p in self.aircraft_providers.split(",") if p.strip()]


settings = Settings()
