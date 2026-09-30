import pytest

from wakeline_collector.fallback import ProviderChain


class FakeStatus:
    def __init__(self):
        self.active = []
        self.switches = []
        self.reasons = []
        self.disabled = set()
        self.none = []

    async def is_disabled(self, name):
        return name in self.disabled

    async def set_active(self, job, name, *, reason):
        self.active.append((name, reason))

    async def switch_event(self, job, frm, to, reason):
        self.switches.append((frm, to))
        self.reasons.append(reason)

    async def set_none(self, job, *, since, reason, next_at):
        self.none.append((job, reason, next_at))


class P:
    supports_region = True
    supports_global = False
    configured = True

    def __init__(self, name):
        self.name = name


@pytest.mark.asyncio
async def test_switch_after_three_failures_and_recover():
    st = FakeStatus()
    chain = ProviderChain("region", {"a": P("a"), "b": P("b")}, st, cooldown_s=0.05)
    order = ["a", "b"]
    assert (await chain.pick(order)).name == "a"
    assert chain.record_failure("a") is False
    assert chain.record_failure("a") is False
    assert chain.record_failure("a") is True
    assert (await chain.pick(order)).name == "b"
    assert st.switches == [("a", "b")]
    import asyncio

    await asyncio.sleep(0.06)
    assert (await chain.pick(order)).name == "a"  # 쿨다운 후 복귀
    assert st.switches[-1] == ("b", "a")


@pytest.mark.asyncio
async def test_disabled_and_unconfigured_skipped():
    st = FakeStatus()
    st.disabled.add("a")
    c = P("c")
    c.configured = False
    chain = ProviderChain("region", {"a": P("a"), "b": P("b"), "c": c}, st)
    assert (await chain.pick(["c", "a", "b"])).name == "b"
    assert await chain.pick(["c", "a"]) is None


@pytest.mark.asyncio
async def test_rate_limited_backoff_grows_and_resets(monkeypatch):
    from types import SimpleNamespace

    from wakeline_collector import fallback

    clk = [5_000.0]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: clk[0]))
    st = FakeStatus()
    chain = ProviderChain("region", {"a": P("a"), "b": P("b")}, st)
    assert chain.record_rate_limited("a") == 60
    assert chain.record_rate_limited("a") == 120
    assert chain.record_rate_limited("a") == 240
    assert chain.record_rate_limited("a") == 300
    assert (await chain.pick(["a", "b"])).name == "b"  # 쉬는 동안 2순위
    chain.record_success("a")  # 최근 429 직후의 성공은 단계를 초기화하지 않는다(플래핑 방지)
    assert chain.record_rate_limited("a") == 300
    # R-17: 쉬고 미뤄 둔 기간(여기서는 hold 3600 s)이 끝난 뒤 15분 조용해야 초기화 — 그 전 성공은 초기화하지 않는다
    clk[0] += 3600 + fallback.RATE_LIMIT_RESET_S - 1
    chain.record_success("a")
    assert chain._rate_limited["a"] > 0
    clk[0] += 2
    chain.record_success("a")
    assert chain.record_rate_limited("a") == 60


# ---- R-17: 429 가 15분 안에 되풀이되면 복귀를 늦춘다(이력) — 반복 429·전환이 수렴해야 한다 ------------------------------
def _simulate_region(monkeypatch, *, hours: float, limit_calls: int, window_s: float, fi_down: bool = False):
    """10 s 주기 관심 지역을 흉내 낸다. 1순위(lol)는 최근 window_s 안에 limit_calls 번 넘게 부르면 429(한도 수치는 가정)."""
    from types import SimpleNamespace

    from wakeline_collector import fallback

    clk = [10_000.0]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: clk[0]))
    st = FakeStatus()
    chain = ProviderChain("region", {"lol": P("lol"), "fi": P("fi")}, st)
    if fi_down:
        chain.mark_down("fi", hours * 3600 + 1)
    lol_calls: list[float] = []
    n429 = served = 0

    async def run():
        nonlocal n429, served
        for _ in range(int(hours * 360)):
            p = await chain.pick(["lol", "fi"])
            if p is not None:
                served += 1
                if p.name == "lol":
                    lol_calls[:] = [t for t in lol_calls if clk[0] - t < window_s]
                    lol_calls.append(clk[0])
                    if len(lol_calls) > limit_calls:
                        n429 += 1
                        chain.record_rate_limited("lol")
                    else:
                        chain.record_success("lol")
                else:
                    chain.record_success("fi")
            clk[0] += 10.0

    return run, st, lambda: (n429, served)


