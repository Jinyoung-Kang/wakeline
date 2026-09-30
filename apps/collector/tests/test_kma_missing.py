"""기상청 내려받기 '파일 없음' 연속(운영 로그 2026-09-30): 목록(rdr_cmp_file_list, 기본 ext=Y)은 RDR_CMP_HSR_EXT_* 를 09:50 KST 까지 싣는데
내려받기(rdr_cmp_file)는 08:15 부터 모든 tm 에 HTTP 200 '# file not exist (RDR_CMP_HSR_PUB_<tm>.bin.gz)' 로 답했다(오케스트레이터가 실제 호출로 확인).
결함 셋을 재현한다 — 이 파일의 시험은 고치기 전 코드에서 실패했다.
1. 로그 소음: tm 마다 3번 시도한 뒤 WARN 하나씩(5분마다 같은 지문) — 로그 화면이 그것으로 찼다.
2. 운영 상태: 프레임을 하나도 저장하지 못한 주기도 실행 'ok' · 공급자 LAST SUCCESS 가 갱신됐다(RECORDS 0 · FAILS 0).
3. 까닭이 어디에도 없었다: meta · 공급자 해시에 연속(첫 tm · 수 · 마지막 확인)이 없다.
"""

from __future__ import annotations

import logging
import re
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
    return make_env(monkeypatch, caplog)


def make_env(monkeypatch, caplog):
    """env 의 몸통 — 다른 시험 파일(test_kma_list_idle)도 같은 가짜 시계 · Redis · 실행 기록을 쓴다."""
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
        "kma radar: KMA download has no file from tm=202609271215 on — 3 tms answered missing (newest tm=202609271225); "
        "the listing has tm=202609271215 (EXT); tm=202609271215 answered 3 times: "
        "not gzip: '# file not exist (RDR_CMP_HSR_PUB_202609271215.bin.gz)'; probing only the newest listed tm and the newest one "
        "at least 10 min old once per cycle, every 15 min once the gap is 60 min old, reminder every 60 min (chosen)"
    )
    # 첫 tm 부터 60분(13:15)이 넘은 뒤로는 15분마다 확인한다(계약 v5 §G26) — 13:15 · 13:20 · 13:30 · 13:35 는 기다린 주기라 세지 않는다(전에는 15 tms)
    assert warns[1] == (
        "kma radar: KMA download still has no file — since tm=202609271215, 14 tms answered missing, newest tm=202609271325 (EXT), "
        "1 h 10 min of tms; probing every 15 min (chosen); last answer: not gzip: '# file not exist (RDR_CMP_HSR_PUB_202609271325.bin.gz)'"
    )
    assert mod.MISSING_REMIND_S == 60 * 60
    caplog.clear()
    clock["now"] = "202609271340"
    await job.run_once()  # 확인하는 주기 — 파일이 다시 있다
    assert _warns(caplog) == []
    assert (
        "kma radar: KMA download has the file again at tm=202609271340 — the gap from tm=202609271215 is 1 h 25 min of tms "
        "(15 tms answered missing, the newest tm=202609271330); normal retries resume"
    ) in _infos(caplog)


