"""기상청 '파일 없음' 연속 중 목록도 자라지 않을 때(운영 2026-10-01 00:50 KST — 계약 v5 §G22 · §G26 개정).

운영에서 본 것: 연속(since tm 202609301310)이 늦춘 확인(15분마다) 중이었다. 기상청 목록은 tm=20260930 이 RDR_CMP_HSR_EXT_202609301950 에서 끝났고
tm=20261001 은 비었거나 HTTP 504 였다. 00:05 KST(자정 직후 창 — 전날 목록을 합친다)의 확인은 19:50 을 다시 확인해 '파일 없음'을 받았다. 00:20 · 00:35 ·
00:50 의 확인은 오늘 목록만 읽었고 거기에 tm 이 없어 확인할 tm 이 없었다 — 실행은 'ok' · http 200 · 오류 글자 없음, 공급자 last success 가 갱신됐고
(08:14 KST 뒤로 저장한 프레임이 없는데도), 연속의 마지막 확인(missing_checked_at)은 00:05 에 머물러 웹이 '확인 멈춤'(마지막 확인 > 확인 간격 × 3)을 잘못 붙였다.

고친 규칙(이 파일의 시험은 고치기 전 코드에서 실패했다):
- 연속 중 목록이 답한 확인 주기는 확인이다 — 확인할 tm 이 없어도 마지막 확인을 옮기고, 목록이 보인 것(가장 새 tm · 마지막 tm 뒤로 실은 tm 수)을 싣는다.
- 그 주기는 'ok' 가 아니다(저장한 프레임 없음 — 'missing', 오류 글자가 목록에 새 tm 이 없다고 적는다) · 공급자 성공으로 적지 않는다. 연속 밖에서는 전처럼 'ok'.
- 목록이 실패하면(504 · ReadTimeout) 실행 'error' 이고 마지막 확인 · 목록 필드는 그대로다(확인하지 않았다 — 그러면 '확인 멈춤'이 맞다).
- KST 자정을 넘어 새 날 목록이 비어 있는 동안 연속의 마지막 tm 이 전날이면 전날 목록도 읽는다(자정 직후 창 00:00–00:14 과 같은 전날 목록) —
  빈 새 날 목록을 '파일 없음'으로 세지 않고, 마지막 tm 뒤를 싣는 목록을 계속 확인한다. 그때 전날 목록은 덧붙이는 목록이 아니라 확인에 필요한
  목록이다 — 실패하면(504 · 시간 초과) 'error', 예산이 없으면 예산 상태이고 둘 다 마지막 확인 · 목록 필드를 옮기지 않는다(리뷰 2026-10-01 — 전에는
  오늘 목록만으로 이어가 확인할 tm 이 없는 'missing' · 마지막 확인을 옮겨 수집기가 몇 시간 동안 아무 tm 도 묻지 않았는데 '확인 멈춤'이 뜨지 않았다).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

import pytest
from test_kma_missing import KST, OutageKma, _infos, _warns, make_env

from wakeline_collector.models import ProviderResult


@pytest.fixture
def env(monkeypatch, caplog):
    return make_env(monkeypatch, caplog)


def _walk(since: str, until: str) -> list[str]:
    """since 부터 until 까지(둘 다 포함) 5분마다의 tm — 날을 넘는다."""
    t, end = datetime.strptime(since, "%Y%m%d%H%M"), datetime.strptime(until, "%Y%m%d%H%M")
    out: list[str] = []
    while t <= end:
        out.append(t.strftime("%Y%m%d%H%M"))
        t += timedelta(minutes=5)
    return out


def _day(day: str) -> list[str]:
    return _walk(f"{day}0000", f"{day}2355")


def _utc(tm: str) -> str:
    """KST 벽시계 tm → 그 순간의 UTC ISO(수집기 _iso 와 같은 모양)."""
    return (datetime.strptime(tm, "%Y%m%d%H%M") - KST).strftime("%Y-%m-%dT%H:%M:%SZ")


class StalledKma(OutageKma):
    """날마다 목록(tm=YYYYMMDD)을 싣는다 — 시계까지, 그리고 list_until 까지만(그 뒤로 기상청 목록이 자라지 않는다).
    내려받기는 [down_from, up_from) 에서 'file not exist'. fail[day] 가 있으면 그날 목록은 그 오류로 답한다(fail_once[day] 는 한 번만)."""

    def __init__(self, clock: dict, down_from: str, list_until: str, up_from: str | None = None):
        super().__init__(clock, down_from, up_from)
        self.list_until = list_until
        self.fail: dict[str, BaseException] = {}
        self.fail_once: dict[str, BaseException] = {}
        self.days: list[str] = []

    async def file_list(self, day):
        self.days.append(day)
        if day in self.fail:
            raise self.fail[day]
        if day in self.fail_once:
            raise self.fail_once.pop(day)
        top = min(self.clock["now"], self.list_until)
        tms = [t for t in _day(day) if t <= top]
        return ProviderResult(self.name, b"", datetime.now(UTC), 200, 5, data=tms, extra={"kinds": {t: ["EXT"] for t in tms}})


async def _run(job, clock, tms: list[str]) -> None:
    for t in tms:
        clock["now"] = t
        await job.run_once()


async def _stalled_streak(mod, ctx, clock):
    """운영 2026-09-30 → 10-01 의 모양: 11:00 부터 정상, 13:10 부터 내려받기 '파일 없음', 목록은 19:50 에서 멈춘다.
    연속은 13:20 에 열리고(13:10 이 세 번째) 14:10 부터 15분마다 확인한다(14:20 · 14:35 · 14:50 · 15:05 …)."""
    prov = StalledKma(clock, down_from="202609301310", list_until="202609301950")
    job = mod.KmaRadarJob(prov, ctx)
    await _run(job, clock, _walk("202609301100", "202609302355"))
    return prov, job


# ---- 운영 모양 그대로: 목록이 멈춘 뒤의 확인 · 자정 넘어 빈 새 날 목록 -----------------------------------------------------------
async def test_a_stalled_listing_during_the_streak_is_a_check_named_on_the_hash(env):
    mod, r, ctx, clock, runs = env
    prov, job = await _stalled_streak(mod, ctx, clock)
    assert job.missing is not None and job.missing.since_tm == "202609301310"
    meta = await r.hgetall(mod.KEY_META)
    # 23:50 의 확인: 목록의 가장 새 tm 은 19:50 = 마지막 tm — 목록도 그 뒤로 자라지 않았다(19:50 을 다시 확인해 '파일 없음')
    assert meta["missing_last_tm"] == "202609301950"
    assert meta["missing_checked_at"] == _utc("202609302350")
    assert (meta["missing_list_tm"], meta["missing_list_newer"]) == ("202609301950", "0")
    prov_h = await r.hgetall("wakeline:provider:kma_radar")
    assert (prov_h["missing_list_tm"], prov_h["missing_list_newer"]) == ("202609301950", "0")
    assert runs[-1]["status"] == "waiting"  # 23:55 — 기다린 주기
    probe = [run for run in runs if run["status"] == "missing"][-1]
    assert "the KMA listing has no tm after tm=202609301950 either (newest listed tm=202609301950" in probe["error_text"]


async def test_after_kst_midnight_an_empty_new_day_listing_still_checks_the_previous_day(env):
    """00:05(자정 직후 창)은 전날 목록을 합쳐 19:50 을 다시 확인한다. 00:20 · 00:35 · 00:50 — 전에는 오늘(빈) 목록만 읽어 확인할 tm 이 없었고 'ok' 였다.
    이제 연속의 마지막 tm 이 전날이고 새 날 목록이 아직 비었으면 전날 목록도 읽는다: 19:50 을 다시 확인하고('파일 없음' — 'missing'), 마지막 확인을 옮긴다."""
    mod, r, ctx, clock, runs = env
    prov, job = await _stalled_streak(mod, ctx, clock)
    before = await r.hgetall("wakeline:provider:kma_radar")
    used = lambda: ctx.budget.usage("kma_radar")  # noqa: E731
    runs.clear()
    for t in _walk("202610010000", "202610010050"):
        clock["now"] = t
        prov.days.clear()
        prov.binaries.clear()
        n0 = (await used())[0]
        await job.run_once()
        n = (await used())[0] - n0
        if t in ("202610010005", "202610010020", "202610010035", "202610010050"):  # 확인하는 주기(15분마다)
            assert sorted(prov.days) == ["20260930", "20261001"], t
            assert prov.binaries == ["202609301950"], t
            assert n == 3, t  # 오늘 목록 1 + 전날 목록 1 + 확인 1 — 늦춘 확인의 주기당 상한(STREAK_CALLS_PER_PROBE) 그대로
        else:
            assert prov.days == [] and prov.binaries == [] and n == 0, t
    statuses = [run["status"] for run in runs]
    assert statuses == [
        "waiting",
        "missing",
        "waiting",
        "waiting",
        "missing",
        "waiting",
        "waiting",
        "missing",
        "waiting",
        "waiting",
        "missing",
    ]
    meta = await r.hgetall(mod.KEY_META)
    assert meta["missing_checked_at"] == _utc("202610010050")  # 전에는 00:05(15:05Z)에 머물렀다
    assert (meta["missing_list_tm"], meta["missing_list_newer"]) == ("202609301950", "0")
    assert meta["missing_last_tm"] == "202609301950"  # 빈 새 날 목록을 '파일 없음' 으로 세지 않는다
    after = await r.hgetall("wakeline:provider:kma_radar")
    assert after["last_success_at"] == before["last_success_at"]  # 저장한 프레임이 없다 — 성공이 아니다


async def test_an_empty_listing_during_the_streak_says_nothing_is_listed_after_the_last_tm(env):
    """같은 날 목록이 빈 답(200)을 낸 확인: 마지막 tm 의 날을 읽었으니 '마지막 tm 뒤로 새 tm 없음'(0)은 안다 — 가장 새 tm 은 없다(빈 값)."""
    mod, r, ctx, clock, runs = env
    prov = StalledKma(clock, down_from="202609301310", list_until="202609301950")
    job = mod.KmaRadarJob(prov, ctx)
    await _run(job, clock, _walk("202609301100", "202609301400"))  # 13:20 에 연속 — 아직 5분마다
    assert job.missing is not None
    prov.list_until = "202609292355"  # 그날 목록이 빈 답을 낸다(기상청 쪽 — 모양만 재현)
    runs.clear()
    prov.binaries.clear()
    clock["now"] = "202609301405"
    await job.run_once()
    assert prov.binaries == [] and [run["status"] for run in runs] == ["missing"]
    assert runs[0]["error_text"].startswith(
        "no new frame stored — nothing to probe: the KMA listing has no tm after tm=202609301400 either (the listing 20260930 lists no tm); "
        "KMA download has no file since tm=202609301310"
    )
    meta = await r.hgetall(mod.KEY_META)
    assert meta["missing_checked_at"] == _utc("202609301405")
    assert (meta["missing_list_tm"], meta["missing_list_newer"]) == ("", "0")


async def test_a_streak_whose_last_tm_is_two_days_back_checks_both_read_listings_but_does_not_claim_nothing_newer(env):
    """수집기는 전날 · 오늘 목록만 읽는다. 연속의 마지막 tm(09-30 19:50)이 그저께가 된 10-02 00:20 — 두 목록이 모두 답했고(빈 답) 확인할 tm 이 없다:
    목록만 읽은 확인이다(마지막 확인을 옮기고 'missing') — 다만 읽은 목록이 마지막 tm 의 날을 덮지 못했으니 '마지막 tm 뒤로 새 tm 없음'은 모른다(빈 값)."""
    mod, r, ctx, clock, runs = env
    prov, job = await _stalled_streak(mod, ctx, clock)
    await _run(job, clock, _walk("202610010000", "202610020015"))
    runs.clear()
    prov.days.clear()
    prov.binaries.clear()
    clock["now"] = "202610020020"
    await job.run_once()
    assert sorted(prov.days) == ["20261001", "20261002"] and prov.binaries == []
    assert [run["status"] for run in runs] == ["missing"]
    assert runs[0]["error_text"].startswith(
        "no new frame stored — nothing to probe: the KMA listing 20261001+20261002 lists no tm "
        "(tm=202609301950 is on 20260930 — that listing was not read); KMA download has no file since tm=202609301310"
    )
    meta = await r.hgetall(mod.KEY_META)
    assert meta["missing_checked_at"] == _utc("202610020020")
    assert (meta["missing_list_tm"], meta["missing_list_newer"]) == ("", "")


# ---- 목록 실패는 확인이 아니다 --------------------------------------------------------------------------------------------------
def _list_errors():
    import httpx

    from wakeline_collector.http import ProviderHttpError

    return [ProviderHttpError(504, "Gateway Time-out"), httpx.ReadTimeout("read timed out")]


@pytest.mark.parametrize("error", _list_errors(), ids=lambda e: type(e).__name__)
async def test_a_failed_listing_is_an_error_run_and_does_not_move_the_last_check(env, monkeypatch, error):
    mod, r, ctx, clock, runs = env

    async def no_wait(_s):
        return None

    monkeypatch.setattr(mod, "_sleep", no_wait)
    prov, job = await _stalled_streak(mod, ctx, clock)
    await _run(job, clock, _walk("202610010000", "202610010015"))
    before = await r.hgetall(mod.KEY_META)
    assert before["missing_checked_at"] == _utc("202610010005")
    prov.fail["20261001"] = error  # 오늘(주) 목록이 실패 — 일시 오류면 한 번 다시 불러도 실패
    runs.clear()
    prov.binaries.clear()
    clock["now"] = "202610010020"
    await job.run_once()
    assert [run["status"] for run in runs] == ["error"] and prov.binaries == []
    after = await r.hgetall(mod.KEY_META)
    assert {k: after[k] for k in mod.MISSING_KEYS} == {k: before[k] for k in mod.MISSING_KEYS}  # 마지막 확인 · 목록 필드 그대로
    # 확인 간격은 목록을 부른 주기부터 센다(§G26 — 실패한 목록 포함) — 다음 확인은 00:35
    runs.clear()
    del prov.fail["20261001"]
    await _run(job, clock, ["202610010025", "202610010030", "202610010035"])
    assert [run["status"] for run in runs] == ["waiting", "waiting", "missing"]
    assert (await r.hgetall(mod.KEY_META))["missing_checked_at"] == _utc("202610010035")


@pytest.mark.parametrize("error", _list_errors(), ids=lambda e: type(e).__name__)
async def test_a_failed_previous_day_listing_the_streak_needs_is_an_error_run_and_moves_nothing(env, monkeypatch, caplog, error):
    """리뷰 2026-10-01(중간): 자정을 넘어 새 날 목록이 비었고 연속의 마지막 tm(19:50)이 전날이면 그 뒤를 싣는 목록은 전날 것이다 — 그 목록이
    504 · 시간 초과면 확인하지 못했다. 전에는 오늘(빈) 목록으로 이어가 확인할 tm 이 없는 'missing'(http 200)을 남기고 마지막 확인을 옮겼다:
    몇 시간 동안 기상청에 아무 tm 도 묻지 않았는데 '확인 멈춤'이 뜨지 않았고 공급자 last_error 도 비었다. 이제 오늘 목록이 실패한 주기와 같다 —
    실행 'error'(전날 목록 단계) · 공급자 오류 · WARN, 마지막 확인 · 목록 필드 · 마지막 tm 은 그대로(그러면 45분 뒤 '확인 멈춤'이 맞다)."""
    mod, r, ctx, clock, runs = env
    slept: list[float] = []

    async def no_wait(s):
        slept.append(s)

    monkeypatch.setattr(mod, "_sleep", no_wait)
    prov, job = await _stalled_streak(mod, ctx, clock)
    before = await r.hgetall(mod.KEY_META)
    before_prov = await r.hgetall("wakeline:provider:kma_radar")
    assert before["missing_checked_at"] == _utc("202609302350")
    prov.fail["20260930"] = error  # 자정 직후 창(00:05)부터 02:50 까지 전날 목록이 실패한다 — 새 날 목록은 빈 답(200)
    runs.clear()
    caplog.clear()
    prov.binaries.clear()
    prov.days.clear()
    await _run(job, clock, _walk("202610010000", "202610010250"))
    assert prov.binaries == []  # 확인할 tm 을 모른다 — 한 tm 도 묻지 않았다
    # 일시 오류(시간 초과)는 5 s 뒤 한 번 다시 부른다(확인에 필요한 전날 목록만 — 조사 F2), HTTP 오류(504)는 다시 부르지 않는다
    retried = getattr(error, "status", None) is None
    assert prov.days.count("20260930") == 12 * (2 if retried else 1) and slept == [5.0] * (12 if retried else 0)
    statuses = [run["status"] for run in runs]
    assert set(statuses) == {"waiting", "error"} and statuses.count("error") == 12  # 00:05 · 00:20 · … · 02:50(15분마다)
    errors = [run for run in runs if run["status"] == "error"]
    http = getattr(error, "status", None)
    assert all(run["http_status"] == http and "previous-day listing 20260930" in run["error_text"] for run in errors)
    assert all(("5 s 뒤 1회 재시도(첫 시도 ReadTimeout" in run["error_text"]) is retried for run in errors)
    after = await r.hgetall(mod.KEY_META)
    assert {k: after[k] for k in mod.MISSING_KEYS} == {k: before[k] for k in mod.MISSING_KEYS}  # 마지막 확인 23:50 그대로
    prov_h = await r.hgetall("wakeline:provider:kma_radar")
    assert prov_h["last_success_at"] == before_prov["last_success_at"]
    assert "previous-day listing 20260930" in prov_h["last_error"] and prov_h["consecutive_failures"] == "12"
    warns = [m for m in _warns(caplog) if "previous-day listing 20260930" in m]
    assert len(warns) == 12  # 오늘 목록의 실패와 같게 주기마다 WARN(확인이 멈췄다)
    # 전날 목록이 다시 답하면 다음 확인 주기(03:05)가 19:50 을 다시 확인한다 — 마지막 확인이 옮겨 가고 실행은 'missing'
    del prov.fail["20260930"]
    runs.clear()
    await _run(job, clock, _walk("202610010255", "202610010305"))
    assert [run["status"] for run in runs] == ["waiting", "waiting", "missing"] and prov.binaries == ["202609301950"]
    meta = await r.hgetall(mod.KEY_META)
    assert meta["missing_checked_at"] == _utc("202610010305")
    assert (meta["missing_list_tm"], meta["missing_list_newer"]) == ("202609301950", "0")


async def test_a_previous_day_listing_the_streak_needs_without_budget_is_a_budget_run_and_moves_nothing(env):
    """같은 경우 전날 목록의 예산 예약이 거절됐다: 전에는 확인할 tm 이 없는 'missing' · 마지막 확인을 옮겼다(오류 글자에 'budget exhausted').
    이제 확인이 아니다 — 실행은 예산 상태('budget_exhausted') 하나, 마지막 확인 · 목록 필드 그대로, 공급자 성공도 공급자 오류도 아니다."""
    from test_kma_missing import _refuse_after

    mod, r, ctx, clock, runs = env
    prov, job = await _stalled_streak(mod, ctx, clock)
    await _run(job, clock, _walk("202610010000", "202610010015"))  # 00:05 확인(창 — 전날 목록 합침)
    before = await r.hgetall(mod.KEY_META)
    before_prov = await r.hgetall("wakeline:provider:kma_radar")
    assert before["missing_checked_at"] == _utc("202610010005")
    _refuse_after(ctx, 1)  # 오늘 목록 1 만 — 전날 목록 예약부터 거절(한도 초과 1,000)
    runs.clear()
    prov.days.clear()
    prov.binaries.clear()
    clock["now"] = "202610010020"
    await job.run_once()
    assert prov.days == ["20261001"] and prov.binaries == []  # 전날 목록은 부르지 않았다
    assert [(run["status"], run.get("http_status")) for run in runs] == [("budget_exhausted", None)]
    assert runs[0]["error_text"].startswith("daily budget exhausted (used=1000) — previous-day listing 20260930 not read")
    after = await r.hgetall(mod.KEY_META)
    assert {k: after[k] for k in mod.MISSING_KEYS} == {k: before[k] for k in mod.MISSING_KEYS}
    prov_h = await r.hgetall("wakeline:provider:kma_radar")
    assert prov_h["last_success_at"] == before_prov["last_success_at"]
    assert prov_h.get("last_error", "") == before_prov.get("last_error", "")  # 예산은 공급자 오류가 아니다


# ---- 회복 · 연속 밖 · 여는 순간 · 이어받기 ---------------------------------------------------------------------------------------
async def test_the_streak_closes_when_the_listing_grows_again_with_a_file(env, caplog):
    mod, r, ctx, clock, runs = env
    prov, job = await _stalled_streak(mod, ctx, clock)
    await _run(job, clock, _walk("202610010000", "202610010040"))
    # 기상청이 돌아왔다(00:45 부터): 새 날 목록이 다시 자라고 새 날 파일을 내려받을 수 있다
    prov.list_until, prov.up_from = "209912312355", "202610010000"
    runs.clear()
    caplog.clear()
    await _run(job, clock, ["202610010045", "202610010050"])
    assert job.missing is None
    assert [run["status"] for run in runs] == ["waiting", "ok"]
    meta = await r.hgetall(mod.KEY_META)
    assert all(meta[k] == "" for k in mod.MISSING_KEYS)  # 목록 필드도 함께 지운다
    assert meta["latest_tm"] == "202610010050"
    # 00:50 의 확인: 목록의 가장 새 tm(00:50)과 10분 넘은 가장 새 tm(00:40) — 00:40 의 gzip 이 연속을 닫는다
    assert any("has the file again at tm=202610010040 — the gap from tm=202609301310" in m for m in _infos(caplog))


async def test_outside_a_streak_an_empty_new_day_listing_is_ok_and_opens_nothing(env):
    """연속이 없으면 전처럼: 자정 직후 창이 지나 새 날 목록이 비어 있어도 새로 받을 tm 이 없는 주기 — 'ok', 전날 목록은 읽지 않는다, 연속을 열지 않는다."""
    mod, r, ctx, clock, runs = env
    prov = StalledKma(clock, down_from="209912312355", list_until="202609302355")
    job = mod.KmaRadarJob(prov, ctx)
    await _run(job, clock, _walk("202609302300", "202610010030"))
    prov.days.clear()
    runs.clear()
    clock["now"] = "202610010035"
    await job.run_once()
    assert prov.days == ["20261001"] and prov.binaries[-1] == "202609302355"
    assert [run["status"] for run in runs] == ["ok"] and job.missing is None
    assert (await r.hgetall(mod.KEY_META)).get("missing_since_tm", "") == ""


async def test_a_restart_that_dropped_a_stale_streak_reopens_it_from_the_previous_day_listing(env, caplog):
    """운영 2026-10-01 02:07 KST(배포): 옛 판의 거짓 '확인 멈춤'으로 마지막 확인이 00:05 에 머문 연속을 다시 띄운 수집기가 버렸다(이어받기 상한 45분 밖).
    연속이 없으니 전날 목록을 읽지 않았고(자정 직후 창 밖), 빈 새 날 목록에는 확인할 tm 이 없어 주기마다 'ok' — 연속이 다시 열리지 않아 웹은
    '파일 없음' · '목록에도 … 없음'을 적지 못했다. 이제 연속이 없어도 새 날 목록에 아직 tm 이 없고 저장한 프레임이 전날 끝(23:55)에 닿지 않았으면
    전날 목록도 읽는다(덧붙이는 목록 — 자정 직후 창과 같다): 19:50 쪽 tm 을 받으려 하고, '파일 없음'이 세 번이면 연속이 다시 열린다."""
    mod, r, ctx, clock, runs = env
    prov, _ = await _stalled_streak(mod, ctx, clock)
    meta = await r.hgetall(mod.KEY_META)
    await r.hset(
        mod.KEY_META, mapping={"missing_checked_at": _utc("202610010005")}
    )  # 옛 판: 00:05 뒤로 마지막 확인이 움직이지 않았다
    again = mod.KmaRadarJob(prov, ctx)
    runs.clear()
    prov.days.clear()
    prov.binaries.clear()
    clock["now"] = "202610010205"
    await again.run_once()
    assert again.missing is None  # 마지막 확인 00:05 — 늦춘 연속의 이어받기 상한 45분 밖이라 버렸다
    assert "dropped the missing-file streak since tm=202609301310" in " ".join(_infos(caplog))
    assert sorted(prov.days) == ["20260930", "20261001"]  # 새 날 목록이 비었다 — 전날 목록도 읽는다
    assert prov.binaries and all(tm.startswith("20260930") and tm <= "202609301950" for tm in prov.binaries)
    await _run(again, clock, _walk("202610010210", "202610010225"))
    assert again.missing is not None and again.missing.last_tm == "202609301950"
    assert "ok" not in [run["status"] for run in runs]  # 저장한 프레임 없이 'ok' 로 끝난 주기가 없다
    clock["now"] = "202610010230"
    for t in _walk("202610010230", "202610010330"):
        clock["now"] = t
        await again.run_once()
    meta = await r.hgetall(mod.KEY_META)
    assert meta["missing_last_tm"] == "202609301950"
    assert (meta["missing_list_tm"], meta["missing_list_newer"]) == ("202609301950", "0")
    assert _utc("202610010230") <= meta["missing_checked_at"] <= _utc("202610010330")


# ---- 연속이 없을 때도 필요한 전날 목록(리뷰 2026-10-01 · 운영 02:23:54 KST) --------------------------------------------------------------
# 운영 02:23:54 KST: 연속이 없고(다시 띄운 수집기가 이어받기 상한 밖이라 버렸다) 프레임은 만료됐고 새 날 목록은 비었다 — 그 주기가 읽을 것은 전날 목록뿐인데
# 'previous-day listing 20260930 — ReadTimeout … — using today's only' WARN 뒤 실행은 'ok' · 공급자 성공(last_success_at · consecutive_failures 0)이었다.
# 기상청에 쓸 만한 것을 하나도 묻지 못한 주기가 §G22 가 없앤 모양('ok' + LAST SUCCESS · RECORDS 0)으로 남았다. 이제 그 전날 목록(_behind_prev_day)은 연속의
# 확인에 필요한 전날 목록과 같다 — 실패하면 'error', 예산이 없으면 예산 상태, 429 · 속도 상한이면 'throttled'(test_kma_throttle — 새 날 목록이 빈 경우).
# 자정 직후 창(00:00–00:14)의 전날 목록은 새 날 목록에 tm 이 있거나 저장한 프레임이 23:55 에 닿았으면 전처럼 덧붙이는 목록이다.
def _expire_frames(mod, r) -> None:
    """저장한 프레임을 모두 만료시킨다(영상 TTL 3 h — FakeRedis 는 실제 시계라 손으로)."""
    for k in [k for k in r.kv if k.startswith("wakeline:radar_kr:frame:")] + [mod.KEY_FRAMES]:
        r.expire_now(k)


async def _restarted_without_a_streak(mod, r, ctx, clock):
    """운영 02:18 KST 의 모양: 09-30 11:00–13:05 저장(공급자 성공) → 13:10 부터 '파일 없음' · 목록은 19:50 에서 멈춤 → 10-01 02:15 에 연속 없이 새 수집기,
    프레임은 만료됐다."""
    prov = StalledKma(clock, down_from="202609301310", list_until="202609301950")
    await _run(mod.KmaRadarJob(prov, ctx), clock, _walk("202609301100", "202609301305"))
    _expire_frames(mod, r)
    return prov, mod.KmaRadarJob(prov, ctx)


@pytest.mark.parametrize("error", _list_errors(), ids=lambda e: type(e).__name__)
async def test_without_a_streak_a_failed_previous_day_listing_the_cycle_needs_is_an_error_run(env, caplog, error):
    """고치기 전: 네 주기 모두 'ok' · 공급자 last_success_at 이 새로 적히고 consecutive_failures 0 · last_error 없음(WARN 'using today's only' 뿐)."""
    mod, r, ctx, clock, runs = env
    prov, job = await _restarted_without_a_streak(mod, r, ctx, clock)
    before = await r.hgetall("wakeline:provider:kma_radar")
    assert before["last_success_at"] and before.get("consecutive_failures", "0") == "0"
    prov.fail["20260930"] = error
    runs.clear()
    caplog.clear()
    prov.binaries.clear()
    prov.days.clear()
    await _run(job, clock, _walk("202610010215", "202610010230"))
    assert prov.binaries == []  # 받을 tm 을 모른다 — 한 tm 도 묻지 않았다
    assert (
        prov.days.count("20260930") == 4
    )  # 다시 부르지 않는다(새 날 목록이 하루 내내 빌 수 있다 — 5분마다 다시 부르면 최악 4 × 288 > 1,000)
    assert [run["status"] for run in runs] == ["error"] * 4
    http = getattr(error, "status", None)
    assert all(run["http_status"] == http and "previous-day listing 20260930" in run["error_text"] for run in runs)
    after = await r.hgetall("wakeline:provider:kma_radar")
    assert after["last_success_at"] == before["last_success_at"]  # 성공이 아니다
    assert after["consecutive_failures"] == "4" and "previous-day listing 20260930" in after["last_error"]
    assert len([m for m in _warns(caplog) if m.startswith("kma radar: previous-day listing 20260930 — ")]) == 4
    assert not [m for m in _warns(caplog) if "using today's only" in m]
    # 전날 목록이 다시 답하면 전처럼 전날 보관 창의 tm 을 받으려 하고(R-03), '파일 없음' 세 번이면 연속이 열린다 — 그동안 'ok' 는 없다
    del prov.fail["20260930"]
    runs.clear()
    await _run(job, clock, _walk("202610010235", "202610010245"))
    assert [run["status"] for run in runs] == ["missing"] * 3
    assert job.missing is not None and job.missing.last_tm == "202609301950"


async def test_without_a_streak_a_previous_day_listing_the_cycle_needs_without_budget_is_a_budget_run(env):
    """같은 모양에서 전날 목록의 예산 예약이 거절됐다. 고치기 전: INFO 'previous-day listing skipped' 뒤 'ok' · 공급자 성공."""
    from test_kma_missing import _refuse_after

    mod, r, ctx, clock, runs = env
    prov, job = await _restarted_without_a_streak(mod, r, ctx, clock)
    before = await r.hgetall("wakeline:provider:kma_radar")
    _refuse_after(ctx, 1)  # 오늘 목록 1 만 — 전날 목록 예약부터 거절
    runs.clear()
    prov.days.clear()
    prov.binaries.clear()
    clock["now"] = "202610010215"
    await job.run_once()
    assert prov.days == ["20261001"] and prov.binaries == []  # 전날 목록은 부르지 않았다
    assert [(run["status"], run.get("http_status")) for run in runs] == [("budget_exhausted", None)]
    assert runs[0]["error_text"] == (
        "daily budget exhausted (used=1000) — previous-day listing 20260930 not read: the listing 20261001 lists no tm yet and "
        "no stored frame reaches tm=202609302355 (newest stored tm=202609301305) — nothing else to fetch this cycle"
    )
    after = await r.hgetall("wakeline:provider:kma_radar")
    assert after["last_success_at"] == before["last_success_at"]
    assert after.get("last_error", "") == before.get("last_error", "")  # 예산은 공급자 오류가 아니다


@pytest.mark.parametrize("stored_2355", [True, False])
async def test_a_failed_previous_day_listing_at_kst_midnight_is_additive_only_with_something_else(env, caplog, stored_2355):
    """00:02 KST · 새 날 목록은 아직 빈 답 · 전날 목록이 ReadTimeout. 23:55 까지 저장했으면 전날 목록은 덧붙이는 목록이다 — WARN 한 줄 · 'ok'(새로 받을
    것이 없다). 23:55 를 아직 받지 못했으면(목록이 23:57 에야 실었다) 그 주기가 읽을 것은 전날 목록뿐이다 — 'error'(고치기 전: 'ok' · 공급자 성공)."""
    import httpx

    mod, r, ctx, clock, runs = env
    prov = StalledKma(clock, down_from="209912312355", list_until="202609302355")
    job = mod.KmaRadarJob(prov, ctx)
    await _run(job, clock, _walk("202609302300", "202609302355" if stored_2355 else "202609302350"))
    assert ("202609302355" in prov.binaries) is stored_2355
    prov.fail["20260930"] = httpx.ReadTimeout("read timed out")
    runs.clear()
    caplog.clear()
    prov.days.clear()
    clock["now"] = "202610010002"
    await job.run_once()
    assert sorted(prov.days) == ["20260930", "20261001"]  # 전날 목록은 한 번(다시 부르지 않는다)
    if stored_2355:
        assert [run["status"] for run in runs] == ["ok"]
        assert [m for m in _warns(caplog) if "previous-day listing 20260930" in m and "using today's only" in m]
    else:
        assert [run["status"] for run in runs] == ["error"] and "previous-day listing 20260930" in runs[0]["error_text"]
        assert (await r.hgetall("wakeline:provider:kma_radar"))["consecutive_failures"] == "1"


async def test_a_restart_past_the_carry_bound_in_a_previous_day_listing_outage_is_error_and_clears_the_streak(env, caplog):
    """리뷰 2026-10-01(도전): 연속이 전날 목록 장애 중(00:05 부터)이고 수집기가 01:00 에 다시 떴다 — 마지막 확인 23:50 뒤 70분이라 이어받기 상한(45분) 밖으로
    버린다. 고치기 전: 01:00–02:00 이 모두 'ok'(13번) · consecutive_failures 0 · 연속은 'ok' 주기의 발행으로 지워졌다. 'error' 만 고치면 발행이 없는
    주기라 버린 연속이 두 해시에 남아 웹이 이 프로세스가 더는 다루지 않는 연속을 '파일 없음 · 확인 멈춤'으로 적는다. 이제 'error' 이고, 버린 연속은
    그 주기에 지운다(발행 — 주기가 어떻게 끝나든)."""
    mod, r, ctx, clock, runs = env
    prov, job = await _stalled_streak(mod, ctx, clock)
    # 00:05 확인부터 전날 목록이 실패한다(일시 오류 RETRY_ERRORS 가 아닌 종류 — 다시 부르지 않는다)
    prov.fail["20260930"] = TimeoutError("read timed out")
    await _run(job, clock, _walk("202610010000", "202610010055"))
    meta = await r.hgetall(mod.KEY_META)
    assert meta["missing_since_tm"] == "202609301310" and meta["missing_checked_at"] == _utc("202609302350")
    before = await r.hgetall("wakeline:provider:kma_radar")
    again = mod.KmaRadarJob(prov, ctx)  # 01:00 에 다시 띄운 수집기
    runs.clear()
    caplog.clear()
    await _run(again, clock, _walk("202610010100", "202610010200"))
    assert again.missing is None and "dropped the missing-file streak since tm=202609301310" in " ".join(_infos(caplog))
    assert [run["status"] for run in runs] == ["error"] * 13
    after = await r.hgetall("wakeline:provider:kma_radar")
    assert after["last_success_at"] == before["last_success_at"]
    assert int(after["consecutive_failures"]) == int(before["consecutive_failures"]) + 13
    meta = await r.hgetall(mod.KEY_META)
    assert all(meta[k] == "" for k in mod.MISSING_KEYS) and all(after[k] == "" for k in mod.MISSING_KEYS)


async def test_outside_a_streak_frames_up_to_the_previous_day_end_read_only_the_new_day_listing(env):
    """덧붙이는 전날 목록은 저장한 프레임이 전날 끝(23:55)에 닿지 않았을 때만 — 받은 프레임이 이미 23:55 까지면 전날 목록에 새로 받을 것이 없다
    (새 날 목록이 하루 내내 비어 있어도 5분마다 목록 호출을 하나 더 쓰지 않는다)."""
    mod, r, ctx, clock, runs = env
    prov = StalledKma(clock, down_from="209912312355", list_until="202609302355")
    job = mod.KmaRadarJob(prov, ctx)
    await _run(job, clock, _walk("202609302300", "202610010030"))
    for t in _walk("202610010035", "202610010300"):
        clock["now"] = t
        prov.days.clear()
        await job.run_once()
        assert prov.days == ["20261001"], t


async def test_the_cycle_that_opens_the_streak_leaves_the_listing_fields_unknown(env):
    """연속을 여는 주기는 '확인 전 마지막 tm' 이 없다 — 목록 필드는 첫 확인이 채운다(그 전에는 빈 값 — 웹은 '목록에도 … 없음'을 적지 않는다)."""
    mod, r, ctx, clock, runs = env
    prov = StalledKma(clock, down_from="202609301310", list_until="209912312355")
    job = mod.KmaRadarJob(prov, ctx)
    await _run(job, clock, _walk("202609301100", "202609301320"))
    meta = await r.hgetall(mod.KEY_META)
    assert meta["missing_since_tm"] == "202609301310"
    assert (meta["missing_list_tm"], meta["missing_list_newer"]) == ("", "")
    clock["now"] = "202609301325"
    await job.run_once()  # 첫 확인 — 목록은 13:25 까지 자랐다(마지막 tm 13:20 뒤로 하나)
    meta = await r.hgetall(mod.KEY_META)
    assert (meta["missing_list_tm"], meta["missing_list_newer"]) == ("202609301325", "1")


async def test_a_restart_during_a_stalled_listing_carries_the_listing_fields(env):
    mod, r, ctx, clock, runs = env
    prov, job = await _stalled_streak(mod, ctx, clock)
    again = mod.KmaRadarJob(prov, ctx)  # 00:00 에 다시 띄운 수집기(마지막 확인 23:50 — 늦춘 연속의 이어받기 상한 45분 안)
    clock["now"] = "202610010000"
    await again.run_once()
    assert again.missing is not None
    assert (again.missing.list_tm, again.missing.list_newer) == ("202609301950", 0)
    meta = await r.hgetall(mod.KEY_META)
    assert (meta["missing_list_tm"], meta["missing_list_newer"]) == ("202609301950", "0")


async def test_the_hourly_reminder_says_the_listing_has_nothing_new_either(env, caplog):
    """목록이 자라는 동안(19:50 확인까지 — 확인 전 마지막 tm 뒤로 새 tm 이 있었다)의 알림은 목록을 말하지 않고, 목록이 멈춘 뒤(20:05 확인부터)의 알림은
    모두 그 까닭도 적는다."""
    mod, r, ctx, clock, runs = env
    caplog.set_level(logging.INFO, logger="job.kma_radar")
    prov = StalledKma(clock, down_from="202609301310", list_until="202609301950")
    job = mod.KmaRadarJob(prov, ctx)

    def reminders() -> list[str]:
        return [m for m in _warns(caplog) if m.startswith("kma radar: KMA download still has no file")]

    await _run(job, clock, _walk("202609301100", "202609302000"))
    growing = reminders()
    assert growing and not [m for m in growing if "listing" in m]
    caplog.clear()
    await _run(job, clock, _walk("202609302005", "202609302355"))
    stalled = reminders()
    idle = "; the KMA listing has no tm after tm=202609301950 either (newest listed tm=202609301950)"
    assert stalled and all(m.endswith(idle) for m in stalled)


# ---- 전날 목록 다시 부르기 · 잴 수 있게(조사 F2 · 도전 — 레인 kma 7차) -------------------------------------------------------------------
# 연속의 확인에 필요한 전날 목록은 _call(retry.call_retry_once)로 부른다 — 일시 오류면 5 s 뒤 한 번(예산 1 따로 · 보내지 않은 시도는 돌려준다), HTTP 오류 ·
# 429 · 속도 상한은 다시 부르지 않는다. 전에는 같은 주기의 오늘 목록(빈 답)만 다시 부르고 확인할 tm 을 싣는 전날 목록은 부르지 않아, 한 번 멈추면 확인 하나
# (15분)를 잃었다. 새 날 목록이 빈 주기(_behind_prev_day)와 자정 직후 창의 전날 목록은 다시 부르지 않는다. 전날 목록을 읽을 때마다 INFO 한 줄(날 · tm 수 · ms) —
# 실행 기록의 latency_ms 는 오늘 목록만이라 전에는 전날 목록이 얼마나 걸렸는지 성공한 호출에서는 어디에도 남지 않았다.
def _no_wait(monkeypatch, mod) -> list[float]:
    slept: list[float] = []

    async def no_wait(s):
        slept.append(s)

    monkeypatch.setattr(mod, "_sleep", no_wait)
    return slept


def _read_lines(caplog, day: str) -> list[str]:
    return [m for m in _infos(caplog) if m.startswith(f"kma radar: previous-day listing {day} read ")]


async def _at_the_0020_check(mod, r, ctx, clock):
    """운영 모양 그대로 00:05 확인까지 — 다음 확인은 00:20(새 날 목록은 빈 답 · 연속의 마지막 tm 19:50 은 전날)."""
    prov, job = await _stalled_streak(mod, ctx, clock)
    await _run(job, clock, _walk("202610010000", "202610010015"))
    assert (await r.hgetall(mod.KEY_META))["missing_checked_at"] == _utc("202610010005")
    prov.days.clear()
    prov.binaries.clear()
    clock["now"] = "202610010020"
    return prov, job


async def test_the_previous_day_listing_a_streak_check_needs_is_retried_once_after_a_timeout(env, monkeypatch, caplog):
    """고치기 전: 'error'(전날 목록 ReadTimeout) · 마지막 확인 그대로 — 다음 확인은 15분 뒤였다."""
    import httpx

    mod, r, ctx, clock, runs = env
    slept = _no_wait(monkeypatch, mod)
    prov, job = await _at_the_0020_check(mod, r, ctx, clock)
    prov.fail_once["20260930"] = httpx.ReadTimeout("read timed out")
    used = (await ctx.budget.usage("kma_radar"))[0]
    runs.clear()
    caplog.clear()
    await job.run_once()
    assert prov.days == ["20261001", "20260930", "20260930"] and slept == [5.0]
    assert [run["status"] for run in runs] == ["missing"] and prov.binaries == ["202609301950"]
    assert (await ctx.budget.usage("kma_radar"))[0] - used == 3 + 1  # 오늘 목록 + 전날 목록 + 확인 + 다시 부르기 1
    meta = await r.hgetall(mod.KEY_META)
    assert meta["missing_checked_at"] == _utc("202610010020")
    assert (meta["missing_list_tm"], meta["missing_list_newer"]) == ("202609301950", "0")
    assert any(
        m.startswith("kma radar: previous-day listing 20260930 — ReadTimeout") and m.endswith("retrying once in 5 s")
        for m in _infos(caplog)
    )
    lines = _read_lines(caplog, "20260930")
    assert len(lines) == 1 and lines[0].startswith(
        "kma radar: previous-day listing 20260930 read for the streak check — 239 tms, HTTP 5 ms, step "
    )
    assert lines[0].endswith(" ms (host-bucket wait and any retry included)")
    assert not [m for m in _warns(caplog) if "previous-day listing" in m]  # 다시 불러 읽었다 — 실패가 아니다


async def test_a_refused_retry_reservation_leaves_the_streak_check_an_error_run(env, monkeypatch, caplog):
    import httpx
    from test_kma_missing import _refuse_after

    mod, r, ctx, clock, runs = env
    slept = _no_wait(monkeypatch, mod)
    prov, job = await _at_the_0020_check(mod, r, ctx, clock)
    prov.fail_once["20260930"] = httpx.ReadTimeout("read timed out")
    _refuse_after(ctx, 2)  # 오늘 목록 · 전날 목록 첫 시도까지 — 다시 부르기 예약부터 거절
    runs.clear()
    caplog.clear()
    await job.run_once()
    assert prov.days == ["20261001", "20260930"] and slept == [] and prov.binaries == []
    assert [run["status"] for run in runs] == ["error"] and "previous-day listing 20260930" in runs[0]["error_text"]
    assert any(
        "previous-day listing 20260930 — ReadTimeout" in m and "not retried (budget exhausted (used=1000))" in m
        for m in _infos(caplog)
    )
    assert (await r.hgetall(mod.KEY_META))["missing_checked_at"] == _utc("202610010005")  # 확인이 아니다


async def test_a_429_on_the_previous_day_listing_a_streak_check_needs_is_not_retried(env, monkeypatch):
    from wakeline_collector.http import ProviderHttpError

    mod, r, ctx, clock, runs = env
    slept = _no_wait(monkeypatch, mod)
    prov, job = await _at_the_0020_check(mod, r, ctx, clock)
    prov.fail_once["20260930"] = ProviderHttpError(429, "too many", pause_s=30.0)
    runs.clear()
    await job.run_once()
    assert prov.days == ["20261001", "20260930"] and slept == [] and prov.binaries == []
    assert [(run["status"], run["http_status"]) for run in runs] == [("throttled", 429)]
    assert (await r.hgetall(mod.KEY_META))["missing_checked_at"] == _utc("202610010005")


async def test_every_previous_day_listing_read_is_one_info_line_with_its_day_tm_count_and_time(env, caplog):
    """자정 직후 창(덧붙이는 목록) · 새 날 목록이 빈 주기 · 연속의 확인 — 셋 다 읽을 때마다 한 줄(성공도). WARN 이 아니다(로그 화면을 채우지 않는다)."""
    mod, r, ctx, clock, runs = env
    prov = StalledKma(clock, down_from="209912312355", list_until="209912312355")
    job = mod.KmaRadarJob(prov, ctx)
    await _run(job, clock, _walk("202609302300", "202609302355"))
    caplog.clear()
    await _run(job, clock, ["202610010005"])  # 새 날 목록에 00:00 · 00:05 — 자정 직후 창
    assert [m.split(" — ")[0] for m in _read_lines(caplog, "20260930")] == [
        "kma radar: previous-day listing 20260930 read for the KST 00:00–00:14 window"
    ]
    _expire_frames(mod, r)  # 다른 수집기 · 다른 날(아래) — 위 주기가 남긴 프레임 · meta latest_tm(00:05)을 이어받지 않는다
    await r.delete(mod.KEY_META)
    prov2, job2 = await _restarted_without_a_streak(mod, r, ctx, clock)
    caplog.clear()
    await _run(job2, clock, ["202610010215"])
    assert [m.split(" — ")[0] for m in _read_lines(caplog, "20260930")] == [
        "kma radar: previous-day listing 20260930 read for frames short of the previous day's end"
    ]
    assert "— 239 tms, HTTP 5 ms, step " in _read_lines(caplog, "20260930")[0]


async def test_a_utc_day_of_slow_streak_checks_where_every_first_attempt_times_out_stays_within_the_bound(env, monkeypatch):
    """설정값 계산의 최악(호출마다 첫 시도가 시간 초과 · 다시 부른 시도는 답한다)을 UTC 하루(KST 09:00 → 다음 날 09:00 — KST 자정을 넘는다)로 센다: 연속만
    이어지고 KST 자정 뒤 새 날 목록이 빈 날. 확인하는 주기는 (목록 1 + 확인 ≤ 2) 또는 자정 뒤 (오늘 목록 1 + 전날 목록 1 + 확인 1) — 모두 다시 부른다(× 2).
    자정 직후 창(00:00–00:14)의 확인 주기 하나는 목록 2 + 확인 2 일 수 있다(+1). streak_calls_per_day(300, slow=True, retries=True) = (96 × 3 + 1) × 2 = 578 < 1,000."""
    import httpx

    mod, r, ctx, clock, runs = env
    _no_wait(monkeypatch, mod)

    class FirstAttemptTimesOut(StalledKma):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self.pending: set[tuple[str, str]] = set()

        def _first(self, key: tuple[str, str]) -> bool:
            if key in self.pending:
                self.pending.discard(key)
                return False
            self.pending.add(key)
            return True

        async def file_list(self, day):
            if self._first(("list", day)):
                self.days.append(day)
                raise httpx.ReadTimeout("read timed out")
            return await super().file_list(day)

        async def binary(self, tm):
            if self._first(("bin", tm)):
                self.binaries.append(tm)
                raise httpx.ReadTimeout("read timed out")
            return await super().binary(tm)

    prov = FirstAttemptTimesOut(clock, down_from="202609300700", list_until="202609302355")
    job = mod.KmaRadarJob(prov, ctx)
    await _run(
        job, clock, _walk("202609300600", "202609300855")
    )  # 07:00 부터 '파일 없음' — 연속은 07:10 에 열리고 08:00 부터 15분마다
    assert job.missing is not None and job.missing.every_s == 900
    before = (await ctx.budget.usage("kma_radar"))[0]
    checks_after_midnight = 0
    for t in _walk("202609300900", "202610010855"):  # UTC 2026-09-30 하루
        clock["now"] = t
        prov.days.clear()
        runs.clear()
        await job.run_once()
        if t >= "202610010000" and [run["status"] for run in runs] == ["missing"]:
            checks_after_midnight += 1
            assert prov.days.count("20260930") == 2, t  # 확인에 필요한 전날 목록 — 첫 시도 시간 초과 뒤 다시 불러 읽었다
    used = (await ctx.budget.usage("kma_radar"))[0] - before
    assert mod.streak_calls_per_day(300, slow=True, retries=True) == (96 * 3 + 1) * 2 == 578
    assert used <= 578 < 1000
    assert checks_after_midnight == 36  # 00:00–08:45 KST 15분마다 — 한 번도 잃지 않았다


# ---- 목록이 멈췄는데 파일은 있을 때 — 옛 tm 을 새것처럼 보이지 않는다(도전 'missed' 2026-10-01 — 레인 kma 7차) --------------------------------
# 도전이 본 것(고치기 전 코드, scratch): 목록이 19:50 에서 멈추고 파일은 받을 수 있는 동안 영상(TTL 3 h)이 만료되면 select_candidates 가 보관 창(목록의 최신 12개)의
# 옛 tm 을 다시 골라 받고, _store 가 meta fetched_at(= latest_tm 을 처음 저장한 시각 — api meta.stale · 웹 KMA STALE 의 시계, lib/format isKrRadarStale)을 지금으로
# 옮겼다: 19:50 프레임이 3 h 넘게 지났는데 STALE 이 15분 동안 사라지고, 실행은 'ok' · 기록 수 > 0 · 공급자 성공. 3 h 마다 되풀이(목록이 멈춘 동안 끝없이).
def _track_images(mod, r, stored_at: dict[str, str], gone: set[str], now: str) -> None:
    """영상 키가 새로 생기면(처음 · 다시 받음) 그 시각을 적는다 — FakeRedis 의 TTL 은 실제 시계라 가짜 시계로 만료를 흉내 낸다."""
    for k in [k for k in r.kv if k.startswith("wakeline:radar_kr:frame:")]:
        tm = k.rsplit(":", 1)[1]
        if tm not in stored_at or tm in gone:
            stored_at[tm] = now
            gone.discard(tm)


def _expire_due(mod, r, stored_at: dict[str, str], gone: set[str], now: str) -> None:
    for tm, at in stored_at.items():
        if (
            tm not in gone
            and (datetime.strptime(now, "%Y%m%d%H%M") - datetime.strptime(at, "%Y%m%d%H%M")).total_seconds() >= mod.FRAME_TTL_S
        ):
            r.expire_now(mod.KEY_FRAME.format(tm=tm))
            gone.add(tm)


async def test_a_stalled_listing_with_files_present_never_re_downloads_expired_frames_nor_refreshes_the_stale_clock(env):
    """고치기 전: 21:55 부터 만료된 옛 tm(18:55 …)을 하나씩 다시 받았고, 22:50 에 19:50 을 다시 받아 meta fetched_at 이 지금이 됐다(STALE 이 사라짐) —
    자정 뒤에는 새 날 목록이 빈 주기의 전날 목록으로 같은 12개를 또 받았다."""
    mod, r, ctx, clock, runs = env
    prov = StalledKma(clock, down_from="209912312355", list_until="202609301950")  # 파일은 늘 있다 — 목록만 19:50 에서 멈춘다
    job = mod.KmaRadarJob(prov, ctx)
    stored_at: dict[str, str] = {}
    gone: set[str] = set()
    for t in _walk("202609301700", "202609301950"):
        clock["now"] = t
        await job.run_once()
        _track_images(mod, r, stored_at, gone, t)
    first = await r.hgetall(mod.KEY_META)
    assert first["latest_tm"] == "202609301950" and first["available"] == "1"
    prov.binaries.clear()
    runs.clear()
    for t in _walk("202609301955", "202610010300"):
        clock["now"] = t
        _expire_due(mod, r, stored_at, gone, t)
        await job.run_once()
        _track_images(mod, r, stored_at, gone, t)
    assert prov.binaries == []  # 영상 보관(3 h)보다 오래된, 이미 받았던 tm 은 다시 받지 않는다
    meta = await r.hgetall(mod.KEY_META)
    assert (
        meta["fetched_at"] == first["fetched_at"]
    )  # STALE 시계는 19:50 을 처음 저장한 때 그대로 — api meta.stale · 웹 STALE 이 뜬다
    assert meta["latest_tm"] == "202609301950" and meta["available"] == "0"  # 옛 프레임은 모두 만료됐다(보이지 않는다)
    assert {run["records_in"] for run in runs} == {0}


async def test_re_storing_the_latest_tm_does_not_move_the_stale_clock(env):
    """보관 창 안(3 h 안)의 최신 tm 영상이 사라져(Redis 가 잃었다 등) 다시 받아도 새 프레임이 아니다 — meta fetched_at(STALE 시계)은 그 tm 을 처음 저장한
    때 그대로다. 고치기 전: 다시 받은 시각으로 옮겨 새 tm 이 오지 않는 동안에도 STALE 이 늦어졌다."""
    mod, r, ctx, clock, runs = env
    prov = StalledKma(clock, down_from="209912312355", list_until="202609302000")
    job = mod.KmaRadarJob(prov, ctx)
    await _run(job, clock, _walk("202609301900", "202609302000"))
    first = await r.hgetall(mod.KEY_META)
    assert first["latest_tm"] == "202609302000"
    r.expire_now(mod.KEY_FRAME.format(tm="202609302000"))
    prov.binaries.clear()
    await _run(job, clock, ["202609302005"])
    assert prov.binaries == ["202609302000"]  # 보관 창 안이라 다시 받는다(영상이 없다)
    meta = await r.hgetall(mod.KEY_META)
    assert meta["latest_tm"] == "202609302000" and meta["available"] == "1"
    assert meta["fetched_at"] == first["fetched_at"]


async def test_a_file_back_for_a_tm_older_than_the_image_retention_closes_the_streak_but_is_not_shown(env, caplog):
    """'파일 없음' 연속(13:10 부터) 중 목록은 19:50 에서 멈췄다. 01:00 에 기상청 내려받기가 돌아왔는데 목록은 그대로다 — 다음 확인이 19:50(5 h 넘게 지남)의
    gzip 을 받는다. 파일이 돌아왔으니 연속은 닫지만, 영상 보관(3 h)보다 오래된 tm 은 저장하지 않는다(보이지 않는다 — meta latest_tm · fetched_at 그대로, STALE).
    고치기 전: 19:50 을 새 latest_tm 으로 저장하고 fetched_at 을 지금으로 옮겨 5 h 지난 영상이 15분 동안 STALE 없이 보였다. 그 뒤로 옛 tm 을 더 받지 않는다."""
    mod, r, ctx, clock, runs = env
    prov, job = await _stalled_streak(mod, ctx, clock)
    await _run(job, clock, _walk("202610010000", "202610010055"))
    _expire_frames(mod, r)  # 11:00–13:05 프레임은 벌써 만료됐다(가짜 시계)
    before = await r.hgetall(mod.KEY_META)
    assert before["latest_tm"] == "202609301305"
    prov.down_from = "209912312355"  # 내려받기가 돌아왔다 — 목록은 여전히 19:50 에서 멈춤
    prov.binaries.clear()
    runs.clear()
    caplog.clear()
    await _run(job, clock, _walk("202610010100", "202610010200"))
    assert job.missing is None
    assert prov.binaries == ["202609301950"]  # 확인 한 번 — 그 뒤 옛 tm 을 더 받지 않는다
    meta = await r.hgetall(mod.KEY_META)
    assert (meta["latest_tm"], meta["fetched_at"]) == (before["latest_tm"], before["fetched_at"])
    assert meta["available"] == "0" and all(meta[k] == "" for k in mod.MISSING_KEYS)
    assert any("tm=202609301950 has a file but is older than the 3 h image retention — not stored" in m for m in _infos(caplog))


# ---- 전날 끝까지 받은 뒤 프레임이 만료돼도 전날 목록은 필요한 목록이 아니다(리뷰 2026-10-01 · 레인 kma 8차) -----------------------------------------
# 리뷰가 본 것(레인 7차 코드): _behind_prev_day 가 '전날 끝(23:55)에 닿았는가'를 Redis 에 남은 프레임(have — 3 h 뒤 만료)으로만 보았다. 옛 tm 을 다시 받지 않게
# 고친 뒤로는 만료된 프레임이 다시 채워지지 않아, 새 날 목록이 빈 채로 03:00 이 지나면 주기마다 전날 목록을 '필요한 목록'으로 읽었다 — 그 목록이 싣는 tm 은 모두
# latest_tm(23:55) 이하 · 3 h 넘은 tm 이라 받을 것이 없는데도, 그 목록이 한 번 멈추면 'error'(공급자 실패 · WARN) 였다.
async def test_frames_expired_after_reaching_the_previous_day_end_never_make_the_previous_day_listing_required(env, caplog):
    """전날 22:00–23:55 저장 · 목록은 23:55 에서 끝나고 새 날 목록은 빈 답 · 파일은 있다. 영상은 저장 3 h 뒤 만료(가짜 시계). 00:15 뒤 전날 목록은 늘
    ReadTimeout — 고치기 전: 02:55 부터 주기마다 전날 목록을 읽고(필요한 목록) 모두 'error'. 이제 전날 끝까지 받았으니(meta latest_tm 23:55) 오늘 목록만 읽는다."""
    import httpx

    mod, r, ctx, clock, runs = env
    prov = StalledKma(clock, down_from="209912312355", list_until="202609302355")
    job = mod.KmaRadarJob(prov, ctx)
    stored_at: dict[str, str] = {}
    gone: set[str] = set()
    for t in _walk("202609302200", "202609302355"):
        clock["now"] = t
        await job.run_once()
        _track_images(mod, r, stored_at, gone, t)
    assert (await r.hget(mod.KEY_META, "latest_tm")) == "202609302355"
    runs.clear()
    caplog.clear()
    reads: dict[str, list[str]] = {}
    for t in _walk("202610010000", "202610010600"):
        clock["now"] = t
        _expire_due(mod, r, stored_at, gone, t)
        if t >= "202610010015":
            prov.fail["20260930"] = httpx.ReadTimeout("read timed out")
        prov.days.clear()
        await job.run_once()
        _track_images(mod, r, stored_at, gone, t)
        reads[t] = list(prov.days)
    assert (await r.hget(mod.KEY_META, "available")) == "0"  # 전날 프레임은 모두 만료됐다
    assert {t: d for t, d in reads.items() if t >= "202610010015" and d != ["20261001"]} == {}  # 전날 목록을 읽지 않는다
    assert "error" not in [run["status"] for run in runs]
    assert not [m for m in _warns(caplog) if "previous-day listing" in m]
    assert prov.binaries[-1] == "202609302355"  # 옛 tm 을 다시 받지 않았다
