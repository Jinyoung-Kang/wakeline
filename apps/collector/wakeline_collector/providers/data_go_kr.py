"""공공데이터포털(apis.data.go.kr) — 서비스 키 하나(DATA_GO_KR_SERVICE_KEY)로 부르는 세 서비스의 공통 규칙과 연안 교통량 공급자 두 개(ADR-023).

세 서비스(ADR-022 해양수산부 선박운항정보 PORT-MIS — providers/portmis.py · 아래 둘)는 키 · 키 모양 가림(service_key_forms) · 호스트 버킷 하나를 나눠 쓴다.

- 한국해양교통안전공단 실시간 해양교통정보: GET /B554035/realtime/get_realtime?serviceKey=&pageNo=1&numOfRows=6000&dataType=JSON
  (2026-09-29 확인: 한 번에 전체 5,099건 · 245,985 B). 해석은 traffic_grid.parse_komsa.
- 해양수산부 격자4단계 WFS: GET /1192000/apVhdService_G4s/getOpnG4sWFS?ServiceKey=&grid_no=<id>&maxFeatures=1 → GML 3.1.1.
  해석은 marine_grid.parse_wfs. 키 파라미터 이름의 대소문자가 두 서비스에서 다르다(serviceKey · ServiceKey — 확인한 그대로).

서비스 키: 포털은 '인코딩 키'(퍼센트 인코딩)와 '디코딩 키'를 함께 준다. httpx 가 파라미터를 한 번 인코딩하므로 디코딩 키를 넘겨야 한다 —
인코딩 키를 그대로 넘기면 %2B 가 %252B 로 두 번 인코딩돼 인증이 실패한다. 그래서 '%' 가 있으면 한 번 풀어 둔다(decode_service_key).
키는 URL 쿼리에만 실리고 로그 · 상태 · Redis · DB 로 가지 않는다: httpx 로그는 끄고(main), 오류 문구는 mask 를 거치며(serviceKey= · ServiceKey=
모양 규칙 — 언어 간 벡터), 키 값 자체도 네 가지 형태(원문 · 디코딩 · 퍼센트 인코딩 · + 인코딩)를 값 치환 목록에 넣는다(service_key_forms — main).
호출 속도는 HttpClient 의 RateLimiter 가 정한다: 호스트 apis.data.go.kr 버킷 하나(설정 data_go_kr_rps, burst 2) + 수집기 전체 버킷.
세 잡은 우선순위로 나눈다 — 교통 5분 폴링 PRIORITY_FIXED > 선택 선박 입출항 PRIORITY_PORTCALL > 격자 채우기 PRIORITY_BACKFILL(가장 낮다).
하루 호출 수: 공급자마다 UTC 날 예산(budget:{공급자}:{yyyymmdd}) + 포털 하루 한도를 어느 날 경계로 세어도 지키는 Redis 시간 창 — 교통 폴링은
budget:komsa_traffic:h:*(jobs/traffic_grid.HOURLY_CAP), 해양수산부 두 서비스(PORT-MIS · 격자 WFS)는 함께 세는 budget:mof:h:*(아래 MOF_*).
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote, quote_plus, unquote

from wakeline_collector.http import BeforeSend, FetchResponse, HttpClient
from wakeline_collector.marine_grid import WfsResult, parse_wfs
from wakeline_collector.ratelimit import PRIORITY_BACKFILL, PRIORITY_FIXED
from wakeline_collector.traffic_grid import GRID_ID_RE, KomsaSnapshot, parse_komsa

DATA_GO_KR_HOST = "apis.data.go.kr"
KOMSA_URL = f"https://{DATA_GO_KR_HOST}/B554035/realtime/get_realtime"
WFS_URL = f"https://{DATA_GO_KR_HOST}/1192000/apVhdService_G4s/getOpnG4sWFS"
KOMSA_ROWS = (
    6000  # 확인: 한 번에 전체(5,099건)가 온다. totalCount 가 이보다 많으면 스냅샷에 partial 로 표시(다음 쪽은 받지 않는다)
)
KOMSA_TOTAL_S = 30.0  # 요청 전체 상한(약 246 KB) — 선택값
KOMSA_READ_S = 15.0
WFS_TOTAL_S = 15.0
WFS_WAIT_S = 5.0  # 속도 상한 대기 상한 — 못 받으면 이번 틱의 채우기를 멈춘다(보내지 않았으니 예산을 되돌린다)

# 해양수산부 두 서비스(선박운항정보 PORT-MIS portmis · 격자4단계 WFS mof_grid4)가 함께 세는 Redis 시간 창 budget:mof:h:{UTC 시}(ADR-022 · ADR-023).
# 확인한 것: 포털 개발계정 한도는 API 하나당 하루 10,000회. 확인하지 않은 것: 두 API 의 한도가 기관 단위로 묶여 있는지, 포털이 하루를 어느
# 경계(KST 자정 · UTC 자정 · 지난 24시간)로 세는지. UTC 날 예산(3,000 · 6,000)만으로는 KST 하루가 두 UTC 날에 걸쳐 두 몫을 쓸 수 있었다(검토 지적 —
# 입출항 3,000 × 2 + 첫 격자 채우기 약 5,100). 어떤 24시간이든 UTC 시 창을 많아야 25개 걸치므로 25 × MOF_HOURLY_CAP = 10,000 — 두 API 를 합쳐도,
# 어느 경계로 세어도 넘지 않는다. 두 값 모두 선택값이다(잰 값이 아니다).
MOF_HOUR_WINDOW = "mof"
MOF_HOURLY_CAP = 400
# 격자 채우기(가장 낮은 우선순위)는 창의 이만큼을 남기고 그 시의 채우기를 멈춘다 — 사람이 기다리는 입출항 조회(선박 하나 = 요청 10회 이상)가
# 매시 적어도 이만큼을 쓸 수 있게. 채우기 몫은 시간당 많아야 MOF_HOURLY_CAP − 이 값(300칸)이다
MOF_GRID4_HOURLY_HEADROOM = 100


def decode_service_key(raw: str | None) -> str:
    """앞뒤 공백을 떼고, 인코딩 키('%' 가 있음)면 한 번 푼다 — 디코딩 키는 그대로."""
    k = (raw or "").strip()
    return unquote(k) if "%" in k else k


def service_key_forms(raw: str | None) -> list[str]:
    """값으로 가릴 키의 모든 모양(세 서비스 공통 — ADR-022 · ADR-023): 넣은 그대로(원문) · 디코딩 키 · 퍼센트 인코딩(포털의 '인코딩 키'
    이자 요청 URL 에 실리는 모양) · + 인코딩(공백이 + 가 되는 폼 인코딩). 같은 모양은 한 번만, 빈 키는 없음."""
    key = (raw or "").strip()
    dec = decode_service_key(key)
    if not dec:
        return []
    return [v for v in dict.fromkeys((key, dec, quote(dec, safe=""), quote_plus(dec))) if v]


class KomsaTrafficProvider:
    """실시간 해양교통정보 한 번 = 예산 1(budget:komsa_traffic)."""

    name = "komsa_traffic"
    cost = 1
    host = DATA_GO_KR_HOST

    def __init__(self, http: HttpClient, key: str) -> None:
        self._http = http
        self._key = decode_service_key(key)

    @property
    def configured(self) -> bool:
        return bool(self._key)

    async def fetch(self, *, before_send: BeforeSend | None = None) -> tuple[FetchResponse, KomsaSnapshot]:
        """응답과 해석 결과. 실패는 예외 그대로(Throttled · SendCancelled · ProviderHttpError · httpx 오류 · KomsaApiError · ValueError)."""
        resp = await self._http.get(
            KOMSA_URL,
            params={"serviceKey": self._key, "pageNo": 1, "numOfRows": KOMSA_ROWS, "dataType": "JSON"},
            priority=PRIORITY_FIXED,
            before_send=before_send,
            total_s=KOMSA_TOTAL_S,
            read_s=KOMSA_READ_S,
        )
        return resp, parse_komsa(resp.body)


@dataclass(frozen=True)
class WfsLookup:
    result: WfsResult
    body: bytes
    latency_ms: int | None


class Grid4WfsProvider:
    """격자 한 칸의 기하 한 번 = 예산 1(budget:mof_grid4). 우선순위는 가장 낮다(PRIORITY_BACKFILL)."""

    name = "mof_grid4"
    cost = 1
    host = DATA_GO_KR_HOST

    def __init__(self, http: HttpClient, key: str) -> None:
        self._http = http
        self._key = decode_service_key(key)

    @property
    def configured(self) -> bool:
        return bool(self._key)

    async def lookup(self, grid_no: str, *, wait_s: float = WFS_WAIT_S, before_send: BeforeSend | None = None) -> WfsLookup:
        """found · not_found · off_grid. grid_no 가 형식에 맞지 않으면 보내지 않고 ValueError. 그 밖 실패는 예외 그대로(WfsError 포함)."""
        if not isinstance(grid_no, str) or not GRID_ID_RE.fullmatch(grid_no):
            raise ValueError("invalid grid_no")
        resp = await self._http.get(
            WFS_URL,
            headers={"Accept": "*/*"},
            params={"ServiceKey": self._key, "grid_no": grid_no, "maxFeatures": 1},
            priority=PRIORITY_BACKFILL,
            wait_s=wait_s,
            before_send=before_send,
            total_s=WFS_TOTAL_S,
        )
        return WfsLookup(parse_wfs(resp.body, grid_no), resp.body, resp.latency_ms)