async def test_while_the_streak_lasts_only_two_tms_are_probed_per_cycle(env):
    """연속 동안은 옛 tm 마다 세 번씩이 아니라 가장 새 tm 과 10분(선택값) 넘게 앞선 가장 새 tm 만 — 첫 tm 보다 옛 tm 은 보지 않는다.
    첫 tm 부터 60분까지(13:10)는 주기마다 — 그 뒤의 15분 간격은 아래 '긴 연속의 확인 간격'(계약 v5 §G26)."""
    mod, r, ctx, clock, runs = env
    prov = OutageKma(clock, down_from="202609271215")
    job = await _steady(mod, ctx, clock, prov)
    await _cycles(job, clock, "202609271225")  # 12:25 에 12:15 가 세 번째 — 연속 시작
    assert job.missing is not None and job.missing.since_tm == "202609271215"
    assert mod.MISSING_RECHECK_S == 10 * 60
    for t in _tms("202609271310", "202609271230"):
        clock["now"] = t
        prov.binaries.clear()
        before = (await ctx.budget.usage("kma_radar"))[0]
        await job.run_once()
        assert prov.binaries == [_plus(t, -10), t]  # 옛 tm 마다 세 번씩이 아니라 둘만(12:15 보다 옛 tm 은 없다)
        used = (await ctx.budget.usage("kma_radar"))[0]
        assert used - before == 3  # 목록 1 + 확인 2(전에는 목록 1 + 바이너리 4) — 하루 864 < 1,000
    assert job.missing.tms == 3 + len(_tms("202609271310", "202609271230"))
    assert job.missing.last_tm == "202609271310"


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
    # 다시 온 tm(13:00)보다 새 tm 이 '없음'으로 답했을 수 있다(아직 생기지 않았다) — 공백은 다시 온 tm 까지로 말한다
    back = [m for m in _infos(caplog) if "has the file again" in m]
    assert len(back) == 1 and back[0].startswith(
        "kma radar: KMA download has the file again at tm=202609271300 — the gap from tm=202609271215 is 45 min of tms ("
    )
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


async def test_a_restart_right_after_recovery_keeps_the_reported_gap_quiet(env, caplog):
    """리뷰(낮음): 알린 공백(닫은 연속)은 프로세스 메모리에만 있었다 — 회복 직후 수집기를 다시 띄우면(이 수정을 배포하는 때가 바로 그렇다) 보관 창 안의
    빈 tm 마다 세 번 뒤 WARN 이 다시 났다(12:15–13:40 공백, 13:45 재기동 → WARN 5건). 이제 meta 해시에 남겨 다시 읽는다."""
    mod, r, ctx, clock, runs = env
    prov = OutageKma(clock, down_from="202609271215", up_from="202609271340")
    job = await _steady(mod, ctx, clock, prov)
    await _cycles(job, clock, "202609271340")
    assert job.missing is None
    meta = await r.hgetall(mod.KEY_META)
    assert (meta["missing_gap_from"], meta["missing_gap_to"]) == ("202609271215", "202609271340")
    assert "missing_gap_from" not in await r.hgetall("wakeline:provider:kma_radar")  # 수집기 내부 값 — 운영 표에는 싣지 않는다
    caplog.clear()
    again = mod.KmaRadarJob(prov, ctx)  # 새 프로세스
    await _cycles(again, clock, "202609271420")
    assert _warns(caplog) == []
    assert any("still unavailable after 3 tries — skipped (inside the gap reported" in m for m in _infos(caplog))


async def test_an_old_reported_gap_is_not_carried_over(env):
    mod, r, ctx, clock, runs = env
    await r.hset(mod.KEY_META, mapping={"missing_gap_from": "202609270615", "missing_gap_to": "202609270740"})
    prov = OutageKma(clock, down_from="209912312355")
    job = mod.KmaRadarJob(prov, ctx)
    clock["now"] = "202609271100"  # 공백 끝 tm 이 보관할 수 있는 나이(영상 TTL 3 h)보다 오래됐다
    await job.run_once()
    assert job._closed_gap is None
    meta = await r.hgetall(mod.KEY_META)
    assert (meta["missing_gap_from"], meta["missing_gap_to"]) == ("", "")


async def test_the_streak_counts_every_distinct_tm_that_answered_missing(env):
    """리뷰(낮음): tms 는 범위를 넓힌 답만 셌다 — 확인이 둘이 된 뒤로는 범위 안의 처음 확인한 tm(늦은 주기가 건너뛴 tm)을 세지 않았다. 웹은 이 수를
    '확인한 tm N개'로 적으므로 확인한 서로 다른 tm 수와 같아야 한다(같은 tm 을 다시 확인하면 세지 않는다)."""
    mod, r, ctx, clock, runs = env
    prov = OutageKma(clock, down_from="202609271215")
    job = await _steady(mod, ctx, clock, prov)
    prov.binaries.clear()
    await _cycles(job, clock, "202609271225")  # 연속 시작(12:15 · 12:20 · 12:25)
    for t in ("202609271235", "202609271240", "202609271300", "202609271305"):  # 늦은 주기 — 12:30 · 12:45 … 는 건너뛴다
        clock["now"] = t
        await job.run_once()
    checked = {tm for tm in prov.binaries if tm >= "202609271215"}
    assert "202609271230" in checked  # 12:40 의 10분 넘은 확인 — 12:35 보다 옛 tm
    assert job.missing.tms == len(checked)
    assert (await r.hgetall(mod.KEY_META))["missing_tms"] == str(len(checked))


