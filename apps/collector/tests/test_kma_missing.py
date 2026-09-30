"""기상청 내려받기 '파일 없음' 연속(운영 로그 2026-09-30): 목록(rdr_cmp_file_list, 기본 ext=Y)은 RDR_CMP_HSR_EXT_* 를 09:50 KST 까지 싣는데
내려받기(rdr_cmp_file)는 08:15 부터 모든 tm 에 HTTP 200 '# file not exist (RDR_CMP_HSR_PUB_<tm>.bin.gz)' 로 답했다(오케스트레이터가 실제 호출로 확인).
결함 셋을 재현한다 — 이 파일의 시험은 고치기 전 코드에서 실패했다.
1. 로그 소음: tm 마다 3번 시도한 뒤 WARN 하나씩(5분마다 같은 지문) — 로그 화면이 그것으로 찼다.
2. 운영 상태: 프레임을 하나도 저장하지 못한 주기도 실행 'ok' · 공급자 LAST SUCCESS 가 갱신됐다(RECORDS 0 · FAILS 0).
3. 까닭이 어디에도 없었다: meta · 공급자 해시에 연속(첫 tm · 수 · 마지막 확인)이 없다.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import pytest

from wakeline_collector.models import ProviderResult

KST = timedelta(hours=9)


def _tms(until: str, since: str = "202609270000") -> list[str]:
    day = [f"20260927{h:02d}{m:02d}" for h in range(0, 24) for m in range(0, 60, 5)]
    return [t for t in day if since <= t <= until]


def _plus(tm: str, minutes: int) -> str:
    return (datetime.strptime(tm, "%Y%m%d%H%M") + timedelta(minutes=minutes)).strftime("%Y%m%d%H%M")


def _fake_decode(raw: bytes):
    from test_kma_radar import _fake_decode as decode

    return decode(raw)


class OutageKma:
    """목록은 시계까지의 tm 을 EXT 로 싣고, [down_from, up_from) 의 tm 은 내려받기가 'file not exist'(gzip 아님, 200)로 답한다."""

    name = "kma_radar"
    cmp = "HSR"
    configured = True

    def __init__(self, clock: dict, down_from: str, up_from: str | None = None, kinds: bool = True):
        self.clock, self.down_from, self.up_from, self.kinds = clock, down_from, up_from, kinds
        self.binaries: list[str] = []

    def _down(self, tm: str) -> bool:
        return tm >= self.down_from and (self.up_from is None or tm < self.up_from)

    async def file_list(self, day):
        tms = _tms(self.clock["now"])
        extra = {"kinds": {t: ["EXT"] for t in tms}} if self.kinds else {}
        return ProviderResult(self.name, b"", datetime.now(UTC), 200, 5, data=tms, extra=extra)

    async def binary(self, tm):
        self.binaries.append(tm)
        if self._down(tm):
            raise ValueError(f"not gzip: '# file not exist (RDR_CMP_HSR_PUB_{tm}.bin.gz)'")
        return ProviderResult(self.name, tm.encode(), datetime.now(UTC), 200, 7, data={"tm": tm})


@pytest.fixture
def env(monkeypatch, caplog):
    from fakes import FakeRedis, make_ctx

    from wakeline_collector.jobs import kma_radar as mod

    monkeypatch.setattr(mod, "_decode", _fake_decode)
    clock = {"now": "202609271100"}  # KST 벽시계
    wall = lambda: datetime.strptime(clock["now"], "%Y%m%d%H%M")  # noqa: E731
    monkeypatch.setattr(mod, "kst_now", wall)
    monkeypatch.setattr(mod, "_now", lambda: (wall() - KST).replace(tzinfo=UTC))
    caplog.set_level(logging.INFO, logger="job.kma_radar")
    r = FakeRedis()
    ctx = make_ctx(r, limits={"kma_radar": 1000})
    runs: list[dict] = []
    real = ctx.db.record_run

    def rec(job, provider, started_at, **kw):
        runs.append(kw)
        real(job, provider, started_at, **kw)

    ctx.db.record_run = rec
    return mod, r, ctx, clock, runs


def _warns(caplog) -> list[str]:
    return [x.getMessage() for x in caplog.records if x.name == "job.kma_radar" and x.levelno >= logging.WARNING]


def _infos(caplog) -> list[str]:
    return [x.getMessage() for x in caplog.records if x.name == "job.kma_radar" and x.levelno == logging.INFO]


async def _cycles(job, clock, until: str, since: str | None = None) -> None:
    """since(없으면 지금 다음 tm)부터 until 까지 5분마다 한 주기."""
    start = since or _tms("202609272355", clock["now"])[1]
    for t in _tms(until, start):
        clock["now"] = t
        await job.run_once()


async def _steady(mod, ctx, clock, prov):
    """11:00 부터 12:10 까지 정상 수집 — 보관 창(12 프레임)이 찬 뒤 주기마다 1개."""
    job = mod.KmaRadarJob(prov, ctx)
    clock["now"] = "202609271100"
    await job.run_once()
    await _cycles(job, clock, "202609271210")
    return job


# ---- 목록의 파일 종류 -------------------------------------------------------------------------------------------------------
def test_listing_kinds_are_read_per_tm_from_the_file_names():
    from wakeline_collector.providers.kma_radar import parse_file_kinds, parse_file_list

    text = (
        "RDR_CMP_HSR_EXT_202609300810.bin.gz,=\nRDR_CMP_HSR_KMA_202609300810.bin.gz,=\n"
        "RDR_CMP_HSR_EXT_202609300815.bin.gz,=\nRDR_CMP_PPI_EXT_202609300815.bin.gz,=\n"
    )
    assert parse_file_list(text, "HSR") == ["202609300810", "202609300815"]
    assert parse_file_kinds(text, "HSR") == {
        "202609300810": ["EXT", "KMA"],
        "202609300815": ["EXT"],
    }  # 다른 합성(PPI)은 세지 않는다


async def test_provider_file_list_carries_the_kinds():
    import httpx
    import respx

    from wakeline_collector.http import HttpClient
    from wakeline_collector.providers.kma_radar import KmaRadarProvider
    from wakeline_collector.ratelimit import RateLimiter

    http = HttpClient(RateLimiter(100, 100))
    body = b"RDR_CMP_HSR_EXT_202609300950.bin.gz,=\nRDR_CMP_HSR_KMA_202609300950.bin.gz,=\n"
    with respx.mock:
        respx.get(url__regex=r"https://apihub\.kma\.go\.kr/.*").mock(return_value=httpx.Response(200, content=body))
        res = await KmaRadarProvider(http, "k" * 12).file_list("20260930")
    assert res.data == ["202609300950"] and res.extra["kinds"] == {"202609300950": ["EXT", "KMA"]}
    await http.aclose()


# ---- 1 · 3: 연속은 WARN 한 번 · 선택한 간격마다 한 번 · 회복은 INFO(공백 길이) ---------------------------------------------------
async def test_outage_warns_once_then_reminds_per_interval_and_recovery_is_info(env, caplog):
    mod, r, ctx, clock, runs = env
    prov = OutageKma(clock, down_from="202609271215", up_from="202609271340")
    job = await _steady(mod, ctx, clock, prov)
    assert _warns(caplog) == []
    await _cycles(job, clock, "202609271335")  # 12:15–13:35 — 17 주기 동안 파일 없음
    warns = _warns(caplog)
    # 전에는 tm 마다 3번 뒤 WARN 하나씩(12:15 … 13:25 — 15건). 이제 연속이 시작될 때 한 번 + 60분(선택값)마다 한 번
    assert len(warns) == 2, warns
    assert warns[0] == (
        "kma radar: KMA download has no file from tm=202609271215 on — the listing has it (EXT), the download answered "
        "not gzip: '# file not exist (RDR_CMP_HSR_PUB_202609271215.bin.gz)'; probing only the newest listed tm and the newest one "
        "at least 10 min old once per cycle, reminder every 60 min (chosen)"
    )
    assert warns[1].startswith(
        "kma radar: KMA download still has no file — since tm=202609271215, 15 tms answered missing, newest tm=202609271325"
    )
    assert mod.MISSING_REMIND_S == 60 * 60
    caplog.clear()
    clock["now"] = "202609271340"
    await job.run_once()  # 파일이 다시 있다
    assert _warns(caplog) == []
    assert (
        "kma radar: KMA download has the file again at tm=202609271340 — missing from tm=202609271215 to tm=202609271335 "
        "(17 tms answered missing, 1 h 25 min of tms); normal retries resume"
    ) in _infos(caplog)


async def test_while_the_streak_lasts_only_two_tms_are_probed_per_cycle(env):
    """연속 동안은 옛 tm 마다 세 번씩이 아니라 가장 새 tm 과 10분(선택값) 넘게 앞선 가장 새 tm 만 — 첫 tm 보다 옛 tm 은 보지 않는다."""
    mod, r, ctx, clock, runs = env
    prov = OutageKma(clock, down_from="202609271215")
    job = await _steady(mod, ctx, clock, prov)
    await _cycles(job, clock, "202609271225")  # 12:25 에 12:15 가 세 번째 — 연속 시작
    assert job.missing is not None and job.missing.since_tm == "202609271215"
    assert mod.MISSING_RECHECK_S == 10 * 60
    for t in _tms("202609271400", "202609271230"):
        clock["now"] = t
        prov.binaries.clear()
        before = (await ctx.budget.usage("kma_radar"))[0]
        await job.run_once()
        assert prov.binaries == [_plus(t, -10), t]  # 옛 tm 마다 세 번씩이 아니라 둘만(12:15 보다 옛 tm 은 없다)
        used = (await ctx.budget.usage("kma_radar"))[0]
        assert used - before == 3  # 목록 1 + 확인 2(전에는 목록 1 + 바이너리 4) — 하루 864 < 1,000
    assert job.missing.tms == 3 + len(_tms("202609271400", "202609271230"))
    assert job.missing.last_tm == "202609271400"


def test_streak_probes_stay_at_or_after_the_first_missing_tm():
    from wakeline_collector.jobs.kma_radar import streak_probes

    listing = _tms("202609271230", "202609271100")
    stored = _tms("202609271205", "202609271100")
    assert streak_probes(listing, stored, "202609271230", "202609271215") == ["202609271220", "202609271230"]
    # 첫 tm 이 10분 안이면 가장 새 tm 하나 — 보관 창 밖의 옛 빈 tm(11:00 전)을 받지 않는다
    assert streak_probes(_tms("202609271230"), stored, "202609271230", "202609271225") == ["202609271230"]
    assert streak_probes(listing, listing, "202609271230", "202609271215") == []
    assert streak_probes(listing, stored, "202609271230", "202609271215", {"202609271230"}) == ["202609271220", "202609271225"]


async def test_recovery_resumes_normal_retries_and_holes_of_the_reported_gap_are_info(env, caplog):
    mod, r, ctx, clock, runs = env
    prov = OutageKma(clock, down_from="202609271215", up_from="202609271340")
    job = await _steady(mod, ctx, clock, prov)
    await _cycles(job, clock, "202609271340")
    assert job.missing is None
    caplog.clear()
    prov.binaries.clear()
    await _cycles(job, clock, "202609271420")
    # 회복 뒤에는 보관 창 안의 빈 곳을 전처럼 다시 시도한다(주기마다 최신 4개) — 포기해도 이미 알린 공백 안이라 INFO
    assert {"202609271325", "202609271330", "202609271335"} <= set(prov.binaries)
    assert _warns(caplog) == []
    assert any("still unavailable after 3 tries — skipped (inside the gap reported" in m for m in _infos(caplog))


async def test_an_isolated_missing_frame_warns_once_and_opens_no_streak(env, caplog):
    mod, r, ctx, clock, runs = env

    class OneHole(OutageKma):
        def _down(self, tm):
            return tm == "202609271215"

    prov = OneHole(clock, down_from="")
    job = await _steady(mod, ctx, clock, prov)
    await _cycles(job, clock, "202609271230")
    assert job.missing is None
    warns = _warns(caplog)
    assert warns == [
        "kma radar: tm=202609271215 still unavailable after 3 tries — skipped: not gzip: '# file not exist (RDR_CMP_HSR_PUB_202609271215.bin.gz)'"
    ]
    assert (await r.hgetall(mod.KEY_META)).get("missing_since_tm", "") == ""


# ---- 2: 실행 상태 · 공급자 해시 ----------------------------------------------------------------------------------------------
async def test_a_cycle_that_stored_no_frame_is_recorded_missing_not_ok(env):
    mod, r, ctx, clock, runs = env
    prov = OutageKma(clock, down_from="202609271215")
    job = await _steady(mod, ctx, clock, prov)
    assert {run["status"] for run in runs} == {"ok"}
    runs.clear()
    await job.run_once()  # 같은 12:10 — 새로 받을 tm 이 없는 주기는 'ok'
    assert [run["status"] for run in runs] == ["ok"] and runs[0]["records_in"] == 0
    before = await r.hgetall("wakeline:provider:kma_radar")
    runs.clear()
    await _cycles(job, clock, "202609271300")
    assert [run["status"] for run in runs] == ["missing"] * len(_tms("202609271300", "202609271215"))
    assert all(run["records_in"] == 0 for run in runs)
    assert runs[0]["error_text"].startswith("no new frame stored — tm=202609271215 not available yet (try 1/3)")
    assert runs[-1]["error_text"].startswith(
        "no new frame stored — KMA download has no file since tm=202609271215 (10 tms answered missing, newest tm=202609271300)"
    )
    h = await r.hgetall("wakeline:provider:kma_radar")
    assert h["last_success_at"] == before["last_success_at"]  # 저장하지 못한 주기는 성공이 아니다(전에는 5분마다 갱신)
    assert int(h["budget_used"]) > int(before["budget_used"])  # 예산 사용량은 갱신한다
    assert h["consecutive_failures"] == "0"  # 호출 실패는 아니다('error' 가 아니다)


async def test_the_streak_is_exposed_in_meta_and_provider_hash_and_cleared_on_recovery(env):
    mod, r, ctx, clock, runs = env
    prov = OutageKma(clock, down_from="202609271215", up_from="202609271300")
    job = await _steady(mod, ctx, clock, prov)
    await _cycles(job, clock, "202609271250")
    want = {
        "missing_since_tm": "202609271215",
        "missing_last_tm": "202609271250",
        "missing_tms": "8",
        "missing_checked_at": "2026-09-27T03:50:00Z",
        "missing_file": "RDR_CMP_HSR_PUB_202609271250.bin.gz",
        "missing_listed": "EXT",
    }
    meta = await r.hgetall(mod.KEY_META)
    prov_h = await r.hgetall("wakeline:provider:kma_radar")
    assert {k: meta[k] for k in want} == want
    assert {k: prov_h[k] for k in want} == want
    clock["now"] = "202609271300"
    await job.run_once()
    meta = await r.hgetall(mod.KEY_META)
    prov_h = await r.hgetall("wakeline:provider:kma_radar")
    assert all(meta[k] == "" for k in want) and all(prov_h[k] == "" for k in want)
    assert meta["latest_tm"] == "202609271300"


async def test_unknown_listing_kinds_and_unreadable_answer_stay_empty(env):
    mod, r, ctx, clock, runs = env

    class Plain(OutageKma):
        async def binary(self, tm):
            self.binaries.append(tm)
            if self._down(tm):
                raise ValueError("not gzip: '<html>busy</html>'")
            return await super().binary(tm)

    prov = Plain(clock, down_from="202609271215", kinds=False)
    job = await _steady(mod, ctx, clock, prov)
    await _cycles(job, clock, "202609271225")
    meta = await r.hgetall(mod.KEY_META)
    assert meta["missing_since_tm"] == "202609271215"
    assert (meta["missing_file"], meta["missing_listed"]) == ("", "")  # 모르는 값을 짓지 않는다


async def test_a_restarted_collector_carries_a_recent_streak_over_without_a_second_warning(env, caplog):
    mod, r, ctx, clock, runs = env
    prov = OutageKma(clock, down_from="202609271215")
    job = await _steady(mod, ctx, clock, prov)
    await _cycles(job, clock, "202609271240")
    assert len(_warns(caplog)) == 1
    caplog.clear()
    again = mod.KmaRadarJob(prov, ctx)  # 새 프로세스
    clock["now"] = "202609271245"
    prov.binaries.clear()
    await again.run_once()
    assert again.missing is not None and again.missing.since_tm == "202609271215"
    assert prov.binaries == ["202609271235", "202609271245"]
    assert _warns(caplog) == []
    assert any(m.startswith("kma radar: carried over the missing-file streak since tm=202609271215") for m in _infos(caplog))


async def test_a_stale_streak_left_in_redis_is_cleared_not_shown(env):
    mod, r, ctx, clock, runs = env
    await r.hset(
        mod.KEY_META,
        mapping={
            "missing_since_tm": "202609270815",
            "missing_last_tm": "202609270950",
            "missing_tms": "20",
            "missing_checked_at": "2026-09-27T00:50:00Z",
            "missing_file": "",
            "missing_listed": "EXT",
        },
    )
    prov = OutageKma(clock, down_from="209912312355")
    job = mod.KmaRadarJob(prov, ctx)
    clock["now"] = "202609271100"  # 마지막 확인 뒤 10분보다 훨씬 지났다(15분 상한 — 선택값)
    await job.run_once()
    assert job.missing is None
    assert (await r.hgetall(mod.KEY_META))["missing_since_tm"] == ""


async def test_a_cycle_whose_only_new_frame_cannot_be_read_is_recorded_quarantined(env):
    mod, r, ctx, clock, runs = env

    class Corrupt(OutageKma):
        async def binary(self, tm):
            self.binaries.append(tm)
            return ProviderResult(self.name, (tm + ("BAD" if tm == "202609271215" else "")).encode(), datetime.now(UTC), 200, 7)

    prov = Corrupt(clock, down_from="")
    job = await _steady(mod, ctx, clock, prov)
    before = (await r.hgetall("wakeline:provider:kma_radar"))["last_success_at"]
    runs.clear()
    clock["now"] = "202609271215"
    await job.run_once()
    assert [run["status"] for run in runs] == ["quarantined"]
    assert runs[0]["error_text"].startswith("no new frame stored — could not read tm=202609271215 kma_radar_parse: ")
    assert (await r.hgetall("wakeline:provider:kma_radar"))["last_success_at"] == before
    assert job.missing is None  # 파일은 있었다 — '파일 없음' 연속이 아니다


async def test_a_failed_clear_of_the_streak_is_written_again_next_cycle(env):
    mod, r, ctx, clock, runs = env
    prov = OutageKma(clock, down_from="202609271215", up_from="202609271240")
    job = await _steady(mod, ctx, clock, prov)
    await _cycles(job, clock, "202609271235")
    real = r.hset
    fail = {"on": True}

    async def flaky_hset(key, field=None, value=None, mapping=None):
        if fail["on"] and mapping and "missing_since_tm" in mapping:
            raise ConnectionError("redis blip")
        return await real(key, field, value, mapping)

    r.hset = flaky_hset
    clock["now"] = "202609271240"
    await job.run_once()  # 회복 — 지우기 실패
    assert job.missing is None and (await r.hgetall(mod.KEY_META))["missing_since_tm"] == "202609271215"
    fail["on"] = False
    clock["now"] = "202609271245"
    await job.run_once()
    assert (await r.hgetall(mod.KEY_META))["missing_since_tm"] == ""
    assert (await r.hgetall("wakeline:provider:kma_radar"))["missing_since_tm"] == ""


# ---- 리뷰(2026-09-30) 후속 -------------------------------------------------------------------------------------------------
class LateKma(OutageKma):
    """R-03 의 늦게 생기는 파일(2026-09-28: 첫 시도에 182 중 14 tm 이 '파일 없음', 다음 주기에 받음): 목록은 tm 을 먼저 싣고 내려받기는
    tm + late 분부터 된다. [down_from, up_from) 의 tm 은 끝내 없다."""

    def __init__(self, clock: dict, down_from: str, up_from: str | None = None, late: int = 5):
        super().__init__(clock, down_from, up_from)
        self.late = late

    def _down(self, tm: str) -> bool:
        return super()._down(tm) or self.clock["now"] < _plus(tm, self.late)


@pytest.mark.parametrize("late", [5, 10])
async def test_recovery_is_seen_when_the_newest_tm_is_not_downloadable_yet(env, caplog, late):
    """리뷰(중간): 연속 동안 가장 새 tm 하나만 확인하면, 회복 뒤에도 가장 새 tm 은 아직 받을 수 없어서(목록이 먼저 싣는다 — R-03) 한 주기 늦게
    받을 수 있게 된 tm 을 다시 보지 않았다 — 연속이 닫히지 않고 프레임도 저장되지 않았다(고치기 전: 두 시간 뒤에도 'missing').
    이제 R-03 의 마지막 시도와 같은 나이(10분 — 설정값 계산)를 넘은 가장 새 tm 도 주기마다 다시 확인한다."""
    mod, r, ctx, clock, runs = env
    prov = LateKma(clock, down_from="202609271215", up_from="202609271300", late=late)
    job = await _steady(mod, ctx, clock, prov)
    assert job.missing is None  # 늦게 생기는 파일만으로는 연속이 아니다(R-03)
    await _cycles(job, clock, "202609271255")
    assert job.missing is not None and job.missing.since_tm == "202609271215"
    await _cycles(job, clock, "202609271310")  # 13:00 부터 파일이 다시 있다(late 분 늦게)
    assert job.missing is None
    assert "202609271300" in [f["tm"] for f in await job._frames()]
    runs.clear()
    await _cycles(job, clock, "202609271320")
    stored = {f["tm"] for f in await job._frames()}
    assert {"202609271300", "202609271305", _plus("202609271320", -late)} <= stored
    assert {run["status"] for run in runs} == {"ok"}
    assert [m for m in _warns(caplog) if "has no file" in m] == [_warns(caplog)[0]]  # 연 순간 WARN 한 번뿐


def _refuse_after(ctx, allowed: int) -> None:
    """예산 예약을 allowed 번만 허용하고 그 뒤로는 한도 초과(1,000)로 답한다."""
    real = ctx.budget.reserve
    n = {"calls": 0}

    async def reserve(provider, cost=1, *, headroom=0):
        n["calls"] += 1
        if n["calls"] > allowed:
            return False, 1000
        return await real(provider, cost, headroom=headroom)

    ctx.budget.reserve = reserve


@pytest.mark.parametrize(("allowed", "want"), [(1, ("budget_exhausted", 0)), (2, ("ok", 1))])
async def test_a_budget_stop_at_the_download_step_is_one_run_and_ok_only_with_a_stored_frame(env, allowed, want):
    """리뷰(낮음): 목록 예약 뒤 바이너리 예약이 거절되면 'budget_exhausted' 실행을 남기고도 주기가 이어져 'ok'(records 0)를 한 번 더 남기고
    last_success_at 을 갱신했다 — 새 tm 이 목록에 있었는데 저장한 프레임이 없는데도. 이제 한 주기 = 실행 기록 하나: 프레임을 저장하지 못했으면
    예산 상태만(성공으로 적지 않는다), 저장했으면 'ok'."""
    mod, r, ctx, clock, runs = env
    prov = OutageKma(clock, down_from="209912312355")
    job = await _steady(mod, ctx, clock, prov)
    before = (await r.hgetall("wakeline:provider:kma_radar"))["last_success_at"]
    runs.clear()
    _refuse_after(ctx, allowed)  # 목록 1(+ 바이너리 allowed − 1)
    clock["now"] = "202609271220"  # 새 tm 둘(12:15 · 12:20)
    await job.run_once()
    assert [(run["status"], run.get("records_in", 0)) for run in runs] == [want]
    after = (await r.hgetall("wakeline:provider:kma_radar"))["last_success_at"]
    assert (after == before) == (want[0] != "ok")
