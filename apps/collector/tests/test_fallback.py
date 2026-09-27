import pytest

from skywx_collector.fallback import ProviderChain


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
async def test_rate_limited_backoff_grows_and_resets():
    st = FakeStatus()
    chain = ProviderChain("region", {"a": P("a"), "b": P("b")}, st)
    assert chain.record_rate_limited("a") == 60
    assert chain.record_rate_limited("a") == 120
    assert chain.record_rate_limited("a") == 240
    assert chain.record_rate_limited("a") == 300
    assert (await chain.pick(["a", "b"])).name == "b"  # 쉬는 동안 2순위
    chain.record_success("a")  # 최근 429 직후의 성공은 단계를 초기화하지 않는다(플래핑 방지)
    assert chain.record_rate_limited("a") == 300
    chain._last_429["a"] = 0.0  # 15분 넘게 조용했던 것으로 간주
    chain.record_success("a")
    assert chain.record_rate_limited("a") == 60
