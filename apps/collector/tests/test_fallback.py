import pytest

from wakeline_collector.fallback import ProviderChain


class FakeStatus:
    def __init__(self):
        self.active = []
        self.switches = []
        self.disabled = set()

    async def is_disabled(self, name):
        return name in self.disabled

    async def set_active(self, job, name, *, reason):
        self.active.append((name, reason))

    async def switch_event(self, job, frm, to, reason):
        self.switches.append((frm, to))


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
async def test_r17_held_primary_is_still_used_when_no_other_provider_is_available(monkeypatch):
    """이력은 '선호도'일 뿐 차단이 아니다: 2순위가 없으면 기본 백오프(최대 300 s)가 끝난 1순위를 쓴다."""
    run, st, result = _simulate_region(monkeypatch, hours=2, limit_calls=20, window_s=300, fi_down=True)
    await run()
    n429, served = result()
    lol_only_before_fix_like = 2 * 360 * (200 / 500)  # 300 s 쉬고 200 s 쓰는 주기의 제공 비율 이상
    assert served >= lol_only_before_fix_like - 30, served
