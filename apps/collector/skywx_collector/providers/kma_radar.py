"""기상청 API허브 레이더 합성 영상(FR-31). 문서: apihub.kma.go.kr 레이더합성자료(seqApi=5).

- 엔드포인트(문서 기준, 2026-09-27): /api/typ04/url/rdr_cmp_file.php?tm=YYYYMMDDHHMM(KST)&data=img&cmp=HSR&authKey=…
- 생산 주기 10분. 최근 2일 조회 가능.
- 인증키는 있어도 API 별 "활용신청" 이 없으면 403(JSON) — 그 사실을 상태에 그대로 남긴다.
- 격자·투영(LCC) 정보는 응답으로 확인하기 전까지 추정하지 않으므로, 지도 오버레이가 아니라 영상 그대로를 보여 준다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from skywx_collector.http import HttpClient
from skywx_collector.models import ProviderResult

BASE = "https://apihub.kma.go.kr/api/typ04/url/rdr_cmp_file.php"
KST = timedelta(hours=9)


def latest_tm(now_utc: datetime | None = None, lag_min: int = 10) -> str:
    """KST 기준 10분 격자로 내림한 뒤 생산 지연(lag_min)만큼 뺀 tm."""
    t = (now_utc or datetime.now(UTC)) + KST - timedelta(minutes=lag_min)
    t = t.replace(minute=t.minute // 10 * 10, second=0, microsecond=0)
    return t.strftime("%Y%m%d%H%M")


class KmaRadarProvider:
    name = "kma_radar"

    def __init__(self, http: HttpClient, key: str, cmp: str = "HSR"):
        self._http, self._key, self._cmp = http, key, cmp

    @property
    def configured(self) -> bool:
        return bool(self._key)

    async def image(self, tm: str) -> ProviderResult:
        resp = await self._http.get(BASE, params={"tm": tm, "data": "img", "cmp": self._cmp, "authKey": self._key})
        ctype = resp.headers.get("content-type", "")
        if not ctype.startswith("image/"):
            raise ValueError(f"unexpected content-type {ctype!r}: {resp.body[:120]!r}")
        return ProviderResult(
            self.name,
            resp.body,
            resp.fetched_at,
            resp.status,
            resp.latency_ms,
            data={"tm": tm, "content_type": ctype, "bytes": len(resp.body)},
        )