_STREAK_IN_REDIS = {
    "missing_since_tm": "202609271015",
    "missing_last_tm": "202609271055",
    "missing_tms": "9",
    "missing_checked_at": "2026-09-27T01:55:00Z",
    "missing_file": "RDR_CMP_HSR_PUB_202609271055.bin.gz",
    "missing_listed": "EXT",
}


async def test_a_streak_left_in_redis_is_cleared_when_the_key_is_not_set(env, caplog):
    """리뷰(낮음): KMA_APIHUB_KEY 가 없으면 run_once 가 연속을 읽기도 지우기도 전에 끝나서, 앞서 남은 missing_* 가 TTL 없이 두 해시에 남았다 —
    KMA 칩이 옛 '파일 없음'을 지금 것처럼 보였다. 이제 수집하지 않는 동안에는 연속 · 알린 공백을 지운다(한 번, 실패하면 다음 주기에)."""
    mod, r, ctx, clock, runs = env
    await r.hset(mod.KEY_META, mapping=_STREAK_IN_REDIS | {"missing_gap_from": "202609270915", "missing_gap_to": "202609270940"})
    await r.hset("wakeline:provider:kma_radar", mapping=_STREAK_IN_REDIS)
    prov = OutageKma(clock, down_from="209912312355")
    prov.configured = False
    job = mod.KmaRadarJob(prov, ctx)
    clock["now"] = "202609271100"  # 마지막 확인 뒤 5분 — 이어받을 수 있는 나이지만 수집하지 않는다
    await job.run_once()
    await job.run_once()
    meta, prov_h = await r.hgetall(mod.KEY_META), await r.hgetall("wakeline:provider:kma_radar")
    assert all(meta[k] == "" for k in (*mod.MISSING_KEYS, *mod.GAP_KEYS))
    assert all(prov_h[k] == "" for k in mod.MISSING_KEYS)
    assert job.missing is None and prov.binaries == [] and runs == []
    assert _warns(caplog) == []


async def test_a_listing_failure_during_a_streak_keeps_the_streak_and_its_last_check(env, caplog, monkeypatch):
    """누락 요구(리뷰): 연속 중 목록 호출이 실패하면 — 주기는 'error'(호출 실패), 연속은 그대로(닫지도 새로 열지도 않는다), 마지막 확인은 옮기지 않는다
    (확인하지 않았다 — 웹은 마지막 확인의 나이로 '확인 멈춤'을 판단한다). 다음 주기에 목록이 되면 연속을 이어 간다(WARN 을 다시 내지 않는다)."""
    import httpx

    mod, r, ctx, clock, runs = env

    async def no_wait(_s):
        return None

    monkeypatch.setattr(mod, "_sleep", no_wait)
    prov = OutageKma(clock, down_from="202609271215")
    job = await _steady(mod, ctx, clock, prov)
    await _cycles(job, clock, "202609271230")
    assert job.missing is not None
    before = await r.hgetall(mod.KEY_META)
    caplog.clear()
    runs.clear()
    real = prov.file_list

    async def down(day):
        raise httpx.ConnectTimeout("connect timed out")

    prov.file_list = down
    clock["now"] = "202609271235"
    await job.run_once()
    assert [run["status"] for run in runs] == ["error"]
    assert job.missing is not None and job.missing.since_tm == "202609271215"
    after = await r.hgetall(mod.KEY_META)
    assert {k: after[k] for k in mod.MISSING_KEYS} == {k: before[k] for k in mod.MISSING_KEYS}  # 마지막 확인도 그대로
    assert not any("has no file" in m for m in _warns(caplog))
    prov.file_list = real
    runs.clear()
    clock["now"] = "202609271240"
    await job.run_once()
    assert [run["status"] for run in runs] == ["missing"]
    assert (await r.hgetall(mod.KEY_META))["missing_checked_at"] == "2026-09-27T03:40:00Z"
    assert not any("has no file" in m for m in _warns(caplog))


