"""SIGMET 부분 실패(REL-12/COR-17): 미국 호출만 실패하면 직전 미국 세트를 싣고, 국제 호출이 실패하면 발행하지 않는다."""

from __future__ import annotations

import base64
import gzip
import json
from datetime import UTC, datetime, timedelta

import orjson
from fakes import FakeRedis, make_ctx

from wakeline_collector.jobs.weather import SigmetJob
from wakeline_collector.models import ProviderResult
from wakeline_collector.publisher import STREAM_SIGMET


def _decode(fields):
    return orjson.loads(gzip.decompress(base64.b64decode(fields["payload"])))


class FakeAwc:
    name = "awc"

    def __init__(self, fixtures_dir):
        now = int(datetime.now(UTC).timestamp())
        self.intl_items = json.loads((fixtures_dir / "awc_isigmet.json").read_text())[:5]
        self.us_items = json.loads((fixtures_dir / "awc_airsigmet.json").read_text())
        for it in self.intl_items + self.us_items:  # 현재 유효하도록 시각 이동
            it["validTimeFrom"], it["validTimeTo"] = now - 600, now + 3600
        self.fail_intl = False
        self.fail_us = False

    async def isigmet(self):
        if self.fail_intl:
            raise TimeoutError("isigmet timeout")
        return ProviderResult(self.name, b"[]", datetime.now(UTC), 200, 10, data=self.intl_items)

    async def airsigmet(self):
        if self.fail_us:
            raise TimeoutError("airsigmet timeout")
        return ProviderResult(self.name, b"[]", datetime.now(UTC), 200, 10, data=self.us_items)


def _published(r):
    return [_decode(f)["sigmets"] for _id, f in r.streams.get(STREAM_SIGMET, [])]


async def test_us_failure_republishes_last_good_us_set_with_original_fetched_at(fixtures_dir):
    r = FakeRedis()
    ctx = make_ctx(r)
    awc = FakeAwc(fixtures_dir)
    job = SigmetJob(awc, ctx)
    await job.run_once()
    first = _published(r)[-1]
    us_first = {s["id"]: s["fetched_at"] for s in first if s["provider"] == "awc_airsigmet"}
    assert len(us_first) == 4

    awc.fail_us = True
    await job.run_once()
    second = _published(r)[-1]
    assert len(second) == len(first)  # 세트가 줄지 않는다
    us_second = {s["id"]: s["fetched_at"] for s in second if s["provider"] == "awc_airsigmet"}
    assert us_second == us_first  # 원래 fetched_at 유지
    st = await r.hgetall("wakeline:provider:awc")
    assert st["sigmet_partial"] == "airsigmet" and st["last_error"].startswith("airsigmet failed")

    awc.fail_us = False
    await job.run_once()
    assert (await r.hgetall("wakeline:provider:awc"))["sigmet_partial"] == ""


async def test_expired_carried_us_records_are_not_republished(fixtures_dir):
    r = FakeRedis()
    ctx = make_ctx(r)
    awc = FakeAwc(fixtures_dir)
    job = SigmetJob(awc, ctx)
    await job.run_once()
    job._last_us[0] = job._last_us[0].model_copy(update={"valid_to": datetime.now(UTC) - timedelta(seconds=1)})
    awc.fail_us = True
    await job.run_once()
    us = [s for s in _published(r)[-1] if s["provider"] == "awc_airsigmet"]
    assert len(us) == 3


async def test_international_failure_publishes_nothing(fixtures_dir):
    r = FakeRedis()
    ctx = make_ctx(r)
    awc = FakeAwc(fixtures_dir)
    job = SigmetJob(awc, ctx)
    await job.run_once()
    awc.fail_intl = True
    await job.run_once()
    assert len(_published(r)) == 1


async def test_restart_restores_us_set_from_last_published_entry(fixtures_dir):
    r = FakeRedis()
    awc = FakeAwc(fixtures_dir)
    await SigmetJob(awc, make_ctx(r)).run_once()
    us_before = {s["id"] for s in _published(r)[-1] if s["provider"] == "awc_airsigmet"}
    # 재시작: 새 작업 객체(메모리 비어 있음) + 첫 호출에서 미국 실패
    awc.fail_us = True
    await SigmetJob(awc, make_ctx(r)).run_once()
    us_after = {s["id"] for s in _published(r)[-1] if s["provider"] == "awc_airsigmet"}
    assert us_after == us_before and len(us_after) == 4


async def test_r20_sigmet_heartbeat_lag_is_unknown_not_zero(fixtures_dir):
    """리뷰 R-20: 기상 작업의 lag_s 는 늘 0.0 이었다(재지 않은 값). 모르면 빈 값."""
    r = FakeRedis()
    await SigmetJob(FakeAwc(fixtures_dir), make_ctx(r)).run_once()
    hb = await r.hgetall("wakeline:collector")
    assert hb["sigmet_at"] and hb["sigmet_lag_s"] == ""


async def test_payload_carries_band_sources(fixtures_dir):
    r = FakeRedis()
    await SigmetJob(FakeAwc(fixtures_dir), make_ctx(r)).run_once()
    for s in _published(r)[-1]:
        assert s["base_source"] in ("json", "assumed_surface") and s["top_source"] in ("json", "raw_text", "unknown")
        assert (s["top_ft"] is None) == (s["top_source"] == "unknown")