@pytest.mark.asyncio
async def test_r17_repeated_429_converges_instead_of_flapping_every_few_minutes(monkeypatch):
    run, st, result = _simulate_region(monkeypatch, hours=6, limit_calls=20, window_s=300)
    await run()
    n429, served = result()
    # 전: 300 s 쉬고 같은 주기로 복귀 → 약 8분마다 429(6 h 에 40회 넘게), 전환 이벤트 그 2배.
    assert n429 <= 12, n429
    assert len(st.switches) <= 2 * n429 + 1
    assert served == 6 * 360  # 폴백(fi)이 그동안 관심 지역을 맡는다 — 빈 주기 없음


@pytest.mark.asyncio
async def test_r17_primary_that_429s_right_after_every_recovery_is_probed_less_and_less(monkeypatch):
    """2026-09-29 관찰: adsb.lol 은 복귀하고 약 1분 안에 다시 429 — 60분 미룸 뒤에도(복귀 11:29:34 KST → 429 11:30:33 → 60분 미룸 →
    복귀 12:30:41). 이 모의에서 사다리가 60분에서 멈추면 하루 27번 429 를 받고, 360분까지 늘리면 10번이다. 폴백은 빈 주기 없이 맡는다."""
    from types import SimpleNamespace

    from wakeline_collector import fallback

    clk = [10_000.0]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: clk[0]))
    st = FakeStatus()
    chain = ProviderChain("region", {"lol": P("lol"), "fi": P("fi")}, st)
    since_recovery: list[float] = []  # lol 이 복귀한 시각
    n429 = served = 0
    for _ in range(24 * 360):  # 10 s 주기 24 h
        p = await chain.pick(["lol", "fi"])
        if p is not None:
            served += 1
            if p.name == "lol":
                if not since_recovery:
                    since_recovery.append(clk[0])
                if clk[0] - since_recovery[0] >= 55:  # 복귀 약 1분 뒤 429(관찰 모양 — 한도 수치는 모른다)
                    n429 += 1
                    chain.record_rate_limited("lol")
                    since_recovery.clear()
                else:
                    chain.record_success("lol")
            else:
                chain.record_success("fi")
        clk[0] += 10.0
    assert n429 <= 10, n429  # 사다리 60분 상한이면 27
    assert served == 24 * 360


@pytest.mark.asyncio
async def test_r17_held_primary_is_still_used_when_no_other_provider_is_available(monkeypatch):
    """이력은 '선호도'일 뿐 차단이 아니다: 2순위가 없으면 기본 백오프(최대 300 s)가 끝난 1순위를 쓴다."""
    run, st, result = _simulate_region(monkeypatch, hours=2, limit_calls=20, window_s=300, fi_down=True)
    await run()
    n429, served = result()
    lol_only_before_fix_like = 2 * 360 * (200 / 500)  # 300 s 쉬고 200 s 쓰는 주기의 제공 비율 이상
    assert served >= lol_only_before_fix_like - 30, served


# ---- 전환 사유: 왜 앞 순위를 건너뛰었는지 · 왜 돌아왔는지(이전: 모두 "fallback/recovery") ----------------------------------
def _clocked(monkeypatch, start: float = 50_000.0):
    from types import SimpleNamespace

    from wakeline_collector import fallback

    clk = [start]
    monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: clk[0]))
    return clk


