"""입출항 색인 작업(ADR-022 개정): 계획(꼬리 → 간격 → 채우기 → 다시 받기) · 쪽 · 완전성 · 범위 · 예산 · 우선순위 · 꺼짐.

외부 호출 없음 — respx 가 가짜 Info5(확인한 동작 그대로: clsgn 은 늘 0건, 날짜 필터는 입항일)를 흉내 낸다. 실제 HttpClient · RateLimiter · Budget ·
ProviderStatus 를 거치고, DB 는 같은 규칙의 메모리 가짜(portcall_index_fakes — 범위 합치기는 실제 merge_day)다.
"""

from __future__ import annotations

import copy
import logging
import math
from datetime import UTC, date, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import respx
from fakes import FakeRedis, make_ctx
from portcall_index_fakes import DirectSource, FakeIndexDb
from portmis_observed import ObservedPortMis, full_record_bytes, real_item, response, synthetic_item

from wakeline_collector.budget import hour_key
from wakeline_collector.db import DayApplied
from wakeline_collector.http import HttpClient
from wakeline_collector.jobs import portcalls_index as ix
from wakeline_collector.jobs.maintenance import PORT_CALL_RETENTION_DAYS, MaintenanceJob
from wakeline_collector.jobs.portcalls_index import PortCallIndexJob, Unit
from wakeline_collector.masking import register_secrets
from wakeline_collector.portcalls import PORT_AUTHORITIES, Coverage, kst_date
from wakeline_collector.providers.data_go_kr import DATA_GO_KR_HOST, MOF_GRID4_HOURLY_HEADROOM, MOF_HOURLY_CAP, service_key_forms
from wakeline_collector.providers.portmis import NUM_OF_ROWS, PortMisProvider
from wakeline_collector.ratelimit import PRIORITY_BACKFILL, PRIORITY_FIXED, PRIORITY_PORTCALL, RateLimiter

URL = "https://apis.data.go.kr/1192000/VsslEtrynd5/Info5"
SERVICE_KEY = "TESTONLYkey0123%2Babc%2Fdef%3D%3D"  # 시험용(실제 키 아님) — 인코딩 키 모양
NOW = datetime(2026, 9, 29, 13, 0, tzinfo=UTC)  # 22:00 KST — 창 2026-08-30 ~ 2026-09-29
TODAY = date(2026, 9, 29)
FLOOR = date(2026, 8, 30)
WINDOW = 30
CODES = [c for c, _ in PORT_AUTHORITIES]


class Clock:
    def __init__(self, at: datetime = NOW):
        self.at = at
        self.mono = 1000.0

    def now(self) -> datetime:
        return self.at

    def tick(self) -> float:
        return self.mono

    def advance(self, **kw: float) -> None:
        d = timedelta(**kw)
        self.at += d
        self.mono += d.total_seconds()


def _job(
    *,
    clock: Clock | None = None,
    r: FakeRedis | None = None,
    db: FakeIndexDb | None = None,
    limit: int = 3000,
    key: str = SERVICE_KEY,
    direct=None,
):
    """direct = 가짜 응답기(ObservedPortMis 등) — 주면 HTTP 없이 바로(빠른 계획 시험), 없으면 실제 HttpClient + respx."""
    clock = clock or Clock()
    r = r or FakeRedis()
    ctx = make_ctx(r, limits={"portmis": limit})
    ctx.db = db or FakeIndexDb()
    http = HttpClient(RateLimiter(100, 100, {DATA_GO_KR_HOST: (100, 2)}))
    source = DirectSource(direct) if direct is not None else PortMisProvider(http, key)
    job = PortCallIndexJob(source, ctx, now=clock.now, mono=clock.tick, wait_s=0.5)
    return job, ctx.db, r, clock


def _q(req: httpx.Request) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(urlsplit(str(req.url)).query).items()}


async def _drain(job: PortCallIndexJob, limit: int = 2000) -> int:
    """계획이 비거나(할 일 없음) 쉬게 될 때까지 단계를 돈다. 돈 단계 수."""
    for n in range(limit):
        if await job.step() > 0:
            return n
    raise AssertionError("did not settle")


def _row_for(db: FakeIndexDb, cs: str):
    rows = db.by_call_sign(cs)
    assert len(rows) == 1, rows
    return rows[0]


@pytest.fixture(autouse=True)
def _httpx_quiet():
    lg = logging.getLogger("httpx")
    old = lg.level
    lg.setLevel(logging.WARNING)
    yield
    lg.setLevel(old)


