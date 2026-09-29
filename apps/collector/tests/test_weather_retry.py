"""기상 작업(AWC METAR/TAF · SIGMET, RainViewer)의 일시 오류 한 번 다시 부르기 — KMA(jobs/kma_radar.py)와 같은 규칙(retry.py).

운영 관찰(2026-09-29): AWC SIGMET 호출 하나가 "ReadTimeout — read 제한 8 s 초과 (aviationweather.gov)" 로 실패해 그 주기(300 s)를
잃었고, 다음 주기는 성공했다. KMA 는 같은 일시 오류를 5 s 뒤 한 번 다시 불러 주기를 살린 것이 배포 뒤 관찰됐다.
규칙: 시간 초과 · 연결 실패 · 프로토콜 오류만, 실패한 호출마다 한 번, 5 s 뒤, 예산 1 을 따로 예약하고 속도 상한을 지난다.
HTTP 오류(ProviderHttpError)·속도 상한(Throttled)은 다시 부르지 않는다. 외부 호출 없음(가짜 공급자 · respx).
"""

from __future__ import annotations

import logging
import re

import httpx
import pytest
from fakes import FakeRedis, make_ctx
from test_sigmet_job import FakeAwc
from test_weather_jobs import FIX, FakeAwcMetar, FakeRainViewer

from wakeline_collector.config import settings
from wakeline_collector.http import ProviderHttpError
from wakeline_collector.models import ProviderResult
from wakeline_collector.publisher import STREAM_RADAR, STREAM_SIGMET
from wakeline_collector.ratelimit import Throttled

_TIMEOUT = {"connect": 4.0, "read": 8.0, "write": 8.0, "pool": 8.0}  # 기본 HttpClient 제한(settings.http_timeout_s 8 s)


def _read_timeout(url: str) -> httpx.ReadTimeout:
    e = httpx.ReadTimeout("")
    e.request = httpx.Request("GET", url, extensions={"timeout": dict(_TIMEOUT)})
    return e


AWC_ISIGMET = "https://aviationweather.gov/api/data/isigmet"
AWC_AIRSIGMET = "https://aviationweather.gov/api/data/airsigmet"
AWC_METAR = "https://aviationweather.gov/api/data/metar"
RV_URL = "https://api.rainviewer.com/public/weather-maps.json"
# 설정의 일일 예산(기본 2,000). 다시 부르기는 남은 하루의 정규 주기 몫(60 s 주기 → 최대 1,441)을 남기고만 예약하므로, 정규 주기만으로
# 넘치는 한도(예: 1,000)에서는 다시 부르지 않는다 — 시험도 실제 한도를 쓴다.
RV_BUDGET = settings.budget_rainviewer


@pytest.fixture
def no_wait(monkeypatch):
    from wakeline_collector.jobs import weather as mod

    waits: list[float] = []

    async def fake_sleep(s: float) -> None:
        waits.append(s)

    monkeypatch.setattr(mod, "_sleep", fake_sleep)
    return waits


def _runs(ctx) -> list[dict]:
    runs: list[dict] = []
    real = ctx.db.record_run

    def rec(job, provider, started_at, **kw):
        runs.append(kw)
        real(job, provider, started_at, **kw)

    ctx.db.record_run = rec
    return runs


def _warnings(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "job.weather" and r.levelno >= logging.WARNING]


class FlakyRadar(FakeRainViewer):
    def __init__(self, errors: list[Exception]) -> None:
        super().__init__()
        self.errors = list(errors)
        self.calls = 0

    async def frames(self) -> ProviderResult:
        self.calls += 1
        if self.errors:
            raise self.errors.pop(0)
        return await super().frames()


