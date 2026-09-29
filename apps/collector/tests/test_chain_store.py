"""R-17 429 이력의 Redis 보존 — 수집기가 재시작해도(재배포) 쉼·미룸을 잊고 adsb.lol 을 바로 다시 부르지 않는다.

이전: 이력이 프로세스 메모리에만 있어 재시작 직후 백오프가 60 s 부터 다시 시작했다(로그: 재시작마다 'backing off 60 s').
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest
from fakes import FakeRedis
from test_fallback import FakeStatus, P

from wakeline_collector import fallback
from wakeline_collector.chain_store import ChainStateStore
from wakeline_collector.fallback import RATE_LIMIT_RESET_S, ProviderChain

KEY = "wakeline:provider:a:ratelimit:region"


class Clocks:
    """재시작을 흉내 낸다: 단조 시계는 프로세스마다 기준이 다르고(여기서는 restart 로 바꾼다), 벽시계는 이어진다."""

    def __init__(self, monkeypatch):
        self.mono = 10_000.0
        self.wall = 1_790_000_000.0
        monkeypatch.setattr(fallback, "time", SimpleNamespace(monotonic=lambda: self.mono))

    def advance(self, s: float) -> None:
        self.mono += s
        self.wall += s

    def restart(self, downtime_s: float = 20.0) -> None:
        self.wall += downtime_s
        self.mono = 3.0  # 새 프로세스(새 컨테이너)의 단조 시계


def _chain(r: FakeRedis, clk: Clocks, st: FakeStatus | None = None) -> tuple[ProviderChain, FakeStatus]:
    st = st or FakeStatus()
    store = ChainStateStore(r, wall=lambda: clk.wall)  # type: ignore[arg-type]
    return ProviderChain("region", {"a": P("a"), "b": P("b")}, st, store=store), st


async def _repeated_429(chain: ProviderChain, clk: Clocks) -> None:
    """429 → 60 s 쉼 → 복귀 → 다시 429(15분 안): 120 s 쉬고 10분 뒤로 미룸."""
    await chain.pick(["a", "b"])
    chain.record_rate_limited("a")
    await chain.persist("a")
    await chain.pick(["a", "b"])
    clk.advance(61)
    assert (await chain.pick(["a", "b"])).name == "a"
    chain.record_rate_limited("a")
    await chain.persist("a")


@pytest.mark.asyncio
async def test_hold_survives_a_restart(monkeypatch):
    clk = Clocks(monkeypatch)
    r = FakeRedis()
    chain, _ = _chain(r, clk)
    await _repeated_429(chain, clk)
    saved = r.kv[KEY]
    assert saved["v"] == "1" and saved["stage"] == "2"
    assert float(saved["hold_until"]) == pytest.approx(clk.wall + 600)  # 벽시계 epoch 초
    assert float(saved["backoff_until"]) == pytest.approx(clk.wall + 120)
    assert float(saved["expires_at"]) == pytest.approx(clk.wall + 600 + RATE_LIMIT_RESET_S)

    clk.restart(downtime_s=30)
    chain2, st2 = _chain(r, clk)
    assert (await chain2.pick(["a", "b"])).name == "b"  # 재시작 직후에도 a 를 부르지 않는다
    assert st2.active == [("b", "initial — a 429 반복 → 10분 뒤로 미룸(재시작 전 기록)")]
    clk.advance(120)  # 쉼(120 s)은 끝났지만 미룸(600 s)은 남았다
    assert (await chain2.pick(["a", "b"])).name == "b"
    clk.advance(600 - 30 - 120 + 1)  # 미룸 끝
    assert (await chain2.pick(["a", "b"])).name == "a"
    assert st2.reasons[-1] == "recovery — a 미룸 끝(1순위 복귀)"
    # 단계도 이어진다: 15분 조용해지기 전의 429 는 3단계(240 s · 20분)
    assert chain2.record_rate_limited("a") == 240
    assert chain2.hold_s("a") == 1200


@pytest.mark.asyncio
async def test_backoff_without_hold_survives_a_restart(monkeypatch):
    clk = Clocks(monkeypatch)
    r = FakeRedis()
    chain, _ = _chain(r, clk)
    await chain.pick(["a", "b"])
    assert chain.record_rate_limited("a") == 60
    await chain.persist("a")
    clk.restart(downtime_s=10)
    chain2, st2 = _chain(r, clk)
    assert (await chain2.pick(["a", "b"])).name == "b"
    assert st2.active == [("b", "initial — a 429 쉼(60 s)(재시작 전 기록)")]
    clk.advance(51)
    assert (await chain2.pick(["a", "b"])).name == "a"


@pytest.mark.asyncio
async def test_expired_state_is_ignored_and_removed(monkeypatch):
    clk = Clocks(monkeypatch)
    r = FakeRedis()
    chain, _ = _chain(r, clk)
    await _repeated_429(chain, clk)
    clk.restart(downtime_s=600 + RATE_LIMIT_RESET_S + 1)  # 미룸이 끝나고 15분 넘게 조용했다 — 이력은 초기화된 것과 같다
    chain2, st2 = _chain(r, clk)
    assert (await chain2.pick(["a", "b"])).name == "a"
    assert st2.active == [("a", "initial")]
    assert KEY not in r.kv or r.kv[KEY] == {}  # 지난 기록은 지운다(HDEL)
    assert chain2.record_rate_limited("a") == 60  # 1단계부터


@pytest.mark.asyncio
async def test_state_between_hold_end_and_quiet_reset_keeps_the_stage(monkeypatch):
    """미룸은 끝났지만 아직 15분 조용하지 않았다: 바로 쓰되, 다음 429 는 이어진 단계로 센다."""
    clk = Clocks(monkeypatch)
    r = FakeRedis()
    chain, _ = _chain(r, clk)
    await _repeated_429(chain, clk)
    clk.restart(downtime_s=600 + 60)
    chain2, st2 = _chain(r, clk)
    assert (await chain2.pick(["a", "b"])).name == "a" and st2.active == [("a", "initial")]
    assert chain2.record_rate_limited("a") == 240


@pytest.mark.parametrize(
    "fields",
    [
        {"v": "2", "stage": "2"},  # 모르는 형식
        {"v": "1", "stage": "x"},
        {
            "v": "1",
            "stage": "2",
            "last_429_at": "nan",
            "backoff_until": "1",
            "hold_until": "",
            "quiet_from": "1",
            "expires_at": "9e99",
        },
    ],
    ids=["version", "stage", "nan"],
)
@pytest.mark.asyncio
async def test_malformed_state_is_ignored(monkeypatch, fields):
    clk = Clocks(monkeypatch)
    r = FakeRedis()
    r.kv[KEY] = dict(fields)
    chain, st = _chain(r, clk)
    assert (await chain.pick(["a", "b"])).name == "a" and st.active == [("a", "initial")]


@pytest.mark.asyncio
async def test_state_far_in_the_future_is_ignored(monkeypatch):
    """벽시계가 뒤로 갔거나 값이 망가져 미룸이 상한(60분)보다 길게 남은 기록은 믿지 않는다."""
    clk = Clocks(monkeypatch)
    r = FakeRedis()
    w = clk.wall
    r.kv[KEY] = {
        "v": "1",
        "stage": "4",
        "last_429_at": str(w),
        "backoff_until": str(w + 300),
        "hold_until": str(w + 86_400),
        "hold_s": "3600",
        "quiet_from": str(w + 86_400),
        "expires_at": str(w + 86_400 + RATE_LIMIT_RESET_S),
    }
    chain, _ = _chain(r, clk)
    assert (await chain.pick(["a", "b"])).name == "a"


@pytest.mark.asyncio
async def test_redis_down_never_blocks_picking_and_logs_once(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="chain_store")
    clk = Clocks(monkeypatch)
    r = FakeRedis()
    r.down = True
    chain, st = _chain(r, clk)
    assert (await chain.pick(["a", "b"])).name == "a"
    chain.record_rate_limited("a")
    await chain.persist("a")  # 쓰기 실패 — 메모리 이력으로 계속
    assert (await chain.pick(["a", "b"])).name == "b"
    chain.record_rate_limited("b")
    await chain.persist("b")
    warns = [x for x in caplog.records if x.name == "chain_store" and x.levelno == logging.WARNING]
    assert len(warns) == 1 and "memory only" in warns[0].getMessage()
    r.down = False
    await chain.persist("b")  # 되살아나면 쓰고, 알린다(INFO)
    assert "wakeline:provider:b:ratelimit:region" in r.kv
    assert any(x.name == "chain_store" and "recovered" in x.getMessage() for x in caplog.records)


@pytest.mark.asyncio
async def test_redis_that_hangs_is_cut_off(monkeypatch):
    """응답하지 않는 Redis: 한 번의 읽기·쓰기가 AUX_TIMEOUT_S 를 넘지 않는다(선택을 붙잡지 않는다)."""
    import asyncio
    import time

    from wakeline_collector import chain_store

    monkeypatch.setattr(chain_store, "AUX_TIMEOUT_S", 0.05)

    class Hanging(FakeRedis):
        def pipeline(self, transaction: bool = False):
            class _P:
                def hgetall(self, key):
                    return self

                async def execute(self):
                    await asyncio.sleep(10)

            return _P()

        async def hset(self, *a, **k):
            await asyncio.sleep(10)

    clk = Clocks(monkeypatch)
    chain, _ = _chain(Hanging(), clk)
    t0 = time.perf_counter()
    assert (await chain.pick(["a", "b"])).name == "a"
    chain.record_rate_limited("a")
    await chain.persist("a")
    assert time.perf_counter() - t0 < 1.0


@pytest.mark.asyncio
async def test_chain_without_store_is_unchanged(monkeypatch):
    Clocks(monkeypatch)
    chain = ProviderChain("region", {"a": P("a"), "b": P("b")}, FakeStatus())
    chain.record_rate_limited("a")
    await chain.persist("a")  # 저장소가 없으면 아무것도 하지 않는다
    assert (await chain.pick(["a", "b"])).name == "b"


@pytest.mark.asyncio
async def test_each_job_keeps_its_own_state(monkeypatch):
    clk = Clocks(monkeypatch)
    r = FakeRedis()
    store = ChainStateStore(r, wall=lambda: clk.wall)  # type: ignore[arg-type]
    g = P("a")
    g.supports_global = True
    region = ProviderChain("region", {"a": P("a"), "b": P("b")}, FakeStatus(), store=store)
    await region.pick(["a", "b"])
    region.record_rate_limited("a")
    await region.persist("a")
    assert KEY in r.kv and "wakeline:provider:a:ratelimit:global" not in r.kv
    clk.restart()
    glob2 = ProviderChain("global", {"a": g}, FakeStatus(), store=store)
    assert (await glob2.pick(["a"], need_global=True)).name == "a"  # 관심 지역의 429 이력은 전세계 체인에 옮지 않는다


# ---- 단계 상한(리뷰): 이력이 재시작을 넘어 이어지므로 단계가 끝없이 커질 수 있었다(1025단계에서 60 × 2**1024 → OverflowError) --------
def test_stage_is_capped_in_memory(monkeypatch):
    """15분 조용함 없이 429 가 2000번 이어져도(다른 공급자 없음) 쉼·미룸은 상한(300 s · 60분)에 머물고 예외가 나지 않는다."""
    clk = Clocks(monkeypatch)
    chain = ProviderChain("region", {"a": P("a")}, FakeStatus())
    for _ in range(2000):
        assert chain.record_rate_limited("a") <= 300
        clk.advance(1)
    assert chain.record_rate_limited("a") == 300 and chain.hold_s("a") == 3600
    # 쉼(4단계 · 300 s)·미룸(5단계 · 60분)이 모두 상한에 닿는 단계
    assert fallback.STAGE_MAX == len(fallback.RATE_LIMIT_HOLD_S) + 1
    assert chain._rate_limited["a"] == fallback.STAGE_MAX


@pytest.mark.asyncio
async def test_restored_oversized_stage_is_clamped(monkeypatch, caplog):
    """망가졌거나 상한 전 코드가 남긴 큰 단계(5000)도 선택·429 기록을 깨뜨리지 않는다 — 상한 단계로 되살린다."""
    caplog.set_level(logging.INFO, logger="fallback")
    clk = Clocks(monkeypatch)
    r = FakeRedis()
    w = clk.wall
    r.kv[KEY] = {
        "v": "1",
        "stage": "5000",
        "last_429_at": str(w),
        "backoff_until": str(w + 100),
        "hold_until": "",
        "hold_s": "0",
        "quiet_from": str(w + 100),
        "expires_at": str(w + 100 + RATE_LIMIT_RESET_S),
    }
    chain, st = _chain(r, clk)
    assert (await chain.pick(["a", "b"])).name == "b"
    assert st.active == [("b", "initial — a 429 쉼(300 s)(재시작 전 기록)")]
    assert any("stage 5," in m for m in caplog.messages)
    assert chain.record_rate_limited("a") == 300 and chain.hold_s("a") == 3600
    await chain.persist("a")
    assert r.kv[KEY]["stage"] == str(fallback.STAGE_MAX)


def test_saved_hold_length_outside_the_known_range_is_malformed():
    w = 1_790_000_000.0
    row = {
        "v": "1",
        "stage": "2",
        "last_429_at": str(w),
        "backoff_until": str(w + 100),
        "hold_until": str(w + 500),
        "hold_s": "1e300",
        "quiet_from": str(w + 500),
        "expires_at": str(w + 500 + RATE_LIMIT_RESET_S),
    }
    assert fallback.parse_saved(row, w) == (None, "format")
    assert fallback.parse_saved({**row, "hold_s": "-5"}, w) == (None, "format")
    saved, why = fallback.parse_saved({**row, "hold_s": "600"}, w)
    assert why == "" and saved is not None and saved.hold_s == 600


# ---- 첫 읽기 실패(리뷰): 이전에는 한 번만 읽어서, 그 순간 Redis 가 흔들리면 재시작 전 미룸을 잊고 다음 429 가 기록을 1단계로 덮었다 ---------
@pytest.mark.asyncio
async def test_failed_first_read_is_retried_on_the_next_pick(monkeypatch):
    clk = Clocks(monkeypatch)
    r = FakeRedis()
    chain, _ = _chain(r, clk)
    await _repeated_429(chain, clk)  # 저장: 2단계 · 쉼 120 s · 미룸 600 s
    clk.restart(downtime_s=30)
    r.down = True
    chain2, st2 = _chain(r, clk)
    assert (await chain2.pick(["a", "b"])).name == "a"  # 읽지 못했다 — 메모리 이력만(모른다)
    r.down = False
    clk.advance(10)
    assert (await chain2.pick(["a", "b"])).name == "b"  # 다음 선택에서 다시 읽어 미룸을 되살린다
    assert st2.reasons[-1] == "fallback — a 429 반복 → 10분 뒤로 미룸(재시작 전 기록)"


@pytest.mark.asyncio
async def test_429_while_the_saved_history_is_unread_does_not_overwrite_it(monkeypatch):
    """읽지 못한 채 받은 429 는 메모리에만 적고 저장하지 않는다. 읽기가 되면 저장된 단계에 이어 센 것으로 맞추고 저장한다."""
    clk = Clocks(monkeypatch)
    r = FakeRedis()
    chain, _ = _chain(r, clk)
    await _repeated_429(chain, clk)  # 저장: 2단계
    clk.restart(downtime_s=30)
    r.down = True
    chain2, _st2 = _chain(r, clk)
    assert (await chain2.pick(["a", "b"])).name == "a"
    assert await chain2.on_rate_limited("a") == 60  # 아직 모른다 — 메모리 1단계
    assert r.kv[KEY]["stage"] == "2"  # 읽지 못한 기록을 1단계로 덮지 않았다
    at_429 = clk.wall
    r.down = False
    clk.advance(5)
    assert (await chain2.pick(["a", "b"])).name == "b"
    # 저장된 2단계 뒤의 429 였으므로 3단계(쉼 240 s · 미룸 20분) — 되살리기가 제때 됐을 때와 같다
    assert chain2.hold_s("a") == 1200
    saved = r.kv[KEY]
    assert saved["stage"] == "3"
    assert float(saved["hold_until"]) == pytest.approx(at_429 + 1200)
    assert float(saved["backoff_until"]) == pytest.approx(at_429 + 240)


@pytest.mark.asyncio
async def test_on_rate_limited_reads_the_saved_history_first(monkeypatch):
    """선택 때 읽기가 실패했어도 429 를 적기 전에 다시 읽는다 — 되면 저장된 단계에 이어 센다(재시작 전 2단계 → 3단계)."""
    clk = Clocks(monkeypatch)
    r = FakeRedis()
    chain, _ = _chain(r, clk)
    await _repeated_429(chain, clk)
    clk.restart(downtime_s=30)
    r.down = True
    chain2, _st2 = _chain(r, clk)
    assert (await chain2.pick(["a", "b"])).name == "a"
    r.down = False
    assert await chain2.on_rate_limited("a") == 240
    assert r.kv[KEY]["stage"] == "3" and chain2.hold_s("a") == 1200


@pytest.mark.asyncio
async def test_load_reports_a_redis_error_as_unknown_not_empty():
    r = FakeRedis()
    r.down = True
    store = ChainStateStore(r)  # type: ignore[arg-type]
    assert await store.load("region", ["a"]) is None
    r.down = False
    assert await store.load("region", ["a"]) == {}


# ---- Redis TTL(요구 사항 1): 기록마다 Redis 만료를 논리 만료(expires_at)와 같은 때로 건다 — 더 쓰지 않는 공급자·작업의 키도 남지 않는다 ----
@pytest.mark.asyncio
async def test_saved_history_gets_a_redis_ttl_at_its_logical_expiry(monkeypatch):
    import time

    clk = Clocks(monkeypatch)
    r = FakeRedis()
    chain, _ = _chain(r, clk)
    await _repeated_429(chain, clk)  # 미룸 600 s → 조용함 기준 +600 s, 만료 +600 + 900 s
    saved = r.kv[KEY]
    logical = float(saved["expires_at"]) - clk.wall
    assert logical == pytest.approx(600 + RATE_LIMIT_RESET_S)
    assert r.ttl[KEY] - time.time() == pytest.approx(logical, abs=2)  # FakeRedis.ttl 은 실제 시계 기준 만료 시각


@pytest.mark.asyncio
async def test_expire_refused_by_an_older_acl_keeps_the_record_and_warns_once(monkeypatch, caplog):
    """EXPIRE 규칙이 없는 Redis(start.sh 를 바꾸기 전에 뜬 컨테이너): 기록은 남기고(논리 만료로 계속) 경고는 한 번만."""
    from redis.exceptions import NoPermissionError

    caplog.set_level(logging.INFO, logger="chain_store")

    class OldAcl(FakeRedis):
        async def expire(self, key, seconds):
            raise NoPermissionError("this user has no permissions to run the 'expire' command")

    clk = Clocks(monkeypatch)
    r = OldAcl()
    chain, _ = _chain(r, clk)
    await _repeated_429(chain, clk)
    assert r.kv[KEY]["stage"] == "2"  # HSET 은 됐다
    warns = [x.getMessage() for x in caplog.records if x.name == "chain_store" and x.levelno == logging.WARNING]
    assert len(warns) == 1, warns
    assert warns[0].startswith("429 history TTL not set (NoPermissionError)")
    assert chain._store is not None and chain._store.errors == 0  # 쓰기 실패가 아니다
