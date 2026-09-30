"""기상청 '파일 없음' 연속 중 목록도 자라지 않을 때(운영 2026-10-01 00:50 KST — 계약 v5 §G22 · §G26 개정).

운영에서 본 것: 연속(since tm 202609301310)이 늦춘 확인(15분마다) 중이었다. 기상청 목록은 tm=20260930 이 RDR_CMP_HSR_EXT_202609301950 에서 끝났고
tm=20261001 은 비었거나 HTTP 504 였다. 00:05 KST(자정 직후 창 — 전날 목록을 합친다)의 확인은 19:50 을 다시 확인해 '파일 없음'을 받았다. 00:20 · 00:35 ·
00:50 의 확인은 오늘 목록만 읽었고 거기에 tm 이 없어 확인할 tm 이 없었다 — 실행은 'ok' · http 200 · 오류 글자 없음, 공급자 last success 가 갱신됐고
(08:14 KST 뒤로 저장한 프레임이 없는데도), 연속의 마지막 확인(missing_checked_at)은 00:05 에 머물러 웹이 '확인 멈춤'(마지막 확인 > 확인 간격 × 3)을 잘못 붙였다.

고친 규칙(이 파일의 시험은 고치기 전 코드에서 실패했다):
- 연속 중 목록이 답한 확인 주기는 확인이다 — 확인할 tm 이 없어도 마지막 확인을 옮기고, 목록이 보인 것(가장 새 tm · 마지막 tm 뒤로 실은 tm 수)을 싣는다.
- 그 주기는 'ok' 가 아니다(저장한 프레임 없음 — 'missing', 오류 글자가 목록에 새 tm 이 없다고 적는다) · 공급자 성공으로 적지 않는다. 연속 밖에서는 전처럼 'ok'.
- 목록이 실패하면(504 · ReadTimeout) 실행 'error' 이고 마지막 확인 · 목록 필드는 그대로다(확인하지 않았다 — 그러면 '확인 멈춤'이 맞다).
- KST 자정을 넘어 새 날 목록이 비어 있는 동안 연속의 마지막 tm 이 전날이면 전날 목록도 읽는다(자정 직후 창 00:00–00:14 과 같은 덧붙이는 목록) —
  빈 새 날 목록을 '파일 없음'으로 세지 않고, 마지막 tm 뒤를 싣는 목록을 계속 확인한다.
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
    내려받기는 [down_from, up_from) 에서 'file not exist'. fail[day] 가 있으면 그날 목록은 그 오류로 답한다."""

    def __init__(self, clock: dict, down_from: str, list_until: str, up_from: str | None = None):
        super().__init__(clock, down_from, up_from)
        self.list_until = list_until
        self.fail: dict[str, BaseException] = {}
        self.days: list[str] = []

    async def file_list(self, day):
        self.days.append(day)
        if day in self.fail:
            raise self.fail[day]
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


async def test_a_check_that_only_reads_the_listing_moves_the_last_check_and_is_not_ok(env, caplog):
    """확인할 tm 이 없는 확인(새 날 목록은 비었고 전날 목록은 HTTP 504 — 덧붙이는 목록이라 오늘 목록으로 계속한다): 전에는 'ok' · 공급자 성공 ·
    마지막 확인 그대로. 이제 확인이다 — 마지막 확인을 옮기고 실행은 'missing'(목록에 확인할 tm 이 없다고 적는다), 공급자 성공은 아니다. 전날 목록을
    읽지 못했으니 '마지막 tm 뒤로 새 tm 없음'은 모른다(빈 값 — 짓지 않는다). 없다는 답을 받은 tm 수 · 마지막 tm 은 그대로다."""
    from wakeline_collector.http import ProviderHttpError

    mod, r, ctx, clock, runs = env
    prov, job = await _stalled_streak(mod, ctx, clock)
    tms_before = job.missing.tms
    before = await r.hgetall("wakeline:provider:kma_radar")
    await _run(job, clock, _walk("202610010000", "202610010015"))  # 00:05 확인(창 — 전날 목록 합침)
    prov.fail["20260930"] = ProviderHttpError(504, "Gateway Time-out")
    runs.clear()
    caplog.clear()
    prov.binaries.clear()
    clock["now"] = "202610010020"
    await job.run_once()
    assert prov.binaries == []
    assert [run["status"] for run in runs] == ["missing"]
    assert runs[0]["http_status"] == 200 and runs[0]["records_in"] == 0
    assert runs[0]["error_text"] == (
        "no new frame stored — nothing to probe: the KMA listing 20261001 lists no tm "
        "(tm=202609301950 is on 20260930 — that listing was not read: HTTP 504 Gateway Timeout — Gateway Time-out); "
        "KMA download has no file since tm=202609301310 "
        f"({tms_before} tms answered missing, newest tm=202609301950)"
    )
    meta = await r.hgetall(mod.KEY_META)
    assert meta["missing_checked_at"] == _utc("202610010020")
    assert (meta["missing_list_tm"], meta["missing_list_newer"]) == ("", "")  # 목록이 마지막 tm 의 날을 덮지 못했다 — 모름
    assert (meta["missing_last_tm"], meta["missing_tms"]) == ("202609301950", str(tms_before))
    after = await r.hgetall("wakeline:provider:kma_radar")
    assert after["last_success_at"] == before["last_success_at"]
    assert after.get("last_error", "") == before.get("last_error", "")  # 호출 실패로 적지 않는다(오늘 목록은 답했다)
    # 연속이 읽는 전날 목록의 실패는 확인마다 되풀이될 수 있다 — WARN 으로 로그 화면을 채우지 않는다(실행의 오류 글자에 있다)
    assert not [m for m in _warns(caplog) if "previous-day listing" in m]
    assert any("previous-day listing 20260930 — HTTP 504" in m for m in _infos(caplog))


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
    mod, r, ctx, clock, runs = env
    caplog.set_level(logging.INFO, logger="job.kma_radar")
    prov, job = await _stalled_streak(mod, ctx, clock)
    reminders = [m for m in _warns(caplog) if m.startswith("kma radar: KMA download still has no file")]
    idle = [m for m in reminders if "the KMA listing has no tm after tm=202609301950 either" in m]
    assert idle and reminders[-1] in idle  # 목록이 멈춘 뒤의 알림은 그 까닭도 적는다
    assert not [m for m in reminders if m not in idle and "newest tm=202609301950" in m and "listing" in m]
