"""후보 9: 특보 MAX_LEN · OverflowError 로 버린 줄이 발행 봉투의 dropped 로 api 에 가는가(+ QA-1222 의 한 줄 글자 풀기 실패).
저장된 실제 응답(tests/fixtures/kma_warning/wrn_now_data_preliminary.txt)에 줄을 덧붙여 KmaWarningJob.run_once 를 돌린다 — 외부 호출 · Redis 없음.
실행: cd apps/collector && uv run --offline python ../../docs/qa/2026-10-aws/evidence/collector/c9_warning_dropped_probe.py
"""
import asyncio, sys
sys.path.insert(0, "tests")
from pathlib import Path
from fakes import FakeRedis, make_ctx
from test_ais_helpers import decode
from wakeline_collector import kma_warning_rules as R
from wakeline_collector.jobs.weather import KmaWarningJob
from wakeline_collector.models import ProviderResult
from wakeline_collector.publisher import STREAM_WXWARN
from datetime import datetime, UTC
FX = Path("tests/fixtures/kma_warning")
base = (FX / "wrn_now_data_preliminary.txt").read_bytes()
text = base.decode("euc-kr")
rows = [l for l in text.splitlines() if l.strip() and not l.startswith("#")]
print("rows:", len(rows)); print(rows[0])

class P:
    name = "kma_warning"; configured = True
    def __init__(self, body): self.body = body
    async def current(self):
        return ProviderResult(self.name, self.body, datetime.now(UTC), 200, 1, data=R.parse(self.body))

async def run(label, body):
    r = FakeRedis(); ctx = make_ctx(r, limits={"kma_warning": 400})
    await KmaWarningJob(P(body), ctx).run_once()
    ents = r.streams.get(STREAM_WXWARN, [])
    if ents:
        p = decode(ents[-1][1]); print(f"{label}: published warnings={len(p['warnings'])} dropped={p['dropped']}")
    else:
        st = await r.hgetall("wakeline:provider:kma_warning")
        print(f"{label}: NOT published — last_error={st.get('last_error')!r}")

async def main():
    cols = rows[0].split(",")
    long_name = cols.copy(); long_name[3] = "가" * 81
    overflow = cols.copy(); overflow[4] = "000101010000"
    body2 = (text + ",".join(long_name) + "\n" + ",".join(overflow) + "\n").encode("euc-kr")
    await run("MAX_LEN + OverflowError lines", body2)
    cp = cols.copy(); cp[3] = "똠방각하"  # '똠' 은 CP949(UHC) 확장 글자 — KS X 1001(EUC-KR) 밖
    body3 = text.encode("euc-kr") + ",".join(cp).encode("cp949") + b"\n"
    await run("one line with a CP949-only syllable", body3)
    body4 = text.encode("euc-kr") + ",".join(cols).encode("euc-kr")[:-3] + b"\xff\n"
    await run("one line with a stray 0xFF byte", body4)
asyncio.run(main())
