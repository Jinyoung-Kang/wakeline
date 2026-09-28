"""레이더 프레임(RainViewer)·METAR 작업의 run_once 흐름(리뷰 R-42) · 원천 보관이 이벤트 루프 밖에서 도는지(R-21).

외부 호출 없음: 공급자는 저장소 fixture(rainviewer_weather_maps.json · awc_metar_region.json)를 돌려주는 가짜다.
"""

from __future__ import annotations

import threading
from datetime import UTC, datetime
from pathlib import Path

import orjson
from fakes import FakeRaw, FakeRedis, make_ctx

from wakeline_collector.models import ProviderResult

FIX = Path(__file__).resolve().parents[3] / "fixtures"


class ThreadRecordingRaw(FakeRaw):
    """원천 보관이 어느 스레드에서 불렸는지 기록한다."""

    def __init__(self) -> None:
        self.threads: list[int] = []

    def save(self, provider: str, body: bytes, at: datetime | None = None) -> str:
        self.threads.append(threading.get_ident())
        return super().save(provider, body, at)


class FakeRainViewer:
    name = "rainviewer"

    def __init__(self) -> None:
        self.body = (FIX / "rainviewer_weather_maps.json").read_bytes()

    async def frames(self) -> ProviderResult:
        return ProviderResult(self.name, self.body, datetime.now(UTC), 200, 11, data=orjson.loads(self.body))


class FakeAwcMetar:
    name = "awc"

    def __init__(self, items: list | None = None) -> None:
        self.body = (FIX / "awc_metar_region.json").read_bytes()
        self.items = items if items is not None else orjson.loads(self.body)
        self.bboxes: list[tuple[float, float, float, float]] = []

    async def metar_bbox(self, lamin, lomin, lamax, lomax) -> ProviderResult:
        self.bboxes.append((lamin, lomin, lamax, lomax))
        return ProviderResult(self.name, self.body, datetime.now(UTC), 200, 13, data=self.items)


# ---- R-21: 원천 보관(gzip)은 이벤트 루프 밖에서 ------------------------------------------------------------------------
async def test_r21_raw_archive_runs_off_the_event_loop_for_every_job():
    from test_aircraft_job import FakeReadsb
    from test_kma_radar import FakeKma, _tms
    from test_sigmet_job import FakeAwc

    from wakeline_collector.fallback import ProviderChain
    from wakeline_collector.jobs import kma_radar as kma_mod
    from wakeline_collector.jobs.aircraft import AircraftJob
    from wakeline_collector.jobs.weather import MetarJob, RadarJob, SigmetJob

    loop_thread = threading.get_ident()
    r = FakeRedis()
    ctx = make_ctx(r)
    raw = ThreadRecordingRaw()
    ctx.raw = raw  # type: ignore[assignment]
    await AircraftJob("region", ProviderChain("region", {"adsb_lol": FakeReadsb("adsb_lol")}, ctx.status), ctx).run_once()
    await SigmetJob(FakeAwc(FIX), ctx).run_once()
    await RadarJob(FakeRainViewer(), ctx).run_once()
    await MetarJob(FakeAwcMetar(), ctx).run_once()
    real_decode = kma_mod._decode
    try:
        from test_kma_radar import _fake_decode

        kma_mod._decode = _fake_decode
        await kma_mod.KmaRadarJob(FakeKma(_tms("202609272000")[-1:]), ctx).run_once()
    finally:
        kma_mod._decode = real_decode
    assert len(raw.threads) >= 6  # region · isigmet · airsigmet · radar · metar · kma
    assert loop_thread not in raw.threads  # 어느 작업도 이벤트 루프 스레드에서 gzip 하지 않는다


async def test_r21_global_normalization_and_encoding_run_off_the_event_loop(monkeypatch):
    from test_aircraft_job import FakeOpenSky

    from wakeline_collector.fallback import ProviderChain
    from wakeline_collector.jobs import aircraft as mod

    threads: list[int] = []
    real = mod.normalize_opensky

    def spy(vec, fetched_at):
        threads.append(threading.get_ident())
        return real(vec, fetched_at)

    monkeypatch.setattr(mod, "normalize_opensky", spy)

    class OneState(FakeOpenSky):
        async def _states(self, params):
            now = datetime.now(UTC)
            vec = [
                "71c0a1",
                "KAL081 ",
                "KR",
                now.timestamp() - 5,
                now.timestamp() - 5,
                126.4,
                37.4,
                10668.0,
                False,
                241.8,
                82.5,
                0.0,
            ]
            data = {"time": 0, "states": [vec]}
            return ProviderResult(self.name, orjson.dumps(data), now, 200, 30, data=data)

    r = FakeRedis()
    ctx = make_ctx(r)
    await mod.AircraftJob("global", ProviderChain("global", {"opensky": OneState()}, ctx.status), ctx).run_once()
    assert threads and threading.get_ident() not in threads
    assert len(r.streams["wakeline:aircraft"]) == 1
