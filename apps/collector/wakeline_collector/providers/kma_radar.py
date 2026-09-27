"""기상청 API허브 레이더 합성자료(FR-31). 문서: apihub.kma.go.kr 레이더합성자료 다운로드(seqApi=5), 활용신청 필요.

- 파일 목록: /api/typ01/url/rdr_cmp_file_list.php?cmp=HSR&tm=YYYYMMDD → "RDR_CMP_HSR_EXT_YYYYMMDDHHMM.bin.gz,=" 줄들
- 바이너리: /api/typ04/url/rdr_cmp_file.php?tm=YYYYMMDDHHMM(KST)&data=bin&cmp=HSR → gzip(RDR_CMP 포맷). 없는 시각은 200 + text/plain "file not exist".
- 생산 주기 5분(포맷 문서), 최근 2일 조회 가능.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

from wakeline_collector.http import HttpClient
from wakeline_collector.models import ProviderResult

LIST_URL = "https://apihub.kma.go.kr/api/typ01/url/rdr_cmp_file_list.php"
FILE_URL = "https://apihub.kma.go.kr/api/typ04/url/rdr_cmp_file.php"
KST = timedelta(hours=9)
_LINE = re.compile(r"RDR_CMP_([A-Z]+)_[A-Z]+_(\d{12})\.bin\.gz")


def kst_now(now_utc: datetime | None = None) -> datetime:
    return (now_utc or datetime.now(UTC)) + KST


def parse_file_list(text: str, cmp: str) -> list[str]:
    """목록 응답에서 tm(YYYYMMDDHHMM)을 오름차순으로."""
    tms = sorted({m.group(2) for m in _LINE.finditer(text) if m.group(1) == cmp})
    return tms


class KmaRadarProvider:
    name = "kma_radar"

    def __init__(self, http: HttpClient, key: str, cmp: str = "HSR"):
        self._http, self._key, self.cmp = http, key, cmp

    @property
    def configured(self) -> bool:
        return bool(self._key)

    async def file_list(self, day_kst: str) -> ProviderResult:
        resp = await self._http.get(LIST_URL, params={"cmp": self.cmp, "tm": day_kst, "authKey": self._key})
        text = resp.body.decode("euc-kr", "replace")
        if text.lstrip().startswith("{"):
            raise ValueError(f"unexpected list response: {text[:120]}")
        return ProviderResult(
            self.name, resp.body, resp.fetched_at, resp.status, resp.latency_ms, data=parse_file_list(text, self.cmp)
        )

    async def binary(self, tm: str) -> ProviderResult:
        resp = await self._http.get(FILE_URL, params={"tm": tm, "data": "bin", "cmp": self.cmp, "authKey": self._key})
        if not resp.body.startswith(b"\x1f\x8b"):
            raise ValueError(f"not gzip: {resp.body[:80].decode('euc-kr', 'replace')!r}")
        return ProviderResult(
            self.name, resp.body, resp.fetched_at, resp.status, resp.latency_ms, data={"tm": tm, "bytes": len(resp.body)}
        )