# ---- 처음 채우기 ------------------------------------------------------------------------------------------------------
async def test_first_run_indexes_the_tail_first_then_backfills_the_30_day_window_without_clsgn(caplog):
    caplog.set_level(logging.INFO)
    register_secrets(*service_key_forms(SERVICE_KEY))
    fake = ObservedPortMis(
        [real_item(), synthetic_item(pa="820", pa_name="울산", clsgn="D7AB2", entry="2026-09-29T21:05:00+09:00", count="041")]
    )
    job, db, r, _clock = _job()
    with respx.mock:
        respx.get(URL).mock(side_effect=fake)
        await _drain(job)
    assert len(fake.requests) == 10 * 31  # 항만청 10곳 × 31일(모두 1쪽 — 기록이 없는 날도 한 번은 묻는다)
    assert all("clsgn" not in q and q["sde"] == q["ede"] and q["deGb"] == "I" and q["numOfRows"] == "50" for q in fake.requests)
    first = [(q["prtAgCd"], q["sde"]) for q in fake.requests[:30]]
    assert first == [
        (c, d) for c in CODES for d in ("20260927", "20260928", "20260929")
    ]  # 꼬리(오래된 날부터)가 모든 채우기보다 먼저
    assert {q["sde"] for q in fake.requests[30:]} == {(FLOOR + timedelta(days=n)).strftime("%Y%m%d") for n in range(28)}
    for c in CODES:
        assert db.cov[c] == Coverage(FLOOR, TODAY, NOW), c  # refreshed_at = 꼬리 갱신이 시작한 때
    row = _row_for(db, "V7A3884")
    assert (row.prt_ag_cd, row.listed_date, row.vssl_nm, row.berth) == (
        "020",
        date(2026, 9, 24),
        "AZAMARA PURSUIT",
        "북항크루즈터미널 2선석",
    )
    assert row.exit_at == datetime(2026, 9, 25, 5, 24, tzinfo=UTC) and row.exit_revision == "최종"
    assert _row_for(db, "D7AB2").listed_date == TODAY
    assert job.counts["requests"] == 310 and job.counts["units_ok"] == 310 and job.counts["units_failed"] == 0
    assert r.kv["budget:portmis:" + datetime.now(UTC).strftime("%Y%m%d")]["used"] == "310"
    assert r.kv[hour_key("mof", NOW)]["used"] == "310"  # 해양수산부 시간 창(격자 WFS 와 함께 센다)
    assert r.kv["wakeline:collector"]["portcalls_index_window_authorities"] == "0/10"  # heartbeat 는 HEARTBEAT_S 에 한 번
    _clock.advance(seconds=ix.HEARTBEAT_S)
    assert await job.step() == ix.IDLE_S  # 할 일 없음 — heartbeat 만
    hb = r.kv["wakeline:collector"]
    assert hb["portcalls_index_state"] == "active" and hb["portcalls_index_window_authorities"] == "10/10"
    assert float(hb["portcalls_index_lag_s"]) == ix.HEARTBEAT_S  # 가장 오래된 항만청의 꼬리 갱신 나이
    st = r.kv["wakeline:provider:portmis"]
    assert st["budget_limit"] == "3000" and "last_success_at" in st
    assert all(run["status"] == "ok" and run["job"] == "portcalls_index" for run in db.runs) and len(db.runs) == 310
    msgs = [rec.getMessage() for rec in caplog.records if rec.name == "job.portcalls_index"]
    assert any("020(부산): tail 2026-09-27..2026-09-29 refreshed" in m for m in msgs)
    assert any("820(울산): 30-day window indexed from 2026-08-30" in m for m in msgs)
    stored = str(r.kv) + caplog.text + str(db.runs)
    for form in service_key_forms(SERVICE_KEY):
        assert form not in stored


async def test_nothing_is_due_right_after_a_complete_index():
    job, db, _r, clock = _job(direct=ObservedPortMis([]))
    await _drain(job)
    assert job.plan(clock.now()) is None
    clock.advance(minutes=59)
    assert job.plan(clock.now()) is None  # 꼬리 갱신은 한 시간마다
    clock.advance(minutes=1)
    assert job.plan(clock.now()) == Unit("020", date(2026, 9, 27), "tail", reset=False, completes_pass=False)


# ---- 갱신 · 판 · 철회 --------------------------------------------------------------------------------------------------
async def test_hourly_tail_refresh_picks_up_exit_times_and_the_final_report():
    entry = synthetic_item(pa="020", clsgn="D7AB2", entry="2026-09-28T10:00:00+09:00", count="007")
    for d in entry.iterfind("details/detail"):
        d.find("reqstSeNm").text = "최초"  # type: ignore[union-attr]
    fake = ObservedPortMis([entry])
    job, db, _r, clock = _job(direct=fake)
    await _drain(job)
    row = _row_for(db, "D7AB2")
    assert (row.entry_revision, row.exit_at) == ("최초", None)  # 아직 입항 중(출항 신고 없음)
    first_updated = db.rows[row.key][2]
    # 한 시간 뒤: 최종 입항 신고와 출항 신고가 붙었다(실제 기록과 같은 모양)
    full = copy.deepcopy(real_item())
    for tag, v in (("clsgn", "D7AB2"), ("etryptCo", "007")):
        full.find(tag).text = v  # type: ignore[union-attr]
    for d in full.iterfind("details/detail"):
        if d.findtext("etryndNm") == "입항":
            d.find("etryptDt").text = "2026-09-28T10:05:00+09:00"  # type: ignore[union-attr]
    fake.items[:] = [full]
    clock.advance(hours=1)
    sent = len(fake.requests)
    await _drain(job)
    assert [(q["prtAgCd"], q["sde"]) for q in fake.requests[sent:]] == [
        (c, d) for c in CODES for d in ("20260927", "20260928", "20260929")
    ]  # 꼬리 3일만 다시
    row = _row_for(db, "D7AB2")
    assert (row.entry_at, row.entry_revision) == (datetime(2026, 9, 28, 1, 5, tzinfo=UTC), "최종")
    assert (row.exit_at, row.exit_revision) == (datetime(2026, 9, 25, 5, 24, tzinfo=UTC), "최종")
    assert db.cov["020"].refreshed_at == NOW + timedelta(hours=1)
    _row, fetched, updated = db.rows[row.key]
    assert updated == fetched and updated > first_updated  # updated_at = 값이 바뀐 것을 본 응답 시각


async def test_older_days_are_revisited_once_a_day_at_a_paced_rate():
    """꼬리보다 오래된 날(출항 · 최종 신고가 늦게 붙는다)은 하루에 한 번 — 시간당 REVISIT_UNITS_PER_HOUR 개까지."""
    fake = ObservedPortMis([])
    job, db, _r, clock = _job(direct=fake)
    await _drain(job)
    clock.advance(hours=24, minutes=1)
    sent = len(fake.requests)
    await _drain(job)
    after = fake.requests[sent:]
    assert len(after) == 30 + ix.REVISIT_UNITS_PER_HOUR  # 꼬리 갱신 + 한 시간 몫의 다시 받기
    revisit = [(q["prtAgCd"], q["sde"]) for q in after[30:]]
    assert all(q[1] <= "20260927" for q in revisit)  # 꼬리(이제 9-28 ~ 9-30)보다 오래된 날만
    assert revisit[0][1] == "20260927"  # 같은 나이면 최근 날 먼저


async def test_restart_revisits_days_whose_last_fetch_is_unknown_at_the_paced_rate():
    fake = ObservedPortMis([])
    job, db, _r, clock = _job(direct=fake)
    db.cov = {c: Coverage(FLOOR, TODAY, NOW) for c in CODES}  # 재기동: 범위는 DB 에, 언제 받았는지는 모른다
    await _drain(job)
    assert len(fake.requests) == ix.REVISIT_UNITS_PER_HOUR and all(q["sde"] <= "20260926" for q in fake.requests)