# ---- 리뷰(2026-09-30 · 통합) 후속: 연속인지는 주기의 후보를 모두 본 뒤에 가린다 -------------------------------------------------
async def test_a_missing_tm_followed_by_a_late_file_in_the_same_cycle_is_one_skipped_tm_not_an_outage(env, caplog):
    """리뷰(낮음): 후보는 오래된 것부터인데 끝내 없는 tm 을 그 자리에서 가렸다 — 12:15 가 세 번째도 없던 주기에 저장된 가장 새 tm 은 12:10 이라 연속을
    열고(WARN '연속 시작'), 같은 주기에 뒤이어 12:20 파일(R-03 — 한 주기 늦게 생김)을 받아 곧바로 닫았다(INFO '5 min 공백'). 이제 주기 끝에 가린다:
    그 tm 하나만 빠졌다(전처럼 WARN 한 번), 연속 · 공백 INFO · 알린 공백은 없다."""
    mod, r, ctx, clock, runs = env

    class HoleLate(LateKma):
        def _down(self, tm):
            return tm == "202609271215" or super()._down(tm)

    prov = HoleLate(clock, down_from="209912312355", late=5)
    job = await _steady(mod, ctx, clock, prov)
    runs.clear()
    await _cycles(job, clock, "202609271240")
    assert _warns(caplog) == [
        "kma radar: tm=202609271215 still unavailable after 3 tries — skipped: not gzip: '# file not exist (RDR_CMP_HSR_PUB_202609271215.bin.gz)'"
    ]
    assert not [m for m in _infos(caplog) if "has the file again" in m]
    assert job.missing is None and job._closed_gap is None
    assert (await r.hgetall(mod.KEY_META)).get("missing_since_tm", "") == ""
    # 12:20 주기만 새 프레임 없음(12:15 는 없고 12:20 은 아직 — 늦게 생김). 12:25 주기에 12:20 을 받는다 — 전에는 이 주기도 'missing'(연속을 열고 닫았다)
    assert [run["status"] for run in runs] == ["ok", "missing", "ok", "ok", "ok", "ok"]


async def test_a_restart_inside_an_outage_starts_the_streak_at_the_first_tm_it_asked(env, caplog):
    """리뷰(낮음): 연속 한가운데서 다시 띄운 수집기(Redis 에 이어받을 연속 없음 — 15분 넘게 멈췄다)는 보관 창의 빈 tm 중 최신 4개만 고르므로 옛 tm 은
    한두 번 묻고 후보에서 밀려났다. 전에는 처음으로 세 번을 채운 tm(12:40)에서 연속을 열어 첫 tm · 수가 줄었고, 앞서 없다고 답한 12:30 · 12:35 는 회복 뒤
    알린 공백 밖이라 tm 마다 WARN 했다. 이제 이 프로세스에서 없다는 답을 받은, 파일이 있던 가장 새 tm(12:10)보다 새 tm 을 모두 센다(첫 tm 12:30).
    이 프로세스가 연속 전에 한 번도 묻지 않은 tm(12:15–12:25)은 받은 답이 없어 세지 않는다 — 회복 뒤 보관 창에서 세 번을 채우면 그 tm 하나로 WARN 할 수 있다."""
    mod, r, ctx, clock, runs = env
    prov = OutageKma(clock, down_from="202609271215", up_from="202609271300")
    await _steady(mod, ctx, clock, prov)
    caplog.clear()
    prov.binaries.clear()
    job = mod.KmaRadarJob(prov, ctx)  # 12:10 뒤 멈췄다가 12:45 에 다시 띄운 수집기
    clock["now"] = "202609271245"
    await job.run_once()
    assert prov.binaries == ["202609271230", "202609271235", "202609271240", "202609271245"]  # 보관 창의 빈 tm 중 최신 4개
    opened_at = None
    for t in _tms("202609271400", "202609271250"):
        clock["now"] = t
        await job.run_once()
        if job.missing is not None and opened_at is None:
            opened_at = t
            asked = {tm for tm in prov.binaries if tm < "202609271300"}
            assert job.missing.since_tm == "202609271230" == min(asked)  # 전에는 202609271240
            assert job.missing.tms == len(asked)  # 전에는 4
    assert opened_at == "202609271255"
    warns = _warns(caplog)
    assert len([m for m in warns if "has no file from" in m]) == 1
    assert "has no file from tm=202609271230 on" in warns[0]
    skipped = [m for m in warns if "still unavailable" in m]
    # 알린 공백의 tm 은 WARN 하지 않는다(INFO)
    assert all(re.search(r"tm=(\d{12})", m).group(1) < "202609271230" for m in skipped), skipped
    inside = "(inside the gap reported from tm=202609271230"
    assert any("tm=202609271235 still unavailable after" in m and inside in m for m in _infos(caplog))


