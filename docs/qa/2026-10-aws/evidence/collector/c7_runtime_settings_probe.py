"""후보 7: Redis 의 운영 설정(wakeline:settings)을 api 를 거치지 않고 넣었을 때 수집기가 읽는 값.
실행: cd apps/collector && FIXTURES_DIR=$PWD/../../fixtures uv run --offline python ../../docs/qa/2026-10-aws/evidence/collector/c7_runtime_settings_probe.py
"""
import asyncio, sys, math
sys.path.insert(0, "tests")
from fakes import FakeRedis
from wakeline_collector.runtime_settings import RuntimeSettings
from wakeline_collector.providers import fixture as fx

async def main():
    for v in ["nan,nan", "inf,127.8", "1_0,127.8", "95,200", "36.5d,127.8", "0x1p5,127.8", "  37 , 127 "]:
        r = FakeRedis(); await r.hset("wakeline:settings", "region_center", v)
        rt = RuntimeSettings(r); await rt.refresh()
        print(repr(v), "->", rt.region)
    r = FakeRedis(); await r.hset("wakeline:settings", "region_center", "nan,nan")
    rt = RuntimeSettings(r); await rt.refresh()
    p = fx.FixtureAircraftProvider()
    try:
        res = await p.fetch_region(*rt.region)
    except Exception as e:
        print("fixture region with nan center: EXC", type(e).__name__, e); res = None
    ac = res.data["ac"] if res else []
    print("fixture region with nan center:", len(ac), "aircraft; sample lat/lon", [(a.get("lat"), a.get("lon")) for a in ac[:3]])
    for v in ["10,10", "1e9", "-5", "999999999"]:
        r = FakeRedis(); await r.hset("wakeline:settings", "global_poll_s", v); await r.hset("wakeline:settings", "region_poll_s", v)
        rt = RuntimeSettings(r); await rt.refresh()
        try:
            print("poll", repr(v), "-> global", rt.global_poll_s, "region", rt.region_poll_s)
        except Exception as e:
            print("poll", repr(v), "-> EXC", type(e).__name__, e)
asyncio.run(main())