async def test_a_withdrawn_report_is_removed_when_its_day_is_fetched_complete():
    keep = synthetic_item(pa="020", clsgn="KEEP1", entry="2026-09-29T09:00:00+09:00", count="001")
    gone = synthetic_item(pa="020", clsgn="GONE1", entry="2026-09-29T10:00:00+09:00", count="002")
    fake = ObservedPortMis([keep, gone])
    job, db, _r, clock = _job(direct=fake)
    await _drain(job)
    assert {k[1] for k in db.rows} == {"KEEP1", "GONE1"}
    fake.items[:] = [keep]
    clock.advance(hours=1)
    await _drain(job)
    assert {k[1] for k in db.rows} == {"KEEP1"} and job.counts["rows_deleted"] == 1


async def test_a_day_that_suddenly_comes_back_empty_is_confirmed_before_its_rows_are_deleted(caplog):
    items = [synthetic_item(pa="020", clsgn=f"EMP{n}", entry="2026-09-29T09:00:00+09:00", count=f"00{n}") for n in range(3)]
    fake = ObservedPortMis(items)
    job, db, _r, clock = _job(direct=fake)
    await _drain(job)
    fake.items[:] = []
    clock.advance(hours=1)
    await _drain(job)
    assert len(db.rows) == 3  # 한 번의 빈 응답으로는 지우지 않는다
    assert "source returned 0 records but 3 are indexed" in caplog.text
    assert job._backoff["020"][1] == 1 and db.cov["020"].refreshed_at == NOW  # 020 꼬리 갱신은 끝나지 않았다
    clock.advance(seconds=ix.EMPTY_CONFIRM_S)
    await _drain(job)
    assert db.rows == {} and db.cov["020"].refreshed_at == NOW + timedelta(hours=1, seconds=ix.EMPTY_CONFIRM_S)


# ---- 쪽 · 완전성 -------------------------------------------------------------------------------------------------------
async def test_a_busy_day_follows_totalcount_through_every_page():
    items = [synthetic_item(pa="020", clsgn=f"BZ{n:04d}", entry="2026-09-29T08:00:00+09:00", count=f"{n}") for n in range(120)]
    fake = ObservedPortMis(items)
    job, db, _r, _clock = _job(direct=fake)
    await _drain(job)
    busan_today = [q["pageNo"] for q in fake.requests if q["prtAgCd"] == "020" and q["sde"] == "20260929"]
    assert busan_today == ["1", "2", "3"]  # ⌈120 / 50⌉
    assert len([k for k in db.rows if k[0] == "020"]) == 120


def _paged(pages: dict[tuple[str, str, int], bytes]):
    """(항만청, 날짜, 쪽) → 본문. 없으면 빈 날."""

    def respond(req: httpx.Request) -> httpx.Response:
        q = _q(req)
        body = pages.get((q["prtAgCd"], q["sde"], int(q["pageNo"])), response([], 0, 1, 0))
        return httpx.Response(200, content=body, headers={"content-type": "text/xml"})

    return respond


@pytest.mark.parametrize(
    ("pages", "why"),
    [
        # 실제 응답 그대로: totalCount 494 인데 쪽마다 item 1개(잘라 둔 fixture) — 10쪽을 다 받아도 받은 수가 모자란다
        ({("020", "20260929", n): full_record_bytes() for n in range(1, 11)}, "10 of totalCount 494 item(s) received"),
        # 쪽을 넘기는 사이 totalCount 가 바뀌었다
        (
            {
                ("020", "20260929", 1): response([real_item() for _ in range(50)], 60, 1, 50),
                ("020", "20260929", 2): response([real_item()], 61, 2, 50),
            },
            "totalCount changed while paging (60 → 61)",
        ),
        # 다른 항만청의 기록이 섞였다(원천이 prtAgCd 를 거르지 않은 것 — clsgn 처럼)
        (
            {
                ("020", "20260929", 1): response(
                    [synthetic_item(pa="820", clsgn="X1Y2Z", entry="2026-09-29T01:00:00+09:00", count="1")], 1, 1, 50
                )
            },
            "1 item(s) of another port authority",
        ),
        # 쪽 경계에서 같은 기록이 두 번 — 다른 기록 하나가 빠졌다
        (
            {
                ("020", "20260929", 1): response(
                    [
                        synthetic_item(pa="020", clsgn=f"DP{n:03d}", entry="2026-09-29T01:00:00+09:00", count=f"{n}")
                        for n in range(50)
                    ],
                    51,
                    1,
                    50,
                ),
                ("020", "20260929", 2): response(
                    [synthetic_item(pa="020", clsgn="DP049", entry="2026-09-29T01:00:00+09:00", count="49")], 51, 2, 50
                ),
            },
            "1 duplicate item(s) across pages",
        ),
    ],
)
async def test_an_inconsistent_day_is_a_hole_its_rows_are_not_trusted_and_the_index_moves_on(pages, why, caplog):
    """어긋난 응답의 날은 빈 곳(hole_days) — 행은 두지 않고(그 응답을 믿지 않는다) 아무것도 지우지 않는다. 범위 · 꼬리 갱신은 그 날을 넘어 이어지고
    (한 날이 그 항만청을 멈추지 않는다), api 는 창 안에 빈 곳이 있으면 'none' 을 말하지 않는다. 원천은 답했으므로 물러나지 않는다."""
    job, db, _r, _clock = _job(direct=_paged(pages))
    await _drain(job)
    assert ("020", TODAY) in db.holes_marked and why in caplog.text
    assert [k for k in db.rows if k[0] == "020"] == []
    assert db.cov["020"] == Coverage(FLOOR, TODAY, NOW, frozenset({TODAY}))
    assert all(db.cov[c] == Coverage(FLOOR, TODAY, NOW) for c in CODES[1:])  # 다른 항만청은 계속
    run = db.runs[[r["status"] for r in db.runs].index("incomplete")]
    assert why in run["error_text"] and "recorded as not indexed" in run["error_text"]
    assert "020" not in job._backoff and job.counts["units_incomplete"] == 1