@pytest.mark.asyncio
async def test_reason_429_backoff_then_recovery(monkeypatch):
    clk = _clocked(monkeypatch)
    st = FakeStatus()
    chain = ProviderChain("region", {"a": P("a"), "b": P("b")}, st)
    order = ["a", "b"]
    assert (await chain.pick(order)).name == "a"
    assert st.active == [("a", "initial")]
    assert chain.record_rate_limited("a") == 60
    assert (await chain.pick(order)).name == "b"
    assert st.reasons == ["fallback — a 429 쉼(60 s)"]
    assert st.active[-1] == ("b", "fallback — a 429 쉼(60 s)")  # set_active 와 switch_event 가 같은 글
    clk[0] += 61
    assert (await chain.pick(order)).name == "a"
    assert st.reasons[-1] == "recovery — a 쉼 끝(1순위 복귀)"
    assert st.active[-1] == ("a", "recovery — a 쉼 끝(1순위 복귀)")


@pytest.mark.asyncio
async def test_reason_repeated_429_says_how_long_it_is_deferred(monkeypatch):
    clk = _clocked(monkeypatch)
    st = FakeStatus()
    chain = ProviderChain("region", {"a": P("a"), "b": P("b")}, st)
    order = ["a", "b"]
    await chain.pick(order)
    chain.record_rate_limited("a")  # 60 s
    await chain.pick(order)
    clk[0] += 61
    await chain.pick(order)  # 복귀
    chain.record_rate_limited("a")  # 15분 안에 되풀이 → 120 s 쉬고 10분 뒤로 미룸
    await chain.pick(order)
    assert st.reasons[-1] == "fallback — a 429 반복 → 10분 뒤로 미룸"
    clk[0] += 121  # 쉼은 끝났지만 아직 미룸 — b 를 계속 쓴다(전환 없음)
    assert (await chain.pick(order)).name == "b" and len(st.reasons) == 3
    clk[0] += 600
    assert (await chain.pick(order)).name == "a"
    assert st.reasons[-1] == "recovery — a 미룸 끝(1순위 복귀)"
    chain.record_rate_limited("a")  # 조용함 15분 전 — 다시 반복: 240 s · 20분
    await chain.pick(order)
    assert st.reasons[-1] == "fallback — a 429 반복 → 20분 뒤로 미룸"


@pytest.mark.asyncio
async def test_reason_three_failures_disabled_paused_and_budget(monkeypatch):
    from datetime import UTC, datetime, timedelta

    clk = _clocked(monkeypatch)
    st = FakeStatus()
    a, b = P("a"), P("b")
    chain = ProviderChain("region", {"a": a, "b": b}, st)
    order = ["a", "b"]
    await chain.pick(order)
    for _ in range(3):
        chain.record_failure("a")
    await chain.pick(order)
    assert st.reasons[-1] == "fallback — a 3회 연속 실패(10분 쉼)"
    clk[0] += 601
    await chain.pick(order)
    assert st.reasons[-1] == "recovery — a 쉼 끝(1순위 복귀)"

    st.disabled.add("a")
    await chain.pick(order)
    assert st.reasons[-1] == "fallback — a 운영자 끔"
    st.disabled.discard("a")
    await chain.pick(order)
    assert st.reasons[-1] == "recovery — a 운영자 켬(1순위 복귀)"

    a.paused_until = datetime.now(UTC) + timedelta(hours=1)
    await chain.pick(order)
    assert st.reasons[-1] == "fallback — a 일시정지(크레딧/예산)"
    a.paused_until = None
    await chain.pick(order)
    assert st.reasons[-1] == "recovery — a 일시정지 끝(1순위 복귀)"

    chain.mark_down("a", 600, why="예산 소진(10분 쉼)")
    await chain.pick(order)
    assert st.reasons[-1] == "fallback — a 예산 소진(10분 쉼)"


@pytest.mark.asyncio
async def test_reason_initial_says_why_the_first_choice_was_skipped(monkeypatch):
    _clocked(monkeypatch)
    st = FakeStatus()
    st.disabled.add("a")
    chain = ProviderChain("region", {"a": P("a"), "b": P("b"), "c": P("c")}, st)
    assert (await chain.pick(["a", "b", "c"])).name == "b"
    assert st.active == [("b", "initial — a 운영자 끔")] and st.switches == []
    st.disabled.discard("a")
    await chain.pick(["a", "b", "c"])
    assert st.reasons[-1] == "recovery — a 운영자 켬(1순위 복귀)"


