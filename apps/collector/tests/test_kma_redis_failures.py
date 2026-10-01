"""기상청 레이더 작업과 Redis 실패(PLAN D2 · collector-review F1 — 이 파일의 시험은 고치기 전 코드에서 실패했다).

전에는 작업이 Redis 를 실패하지 않는 것으로 다뤘다: Redis 오류 · noeviction OOM(infra/redis/redis.conf maxmemory 256mb)이면 run_once 가 redis-py
예외로 스케줄러까지 올라가(except OSError 는 RedisError 를 잡지 못한다) 그 주기의 실행 기록 · 품질 사례가 사라졌고, 목록 SET 뒤 meta HSET 앞에서
실패하면 프레임 목록이 meta(latest_tm · fetched_at — STALE 시계)보다 앞섰다 — 그 tm 은 목록에 있어 다시 받지 않으므로 더 새 tm 이 올 때까지 그대로였다.
고친 규칙: Redis 를 만지는 곳(목록 정리 · meta 읽기 · 프레임 저장)의 실패는 주기의 실행 'error' 하나로 적고(단계 · 예외 · 그 주기에 모은 품질 사례와
글) 작업은 예외 없이 끝난다. 저장 순서는 이미지 → meta → 목록이다 — 어디서 실패해도 목록이 meta 보다 앞서지 않고, meta 가 앞서면 다음 주기가 그
tm 을 다시 받아 맞춘다.
"""

from __future__ import annotations

from datetime import datetime

import orjson
import pytest
from fakes import FakeRedis, make_ctx
from redis.exceptions import ResponseError
from test_kma_radar import FakeKma, _fake_decode, _tms

OOM = "OOM command not allowed when used memory > 'maxmemory'."


class FailingRedis(FakeRedis):
    """armed 에 든 (명령, 키) 를 한 번씩 ResponseError(OOM) 로 거절한다 — noeviction 의 쓰기 거절과 같은 모양. 키가 '*' 로 끝나면 앞부분이 같은 키."""

    def __init__(self) -> None:
        super().__init__()
        self.armed: list[tuple[str, str]] = []
        self.always: set[tuple[str, str]] = set()

    def _refuse(self, cmd: str, key: str) -> None:
        def hit(rule: tuple[str, str]) -> bool:
            c, k = rule
            return c == cmd and (key.startswith(k[:-1]) if k.endswith("*") else key == k)

        if any(hit(x) for x in self.always):
            raise ResponseError(OOM)
        for x in self.armed:
            if hit(x):
                self.armed.remove(x)
                raise ResponseError(OOM)

    async def set(self, key, value, ex=None):
        self._refuse("set", key)
        return await super().set(key, value, ex=ex)

    async def hset(self, key, field=None, value=None, mapping=None):
        self._refuse("hset", key)
        return await super().hset(key, field, value, mapping)

    async def hmget(self, key, fields, *args):
        self._refuse("hmget", key)
        return await super().hmget(key, fields, *args)


class MissingKma(FakeKma):
    """missing 에 든 tm 은 내려받기가 '파일 없음'(gzip 아님)으로 답한다."""

    def __init__(self, listing, missing=()):
        super().__init__(listing)
        self.missing = set(missing)

    async def binary(self, tm):
        if tm in self.missing:
            self.binaries.append(tm)
            raise ValueError(f"not gzip: '# file not exist (RDR_CMP_HSR_PUB_{tm}.bin.gz)'")
        return await super().binary(tm)


@pytest.fixture
def env(monkeypatch):
    from wakeline_collector.jobs import kma_radar as mod

    monkeypatch.setattr(mod, "_decode", _fake_decode)
    clock = {"now": "202609272000"}  # KST 벽시계
    monkeypatch.setattr(mod, "kst_now", lambda: datetime.strptime(clock["now"], "%Y%m%d%H%M"))
    return mod, clock


def _ctx(r):
    ctx = make_ctx(r, limits={"kma_radar": 1000})
    runs: list[dict] = []
    real = ctx.db.record_run

    def rec(job, provider, started_at, **kw):
        runs.append(kw)
        real(job, provider, started_at, **kw)

    ctx.db.record_run = rec  # type: ignore[method-assign]
    return ctx, runs


async def _state(mod, r) -> tuple[list[str], dict[str, str]]:
    raw = r.kv.get(mod.KEY_FRAMES)
    frames = [f["tm"] for f in orjson.loads(raw)] if isinstance(raw, str) else []
    return frames, dict(r.kv.get(mod.KEY_META, {}))