async def test_a_hole_is_cleared_when_the_next_tail_refresh_gets_the_whole_day():
    pages = {
        ("020", "20260929", 1): response([real_item() for _ in range(50)], 60, 1, 50),
        ("020", "20260929", 2): response([real_item()], 61, 2, 50),  # 쪽을 넘기는 사이 신고가 하나 늘었다
    }
    job, db, _r, clock = _job(direct=_paged(pages))
    await _drain(job)
    assert db.cov["020"].holes == frozenset({TODAY})
    pages.clear()
    pages[("020", "20260929", 1)] = response(
        [synthetic_item(pa="020", clsgn="D7OK1", entry="2026-09-29T08:00:00+09:00", count="1")], 1, 1, 50
    )
    clock.advance(hours=1)
    await _drain(job)
    assert db.cov["020"] == Coverage(FLOOR, TODAY, clock.now())  # 빈 곳이 빠졌다
    assert _row_for(db, "D7OK1").listed_date == TODAY


async def test_an_item_without_entry_year_or_count_makes_its_day_a_hole_rather_than_guessing_a_key():
    it = real_item()
    it.remove(it.find("etryptCo"))  # type: ignore[arg-type]
    keyed = synthetic_item(pa="020", clsgn="D7KEY", entry="2026-09-29T10:00:00+09:00", count="003")
    job, db, _r, _clock = _job(direct=_paged({("020", "20260929", 1): response([it, keyed], 2, 1, 50)}))
    await _drain(job)
    assert db.cov["020"].holes == frozenset({TODAY})
    assert _row_for(db, "D7KEY").listed_date == TODAY  # 응답은 서로 맞다 — 키가 있는 기록은 찾을 수 있게 둔다
    assert db.by_call_sign("V7A3884") == []  # 키를 지어내지 않는다
    assert any(r["status"] == "incomplete" and "without etryptYear/etryptCo" in (r.get("error_text") or "") for r in db.runs)


async def test_too_many_pages_for_one_day_is_a_hole_after_the_first_page():
    body = response([], NUM_OF_ROWS * ix.MAX_PAGES_PER_DAY + 1, 1, 0)
    seen: list[tuple[str, str, str]] = []
    paged = _paged({("020", "20260927", 1): body})

    def respond(req: httpx.Request) -> httpx.Response:
        q = _q(req)
        seen.append((q["prtAgCd"], q["sde"], q["pageNo"]))
        return paged(req)

    job, db, _r, _clock = _job(direct=respond)
    await _drain(job)
    assert [x for x in seen if x[:2] == ("020", "20260927")] == [("020", "20260927", "1")]  # 1쪽만 보고 멈춘다
    assert db.cov["020"] == Coverage(FLOOR, TODAY, NOW, frozenset({date(2026, 9, 27)}))


class _RefusingDb(FakeIndexDb):
    """DB 가 거절하는 날(해석기와 V15 가 어긋난 경우를 흉내 낸다): refuse 호출부호의 행이 있으면 rejected · coverage_too 면 행 없이도."""

    def __init__(self, refuse: str, *, coverage_too: bool = False) -> None:
        super().__init__()
        self.refuse, self.coverage_too = refuse, coverage_too

    async def apply_port_call_day(self, pa, day, rows, fetched_at, **kw):  # type: ignore[override]
        if any(r.clsgn == self.refuse for r in rows) or (self.coverage_too and pa == "020" and not rows):
            self.refused.append((pa, day))
            return DayApplied(False, None, rejected="CheckViolationError")
        return await super().apply_port_call_day(pa, day, rows, fetched_at, **kw)


async def test_a_day_the_database_refuses_is_a_hole_and_no_authority_is_held():
    """리뷰 재현의 둘째 반: DB 가 그 날의 행을 거절하면(되돌려졌다) 장애가 아니다 — 모두를 멈추지 않고 그 날을 행 없이 빈 곳으로 적는다."""
    fake = ObservedPortMis([synthetic_item(pa="020", clsgn="D7REF", entry="2026-09-28T10:00:00+09:00", count="001")])
    db = _RefusingDb("D7REF")
    job, _db, r, clock = _job(direct=fake, db=db)
    await _drain(job)
    assert db.refused == [("020", date(2026, 9, 28))] and job._hold_all is None
    assert db.cov["020"] == Coverage(FLOOR, TODAY, NOW, frozenset({date(2026, 9, 28)})) and db.by_call_sign("D7REF") == []
    assert all(db.cov[c] == Coverage(FLOOR, TODAY, NOW) for c in CODES[1:])
    assert not any("database write failed" in (x.get("error_text") or "") for x in db.runs)
    assert any("database refused the day's rows (CheckViolationError)" in (x.get("error_text") or "") for x in db.runs)
    clock.advance(seconds=ix.HEARTBEAT_S)
    await job.step()
    assert r.kv["wakeline:collector"]["portcalls_index_hole_days"] == "1"


async def test_a_refused_coverage_row_backs_off_only_that_authority():
    db = _RefusingDb("D7REF", coverage_too=True)
    fake = ObservedPortMis([synthetic_item(pa="020", clsgn="D7REF", entry="2026-09-27T10:00:00+09:00", count="001")])
    job, _db, _r, clock = _job(direct=fake, db=db)
    await _drain(job)
    assert "020" not in db.cov and job._backoff["020"][1] == 1 and job._hold_all is None
    assert all(db.cov[c] == Coverage(FLOOR, TODAY, NOW) for c in CODES[1:])
    assert any("coverage refused too" in (x.get("error_text") or "") for x in db.runs)


