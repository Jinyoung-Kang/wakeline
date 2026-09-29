"""입출항 색인 작업 시험용 DB — Db 의 색인 메서드(read_port_call_coverage · apply_port_call_day · purge_port_calls)를 메모리에서 같은 규칙으로.

범위 합치기는 실제 코드(portcalls.merge_day)를 쓴다. 행은 (항만청, 호출부호, 입항년도, 입항횟수) → (PortCallRow, fetched_at, updated_at).
실제 SQL 은 tests/test_db_pg_integration.py(선택 실행 — 버리는 PostgreSQL)가 확인한다.
"""

from __future__ import annotations

from datetime import date, datetime

from fakes import RecordingDb

from wakeline_collector.db import DayApplied
from wakeline_collector.portcalls import Coverage, PortCallRow, merge_day


class FakeIndexDb(RecordingDb):
    def __init__(self) -> None:
        super().__init__()
        self.rows: dict[tuple[str, str, str, str], tuple[PortCallRow, datetime, datetime]] = {}
        self.cov: dict[str, Coverage] = {}
        self.down = False  # True = DB 에 닿지 못한다(읽기 · 쓰기 모두 None)
        self.applied: list[tuple[str, date]] = []
        self.reads = 0
        self.runs: list[dict] = []

    async def read_port_call_coverage(self) -> dict[str, Coverage] | None:
        self.reads += 1
        return None if self.down else dict(self.cov)

    async def apply_port_call_day(
        self,
        pa: str,
        day: date,
        rows: list[PortCallRow],
        fetched_at: datetime,
        *,
        reset: bool = False,
        refreshed_at: datetime | None = None,
        refuse_empty_over: int | None = None,
    ) -> DayApplied | None:
        if self.down:
            return None
        cur = self.cov.get(pa)
        stored = [k for k, (r, _f, _u) in self.rows.items() if k[0] == pa and r.listed_date == day]
        if not rows and refuse_empty_over is not None and len(stored) >= refuse_empty_over:
            return DayApplied(False, cur, stored=len(stored), suspect_empty=True)
        for r in rows:
            old = self.rows.get(r.key)
            updated = fetched_at if old is None or old[0] != r else old[2]
            self.rows[r.key] = (r, fetched_at, updated)
        keep = {r.key for r in rows}
        gone = [k for k in stored if k not in keep]
        for k in gone:
            del self.rows[k]
        self.applied.append((pa, day))
        new = merge_day(cur, day, reset=reset)
        if new is None:
            return DayApplied(True, cur, False, len(rows), len(gone))
        if refreshed_at is not None:
            new = Coverage(new.covered_from, new.covered_to, refreshed_at)
        self.cov[pa] = new
        return DayApplied(True, new, True, len(rows), len(gone))

    def purge_port_calls(self, cutoff: date) -> None:
        self.names.append("port_call_retention")
        for k in [k for k, (r, _f, _u) in self.rows.items() if r.listed_date < cutoff]:
            del self.rows[k]
        for pa, c in list(self.cov.items()):
            if c.covered_from < cutoff <= c.covered_to:
                self.cov[pa] = Coverage(cutoff, c.covered_to, c.refreshed_at)

    def record_run(self, job: str, provider: str, started_at: datetime, **kw) -> None:  # type: ignore[override]
        self.runs.append({"job": job, "provider": provider, **kw})

    def by_call_sign(self, cs: str) -> list[PortCallRow]:
        return [r for (_pa, c, _y, _n), (r, _f, _u) in sorted(self.rows.items()) if c == cs]


class DirectSource:
    """HTTP 를 거치지 않는 공급자(빠른 계획 · 범위 시험용): 가짜 Info5 응답기(respx side_effect 와 같은 모양)를 바로 불러 실제 해석기로 읽는다.
    before_send 를 존중한다(거절하면 SendCancelled). HTTP 경로(속도 상한 · 오류 · 가림)는 respx 시험이 실제 HttpClient 로 본다."""

    name, cost, host = "portmis", 1, "apis.data.go.kr"

    def __init__(self, responder) -> None:
        self.responder = responder
        self.calls = 0

    async def fetch_day_page(self, *, port_authority, day, page_no, wait_s=0.0, before_send=None):
        from datetime import UTC, datetime

        import httpx

        from wakeline_collector.http import ProviderHttpError, SendCancelled
        from wakeline_collector.portcalls import parse_index_page
        from wakeline_collector.providers.portmis import PageFetch

        if before_send is not None and not await before_send():
            raise SendCancelled("cancelled before send")
        self.calls += 1
        ymd = day.strftime("%Y%m%d")
        url = (
            "https://apis.data.go.kr/1192000/VsslEtrynd5/Info5?serviceKey=k"
            f"&prtAgCd={port_authority}&sde={ymd}&ede={ymd}&pageNo={page_no}&numOfRows=50&deGb=I"
        )
        resp = self.responder(httpx.Request("GET", url))
        if resp.status_code != 200:
            raise ProviderHttpError(resp.status_code, resp.text)
        return PageFetch(parse_index_page(resp.content, port_authority, day), 3, datetime.now(UTC))