class FlakyAwc(FakeAwc):
    """SIGMET: 국제·미국 호출이 정해 둔 오류를 먼저 낸다."""

    def __init__(self, fixtures_dir, *, intl: list[Exception] = (), us: list[Exception] = ()) -> None:  # type: ignore[assignment]
        super().__init__(fixtures_dir)
        self.intl_errors, self.us_errors = list(intl), list(us)
        self.intl_calls = self.us_calls = 0

    async def isigmet(self):
        self.intl_calls += 1
        if self.intl_errors:
            raise self.intl_errors.pop(0)
        return await super().isigmet()

    async def airsigmet(self):
        self.us_calls += 1
        if self.us_errors:
            raise self.us_errors.pop(0)
        return await super().airsigmet()


class FlakyMetar(FakeAwcMetar):
    def __init__(self, errors: list[Exception]) -> None:
        super().__init__()
        self.errors = list(errors)

    async def metar_bbox(self, lamin, lomin, lamax, lomax) -> ProviderResult:
        if self.errors:
            self.bboxes.append((lamin, lomin, lamax, lomax))
            raise self.errors.pop(0)
        return await super().metar_bbox(lamin, lomin, lamax, lomax)


# ---- 다시 불러 살린다 --------------------------------------------------------------------------------------------------
async def test_radar_read_timeout_is_retried_once_and_the_cycle_is_ok(no_wait, caplog):
    from wakeline_collector.jobs.weather import RadarJob

    caplog.set_level(logging.INFO, logger="job.weather")
    r = FakeRedis()
    ctx = make_ctx(r, limits={"rainviewer": RV_BUDGET})
    runs = _runs(ctx)
    rv = FlakyRadar([_read_timeout(RV_URL)])
    await RadarJob(rv, ctx).run_once()
    assert rv.calls == 2 and no_wait == [5.0]
    assert len(r.streams[STREAM_RADAR]) == 1 and [run["status"] for run in runs] == ["ok"]
    assert _warnings(caplog) == []  # 살린 주기는 경고가 아니다
    assert any(
        re.fullmatch(
            r"radar/rainviewer: frames — ReadTimeout — read 제한 8 s 초과 \(api\.rainviewer\.com\) after \d+\.\d s"
            r" — retrying once in 5 s",
            m,
        )
        for m in caplog.messages
    ), caplog.messages
    assert (await ctx.budget.usage("rainviewer"))[0] == 2  # 다시 부른 호출도 예산을 쓴다
    assert (await r.hgetall("wakeline:provider:rainviewer"))["consecutive_failures"] == "0"


async def test_sigmet_isigmet_timeout_retried_once_publishes_the_set(fixtures_dir, no_wait, caplog):
    from wakeline_collector.jobs.weather import SigmetJob

    r = FakeRedis()
    ctx = make_ctx(r)
    runs = _runs(ctx)
    awc = FlakyAwc(fixtures_dir, intl=[_read_timeout(AWC_ISIGMET)])
    await SigmetJob(awc, ctx).run_once()
    assert awc.intl_calls == 2 and awc.us_calls == 1 and no_wait == [5.0]
    assert len(r.streams[STREAM_SIGMET]) == 1 and [run["status"] for run in runs] == ["ok"]
    assert _warnings(caplog) == []
    assert (await ctx.budget.usage("awc"))[0] == 2 + 1  # 세트 2 + 다시 부른 국제 1


async def test_sigmet_airsigmet_connect_error_retried_once_keeps_the_full_set(fixtures_dir, no_wait, caplog):
    from wakeline_collector.jobs.weather import SigmetJob

    r = FakeRedis()
    ctx = make_ctx(r)
    err = httpx.ConnectError("")
    err.request = httpx.Request("GET", AWC_AIRSIGMET)
    awc = FlakyAwc(fixtures_dir, us=[err])
    await SigmetJob(awc, ctx).run_once()
    assert awc.us_calls == 2 and no_wait == [5.0]
    st = await r.hgetall("wakeline:provider:awc")
    assert st["sigmet_partial"] == "" and "last_error" not in st  # 부분 실패로 남지 않는다
    assert _warnings(caplog) == []