def test_revisits_prefer_overdue_holes_count_failures_and_never_retry_a_day_within_retry_s():
    job, _db, _r, clock = _job()
    hole = date(2026, 9, 20)
    job.coverage = {c: Coverage(FLOOR, TODAY, NOW) for c in CODES}
    job.coverage["020"] = Coverage(FLOOR, TODAY, NOW, frozenset({hole}))
    for c in CODES:
        for n in range(WINDOW + 1):
            job._fetched[(c, FLOOR + timedelta(days=n))] = NOW - timedelta(
                hours=25
            )  # 끝까지 색인한 날은 모두 다시 받을 때가 됐다(25 h)
    job._fetched.pop(("020", hole))
    job._attempted[("020", hole)] = NOW - timedelta(minutes=59)
    u = job.plan(NOW)
    assert (
        u is not None and u.kind == "revisit" and (u.pa, u.day) != ("020", hole)
    )  # 빈 곳은 마지막 시도에서 아직 한 시간이 안 됐다
    job._attempted[("020", hole)] = NOW - timedelta(hours=2)  # 기준(RETRY_S)의 두 배 — 25 h / 24 h 보다 더 늦었다
    assert job.plan(NOW) == Unit("020", hole, "revisit")
    # 실패한 다시 받기: 속도 상한에 세고, 그 항만청의 물러남이 풀려도(다른 날의 성공) RETRY_S 안에는 그 날을 다시 고르지 않는다
    job._fail_pa(Unit("020", hole, "revisit"), NOW, "error", "prtAgCd 020 2026-09-20 page 1: HTTP 500", None)
    assert len(job._revisits) == 1
    job._backoff.pop("020")
    u = job.plan(NOW + timedelta(minutes=1))
    assert u is not None and (u.pa, u.day) != ("020", hole)
    stale = date(2026, 9, 15)
    job._attempted[("030", stale)] = NOW  # 끝까지 색인한 날의 실패도 같다
    job._fetched[("030", stale)] = NOW - timedelta(days=3)  # 가장 늦었지만
    u = job.plan(NOW + timedelta(minutes=1))
    assert u is not None and (u.pa, u.day) not in (("030", stale), ("020", hole))
    at = NOW + timedelta(seconds=ix.RETRY_S)
    job.coverage = {
        c: Coverage(v.covered_from, v.covered_to, at, v.holes) for c, v in job.coverage.items()
    }  # 꼬리 갱신은 방금 끝났다
    assert job.plan(at) == Unit("030", stale, "revisit")  # RETRY_S 가 지나면 — 3일 늦은 날이 한 시간 늦은 빈 곳보다 먼저(비율)


# ---- 범위 계획 --------------------------------------------------------------------------------------------------------
async def test_date_rollover_extends_the_coverage_and_keeps_its_start():
    fake = ObservedPortMis([])
    job, db, _r, clock = _job(direct=fake)
    await _drain(job)
    clock.advance(hours=2, minutes=5)  # 00:05 KST 9-30
    sent = len(fake.requests)
    await _drain(job)
    assert [q["sde"] for q in fake.requests[sent:] if q["prtAgCd"] == "020"] == ["20260928", "20260929", "20260930"]
    assert db.cov["020"] == Coverage(FLOOR, date(2026, 9, 30), clock.now())


async def test_a_gap_after_an_outage_is_filled_forward_before_the_tail():
    fake = ObservedPortMis([])
    job, db, _r, _clock = _job(direct=fake)
    db.cov = {c: Coverage(FLOOR, date(2026, 9, 22), NOW - timedelta(days=7)) for c in CODES}
    await _drain(job)
    assert [q["sde"] for q in fake.requests if q["prtAgCd"] == "020"][:7] == [f"202609{d}" for d in range(23, 30)]
    assert db.cov["020"] == Coverage(FLOOR, TODAY, NOW)


async def test_coverage_entirely_outside_the_window_restarts_at_the_tail():
    fake = ObservedPortMis([])
    job, db, _r, _clock = _job(direct=fake)
    db.cov = {c: Coverage(date(2026, 7, 1), date(2026, 7, 10), NOW - timedelta(days=80)) for c in CODES}
    await _drain(job)
    busan = [q["sde"] for q in fake.requests if q["prtAgCd"] == "020"]
    assert busan[:3] == ["20260927", "20260928", "20260929"] and "20260711" not in busan  # 앞으로 채우지 않고 새로 시작
    assert db.cov["020"] == Coverage(FLOOR, TODAY, NOW)


def test_plan_prefers_every_tail_over_any_backfill_and_the_least_backfilled_authority_first():
    job, db, _r, clock = _job()
    job.coverage = {c: Coverage(date(2026, 9, 20), TODAY, NOW) for c in CODES}
    job.coverage["300"] = Coverage(date(2026, 9, 25), TODAY, NOW)
    assert job.plan(clock.now()) == Unit("300", date(2026, 9, 24), "backfill")
    job.coverage["810"] = Coverage(date(2026, 9, 20), TODAY, NOW - timedelta(hours=2))
    assert job.plan(clock.now()) == Unit("810", date(2026, 9, 27), "tail")


# ---- 예산 · 우선순위 ----------------------------------------------------------------------------------------------------
# 잰 부피(2026-09-29: 10곳 최근 3일 957건 — 선택값의 근거, 잰 값은 부피뿐)
_THREE_DAYS = {"020": 344, "820": 208, "030": 139, "620": 86, "300": 62, "810": 52, "500": 27, "200": 23, "610": 13, "700": 3}