@pytest.mark.asyncio
async def test_reason_rank_counts_only_providers_for_this_scope(monkeypatch):
    """전세계 작업처럼 앞 순위가 이 범위를 지원하지 않으면 그 공급자는 순위에 넣지 않는다."""
    clk = _clocked(monkeypatch)
    st = FakeStatus()
    g1, g2 = P("g1"), P("g2")
    for p in (g1, g2):
        p.supports_global = True
    chain = ProviderChain("global", {"r": P("r"), "g1": g1, "g2": g2}, st)
    order = ["r", "g1", "g2"]
    await chain.pick(order, need_global=True)
    chain.record_rate_limited("g1")
    await chain.pick(order, need_global=True)
    clk[0] += 61
    await chain.pick(order, need_global=True)
    assert st.reasons == ["fallback — g1 429 쉼(60 s)", "recovery — g1 쉼 끝(1순위 복귀)"]


@pytest.mark.asyncio
async def test_reason_held_provider_used_because_nothing_else_is_available(monkeypatch):
    clk = _clocked(monkeypatch)
    st = FakeStatus()
    chain = ProviderChain("region", {"a": P("a"), "b": P("b")}, st)
    order = ["a", "b"]
    await chain.pick(order)
    chain.record_rate_limited("a")
    await chain.pick(order)
    clk[0] += 61
    await chain.pick(order)
    chain.record_rate_limited("a")  # 120 s · 10분 미룸
    await chain.pick(order)  # → b
    for _ in range(3):
        chain.record_failure("b")  # b 도 쉰다
    clk[0] += 121  # a 는 쉼이 끝났지만 미룸 중 — 다른 공급자가 없어 a 를 쓴다
    assert (await chain.pick(order)).name == "a"
    assert st.reasons[-1] == "fallback — b 3회 연속 실패(10분 쉼) · a 429 미룸 중이나 다른 공급자 없음"


@pytest.mark.asyncio
async def test_reason_is_masked_and_at_most_120_chars(monkeypatch):
    _clocked(monkeypatch)
    st = FakeStatus()
    long = "p" * 90 + "_token=abcdef"
    chain = ProviderChain("region", {long: P(long), "b": P("b")}, st)
    await chain.pick([long, "b"])
    chain.mark_down(long, 60, why="x" * 200)
    await chain.pick([long, "b"])
    r = st.reasons[-1]
    assert len(r) <= 120 and "abcdef" not in r and r.startswith("fallback — ppp")
    assert st.active[-1] == ("b", r)


# ---- 운영 로그 2026-09-30 KST: 관심 지역 '공급자 없음'(12:16:32 · 12:22:28) -------------------------------------------------------
# 12:14:50 adsb_fi 'failed 3x — cooling down'(ConnectError SSLEOFError, opendata.adsb.fi) → 10분 쉼. adsb_lol(429 미룸 중)이 맡았다가 12:16:22 · 12:22:18 에
# 429 → 'backing off 300 s … no other provider — deferral not applied'. 고치기 전에는 adsb_lol 이 쉬는 동안 adsb_fi 를 쉼이 끝나는 12:24:50 까지 다시
# 시도하지 않아 관심 지역에 공급자가 없었다: (12:21:22 − 12:16:22) + (12:24:50 − 12:22:18) = 300 + 152 = 452 s(설정값 — 쉼 600 s · 429 쉼 300 s — 과
# 로그 시각으로 계산). '3회 연속 실패' 쉼은 다음 순위에게 넘기려는 선호도다(429 미룸과 같다) — 다른 공급자가 없으면 주기 그대로 다시 시도한다.


def _held_lol_and_failed_fi(clk, st):
    """로그의 상태: lol 은 429 미룸 중(단계 4 — 쉼 300 s · 미룸 40분, 쉼은 끝남), fi 가 맡다가 3회 연속 실패로 10분 쉼."""
    chain = ProviderChain("region", {"lol": P("lol"), "fi": P("fi")}, st)
    t0 = clk[0]
    clk[0] = t0 - 1000
    for _ in range(4):
        chain.record_rate_limited("lol")
    clk[0] = t0
    return chain