async def test_a_call_failure_later_in_the_cycle_still_reports_the_tm_given_up(env, caplog):
    """주기가 중간에 끝나도(뒤 tm 의 HTTP 오류) 이 주기에 포기한 tm 은 가린다 — 품질 이벤트만 남고 로그가 조용해지지 않게."""
    from wakeline_collector.http import ProviderHttpError

    mod, r, ctx, clock, runs = env

    class HoleThenError(OutageKma):
        def _down(self, tm):
            return tm == "202609271215"

        async def binary(self, tm):
            if tm == "202609271225":
                self.binaries.append(tm)
                raise ProviderHttpError(500, "internal error")
            return await super().binary(tm)

    prov = HoleThenError(clock, down_from="")
    job = await _steady(mod, ctx, clock, prov)
    runs.clear()
    await _cycles(job, clock, "202609271225")  # 12:25 주기: 12:15 세 번째(없음) → 12:25 HTTP 500 으로 주기 끝
    assert [run["status"] for run in runs] == ["missing", "ok", "error"]
    warns = _warns(caplog)
    assert warns[0].startswith("kma radar: binary tm=202609271225 — HTTP 500")  # 주기를 끝낸 오류
    assert warns[1:] == [  # 그 뒤 — 이 주기에 포기한 tm(더 새 파일 12:20 이 있다 — 한 tm)
        "kma radar: tm=202609271215 still unavailable after 3 tries — skipped: not gzip: '# file not exist (RDR_CMP_HSR_PUB_202609271215.bin.gz)'"
    ]
    assert job.missing is None


# ---- 긴 연속의 확인 간격(계약 v5 §G26 · ADR-011 개정 2026-09-30 저녁) ---------------------------------------------------------
# 운영 2026-09-30: 기상청이 08:15 KST 부터 모든 바이너리 합성(HSR · HSP · CMX · PPI · CPP PUB)에 'file not exist' 로 답했고 언제 돌아올지 알리지 않았다.
# 연속 동안에도 5분마다 목록 1 + 확인 2(+ 목록 ReadTimeout 다시 부르기)를 불러 18:34 KST 에 예산 417 / 1,000(09:00 KST 에 시작한 UTC 날) — 하루가
# 끝나기 전에 1,000 을 넘을 속도였다(시간당 약 44). 이제 연속의 나이(첫 tm 부터)가 MISSING_SLOW_AFTER_S(60분 — 선택값)를 넘으면 MISSING_SLOW_EVERY_S
# (15분 — 선택값)마다만 확인하고, 그 사이 주기는 기상청을 부르지 않고 실행 'waiting' 으로 남긴다. 파일이 다시 오면 다음 주기부터 전처럼 5분마다.
# 이 절의 시험은 고치기 전 코드에서 실패했다(모든 주기가 목록 1 + 확인 2 를 불렀다 · 해시에 확인 간격이 없었다 · 15분 넘게 멈췄다 다시 띄운 수집기는 연속을 버렸다).
def _used(ctx):
    async def used() -> int:
        return (await ctx.budget.usage("kma_radar"))[0] or 0

    return used


