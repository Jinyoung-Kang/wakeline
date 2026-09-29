"""입출항 색인 작업 시험용 DB — Db 의 색인 메서드(read_port_call_coverage · apply_port_call_day · purge_port_calls)를 메모리에서 같은 규칙으로.

범위 합치기는 실제 코드(portcalls.merge_day)를 쓴다. 행은 (항만청, 호출부호, 입항년도, 입항횟수) → (PortCallRow, fetched_at, updated_at).
V15 의 행 CHECK 도 같게 지킨다(v15_violation — 어긋난 행이 하나라도 있으면 그 날 전체가 되돌려진다. 실제 Db 처럼 rejected).
실제 SQL 은 tests/test_db_pg_integration.py(선택 실행 — 버리는 PostgreSQL)가 확인한다.
"""

from __future__ import annotations

import re
from dataclasses import fields
from datetime import date, datetime

from fakes import RecordingDb

from wakeline_collector.db import DayApplied
from wakeline_collector.portcalls import Coverage, PortCallRow, merge_day

_KEY_PART = re.compile(r"^[0-9A-Za-z]{1,16}$")
_SHORT = re.compile(r"^[A-Z0-9]{1,10}$")
_PORT = re.compile(r"^[A-Z0-9]{2,10}$")
_TEXT_COLS = (
    "prt_ag_nm", "vssl_nm", "nationality_nm", "kind_nm", "purpose_nm", "first_port_nm", "prev_port_nm", "next_port_nm", "dest_port_nm", "berth",
)  # fmt: skip


def _fmt(v: str | None, pattern: re.Pattern[str]) -> bool:
    return v is None or pattern.fullmatch(v) is not None


def v15_violation(r: PortCallRow) -> str | None:
    """V15 port_call 의 CHECK 중 이 행이 어기는 것의 이름(없으면 None) — V15__port_call_index.sql 과 같은 규칙."""
    checks = (
        ("port_call_prt_ag_cd_format", re.fullmatch(r"[0-9]{3}", r.prt_ag_cd) is not None),
        ("port_call_clsgn_format", re.fullmatch(r"[A-Z0-9]{3,7}", r.clsgn) is not None),
        ("port_call_etrypt_year_format", _KEY_PART.fullmatch(r.etrypt_year) is not None),
        ("port_call_etrypt_co_format", _KEY_PART.fullmatch(r.etrypt_co) is not None),
        ("port_call_nationality_cd_format", _fmt(r.nationality_cd, _SHORT)),
        ("port_call_kind_cd_format", _fmt(r.kind_cd, _SHORT)),
        ("port_call_first_port_cd_format", _fmt(r.first_port_cd, _PORT)),
        ("port_call_prev_port_cd_format", _fmt(r.prev_port_cd, _PORT)),
        ("port_call_next_port_cd_format", _fmt(r.next_port_cd, _PORT)),
        ("port_call_dest_port_cd_format", _fmt(r.dest_port_cd, _PORT)),
        ("port_call_entry_revision", r.entry_revision in (None, "최종", "최초")),
        ("port_call_exit_revision", r.exit_revision in (None, "최종", "최초")),
        (
            "port_call_revision_needs_time",
            (r.entry_revision is None or r.entry_at is not None) and (r.exit_revision is None or r.exit_at is not None),
        ),
        ("port_call_text_len", all(len(getattr(r, c) or "") <= 80 for c in _TEXT_COLS)),
    )
    assert {f.name for f in fields(r)} >= set(_TEXT_COLS)
    return next((name for name, ok in checks if not ok), None)


class FakeIndexDb(RecordingDb):
    def __init__(self) -> None:
        super().__init__()
        self.rows: dict[tuple[str, str, str, str], tuple[PortCallRow, datetime, datetime]] = {}
        self.cov: dict[str, Coverage] = {}
        self.down = False  # True = DB 에 닿지 못한다(읽기 · 쓰기 모두 None)
        self.applied: list[tuple[str, date]] = []
        self.refused: list[tuple[str, date]] = []  # V15 CHECK 로 되돌려진 날
        self.holes_marked: list[tuple[str, date]] = []  # 빈 곳(끝까지 색인하지 못한 날)으로 적은 날
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
        hole: bool = False,
    ) -> DayApplied | None:
        if self.down:
            return None
        if any(v15_violation(r) for r in rows):
            self.refused.append((pa, day))
            return DayApplied(False, None, rejected="CheckViolationError")  # 실제 Db: CHECK 위반 → 되돌려지고 rejected
        cur = self.cov.get(pa)
        stored = [k for k, (r, _f, _u) in self.rows.items() if k[0] == pa and r.listed_date == day]
        if not rows and not hole and refuse_empty_over is not None and len(stored) >= refuse_empty_over:
            return DayApplied(False, cur, stored=len(stored), suspect_empty=True)
        for r in rows:
            old = self.rows.get(r.key)
            updated = fetched_at if old is None or old[0] != r else old[2]
            self.rows[r.key] = (r, fetched_at, updated)
        keep = {r.key for r in rows}
        gone = [] if hole else [k for k in stored if k not in keep]  # 빈 곳인 날은 지우지 않는다
        for k in gone:
            del self.rows[k]
        self.applied.append((pa, day))
        if hole:
            self.holes_marked.append((pa, day))
        new = merge_day(cur, day, reset=reset, hole=hole)
        if new is None:
            return DayApplied(True, cur, False, len(rows), len(gone))
        if refreshed_at is not None:
            new = Coverage(new.covered_from, new.covered_to, refreshed_at, new.holes)
        self.cov[pa] = new
        return DayApplied(True, new, True, len(rows), len(gone))

    def purge_port_calls(self, cutoff: date) -> None:
        self.names.append("port_call_retention")
        for k in [k for k, (r, _f, _u) in self.rows.items() if r.listed_date < cutoff]:
            del self.rows[k]
        for pa, c in list(self.cov.items()):
            if c.covered_from < cutoff <= c.covered_to:
                self.cov[pa] = Coverage(cutoff, c.covered_to, c.refreshed_at, frozenset(d for d in c.holes if d >= cutoff))

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