def test_priority_and_budget_arithmetic_are_the_documented_choices():
    """색인 요청은 교통 폴링보다 낮고 격자 채우기보다 높다. 시간 창: 격자 채우기는 합계 290(= 390 − 100) 미만에서만, 색인의 채우기 · 다시 받기는 340
    (= 390 − TAIL_HEADROOM)까지, 꼬리는 390 까지 예약한다. 잰 부피로 하루치 요청 13회(부산 3쪽 · 울산 2쪽 · 나머지 1쪽) → 꼬리 한 바퀴 39회.
    리뷰 2026-10-01(조사 budget PC-2 · 도전): 전에는 '꼬리 39 + 다시 받기 30 ≤ 색인 몫 100' 을 셌는데 묶이는 선은 그것이 아니다 — 격자가 먼저 290 을 채운 시
    (운영 2026-09-30 은 매시)에는 채우기 · 다시 받기가 290–340 띠(50)만 쓰고, 꼬리 한 바퀴가 격자 뒤에 돌면 그 띠에서 먼저 39 를 써 11회만 남는다.
    따라잡는 다시 받기(시간당 15 단위)는 그보다 많다 → 그 시에 'low' budget_exhausted 한 번 · 다음 UTC 정시로 미룸(아래 모의가 흐름을 지킨다)."""
    assert PRIORITY_FIXED < PRIORITY_PORTCALL < PRIORITY_BACKFILL
    assert 0 < ix.TAIL_HEADROOM < MOF_GRID4_HOURLY_HEADROOM < MOF_HOURLY_CAP
    per_day = {pa: n / 3 for pa, n in _THREE_DAYS.items()}
    day_requests = sum(max(1, math.ceil(n / NUM_OF_ROWS)) for n in per_day.values())
    assert day_requests == 3 + 2 + 8 * 1 == 13
    tail_per_hour = ix.TAIL_DAYS * day_requests
    grid_stop = MOF_HOURLY_CAP - MOF_GRID4_HOURLY_HEADROOM  # 격자 채우기가 멈추는 창 합계
    low_stop = MOF_HOURLY_CAP - ix.TAIL_HEADROOM  # 색인의 채우기 · 다시 받기가 멈추는 창 합계
    assert (grid_stop, low_stop) == (290, 340)
    # 꼬리는 340–390 이 늘 남는다 — 격자 · 다시 받기가 먼저 써도 한 바퀴가 끝난다
    assert tail_per_hour == 39 <= MOF_HOURLY_CAP - low_stop
    # 격자가 먼저 차고 꼬리 한 바퀴가 그 뒤에 돈 시에 채우기 · 다시 받기가 쓸 수 있는 요청(실제 상한 — 꼬리가 앞서 돌았으면 50)
    after_grid_and_tail = low_stop - grid_stop - tail_per_hour
    assert after_grid_and_tail == 11 < ix.REVISIT_UNITS_PER_HOUR
    # 다시 받기: 날마다 10곳 × (창 31일 − 꼬리 3일) = 280 단위(시간당 약 11.7) — 상한 15 단위/시는 재기동 뒤 따라잡기(프로세스 기억만)
    assert 10 * (ix.WINDOW_DAYS + 1 - ix.TAIL_DAYS) == 280 and ix.REVISIT_S == 86400
    # 하루 예산: 다시 받는 하루는 대개 한 쪽 — 넉넉히 단위마다 두 쪽으로 센다. 처음 한 번의 채우기 31일 × 13
    revisit_per_hour = ix.REVISIT_UNITS_PER_HOUR * 2
    backfill_once = (ix.WINDOW_DAYS + 1) * day_requests
    assert 24 * (tail_per_hour + revisit_per_hour) + backfill_once == 2059 <= 3000  # budget_portmis
    # 채우기의 최악(격자가 매시 먼저 차고 꼬리가 늘 그 뒤): 시간당 11회 → 403회에 약 37시간(전에 적은 '시간당 약 40회 · 약 11시간'은 이 띠를 보지 않았다)
    assert math.ceil(backfill_once / after_grid_and_tail) == 37


class _MeasuredMix:
    """잰 부피의 하루 건수(부산 약 115 · 울산 약 69 …)로 답하는 Info5 — 하루치 요청이 13회(쪽 수를 섞은 실제 모양). log = (시각, 항만청, 날)."""

    def __init__(self, clock: Clock):
        self.clock = clock
        self.log: list[tuple[datetime, str, str]] = []
        self._days: dict[tuple[str, str], list] = {}

    def __call__(self, req: httpx.Request) -> httpx.Response:
        q = _q(req)
        pa, ymd = q["prtAgCd"], q["sde"]
        self.log.append((self.clock.at, pa, ymd))
        if (pa, ymd) not in self._days:
            d = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}"
            n = round(_THREE_DAYS[pa] / 3)
            self._days[(pa, ymd)] = [
                synthetic_item(pa=pa, clsgn=f"M{pa}{k:03d}"[:7], entry=f"{d}T09:00:00+09:00", count=f"{ymd}{k:03d}")
                for k in range(n)
            ]
        hits = self._days[(pa, ymd)]
        page = int(q["pageNo"])
        chunk = hits[(page - 1) * NUM_OF_ROWS : page * NUM_OF_ROWS]
        return httpx.Response(
            200, content=response([copy.deepcopy(i) for i in chunk], len(hits), page, NUM_OF_ROWS if chunk else 0)
        )


async def test_after_the_grid_fills_the_hour_revisits_get_what_the_tail_leaves_below_340():
    """리뷰 2026-10-01(조사 budget PC-2 · 도전 — 동작은 바꾸지 않는다, 흐름을 지킨다): 08:30Z 에 다시 띄운 수집기 — 격자 채우기가 이 시의 몫(290)을 이미 다 썼고,
    꼬리 갱신이 막 돌아올 때다. 격자 모형: 매 정시부터 30 s 마다 15 칸씩 290 까지(운영 INFO 'grid share used' 의 모양 — 속도는 모형 값).
    - 08시: 꼬리 한 바퀴 39회(290 → 329)가 끝나고, 다시 받기는 340 까지 11회만 — 'low' budget_exhausted 한 번('… (50 kept for the tail refresh) — resumes at 09:00Z').
    - 미룬 다시 받기는 다음 정시 직후(09:00:00 — 격자가 차기 전, 290 몫 안)에 나간다. 한 시간 뒤 같은 모양(재기동의 따라잡기 뒤 첫 꼬리)이 한 번 더 멈출 수 있다.
    - 그 뒤 시각이 그대로면 다시 멈추지 않는다: 다시 받기가 정시 직후로 옮겨 간다. 창은 어느 시에도 340 을 넘지 않고(꼬리 몫 50 은 남는다) 꼬리는 매시 39회."""
    start = datetime(2026, 9, 30, 8, 30, tzinfo=UTC)  # 17:30 KST
    clock = Clock(start)
    today = kst_date(start)
    fake = _MeasuredMix(clock)
    job, db, r, _clock = _job(clock=clock, direct=fake, limit=30_000)
    db.cov = {
        c: Coverage(today - timedelta(days=WINDOW), today, start - timedelta(hours=1)) for c in CODES
    }  # 꼬리가 지금 돌아온다
    r.kv[hour_key("mof", start)] = {"used": str(MOF_HOURLY_CAP - MOF_GRID4_HOURLY_HEADROOM), "limit": "390"}
    peak: dict[str, int] = {}
    while clock.at < start + timedelta(hours=5, minutes=30):
        k = hour_key("mof", clock.at)
        h = r.kv.setdefault(k, {"used": "0", "limit": "390"})
        h["used"] = str(max(int(h["used"]), min(290, int(h["used"]) + 15)))  # 격자 모형
        await _drain(job)
        peak[f"{clock.at:%H}"] = int(r.kv[k]["used"])
        clock.advance(seconds=30)
    tail_from = (today - timedelta(days=ix.TAIL_DAYS - 1)).strftime("%Y%m%d")

    def per_hour(revisit: bool) -> dict[str, int]:
        out: dict[str, int] = {}
        for at, _pa, ymd in fake.log:
            if (ymd < tail_from) is revisit:
                out[f"{at:%H}"] = out.get(f"{at:%H}", 0) + 1
        return out

    refusals: dict[str, list[str]] = {}
    for run in db.runs:
        if run["status"] == "budget_exhausted":
            hour = run["error_text"].split("UTC hour ")[1][8:10]
            refusals.setdefault(hour, []).append(run["error_text"])
    assert refusals["08"] == [
        "MOF hourly window: 340 of 390 used in UTC hour 2026093008 (50 kept for the tail refresh) — resumes at 2026-09-30T09:00:00Z"
    ]
    assert all(len(v) == 1 for v in refusals.values())  # 한 UTC 시에 많아야 한 번(_hold_low)
    assert set(refusals) <= {"08", "09"}  # 재기동 시와 그다음 시 — 그 뒤로는 멈추지 않는다
    assert per_hour(revisit=True)["08"] == 340 - 290 - 39 == 11  # 실제 상한
    assert {h: n for h, n in per_hour(revisit=False).items() if h != "14"} == {
        h: 39 for h in ("08", "09", "10", "11", "12", "13")
    }
    first_revisit = {}
    for at, _pa, ymd in fake.log:
        if ymd < tail_from:
            first_revisit.setdefault(f"{at:%H}", at)
    assert first_revisit["09"] == datetime(2026, 9, 30, 9, 0, tzinfo=UTC)  # 미룬 단위는 다음 정시 직후
    assert all(first_revisit[h].minute == 0 for h in ("10", "11", "12", "13"))  # 다시 받기가 정시 직후로 옮겨 갔다
    assert max(peak.values()) <= 340  # 채우기 · 다시 받기는 340 에서 멈춘다 — 꼬리 몫 50 은 늘 남는다