@pytest.mark.asyncio
async def test_failed_provider_is_retried_when_every_other_provider_is_out(monkeypatch):
    clk = _clocked(monkeypatch)
    st = FakeStatus()
    chain = _held_lol_and_failed_fi(clk, st)
    order = ["lol", "fi"]
    assert (await chain.pick(order)).name == "fi"  # lol 미룸 중 — fi 가 맡는다
    for _ in range(3):
        chain.record_failure("fi")
    assert (await chain.pick(order)).name == "lol"  # 다른 공급자 없음 — 미룸 중인 lol(전과 같다)
    chain.record_rate_limited("lol")  # 12:16:22 — 300 s 쉼
    clk[0] += 10
    p = await chain.pick(order)
    assert p is not None and p.name == "fi"  # 고치기 전: None('no provider available')
    assert (
        st.reasons[-1] == "fallback — lol 429 반복 → 60분 뒤로 미룸 · fi 다시 시도 — 3회 연속 실패(10분 쉼) 중, 다른 공급자 없음"
    )
    assert st.none == []
    until = chain._down_until["fi"]
    assert chain.record_failure("fi") is False  # 쉬는 중 다시 시도가 실패 — 새 '3회' 를 세지 않고(WARN 없음) 쉼 끝도 그대로
    assert chain._down_until["fi"] == until
    clk[0] += 10
    assert st.switches == [("fi", "lol"), ("lol", "fi")]
    assert (await chain.pick(order)).name == "fi" and len(st.switches) == 2  # 같은 공급자 — 전환 기록을 쌓지 않는다
    chain.record_success("fi")  # 회복 — 쉼을 끝낸다
    clk[0] += 300  # lol 쉼이 끝나도(미룸 중) fi 가 정상 후보다
    assert (await chain.pick(order)).name == "fi" and chain.probing("fi") is False


@pytest.mark.asyncio
async def test_two_failed_providers_are_retried_in_turn(monkeypatch):
    """둘 다 3회 연속 실패로 쉬면 오래 시도하지 않은 쪽부터 번갈아 — 한쪽만 되풀이해 다른 쪽의 회복을 놓치지 않게."""
    clk = _clocked(monkeypatch)
    st = FakeStatus()
    chain = ProviderChain("region", {"a": P("a"), "b": P("b")}, st)
    order = ["a", "b"]
    await chain.pick(order)
    for name in ("a", "b"):
        for _ in range(3):
            chain.record_failure(name)
    seen = []
    for _ in range(4):
        clk[0] += 10
        p = await chain.pick(order)
        seen.append(p.name)
        chain.record_failure(p.name)
    assert seen == ["a", "b", "a", "b"]


@pytest.mark.asyncio
async def test_failed_provider_switched_off_by_the_operator_is_not_retried(monkeypatch):
    clk = _clocked(monkeypatch)
    st = FakeStatus()
    chain = _held_lol_and_failed_fi(clk, st)
    order = ["lol", "fi"]
    await chain.pick(order)
    for _ in range(3):
        chain.record_failure("fi")
    await chain.pick(order)
    chain.record_rate_limited("lol")
    st.disabled.add("fi")
    clk[0] += 10
    assert await chain.pick(order) is None


@pytest.mark.asyncio
async def test_no_provider_is_an_explicit_state_with_reasons_and_the_next_known_time(monkeypatch):
    """공급자가 하나도 없으면 상태(set_none: 까닭 · 다음으로 풀리는 때)와 전환 기록(lol → none)을 남긴다 — 전에는 wakeline:active 가 그대로
    'region: lol' 이라 운영 화면이 초록 배지로 쓰던 공급자를 보였다. 다시 고르면 none → lol 전환과 공백 길이."""
    from datetime import UTC, datetime

    clk = _clocked(monkeypatch)
    st = FakeStatus()
    chain = ProviderChain("region", {"lol": P("lol"), "fi": P("fi")}, st)
    order = ["lol", "fi"]
    st.disabled.add("fi")
    assert (await chain.pick(order)).name == "lol"
    chain.record_rate_limited("lol")  # 60 s 쉼
    before = datetime.now(UTC)
    assert await chain.pick(order) is None
    job, reason, next_at = st.none[-1]
    assert job == "region" and reason == "lol 429 쉼(60 s) · fi 운영자 끔"
    assert 55 <= (next_at - before).total_seconds() <= 61  # lol 쉼 끝(체인 상태에서 정해진 값)
    assert st.switches[-1] == ("lol", "none") and st.reasons[-1] == "none — lol 429 쉼(60 s) · fi 운영자 끔"
    assert chain.none_since is not None
    clk[0] += 30
    assert await chain.pick(order) is None and len(st.none) == 1  # 같은 공백 — 한 번만
    clk[0] += 31
    assert (await chain.pick(order)).name == "lol"
    assert st.switches[-1] == ("none", "lol") and st.reasons[-1] == "recovery — 공급자 없음 61 s 끝 · lol 쉼 끝"
    assert st.active[-1] == ("lol", "recovery — 공급자 없음 61 s 끝 · lol 쉼 끝") and chain.none_since is None


