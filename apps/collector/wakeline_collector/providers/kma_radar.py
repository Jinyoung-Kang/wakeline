"""기상청 API허브 레이더 합성자료(FR-31). 문서: apihub.kma.go.kr 레이더합성자료 다운로드(seqApi=5), 활용신청 필요.

- 파일 목록: /api/typ01/url/rdr_cmp_file_list.php?cmp=HSR&tm=YYYYMMDD → "RDR_CMP_HSR_EXT_YYYYMMDDHHMM.bin.gz,=" 줄들. 파일 이름의 세 번째
  마디(EXT · KMA 등 — 목록이 싣는 파일 종류)를 tm 마다 extra["kinds"] 에 싣는다(parse_file_kinds — 목록 글자 그대로, 뜻을 풀지 않는다).
- 바이너리: /api/typ04/url/rdr_cmp_file.php?tm=YYYYMMDDHHMM(KST)&data=bin&cmp=HSR → gzip(RDR_CMP 포맷). 없는 시각은 200 + text/plain "file not exist".
  2026-09-30 확인(실제 호출): 내려받기는 RDR_CMP_HSR_PUB_<tm>.bin.gz 를 찾는다 — 목록(기본 ext=Y)이 EXT 로 싣는 tm 에도 그 파일이 없으면
  "# file not exist (RDR_CMP_HSR_PUB_<tm>.bin.gz)" 로 답한다(08:15 KST 부터 모든 tm). ext=Y · ext=K 를 붙여도 PUB 를 찾는다.
- 생산 주기 5분(포맷 문서), 최근 2일 조회 가능.
"""

from __future__ import annotations

import re

from wakeline_collector.http import HttpClient
from wakeline_collector.models import ProviderResult

LIST_URL = "https://apihub.kma.go.kr/api/typ01/url/rdr_cmp_file_list.php"
FILE_URL = "https://apihub.kma.go.kr/api/typ04/url/rdr_cmp_file.php"
KMA_TOTAL_S = 40.0  # 요청 전체 상한(R-67) — 바이너리(약 1 MB) 실측 최대 25 s
# 읽기 제한(청크 사이 기다림)은 KMA 호출만 15 s — 선택값이다(KMA 응답 간격을 잰 값이 아니다). 기본 8 s(settings.http_timeout_s)에서
# 'ReadTimeout' 이 잦았다(운영 로그 2026-09-29: 5분 주기 약 27회 중 약 7회). 전체 상한 KMA_TOTAL_S 는 그대로 둔다.
KMA_READ_S = 15.0
_LINE = re.compile(r"RDR_CMP_([A-Z]+)_([A-Z]+)_(\d{12})\.bin\.gz")


def parse_file_list(text: str, cmp: str) -> list[str]:
    """목록 응답에서 tm(YYYYMMDDHHMM)을 오름차순으로."""
    tms = sorted({m.group(3) for m in _LINE.finditer(text) if m.group(1) == cmp})
    return tms


def parse_file_kinds(text: str, cmp: str) -> dict[str, list[str]]:
    """목록 응답에서 tm → 그 tm 에 실린 파일 종류(파일 이름의 세 번째 마디, 예 ["EXT", "KMA"] — 정렬). 다른 합성(cmp)은 세지 않는다."""
    kinds: dict[str, set[str]] = {}
    for m in _LINE.finditer(text):
        if m.group(1) == cmp:
            kinds.setdefault(m.group(3), set()).add(m.group(2))
    return {tm: sorted(k) for tm, k in sorted(kinds.items())}


class KmaRadarProvider:
    name = "kma_radar"

    def __init__(self, http: HttpClient, key: str, cmp: str = "HSR"):
        self._http, self._key, self.cmp = http, key, cmp

    @property
    def configured(self) -> bool:
        return bool(self._key)

    async def file_list(self, day_kst: str) -> ProviderResult:
        resp = await self._http.get(
            LIST_URL, params={"cmp": self.cmp, "tm": day_kst, "authKey": self._key}, total_s=KMA_TOTAL_S, read_s=KMA_READ_S
        )
        text = resp.body.decode("euc-kr", "replace")
        if text.lstrip().startswith("{"):
            raise ValueError(f"unexpected list response: {text[:120]}")
        return ProviderResult(
            self.name,
            resp.body,
            resp.fetched_at,
            resp.status,
            resp.latency_ms,
            data=parse_file_list(text, self.cmp),
            extra={"kinds": parse_file_kinds(text, self.cmp)},
        )

    async def binary(self, tm: str) -> ProviderResult:
        resp = await self._http.get(
            FILE_URL,
            params={"tm": tm, "data": "bin", "cmp": self.cmp, "authKey": self._key},
            total_s=KMA_TOTAL_S,
            read_s=KMA_READ_S,
        )
        if not resp.body.startswith(b"\x1f\x8b"):
            raise ValueError(f"not gzip: {resp.body[:80].decode('euc-kr', 'replace')!r}")
        return ProviderResult(
            self.name, resp.body, resp.fetched_at, resp.status, resp.latency_ms, data={"tm": tm, "bytes": len(resp.body)}
        )