async def test_redis_down_is_one_error_run_and_no_kma_call(env, caplog):
    mod, _clock = env
    r = FakeRedis()
    r.down = True
    ctx, runs = _ctx(r)
    prov = FakeKma(_tms("202609272000"))
    await mod.KmaRadarJob(prov, ctx).run_once()  # 전에는 redis.exceptions.ConnectionError 가 스케줄러까지 올라갔다
    assert prov.binaries == []
    assert ctx.db.names == ["ingest_run(radar_kr)"]  # type: ignore[attr-defined]
    ((run,),) = [runs]
    assert run["status"] == "error" and run["error_text"].startswith("ConnectionError — fake redis down · frame list (Redis)")
    warns = [x.getMessage() for x in caplog.records if x.name == "job.kma_radar" and x.levelname == "WARNING"]
    assert warns == [f"kma radar: {run['error_text']} — no KMA call this cycle"]


async def test_a_failed_meta_read_spends_no_budget_and_calls_nothing(env):
    mod, _clock = env
    r = FailingRedis()
    r.always.add(("hmget", mod.KEY_META))
    ctx, runs = _ctx(r)
    prov = FakeKma(_tms("202609272000"))
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.binaries == [] and (await ctx.budget.usage("kma_radar"))[0] == 0
    ((run,),) = [runs]
    assert run["status"] == "error" and "ResponseError — OOM command not allowed" in run["error_text"]
    assert "meta (Redis)" in run["error_text"]


async def test_frame_image_set_refused_by_oom_is_an_error_run_that_keeps_the_cycle_record(env):
    """collector-review 부록 B 실험 2: 목록이 …1050 · …1055 를 싣고 1050 은 '파일 없음', 1055 의 이미지 SET 이 OOM. 전에는 예산 3 을 쓰고 run_once 가
    ResponseError 로 끝나 그 주기의 실행 기록(1050 '아직 없음' 글 포함)이 없었다."""
    mod, clock = env
    clock["now"] = "202609271055"
    r = FailingRedis()
    r.always.add(("set", "wakeline:radar_kr:frame:*"))
    ctx, runs = _ctx(r)
    prov = MissingKma(["202609271050", "202609271055"], missing={"202609271050"})
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.binaries == ["202609271050", "202609271055"] and (await ctx.budget.usage("kma_radar"))[0] == 3
    ((run,),) = [runs]
    assert run["status"] == "error" and run["records_in"] == 0
    assert run["error_text"].startswith(f"ResponseError — {OOM} · store tm=202609271055")
    assert "tm=202609271050 not available yet (try 1/3)" in run["error_text"]
    frames, meta = await _state(mod, r)
    assert frames == [] and "latest_tm" not in meta  # 목록 · meta 에 그 tm 이 없다(목록이 빈 채 — prune 의 available=0 만)


@pytest.mark.parametrize(
    "refused",
    [("set", "wakeline:radar_kr:frame:202609272005"), ("hset", "wakeline:radar_kr:meta"), ("set", "wakeline:radar_kr:frames")],
    ids=["frame image", "meta", "frames list"],
)
async def test_a_refused_store_write_never_leaves_the_list_ahead_of_meta_and_the_next_cycle_catches_up(env, refused):
    mod, clock = env
    r = FailingRedis()
    ctx, runs = _ctx(r)
    prov = FakeKma(["202609271955", "202609272000"])
    job = mod.KmaRadarJob(prov, ctx)
    await job.run_once()
    assert (await _state(mod, r))[0] == ["202609271955", "202609272000"]
    clock["now"] = "202609272005"
    prov.listing.append("202609272005")
    r.armed.append(refused)
    await job.run_once()  # 전에는 ResponseError 가 스케줄러까지 — 'meta' 면 목록(2005)이 meta(2000)보다 앞섰다
    frames, meta = await _state(mod, r)
    assert runs[-1]["status"] == "error" and "store tm=202609272005" in runs[-1]["error_text"]
    assert max(frames) <= meta["latest_tm"]  # 목록이 meta 보다 앞서지 않는다
    clock["now"] = "202609272010"
    prov.listing.append("202609272010")
    prov.binaries.clear()
    await job.run_once()
    assert prov.binaries == ["202609272005", "202609272010"]  # 목록에 없는 2005 를 다시 받는다
    frames, meta = await _state(mod, r)
    assert frames == ["202609271955", "202609272000", "202609272005", "202609272010"] and meta["latest_tm"] == "202609272010"
    assert runs[-1]["status"] == "ok" and runs[-1]["records_in"] == 2
    assert {k for k in r.kv if k.startswith("wakeline:radar_kr:frame:")} == {mod.KEY_FRAME.format(tm=t) for t in frames}
