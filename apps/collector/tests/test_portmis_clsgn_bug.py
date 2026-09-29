"""배포 뒤 발견한 결함의 회귀 시험(ADR-022 개정 · docs/review/evidence/public-data-apis-2026-09-29.txt 마지막 절).

PORT-MIS Info5 의 clsgn(호출부호) 파라미터는 거르지 않는다 — clsgn=V7A3884 는 어느 기간이든 totalCount 0 인데, 같은 항만청 · 기간을 clsgn 없이
부르면 494건 중에 V7A3884(AZAMARA PURSUIT)가 있다. 선택할 때 clsgn 으로 묻던 설계는 그래서 거의 모든 선박에 틀린 "최근 30일 기록 없음" 을 보였다
(이 파일의 첫 판이 그 틀린 none 을 xfail 로 재현했다). 이제 수집기는 clsgn 없이 항만청 · 날짜별로 모두 받아 색인하고 api 가 색인을 호출부호로 찾는다 —
확인한 동작을 흉내 내는 같은 가짜(portmis_observed)로, 색인이 그 선박의 기록을 가진다는 것과 clsgn 을 한 번도 보내지 않는다는 것을 고정한다.
(api 쪽 짝: PortCallReaderTest 의 '색인에 있는 호출부호는 ok' · 'none 은 10곳 모두 창을 덮고 2시간 안에 갱신됐을 때만'.)
"""

from __future__ import annotations

from datetime import UTC, date, datetime

import respx
from fakes import FakeRedis, make_ctx
from portcall_index_fakes import FakeIndexDb
from portmis_observed import ObservedPortMis, full_record_bytes

from wakeline_collector.http import HttpClient
from wakeline_collector.jobs.portcalls_index import PortCallIndexJob
from wakeline_collector.portcalls import parse_index_page
from wakeline_collector.providers.data_go_kr import DATA_GO_KR_HOST
from wakeline_collector.providers.portmis import PortMisProvider
from wakeline_collector.ratelimit import RateLimiter

URL = "https://apis.data.go.kr/1192000/VsslEtrynd5/Info5"
NOW = datetime(2026, 9, 29, 13, 0, tzinfo=UTC)  # 2026-09-29 22:00 KST — 발견한 때


async def test_the_index_finds_a_ship_the_clsgn_filter_misses():
    fake = ObservedPortMis()
    assert parse_index_page(full_record_bytes(), "020", date(2026, 9, 24)).rows[0].clsgn == "V7A3884"  # clsgn 없이 받은 쪽에 있다
    r = FakeRedis()
    ctx = make_ctx(r, limits={"portmis": 3000})
    db = ctx.db = FakeIndexDb()
    http = HttpClient(RateLimiter(100, 100, {DATA_GO_KR_HOST: (100, 2)}))
    job = PortCallIndexJob(PortMisProvider(http, "TESTONLYkey"), ctx, now=lambda: NOW, mono=lambda: 0.0)
    with respx.mock:
        respx.get(URL).mock(side_effect=fake)
        for _ in range(400):
            if await job.step() > 0:
                break
    assert fake.requests and not any("clsgn" in q for q in fake.requests)  # 호출부호로 묻지 않는다
    rows = db.by_call_sign("V7A3884")
    assert len(rows) == 1
    row = rows[0]
    assert (row.prt_ag_cd, row.listed_date, row.vssl_nm) == ("020", date(2026, 9, 24), "AZAMARA PURSUIT")
    assert row.entry_at == datetime(2026, 9, 23, 23, 17, tzinfo=UTC) and row.exit_at == datetime(2026, 9, 25, 5, 24, tzinfo=UTC)
    assert db.cov["020"].covered_from <= date(2026, 8, 30) and db.cov["020"].refreshed_at == NOW