async def test_metar_remote_protocol_error_retried_once(no_wait, caplog):
    from wakeline_collector.jobs.weather import MetarJob

    r = FakeRedis()
    ctx = make_ctx(r, limits={"awc": 1000})
    runs = _runs(ctx)
    awc = FlakyMetar([httpx.RemoteProtocolError("")])
    await MetarJob(awc, ctx).run_once()
    assert len(awc.bboxes) == 2 and no_wait == [5.0]
    assert [run["status"] for run in runs] == ["ok"] and _warnings(caplog) == []
    assert (await r.hgetall("wakeline:collector"))["metar_at"]


# ---- 다시 불러도 실패 → 경고 한 번(단계 · 걸린 시간 · 첫 시도) ----------------------------------------------------------------
async def test_sigmet_retry_that_fails_again_gives_one_warning_with_step_and_elapsed(fixtures_dir, no_wait, caplog):
    """관찰한 실패 그대로: 국제 SIGMET ReadTimeout(read 제한 8 s) — 다시 불러도 시간 초과면 주기를 끝내고 경고는 한 번."""
    from wakeline_collector.jobs.weather import SigmetJob

    caplog.set_level(logging.INFO, logger="job.weather")
    r = FakeRedis()
    ctx = make_ctx(r)
    runs = _runs(ctx)
    awc = FlakyAwc(fixtures_dir, intl=[_read_timeout(AWC_ISIGMET), _read_timeout(AWC_ISIGMET)])
    await SigmetJob(awc, ctx).run_once()
    assert awc.intl_calls == 2 and awc.us_calls == 0 and no_wait == [5.0]
    assert STREAM_SIGMET not in r.streams  # 국제 호출 실패 → 발행하지 않는다(그대로)
    warns = _warnings(caplog)
    assert len(warns) == 1, warns
    assert re.fullmatch(
        r"sigmet/awc failed: isigmet — ReadTimeout — read 제한 8 s 초과 \(aviationweather\.gov\) after \d+\.\d s"
        r"; retried once after 5 s \(first attempt: ReadTimeout after \d+\.\d s\)",
        warns[0],
    ), warns[0]
    st = await r.hgetall("wakeline:provider:awc")
    assert re.fullmatch(
        r"ReadTimeout — read 제한 8 s 초과 \(aviationweather\.gov\) · isigmet · \d+\.\d s 경과"
        r" · 5 s 뒤 1회 재시도\(첫 시도 ReadTimeout · \d+\.\d s\)",
        st["last_error"],
    ), st["last_error"]
    assert [run["status"] for run in runs] == ["error"] and runs[0]["error_text"] == st["last_error"]


async def test_airsigmet_retry_that_fails_again_carries_the_last_us_set_with_one_warning(fixtures_dir, no_wait, caplog):
    from wakeline_collector.jobs.weather import SigmetJob

    r = FakeRedis()
    ctx = make_ctx(r)
    awc = FlakyAwc(fixtures_dir)
    job = SigmetJob(awc, ctx)
    await job.run_once()
    awc.us_errors = [_read_timeout(AWC_AIRSIGMET), _read_timeout(AWC_AIRSIGMET)]
    await job.run_once()
    assert awc.us_calls == 3 and no_wait == [5.0]
    warns = _warnings(caplog)
    assert len(warns) == 1 and warns[0].startswith("airsigmet failed: airsigmet — ReadTimeout — read 제한 8 s 초과"), warns
    assert "retried once after 5 s" in warns[0]
    st = await r.hgetall("wakeline:provider:awc")
    assert st["sigmet_partial"] == "airsigmet" and st["last_error"].startswith("airsigmet failed: ReadTimeout — read 제한 8 s")