async def test_a_long_streak_is_probed_every_15_min_and_the_cycles_between_are_recorded_waiting(env, caplog):
    mod, r, ctx, clock, runs = env
    assert (mod.MISSING_SLOW_AFTER_S, mod.MISSING_SLOW_EVERY_S) == (60 * 60, 15 * 60)
    prov = OutageKma(clock, down_from="202609271215")
    job = await _steady(mod, ctx, clock, prov)
    await _cycles(job, clock, "202609271310")  # 연속은 12:25 에 열렸다 — 첫 tm 12:15 부터 55분: 아직 5분마다
    meta = await r.hgetall(mod.KEY_META)
    assert meta["missing_probe_every_s"] == "300"
    used = _used(ctx)
    runs.clear()
    caplog.clear()
    calls: list[tuple[str, int, list[str]]] = []
    for t in _tms("202609271410", "202609271315"):
        clock["now"] = t
        prov.binaries.clear()
        before = await used()
        await job.run_once()
        calls.append((t, await used() - before, list(prov.binaries)))
    probing = [t for t, n, _b in calls if n]
    assert probing == ["202609271325", "202609271340", "202609271355", "202609271410"]  # 13:10 의 확인 뒤 15분마다
    assert all(n == 3 and len(b) == 2 for _t, n, b in calls if n)  # 목록 1 + 확인 2 — 확인하는 주기는 전과 같다
    assert all(n == 0 and b == [] for _t, n, b in calls if not n)  # 그 사이 주기는 기상청을 부르지 않는다
    statuses = [run["status"] for run in runs]
    assert statuses == ["waiting", "waiting", "missing"] * 4
    waiting = [run for run in runs if run["status"] == "waiting"]
    assert all(run.get("http_status") is None and run.get("records_in") == 0 for run in waiting)
    assert waiting[0]["error_text"] == (
        "not called — probing every 15 min (chosen) while the KMA download has no file (since tm=202609271215, 1 h 0 min of tms); "
        "last probe 5 min before this cycle"
    )
    meta, prov_h = await r.hgetall(mod.KEY_META), await r.hgetall("wakeline:provider:kma_radar")
    assert meta["missing_probe_every_s"] == prov_h["missing_probe_every_s"] == "900"
    assert meta["missing_checked_at"] == "2026-09-27T05:10:00Z"  # 기다린 주기는 확인이 아니다
    switch = [m for m in _infos(caplog) if "probing every 15 min from now on" in m]
    assert switch == [
        "kma radar: the missing-file streak since tm=202609271215 has lasted 1 h 0 min of tms — probing every 15 min from now on "
        "(chosen, after 60 min); the 5 min cadence resumes when a file comes back"
    ]
    assert not [m for m in _warns(caplog) if "has no file from" in m]  # 새 연속이 아니다


@pytest.mark.parametrize(("poll", "every"), [(300, 900), (600, 1200), (400, 1200), (450, 900), (1800, 1800), (60, 900)])
def test_the_published_slow_interval_is_the_cadence_the_cycles_actually_reach(poll, every):
    """리뷰 2026-09-30 밤: 확인 간격은 max(900, 주기)로 알렸지만 기다림은 '마지막 확인 뒤 900 s 미만이면 기다린다'라 주기가 15분을 나누지 못하면(600 s)
    실제로는 1,200 s 마다 확인했다 — 웹은 '15분마다 확인', 예산 계산은 하루 96번. 알리는 값 = 실제 간격: 주기(쉼 ≥ 주기)를 거듭해 처음 900 s 이상이 되는 때."""
    from wakeline_collector.jobs import kma_radar as mod

    assert mod.slow_probe_every_s(poll) == every
    since = datetime(2026, 9, 27, 10, 0)
    assert mod.streak_probe_every_s("202609271000", since + timedelta(minutes=61), poll) == every
    t, probes = 0, [0]
    while t < 6 * 3600:  # 스케줄러: 실행 뒤 poll(+ 지터 ≥ 0)을 쉰다 — 지터 0 이 가장 이른 경우
        t += poll
        if t - probes[-1] >= every:  # _waiting 과 같은 비교(간격 미만이면 기다린다)
            probes.append(t)
    assert {b - a for a, b in zip(probes, probes[1:], strict=False)} == {every}


