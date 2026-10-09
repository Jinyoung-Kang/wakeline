"""기상청 API허브 특보현황(ADR-036 · SPEC F3) — /api/typ01/url/wrn_now_data.php?fe=f&tm=&disp=0&help=1(지금 발효 중인 특보, 구역 코드 단위).

2026-10-09 실제 호출로 확인: EUC-KR 글자 · 머리 주석 + 한 특보 한 줄(쉼표 · 끝 '='), 특보가 없으면 주석만. 해석은 규칙(kma_warning_rules).
호스트 버킷(apihub.kma.go.kr 0.5 req/s · burst 1 — 레이더 합성과 나눈다)은 http 가 건다. 키는 authKey 파라미터 — 로그 · 오류에는 가린 URL 만(masking).
"""

from __future__ import annotations

from wakeline_collector import kma_warning_rules
from wakeline_collector.http import HttpClient
from wakeline_collector.models import ProviderResult

URL = "https://apihub.kma.go.kr/api/typ01/url/wrn_now_data.php"
TOTAL_S = 30.0  # 요청 전체 상한 — 응답은 수 KB(조사 때 첫 호출 한 번 504, 다시 부르자 0.3 s)
READ_S = 15.0


class KmaWarningProvider:
    name = "kma_warning"

    def __init__(self, http: HttpClient, key: str):
        self._http, self._key = http, key

    @property
    def configured(self) -> bool:
        return bool(self._key)

    async def current(self) -> ProviderResult:
        resp = await self._http.get(
            URL, params={"fe": "f", "tm": "", "disp": "0", "help": "1", "authKey": self._key}, total_s=TOTAL_S, read_s=READ_S
        )
        parsed = kma_warning_rules.parse(resp.body)  # 모양이 틀리면 WarningResponseError — 이번 주기는 발행하지 않는다
        return ProviderResult(self.name, resp.body, resp.fetched_at, resp.status, resp.latency_ms, data=parsed)