async def test_radar_retry_that_fails_again_records_one_error(no_wait, caplog):
    from wakeline_collector.jobs.weather import RadarJob

    r = FakeRedis()
    ctx = make_ctx(r, limits={"rainviewer": RV_BUDGET})
    runs = _runs(ctx)
    rv = FlakyRadar([httpx.ConnectTimeout(""), httpx.ConnectTimeout("")])
    await RadarJob(rv, ctx).run_once()
    assert rv.calls == 2 and STREAM_RADAR not in r.streams
    assert [run["status"] for run in runs] == ["error"] and len(_warnings(caplog)) == 1
    assert (await r.hgetall("wakeline:provider:rainviewer"))["consecutive_failures"] == "1"  # 한 주기 = 실패 하나


# ---- 다시 부르지 않는 것 --------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "error",
    [
        ProviderHttpError(404, "not found"),
        ProviderHttpError(429, "<html><head><title>429 Too Many Requests</title></head></html>"),
        ProviderHttpError(503, "maintenance"),
        Throttled("api.rainviewer.com", "no slot within 10.0 s"),
        ValueError("unexpected rainviewer response shape"),
    ],
    ids=["404", "429", "503", "throttled", "shape"],
)
async def test_http_errors_throttling_and_bad_shapes_are_never_retried(no_wait, caplog, error):
    from wakeline_collector.jobs.weather import RadarJob

    r = FakeRedis()
    ctx = make_ctx(r, limits={"rainviewer": RV_BUDGET})
    rv = FlakyRadar([error])
    await RadarJob(rv, ctx).run_once()
    assert rv.calls == 1 and no_wait == []
    # 보낸 호출은 예산 1 — 속도 상한이 막은 호출(Throttled)은 보내지 않았으므로 돌려준다
    assert (await ctx.budget.usage("rainviewer"))[0] == (0 if isinstance(error, Throttled) else 1)
    warns = _warnings(caplog)
    assert len(warns) == 1 and warns[0].startswith("radar/rainviewer failed: frames — "), warns
    assert "retried" not in warns[0]


async def test_metar_4xx_is_never_retried(no_wait):
    from wakeline_collector.jobs.weather import MetarJob

    r = FakeRedis()
    ctx = make_ctx(r, limits={"awc": 1000})
    awc = FlakyMetar([ProviderHttpError(400, "bad bbox")])
    await MetarJob(awc, ctx).run_once()
    assert len(awc.bboxes) == 1 and no_wait == []
    st = await r.hgetall("wakeline:provider:awc")
    assert st["last_http_status"] == "400" and st["last_error"].startswith("HTTP 400 Bad Request — bad bbox · metar ")


async def test_retry_needs_budget(no_wait):
    from wakeline_collector.jobs.weather import MetarJob

    r = FakeRedis()
    ctx = make_ctx(r, limits={"awc": 1})  # 첫 호출분만 — 다시 부를 예산이 없다
    awc = FlakyMetar([_read_timeout(AWC_METAR)])
    await MetarJob(awc, ctx).run_once()
    assert len(awc.bboxes) == 1 and no_wait == []
    assert (await r.hgetall("wakeline:provider:awc"))["last_error"].startswith("ReadTimeout — read 제한 8 s 초과")


# ---- 다시 부른 호출도 속도 상한(RateLimiter)을 지난다 -----------------------------------------------------------------------
def _real_awc(limiter):
    from wakeline_collector.http import HttpClient
    from wakeline_collector.providers.awc import AwcProvider

    http = HttpClient(limiter)
    return http, AwcProvider(http)


async def test_retry_passes_through_the_rate_limiter(no_wait):
    import respx

    from wakeline_collector.jobs.weather import RadarJob
    from wakeline_collector.providers.rainviewer import RainViewerProvider
    from wakeline_collector.ratelimit import RateLimiter

    limiter = RateLimiter(100, 100)
    http, _awc = _real_awc(limiter)
    body = (FIX / "rainviewer_weather_maps.json").read_bytes()
    seen: list[str] = []

    def respond(request: httpx.Request):
        seen.append(str(request.url))
        if len(seen) == 1:
            raise httpx.ReadTimeout("", request=request)
        return httpx.Response(200, content=body)

    r = FakeRedis()
    ctx = make_ctx(r, limits={"rainviewer": RV_BUDGET})
    with respx.mock:
        respx.get(RV_URL).mock(side_effect=respond)
        await RadarJob(RainViewerProvider(http), ctx).run_once()
    await http.aclose()
    assert len(seen) == 2 and no_wait == [5.0]
    assert limiter.granted == 2  # 두 호출 모두 허가를 받았다(우회하지 않는다)
    assert len(r.streams[STREAM_RADAR]) == 1