async def test_the_backfill_leaves_the_tail_its_share_of_the_mof_hour_window(caplog):
    caplog.set_level(logging.INFO)
    fake = ObservedPortMis([])
    job, db, r, clock = _job(direct=fake)
    # 격자 채우기 등이 이 시의 창을 채우기 · 다시 받기가 멈출 선(390 − 50)의 30 앞까지 썼다
    r.kv[hour_key("mof", NOW)] = {"used": str(MOF_HOURLY_CAP - ix.TAIL_HEADROOM - 30), "limit": "390"}
    await _drain(job)
    assert len(fake.requests) == 30  # 꼬리 30회만 — 채우기는 남긴 몫에 닿아 멈췄다
    assert all(c.covered_from == date(2026, 9, 27) for c in db.cov.values())
    assert "backfill/revisit paused until 2026-09-29T14:00:00Z" in caplog.text
    assert any(run["status"] == "budget_exhausted" and "kept for the tail refresh" in run["error_text"] for run in db.runs)
    clock.advance(hours=1)  # 다음 UTC 시 — 새 창
    await _drain(job)
    assert all(c == Coverage(FLOOR, TODAY, NOW + timedelta(hours=1)) for c in db.cov.values())


async def test_a_full_hour_window_pauses_everything_until_the_next_utc_hour():
    job, db, r, clock = _job()
    r.kv[hour_key("mof", NOW)] = {"used": str(MOF_HOURLY_CAP), "limit": "390"}
    with respx.mock(assert_all_called=False) as m:
        route = m.get(URL).mock(side_effect=ObservedPortMis([]))
        delay = await job.step()
        assert route.call_count == 0 and 1 <= delay <= ix.IDLE_S
        assert job._hold_all == datetime(2026, 9, 29, 14, 0, tzinfo=UTC)
        assert await job.step() > 0 and route.call_count == 0
    assert db.runs[-1]["status"] == "budget_exhausted" and "resumes at 2026-09-29T14:00:00Z" in db.runs[-1]["error_text"]
    assert r.kv[hour_key("mof", NOW)]["used"] == str(MOF_HOURLY_CAP)  # 거절한 예약은 세지 않았다


async def test_an_exhausted_daily_budget_pauses_until_the_next_utc_day():
    job, db, r, _clock = _job(limit=5)
    with respx.mock:
        route = respx.get(URL).mock(side_effect=ObservedPortMis([]))
        await _drain(job)
    assert route.call_count == 5 and job._hold_all == datetime(2026, 9, 30, 0, 0, tzinfo=UTC)
    assert db.runs[-1]["status"] == "budget_exhausted" and "daily budget exhausted (used=5)" in db.runs[-1]["error_text"]
    assert r.kv[hour_key("mof", NOW)]["used"] == "5"  # 하루 예산에 막힌 요청의 시간 창 예약은 되돌렸다


async def test_the_budget_store_being_down_fails_closed():
    job, db, r, _clock = _job()
    r.down = True
    with respx.mock(assert_all_called=False) as m:
        route = m.get(URL).mock(side_effect=ObservedPortMis([]))
        assert await job.step() > 0
    assert route.call_count == 0 and db.runs[-1]["status"] == "budget_unavailable"


# ---- 실패 · 꺼짐 -------------------------------------------------------------------------------------------------------
async def test_an_http_error_backs_off_only_that_authority_and_the_reason_is_masked(caplog):
    register_secrets(*service_key_forms(SERVICE_KEY))
    ok = ObservedPortMis([])

    def respond(req: httpx.Request) -> httpx.Response:
        if _q(req)["prtAgCd"] == "020":
            return httpx.Response(500, text="<html>err serviceKey=TESTONLYkey0123+abc/def==</html>")
        return ok(req)

    job, db, r, clock = _job()
    with respx.mock:
        respx.get(URL).mock(side_effect=respond)
        await _drain(job)
    assert "020" not in db.cov and all(db.cov[c] == Coverage(FLOOR, TODAY, NOW) for c in CODES[1:])
    assert job._backoff["020"] == (clock.now() + timedelta(seconds=60), 1)
    st = r.kv["wakeline:provider:portmis"]
    assert "HTTP 500" in st["last_error"] and "prtAgCd 020 2026-09-27" in st["last_error"]
    for form in service_key_forms(SERVICE_KEY):
        assert form not in st["last_error"] and form not in caplog.text and form not in str(db.runs)


