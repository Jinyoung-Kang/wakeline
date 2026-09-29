"""해양수산부_선박운항정보(PORT-MIS) 공급자(ADR-022) — GET https://apis.data.go.kr/1192000/VsslEtrynd5/Info5.

필수: serviceKey · prtAgCd(항만청 코드) · sde · ede(YYYYMMDD). 선택: pageNo · numOfRows(≤ 50) · deGb(I = 입항일 기준, 기본) · clsgn(호출부호).
- 키는 환경변수 DATA_GO_KR_SERVICE_KEY(수집기 컨테이너에만). 공공데이터포털은 "인코딩 키"(%2B·%2F·%3D)와 "디코딩 키"(+·/·=)를 함께 준다 —
  어느 쪽을 넣어도 되게 '%' 가 있으면 한 번 풀어(decode_service_key) 두고, 보낼 때 httpx 가 한 번만 인코딩한다(%252B 처럼 두 번 인코딩되지 않게).
  키 모양 목록(service_key_forms)을 비밀값 목록에 올려(register_secrets — main) 어디에 나와도 가린다. URL 은 로그·상태에 쓰지 않는다.
  키 규칙 · 호스트는 연안 교통량(ADR-023)과 같은 것 하나다(providers/data_go_kr).
- 호출 속도는 HttpClient 의 RateLimiter 가 정한다: 호스트 apis.data.go.kr 버킷 하나(1 req/s, burst 2 — 연안 교통량 두 서비스와 나눠 쓴다) +
  수집기 전체 버킷. 우선순위 PRIORITY_PORTCALL — 연안 교통량 5분 폴링(PRIORITY_FIXED)보다 낮고 격자 채우기(PRIORITY_BACKFILL)보다 높다.
- 응답 본문은 돌려주지 않는다 — 파싱·검증한 쪽(ParsedPage)만 돌려준다.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime

from wakeline_collector.config import settings
from wakeline_collector.http import BeforeSend, HttpClient
from wakeline_collector.portcalls import CALL_SIGN_RE, PORT_AUTHORITIES, ParsedPage, parse_page
from wakeline_collector.providers.data_go_kr import DATA_GO_KR_HOST, decode_service_key
from wakeline_collector.ratelimit import PRIORITY_PORTCALL

NUM_OF_ROWS = 50  # 공급자 상한(Swagger: numOfRows 최대 50)
PORTMIS_WAIT_S = 15.0  # 속도 상한 대기 상한(요청 하나)
PORTMIS_TOTAL_S = 20.0  # 요청 하나 전체(보내기 ~ 본문 끝) 상한
_PA_CODES = frozenset(code for code, _ in PORT_AUTHORITIES)


@dataclass(frozen=True)
class PageFetch:
    page: ParsedPage
    latency_ms: int
    fetched_at: datetime


class PortMisProvider:
    """(항만청, 호출부호, 기간, 쪽) → ParsedPage. 호출 1회 = 예산 1."""

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

    def params(self, *, port_authority: str, call_sign: str, sde: date, ede: date, page_no: int) -> dict[str, str]:
        """요청 쿼리. 입력은 여기서 다시 검증한다(URL 에 들어가는 값)."""
        if port_authority not in _PA_CODES:
            raise ValueError("unknown port authority code")
        if not isinstance(call_sign, str) or not CALL_SIGN_RE.fullmatch(call_sign):
            raise ValueError("invalid call sign")
        if not (1 <= page_no <= 100) or sde > ede:
            raise ValueError("invalid page or window")
        return {
            "serviceKey": self._key,
            "prtAgCd": port_authority,
            "sde": sde.strftime("%Y%m%d"),
            "ede": ede.strftime("%Y%m%d"),
            "pageNo": str(page_no),
            "numOfRows": str(NUM_OF_ROWS),
            "deGb": "I",
            "clsgn": call_sign,
        }

    async def fetch_page(
        self,
        *,
        port_authority: str,
        call_sign: str,
        sde: date,
        ede: date,
        page_no: int,
        wait_s: float = PORTMIS_WAIT_S,
        before_send: BeforeSend | None = None,
    ) -> PageFetch:
        """한 쪽. 실패는 예외 그대로(Throttled · SendCancelled · ProviderHttpError · httpx 오류 · PortCallApiError · PortCallParseError)."""
        params = self.params(port_authority=port_authority, call_sign=call_sign, sde=sde, ede=ede, page_no=page_no)
        resp = await self._http.get(
            self._url,
            params=params,
            headers={"Accept": "application/xml"},  # JSON 을 요청해도 XML 이 온다(2026-09-29 확인) — XML 만 읽는다
            priority=PRIORITY_PORTCALL,
            wait_s=wait_s,
            before_send=before_send,
            total_s=PORTMIS_TOTAL_S,
        )
        return PageFetch(parse_page(resp.body, call_sign), resp.latency_ms, resp.fetched_at)
