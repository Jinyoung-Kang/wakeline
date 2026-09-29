"""해양수산부_선박운항정보(PORT-MIS) 공급자(ADR-022 · 개정) — GET https://apis.data.go.kr/1192000/VsslEtrynd5/Info5.

필수: serviceKey · prtAgCd(항만청 코드) · sde · ede(YYYYMMDD). 선택: pageNo · numOfRows(≤ 50) · deGb(I = 입항일 기준, 기본) · clsgn(호출부호).
- **clsgn 은 보내지 않는다**(ADR-022 개정): 명세에 있지만 거르지 않는다 — clsgn=V7A3884 는 어느 기간이든 0건인데 clsgn 없이 부르면 494건 중에 있다
  (docs/review/evidence/public-data-apis-2026-09-29.txt 마지막 절). 그래서 입출항 색인(jobs/portcalls_index)이 항만청 · KST 날짜 하루씩(sde = ede) 모든
  쪽을 받는다. 요청 URL 에 들어가는 값(항만청 코드 · 날짜 · 쪽 번호)은 여기서 다시 검증한다.
- 키는 환경변수 DATA_GO_KR_SERVICE_KEY(수집기 컨테이너에만). 공공데이터포털은 "인코딩 키"(%2B·%2F·%3D)와 "디코딩 키"(+·/·=)를 함께 준다 —
  어느 쪽을 넣어도 되게 '%' 가 있으면 한 번 풀어(decode_service_key) 두고, 보낼 때 httpx 가 한 번만 인코딩한다(%252B 처럼 두 번 인코딩되지 않게).
  키 모양 목록(service_key_forms)을 비밀값 목록에 올려(register_secrets — main) 어디에 나와도 가린다. URL 은 로그·상태에 쓰지 않는다.
  키 규칙 · 호스트는 연안 교통량(ADR-023)과 같은 것 하나다(providers/data_go_kr).
- 호출 속도는 HttpClient 의 RateLimiter 가 정한다: 호스트 apis.data.go.kr 버킷 하나(data_go_kr_rps, burst 2 — 연안 교통량 두 서비스와 나눠 쓴다) +
  수집기 전체 버킷. 우선순위 PRIORITY_PORTCALL — 연안 교통량 5분 폴링(PRIORITY_FIXED)보다 낮고 격자 채우기(PRIORITY_BACKFILL)보다 높다.
- 응답 본문은 돌려주지 않는다 — 파싱·검증한 쪽(IndexPage)만 돌려준다.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime

from wakeline_collector.config import settings
from wakeline_collector.http import BeforeSend, HttpClient
from wakeline_collector.portcalls import PORT_AUTHORITIES, IndexPage, parse_index_page
from wakeline_collector.providers.data_go_kr import DATA_GO_KR_HOST, decode_service_key
from wakeline_collector.ratelimit import PRIORITY_PORTCALL

NUM_OF_ROWS = 50  # 공급자 상한(Swagger: numOfRows 최대 50)
MAX_PAGE_NO = 100  # URL 에 넣는 쪽 번호의 상한(작업의 하루 쪽 상한보다 크다 — 여기서는 모양만 막는다)
PORTMIS_WAIT_S = 15.0  # 속도 상한 대기 상한(요청 하나)
PORTMIS_TOTAL_S = 20.0  # 요청 하나 전체(보내기 ~ 본문 끝) 상한
_PA_CODES = frozenset(code for code, _ in PORT_AUTHORITIES)


@dataclass(frozen=True)
class PageFetch:
    page: IndexPage
    latency_ms: int
    fetched_at: datetime


class PortMisProvider:
    """(항만청, KST 날짜 하루, 쪽) → IndexPage. 호출 1회 = 예산 1."""

    name = "portmis"
    cost = 1
    host = DATA_GO_KR_HOST

    def __init__(self, http: HttpClient, service_key: str, base_url: str | None = None):
        self._http = http
        self._key = decode_service_key(service_key)
        self._url = (base_url or settings.portmis_base_url).rstrip("/") + "/Info5"

    @property
    def configured(self) -> bool:
        return bool(self._key)

    def params(self, *, port_authority: str, day: date, page_no: int) -> dict[str, str]:
        """요청 쿼리 — 하루(sde = ede) · 입항일 기준 · 50건씩. 호출부호(clsgn)는 싣지 않는다(거르지 않는다 — ADR-022 개정)."""
        if port_authority not in _PA_CODES:
            raise ValueError("unknown port authority code")
        if not isinstance(day, date) or isinstance(day, datetime):
            raise ValueError("invalid day")
        if not (1 <= page_no <= MAX_PAGE_NO):
            raise ValueError("invalid page")
        ymd = day.strftime("%Y%m%d")
        return {
            "serviceKey": self._key,
            "prtAgCd": port_authority,
            "sde": ymd,
            "ede": ymd,
            "pageNo": str(page_no),
            "numOfRows": str(NUM_OF_ROWS),
            "deGb": "I",
        }

    async def fetch_day_page(
        self,
        *,
        port_authority: str,
        day: date,
        page_no: int,
        wait_s: float = PORTMIS_WAIT_S,
        before_send: BeforeSend | None = None,
    ) -> PageFetch:
        """한 쪽. 실패는 예외 그대로(Throttled · SendCancelled · ProviderHttpError · httpx 오류 · PortCallApiError · PortCallParseError)."""
        params = self.params(port_authority=port_authority, day=day, page_no=page_no)
        resp = await self._http.get(
            self._url,
            params=params,
            headers={"Accept": "application/xml"},  # JSON 을 요청해도 XML 이 온다(2026-09-29 확인) — XML 만 읽는다
            priority=PRIORITY_PORTCALL,
            wait_s=wait_s,
            before_send=before_send,
            total_s=PORTMIS_TOTAL_S,
        )
        return PageFetch(parse_index_page(resp.body, port_authority, day), resp.latency_ms, resp.fetched_at)