@pytest.mark.asyncio
async def test_no_provider_next_time_is_unknown_when_nothing_is_time_bound(monkeypatch):
    _clocked(monkeypatch)
    st = FakeStatus()
    st.disabled.update({"lol", "fi"})
    chain = ProviderChain("region", {"lol": P("lol"), "fi": P("fi")}, st)
    assert await chain.pick(["lol", "fi"]) is None
    assert st.none == [("region", "lol 운영자 끔 · fi 운영자 끔", None)]  # 운영자가 켜야 풀린다 — 때를 짓지 않는다
    assert st.switches == []  # 쓰던 공급자가 없었다(첫 선택) — 전환 기록 없음


async def _replay_2026_09_30(monkeypatch, fi_ok_at: float) -> tuple[float, float | None, list[str]]:
    """10 s 주기로 로그의 흐름을 되풀이한다. t = 0 이 12:14:50 KST(adsb_fi 세 번째 실패). lol 은 돌아올 때마다 로그처럼 9번째(12:15:00–12:16:22) ·
    6번째(12:21:2x–12:22:18) 호출에서 429, 그 뒤로도 6번째마다(가정 — 시험에서만). fi 는 fi_ok_at 전까지 연결 실패(가정 — 언제 풀렸는지는 로그에 없다).
    돌려주는 값: 공급자가 없던 초 · fi 가 처음 성공한 t · 고른 공급자 이름들."""
    clk = _clocked(monkeypatch, start=0.0)
    st = FakeStatus()
    chain = _held_lol_and_failed_fi(clk, st)
    for _ in range(3):
        chain.record_failure("fi")
    order = ["lol", "fi"]
    limits = [9, 6]
    lol_run = n429 = 0
    none_s, fi_first, picked = 0.0, None, []
    for t in range(10, 901, 10):
        clk[0] = float(t)
        p = await chain.pick(order)
        if p is None:
            none_s += 10
            picked.append("-")
            continue
        picked.append(p.name)
        if p.name == "lol":
            lol_run += 1
            if lol_run >= limits[min(n429, len(limits) - 1)]:
                lol_run, n429 = 0, n429 + 1
                chain.record_rate_limited("lol")
            else:
                chain.record_success("lol")
        elif t < fi_ok_at:
            chain.record_failure("fi")
        else:
            fi_first = fi_first if fi_first is not None else float(t)
            chain.record_success("fi")
    return none_s, fi_first, picked


@pytest.mark.asyncio
async def test_observed_2026_09_30_sequence_leaves_no_provider_less_gap(monkeypatch):
    """고치기 전: 같은 흐름에서 fi 가 쉼 끝(t = 600) 전에 풀려도 공급자 없음이 약 7분(10 s 격자로 440 s — 로그 시각으로는 452 s)이었고 fi 는 t = 600
    에야 다시 시도했다. 고친 뒤: lol 이 쉬는 동안 fi 를 주기마다 다시 시도한다 — 공급자 없음 0, fi 가 풀린 주기에 곧바로 받는다."""
    none_s, fi_first, picked = await _replay_2026_09_30(monkeypatch, fi_ok_at=150.0)
    assert none_s == 0, picked
    assert fi_first == 150.0
    none_s, fi_first, _ = await _replay_2026_09_30(
        monkeypatch, fi_ok_at=10_000.0
    )  # fi 가 끝내 풀리지 않아도 '공급자 없음'이 아니라 다시 시도 중
    assert none_s == 0 and fi_first is None