async def test_budget_arithmetic_of_a_streak_before_and_after_the_slow_cadence(env):
    """설정값 계산(잰 값이 아니다): 연속만 이어지는 UTC 하루의 정규 호출 = 확인하는 주기 수 × (목록 1 + 확인 ≤ 2). 다시 부르기(일시 오류 — 호출마다 한 번)는
    최악 두 배. 전: 5분마다 288 × 3 = 864(최악 1,728 — 한도 1,000 을 넘는다). 뒤: 60분 넘은 연속은 15분마다 96 × 3 = 288(최악 576).
    모의 하루(12:15 부터 파일 없음)로 같은 수를 센다 — 늦춘 뒤 한 시간마다 목록 1 + 확인 2 를 네 번(12)."""
    from wakeline_collector.config import Settings

    mod, r, ctx, clock, runs = env
    assert mod.STREAK_CALLS_PER_PROBE == 3
    assert mod.streak_calls_per_day(300, slow=False) == 864
    assert mod.streak_calls_per_day(300, slow=False, retries=True) == 1728 > Settings().budget_kma_radar
    assert mod.streak_calls_per_day(300, slow=True) == 288
    assert mod.streak_calls_per_day(300, slow=True, retries=True) == 576 < Settings().budget_kma_radar
    assert mod.streak_calls_per_day(1800, slow=True) == 48 * 3  # 주기가 15분보다 길면 주기마다(늦추지 않는다)
    assert mod.streak_calls_per_day(600, slow=True) == 72 * 3  # 15분을 나누지 못하는 주기 — 실제 간격 20분(아래 시험)
    prov = OutageKma(clock, down_from="202609271215")
    job = await _steady(mod, ctx, clock, prov)
    used = _used(ctx)
    per_hour: dict[str, int] = {}
    for t in _tms("202609272355", "202609271215"):
        clock["now"] = t
        before = await used()
        await job.run_once()
        per_hour[t[8:10]] = per_hour.get(t[8:10], 0) + await used() - before
    # 12:15 목록 1 + 새 tm 1 · 12:20 목록 1 + 2 · 12:25 목록 1 + 3(R-03 — 연속을 여는 주기) · 12:30–12:55 여섯 주기 × (목록 1 + 확인 2)
    assert per_hour["12"] == 2 + 3 + 4 + 6 * 3
    assert per_hour["13"] == 3 * 3 + 3 * 3  # 13:00–13:10 5분마다 · 13:15 부터 늦춤(13:25 · 13:40 · 13:55)
    assert {h: n for h, n in per_hour.items() if h >= "14"} == {f"{h:02d}": 12 for h in range(14, 24)}
    assert 24 * per_hour["14"] == mod.streak_calls_per_day(300, slow=True)


async def test_a_file_during_slow_probing_closes_the_streak_and_the_5_min_cadence_resumes(env, caplog):
    mod, r, ctx, clock, runs = env
    prov = OutageKma(clock, down_from="202609271215", up_from="202609271400")
    job = await _steady(mod, ctx, clock, prov)
    await _cycles(job, clock, "202609271405")  # 13:55 확인(없음) · 14:00 · 14:05 기다림
    assert job.missing is not None and runs[-1]["status"] == "waiting"
    clock["now"] = "202609271410"
    prov.binaries.clear()
    await job.run_once()  # 확인하는 주기 — 14:00 · 14:10 파일이 있다
    assert prov.binaries == ["202609271400", "202609271410"]
    assert job.missing is None and runs[-1]["status"] == "ok"
    back = [m for m in _infos(caplog) if "has the file again" in m]
    assert back and back[0].startswith(
        "kma radar: KMA download has the file again at tm=202609271400 — the gap from tm=202609271215 is 1 h 45 min"
    )
    assert (await r.hgetall(mod.KEY_META))["missing_probe_every_s"] == ""
    runs.clear()
    prov.binaries.clear()
    clock["now"] = "202609271415"
    await job.run_once()  # 다음 주기부터 전처럼 — 보관 창의 빈 tm 을 다시 시도한다
    assert [run["status"] for run in runs] != ["waiting"] and len(prov.binaries) == 4


