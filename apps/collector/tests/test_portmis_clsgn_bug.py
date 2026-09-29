"""배포 뒤 발견한 결함의 재현(ADR-022 개정 · docs/review/evidence/public-data-apis-2026-09-29.txt 마지막 절).

PORT-MIS Info5 의 clsgn(호출부호) 파라미터는 거르지 않는다 — clsgn=V7A3884 는 어느 기간이든 totalCount 0 인데, 같은 항만청 · 기간을 clsgn 없이
부르면 494건 중에 V7A3884(AZAMARA PURSUIT)가 있다. 선택할 때 clsgn 으로 묻는 설계는 그래서 거의 모든 선박에 틀린 "최근 30일 기록 없음" 을 보였다.
이 시험은 확인한 동작을 흉내 내는 가짜(portmis_observed)로 그 틀린 none 을 재현한다 — 기대(= 'none' 이 아니어야 한다)가 지금 코드에서 실패한다.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import orjson
import pytest
import respx
from fakes import FakeRedis
from portmis_observed import ObservedPortMis, full_record_bytes

from wakeline_collector.budget import Budget
from wakeline_collector.http import HttpClient
from wakeline_collector.jobs.portcalls import PortCallLookup
from wakeline_collector.portcalls import parse_page
from wakeline_collector.providers.data_go_kr import DATA_GO_KR_HOST
from wakeline_collector.providers.portmis import PortMisProvider
from wakeline_collector.ratelimit import RateLimiter
from wakeline_collector.status import ProviderStatus

URL = "https://apis.data.go.kr/1192000/VsslEtrynd5/Info5"
NOW = datetime(2026, 9, 29, 13, 0, tzinfo=UTC)  # 2026-09-29 22:00 KST — 발견한 때


@pytest.mark.xfail(strict=True, reason="BUG: PORT-MIS ignores clsgn — the per-selection lookup reports 'none' for a listed ship")
async def test_lookup_by_call_sign_must_not_say_none_for_a_ship_listed_in_unfiltered_pages():
    fake = ObservedPortMis()
    assert parse_page(full_record_bytes(), "V7A3884").items, "the ship is in the unfiltered page (clsgn not sent)"
    r = FakeRedis()
    http = HttpClient(RateLimiter(100, 100, {DATA_GO_KR_HOST: (100, 2)}))
    lk = PortCallLookup(r, PortMisProvider(http, "TESTONLYkey"), Budget(r, {"portmis": 3000}), ProviderStatus(r), now=lambda: NOW)  # type: ignore[arg-type]
    with respx.mock:
        respx.get(URL).mock(side_effect=fake)
        lk.request(["V7A3884"])
        await asyncio.gather(*lk._tasks.values())
    assert all(q.get("clsgn") == "V7A3884" for q in fake.requests)  # 선택한 호출부호로만 물었다
    v = orjson.loads(r.kv["wakeline:portcalls:V7A3884"])
    assert v["status"] != "none", "PORT-MIS lists V7A3884 at 020 (entry 2026-09-24T08:17+09:00) — 'none' is wrong"