async def test_retry_blocked_by_the_rate_limiter_is_not_sent_and_not_retried_again(no_wait, caplog):
    """첫 시도가 시간 초과로 끝난 사이 그 호스트가 429 쿨다운에 들어갔다(다른 호출자의 429): 다시 부르기는 허가를 못 받아
    Throttled 로 끝난다 — 보내지 않고, 또 다시 부르지 않는다. 경고는 한 번."""
    import respx

    from wakeline_collector.jobs.weather import SigmetJob
    from wakeline_collector.ratelimit import RateLimiter

    limiter = RateLimiter(100, 100)
    http, awc = _real_awc(limiter)
    sent: list[str] = []

    def respond(request: httpx.Request):
        sent.append(str(request.url))
        limiter.penalize("aviationweather.gov", 600)  # 같은 호스트의 429 쿨다운(대기 상한 10 s 보다 길다)
        raise httpx.ReadTimeout("", request=request)

    r = FakeRedis()
    ctx = make_ctx(r)
    with respx.mock:
        respx.get(url__regex=r"https://aviationweather\.gov/.*").mock(side_effect=respond)
        await SigmetJob(awc, ctx).run_once()
    await http.aclose()
    assert sent == [AWC_ISIGMET + "?format=json"] and no_wait == [5.0]
    warns = _warnings(caplog)
    assert len(warns) == 1 and warns[0].startswith("sigmet/awc failed: isigmet — Throttled — throttled aviationweather.gov"), (
        warns
    )
    assert "first attempt: ReadTimeout" in warns[0]
    assert limiter.throttled == 1


async def test_fixture_mode_retry_reserves_no_budget(no_wait):
    """fixture 모드는 예산을 쓰지 않는다(_guard 와 같다) — 다시 부르기도."""
    from wakeline_collector.jobs.weather import RadarJob

    r = FakeRedis()
    ctx = make_ctx(r, limits={"rainviewer": 1}, fixture=True)
    rv = FlakyRadar([_read_timeout(RV_URL)])
    await RadarJob(rv, ctx).run_once()
    assert rv.calls == 2 and (await ctx.budget.usage("rainviewer"))[0] == 0


# ---- 예산: 다시 부르기는 정규 주기의 몫을 쓰지 않고, 보내지 않은 호출은 예산을 돌려준다(리뷰) -------------------------------------
@pytest.fixture
def fake_now(monkeypatch):
    """다시 부르기 여유 계산이 읽는 시각(UTC). 예산 키 날짜는 실제 날짜 그대로 — 시험 하루가 한 예산 날이다."""
    from datetime import UTC, datetime

    from wakeline_collector.jobs import weather as mod

    now = [datetime(2026, 9, 29, 0, 0, 0, tzinfo=UTC)]
    monkeypatch.setattr(mod, "_now", lambda: now[0])
    return now


async def _radar_day(ctx, rv, no_wait, fake_now) -> list[dict]:
    """UTC 하루 동안 RadarJob 을 run_periodic 처럼 돌린다: 주기가 끝난 뒤 radar_poll_s(60 s) 쉰다 — 다시 불렀으면 5 s 가 더 붙는다."""
    from datetime import timedelta

    from wakeline_collector.jobs.weather import RadarJob

    runs = _runs(ctx)
    job = RadarJob(rv, ctx)
    end = fake_now[0] + timedelta(days=1)
    while fake_now[0] < end:
        waited = len(no_wait)
        await job.run_once()
        fake_now[0] += timedelta(seconds=ctx.rt.radar_poll_s + 5.0 * (len(no_wait) - waited))
    return runs