async def test_a_restart_mid_streak_keeps_the_slow_cadence_its_first_tm_and_no_second_warning(env, caplog):
    """늦춘 뒤 마지막 확인은 15분까지 지날 수 있다 — 전의 이어받기 상한(15분 고정)이면 다시 띄운 수집기가 연속을 버리고 R-03 을 처음부터 해(주기마다
    목록 1 + 바이너리 4 를 세 주기) 나중 tm 에서 새 연속을 열었다(WARN 한 번 더 · 첫 tm 이 늦음 — 운영 로그의 'since tm=202609301310'). 이제 이어받는 상한 =
    확인 간격 × MISSING_STALE_PROBES(3 — 선택값, 전의 15분 = 5분 × 3 과 같은 규칙): 늦춘 연속은 45분. 이어받은 연속은 마지막 확인에서 15분을 센다."""
    mod, r, ctx, clock, runs = env
    assert (
        mod.MISSING_STALE_PROBES == 3 and mod.missing_carry_s(900) == 45 * 60 and mod.missing_carry_s(300) == mod.MISSING_CARRY_S
    )
    prov = OutageKma(clock, down_from="202609271215")
    job = await _steady(mod, ctx, clock, prov)
    await _cycles(job, clock, "202609271325")  # 13:25 에 확인(늦춘 뒤 첫 확인)
    assert (await r.hgetall(mod.KEY_META))["missing_checked_at"] == "2026-09-27T04:25:00Z"
    caplog.clear()
    runs.clear()
    again = mod.KmaRadarJob(prov, ctx)  # 13:35 에 다시 띄운 수집기
    clock["now"] = "202609271335"
    prov.binaries.clear()
    await again.run_once()
    assert again.missing is not None and again.missing.since_tm == "202609271215"
    assert prov.binaries == [] and [run["status"] for run in runs] == ["waiting"]  # 마지막 확인 뒤 10분 — 기다린다
    clock["now"] = "202609271340"
    await again.run_once()
    assert prov.binaries == ["202609271330", "202609271340"] and runs[-1]["status"] == "missing"
    assert not [m for m in _warns(caplog) if "has no file from" in m]
    # 30분 멈췄다 다시 띄움(13:40 확인 → 14:10): 상한 45분 안 — 이어받고 곧바로 확인한다
    third = mod.KmaRadarJob(prov, ctx)
    clock["now"] = "202609271410"
    prov.binaries.clear()
    await third.run_once()
    assert third.missing is not None and third.missing.since_tm == "202609271215" and len(prov.binaries) == 2
    # 50분 멈췄다 다시 띄움(14:10 확인 → 15:00): 상한 밖 — 옛 연속을 지금처럼 보이지 않게 버린다(전과 같은 규칙)
    fourth = mod.KmaRadarJob(prov, ctx)
    clock["now"] = "202609271500"
    await fourth.run_once()
    assert any(m.startswith("kma radar: dropped the missing-file streak since tm=202609271215") for m in _infos(caplog))
    assert fourth.missing is None


@pytest.mark.parametrize(("every", "carried"), [("900", True), ("99999999", False), ("x", False), ("", False)])
async def test_the_carry_bound_trusts_only_a_sane_probe_interval_from_redis(env, every, carried):
    """이어받기 상한은 앞 프로세스가 남긴 확인 간격 × 3 — 하루를 넘거나 수가 아닌 값(망가진 기록)은 믿지 않고 주기(5분 → 15분 상한)로 본다."""
    mod, r, ctx, clock, runs = env
    await r.hset(
        mod.KEY_META, mapping=_STREAK_IN_REDIS | {"missing_checked_at": "2026-09-27T01:40:00Z", "missing_probe_every_s": every}
    )
    job = mod.KmaRadarJob(OutageKma(clock, down_from="202609271015"), ctx)  # 기상청은 여전히 '파일 없음'
    clock["now"] = "202609271100"  # 마지막 확인(10:40 KST) 뒤 20분
    await job.run_once()
    assert (job.missing is not None) is carried
    assert (job.missing is not None and job.missing.since_tm == "202609271015") is carried  # 이어받았으면 첫 tm 그대로