async def test_backoff_grows_and_resets_after_a_good_day():
    calls = {"n": 0}
    ok = ObservedPortMis([])

    def respond(req: httpx.Request) -> httpx.Response:
        if _q(req)["prtAgCd"] == "020" and calls["n"] < 2:
            calls["n"] += 1
            return httpx.Response(503)
        return ok(req)

    job, db, _r, clock = _job(direct=respond)
    await _drain(job)
    assert job._backoff["020"][1] == 1
    clock.advance(seconds=60)
    await _drain(job)
    assert job._backoff["020"] == (clock.now() + timedelta(seconds=120), 2)
    clock.advance(seconds=120)
    await _drain(job)
    assert "020" not in job._backoff and db.cov["020"].covered_to == TODAY


async def test_a_provider_error_code_is_a_failure_not_an_empty_day():
    body = b"<response><header><resultCode>22</resultCode><resultMsg>LIMITED NUMBER OF SERVICE REQUESTS EXCEEDS ERROR.</resultMsg></header></response>"
    job, db, r, _clock = _job()
    with respx.mock:
        respx.get(URL).mock(return_value=httpx.Response(200, content=body))
        await job.step()
    assert db.applied == [] and "resultCode 22" in r.kv["wakeline:provider:portmis"]["last_error"]


async def test_rate_limited_waits_are_not_charged_and_pause_everything():
    job, db, r, _clock = _job()
    job.provider = PortMisProvider(HttpClient(RateLimiter(100, 100, {DATA_GO_KR_HOST: (0.001, 1)})), SERVICE_KEY)
    job._wait_s = 0.01
    with respx.mock(assert_all_called=False) as m:
        route = m.get(URL).mock(side_effect=ObservedPortMis([]))
        await job.step()  # burst 1 — 첫 요청은 나간다
        await job.step()  # 둘째는 속도 상한 대기 초과
    assert route.call_count == 1 and job._hold_all is not None
    assert (
        r.kv[hour_key("mof", NOW)]["used"] == "1"
        and r.kv["budget:portmis:" + datetime.now(UTC).strftime("%Y%m%d")]["used"] == "1"
    )
    assert db.runs[-1]["status"] == "error" and "rate limited" in db.runs[-1]["error_text"]


async def test_operator_switch_stops_fetching_and_the_heartbeat_says_so():
    job, db, r, _clock = _job()
    r.kv["wakeline:provider:portmis"] = {"disabled": "1"}
    with respx.mock(assert_all_called=False) as m:
        route = m.get(URL).mock(side_effect=ObservedPortMis([]))
        assert await job.step() == ix.IDLE_S
    assert route.call_count == 0 and r.kv["wakeline:collector"]["portcalls_index_state"] == "operator_off"


@pytest.mark.parametrize("state", ["no_key", "fixture"])
async def test_without_a_provider_nothing_is_fetched_and_the_state_is_reported(state):
    r = FakeRedis()
    ctx = make_ctx(r, limits={"portmis": 3000})
    ctx.db = FakeIndexDb()
    job = PortCallIndexJob(None, ctx, off_state=state)
    assert await job.step() == ix.IDLE_S
    hb = r.kv["wakeline:collector"]
    assert hb["portcalls_index_state"] == state and hb["portcalls_index_at"] and hb["portcalls_index_lag_s"] == ""
    assert ctx.db.reads == 0


async def test_without_the_database_nothing_is_fetched():
    db = FakeIndexDb()
    db.down = True
    job, _db, r, _clock = _job(db=db)
    with respx.mock(assert_all_called=False) as m:
        route = m.get(URL).mock(side_effect=ObservedPortMis([]))
        assert await job.step() == ix.DB_RETRY_S
    assert route.call_count == 0 and r.kv["wakeline:collector"]["portcalls_index_state"] == "db_unavailable"


async def test_a_failed_write_holds_the_index_and_refetches_the_day():
    db = FakeIndexDb()
    fake = ObservedPortMis([])
    job, _db, _r, clock = _job(db=db, direct=fake)
    await job.step()  # 범위 읽기 + 첫 하루
    db.down = True
    assert await job.step() == ix.DB_RETRY_S  # 받았지만 적지 못했다
    assert db.runs[-1]["status"] == "error" and "database write failed" in db.runs[-1]["error_text"]
    db.down = False
    clock.advance(seconds=ix.DB_RETRY_S)
    await _drain(job)
    assert [q["sde"] for q in fake.requests if q["prtAgCd"] == "020"][:3] == [
        "20260927",
        "20260928",
        "20260927",
    ]  # 꼬리를 처음부터
    assert db.cov["020"] == Coverage(FLOOR, TODAY, NOW + timedelta(seconds=ix.DB_RETRY_S))


async def test_run_loop_stops_promptly_and_survives_an_unexpected_error(monkeypatch):
    import asyncio

    job, _db, _r, _clock = _job()
    calls = {"n": 0}

    async def boom() -> float:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("unexpected")
        stop.set()
        return 0.0

    monkeypatch.setattr(job, "step", boom)
    monkeypatch.setattr(ix, "IDLE_S", 0.01)
    stop = asyncio.Event()
    await asyncio.wait_for(job.run(stop), 2)
    assert calls["n"] == 2


def test_metrics_are_counts_only():
    job, _db, _r, _clock = _job()
    assert set(job.metrics()) == {
        "portcall_requests",
        "portcall_index_units_ok",
        "portcall_index_units_incomplete",
        "portcall_index_units_failed",
        "portcall_index_rows_upserted",
        "portcall_index_rows_deleted",
    }


# ---- 보존 -------------------------------------------------------------------------------------------------------------
async def test_maintenance_purges_rows_older_than_60_kst_days_and_lifts_the_coverage_start():
    r = FakeRedis()
    ctx = make_ctx(r)
    db = FakeIndexDb()
    ctx.db = db
    today = kst_date(datetime.now(UTC))
    cutoff = today - timedelta(days=PORT_CALL_RETENTION_DAYS)
    db.cov["020"] = Coverage(today - timedelta(days=90), today, NOW)
    db.cov["030"] = Coverage(today - timedelta(days=100), today - timedelta(days=70), NOW)
    await MaintenanceJob([], ctx).run_once()
    assert "port_call_retention" in db.names
    assert db.cov["020"].covered_from == cutoff  # 지운 날을 덮는다고 말하지 않는다
    assert db.cov["030"].covered_from == today - timedelta(days=100)  # 범위 전체가 오래됐으면 그대로(작업이 새로 시작한다)