async def test_a_day_of_connect_errors_spends_no_rainviewer_budget(no_wait, fake_now):
    """리뷰: 연결 실패가 빠르게 끝나는 긴 장애에서 주기마다 2(첫 호출 + 다시 부르기)를 써 약 18 h 뒤 일일 예산 2,000 이 바닥나고
    RainViewer 가 돌아와도 UTC 자정까지 budget_exhausted 였다. 연결조차 못 한 호출(NOT_SENT_ERRORS)은 보내지 않았으므로 예산을 돌려준다
    (aircraft · route 와 같다) — 하루 내내 ConnectError 여도 사용량이 쌓이지 않는다."""
    from wakeline_collector.config import settings

    ctx = make_ctx(FakeRedis(), limits={"rainviewer": settings.budget_rainviewer})
    rv = FlakyRadar([])
    rv.errors = _Always(lambda: httpx.ConnectError("connection refused"))  # type: ignore[assignment]
    runs = await _radar_day(ctx, rv, no_wait, fake_now)
    assert len(runs) > 1300 and {run["status"] for run in runs} == {"error"}  # 주기마다 다시 불렀다(65 s 주기)
    assert (await ctx.budget.usage("rainviewer"))[0] == 0


async def test_a_day_of_sent_transient_errors_never_exhausts_the_regular_radar_budget(no_wait, fake_now):
    """보낸 뒤의 일시 오류(여기서는 곧바로 끊기는 RemoteProtocolError — 보낸 호출로 센다)가 하루 내내여도, 다시 부르기는 남은 하루의
    정규 주기 몫(radar_poll_s 60 s → 남은 초 // 60 + 1)을 남기고만 예약하므로 정규 주기가 예산 소진으로 막히지 않는다."""
    from wakeline_collector.config import settings

    ctx = make_ctx(FakeRedis(), limits={"rainviewer": settings.budget_rainviewer})
    rv = FlakyRadar([])
    rv.errors = _Always(lambda: httpx.RemoteProtocolError("Server disconnected without sending a response."))  # type: ignore[assignment]
    runs = await _radar_day(ctx, rv, no_wait, fake_now)
    statuses = [run["status"] for run in runs]
    assert "budget_exhausted" not in statuses and set(statuses) == {"error"}
    used = (await ctx.budget.usage("rainviewer"))[0]
    assert used is not None and used <= settings.budget_rainviewer
    assert len(no_wait) > 300  # 여유가 있는 동안은 여전히 다시 부른다


def test_retry_headroom_is_the_regular_schedules_remaining_calls_until_utc_midnight():
    """다시 부르기가 남겨 둘 몫 = 예산 날(UTC)이 끝날 때까지 정규 주기의 최대 호출 수(설정값 계산): 남은 주기 ≤ 남은 초 // 주기 + 1.
    AWC 는 SIGMET(국제·미국 2) 과 METAR(상자 최대 2) 가 한 예산을 나눈다."""
    from datetime import UTC, datetime

    from fakes import FakeRt

    from wakeline_collector.jobs.weather import retry_headroom

    rt = FakeRt()
    midnight = datetime(2026, 9, 29, 0, 0, 0, tzinfo=UTC)
    assert retry_headroom(rt, "rainviewer", midnight) == 86400 // 60 + 1
    assert retry_headroom(rt, "awc", midnight) == (86400 // 300 + 1) * 2 + (86400 // 600 + 1) * 2
    late = datetime(2026, 9, 29, 23, 59, 30, tzinfo=UTC)
    assert retry_headroom(rt, "rainviewer", late) == 1 and retry_headroom(rt, "awc", late) == 4


async def test_retry_is_not_reserved_from_the_regular_cycles_share(no_wait, fake_now):
    """자정(UTC)에 레이더 정규 주기 몫은 1,441 — 한도 2,000 이면 사용량 559 부터는 다시 부르지 않는다(첫 호출은 그대로 한다)."""
    from wakeline_collector.budget import day_key
    from wakeline_collector.config import settings
    from wakeline_collector.jobs.weather import RadarJob

    limit = settings.budget_rainviewer
    share = 86400 // 60 + 1
    for used_before, retried in ((limit - share - 2, True), (limit - share - 1, False)):
        r = FakeRedis()
        ctx = make_ctx(r, limits={"rainviewer": limit})
        await r.hincrby(day_key("rainviewer"), "used", used_before)
        rv = FlakyRadar([_read_timeout(RV_URL), _read_timeout(RV_URL)])
        no_wait.clear()
        await RadarJob(rv, ctx).run_once()
        assert (rv.calls == 2) is retried and (no_wait == [5.0]) is retried, used_before


@pytest.mark.parametrize(
    ("errors", "used"),
    [
        ([httpx.ConnectError(""), httpx.ConnectError("")], 0),  # 두 시도 모두 연결 전 실패 — 둘 다 돌려준다
        ([httpx.ConnectTimeout(""), _read_timeout(RV_URL)], 1),  # 첫 시도만 보내지 않았다
        ([httpx.PoolTimeout("")] * 2, 0),
        ([Throttled("api.rainviewer.com", "no slot within 10.0 s")], 0),  # 속도 상한이 막았다 — 보내지 않았다
        ([_read_timeout(RV_URL), _read_timeout(RV_URL)], 2),  # 보낸 뒤 시간 초과 — 보낸 호출로 센다(과대 집계는 안전 쪽)
    ],
    ids=["connect-twice", "connect-then-read", "pool", "throttled", "read-twice"],
)
async def test_calls_that_were_never_sent_give_back_their_budget_unit(no_wait, errors, used):
    from wakeline_collector.config import settings
    from wakeline_collector.jobs.weather import RadarJob

    ctx = make_ctx(FakeRedis(), limits={"rainviewer": settings.budget_rainviewer})
    await RadarJob(FlakyRadar(list(errors)), ctx).run_once()
    assert (await ctx.budget.usage("rainviewer"))[0] == used


async def test_sigmet_international_failure_gives_back_the_unit_for_the_us_call_it_never_made(fixtures_dir, no_wait):
    """세트는 예산 2(국제 · 미국)를 먼저 예약한다 — 국제 호출이 실패해 미국 호출을 하지 않으면 그 1 을 돌려준다."""
    r = FakeRedis()
    ctx = make_ctx(r, limits={"awc": 2000})
    from wakeline_collector.jobs.weather import SigmetJob

    awc = FlakyAwc(fixtures_dir, intl=[_read_timeout(AWC_ISIGMET), _read_timeout(AWC_ISIGMET)])
    await SigmetJob(awc, ctx).run_once()
    assert awc.intl_calls == 2 and awc.us_calls == 0
    assert (await ctx.budget.usage("awc"))[0] == 2  # 국제 두 시도(보냄) — 미국 몫은 돌려줬다


async def test_fixture_mode_never_releases_budget(no_wait):
    """fixture 모드는 예약하지 않으므로 돌려주지도 않는다(사용량이 음수가 되지 않게)."""
    from wakeline_collector.jobs.weather import RadarJob

    ctx = make_ctx(FakeRedis(), limits={"rainviewer": 2000}, fixture=True)
    await RadarJob(FlakyRadar([httpx.ConnectError(""), httpx.ConnectError("")]), ctx).run_once()
    assert (await ctx.budget.usage("rainviewer"))[0] == 0


class _Always(list):
    """FlakyRadar.errors 대신: 비지 않은 목록처럼 보이고 pop 마다 새 오류를 만든다."""

    def __init__(self, make) -> None:
        super().__init__([None])
        self._make = make

    def pop(self, _i: int = -1):  # type: ignore[override]
        return self._make()
