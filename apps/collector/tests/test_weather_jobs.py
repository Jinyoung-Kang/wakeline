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


# ---- R-42: RadarJob · MetarJob run_once 와 DB 쓰기 인자 조립 -----------------------------------------------------------
class FakePool:
    """writer 가 넘기는 SQL·인자를 기록한다(실제 DB 없이 인자 조립을 대조)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, list[tuple]]] = []

    async def executemany(self, sql: str, args) -> None:
        self.calls.append((" ".join(sql.split()), list(args)))

    async def execute(self, sql: str, *args) -> None:
        self.calls.append((" ".join(sql.split()), [tuple(args)]))


async def _drain_db(ctx) -> FakePool:
    """RecordingDb 큐에 쌓인 쓰기를 순서대로 가짜 풀에 실행한다."""
    pool = FakePool()
    while ctx.db._q:
        op = ctx.db._q.popleft()
        if op.name.startswith("ingest_run"):
            continue  # ingest_run 은 conn.transaction 을 쓴다(test_db_writer 가 다룬다)
        await op.fn(pool)
    return pool


def _decode(fields):
    from wakeline_collector.publisher import decode_payload

    return decode_payload(fields["payload"])


async def test_r42_radar_run_once_publishes_frames_records_db_and_heartbeat():
    from wakeline_collector.jobs.weather import RadarJob
    from wakeline_collector.publisher import STREAM_RADAR

    r = FakeRedis()
    ctx = make_ctx(r, limits={"rainviewer": 1000})
    rv = FakeRainViewer()
    await RadarJob(rv, ctx).run_once()
    ((_sid, fields),) = r.streams[STREAM_RADAR]
    fx = orjson.loads(rv.body)
    payload = _decode(fields)
    assert fields["kind"] == "radar" and fields["provider"] == "rainviewer" and fields["count"] == str(len(fx["radar"]["past"]))
    assert payload["host"] == fx["host"] and payload["generated"] == fx["generated"]
    assert payload["past"] == [{"time": f["time"], "path": f["path"]} for f in fx["radar"]["past"]]
    assert ctx.db.names == ["radar_frame", "ingest_run(radar)"]  # type: ignore[attr-defined]
    pool = await _drain_db(ctx)
    ((sql, args),) = pool.calls
    assert sql.startswith("INSERT INTO radar_frame (frame_time, host, path, fetched_at) VALUES (to_timestamp($1), $2, $3, $4)")
    assert [a[:3] for a in args] == [(f["time"], fx["host"], f["path"]) for f in fx["radar"]["past"]]
    assert (await ctx.budget.usage("rainviewer"))[0] == 1
    hb = await r.hgetall("wakeline:collector")
    assert hb["radar_at"] and (await r.hgetall("wakeline:provider:rainviewer"))["last_records"] == str(len(payload["past"]))


async def test_r42_radar_provider_failure_publishes_nothing_and_records_error():
    from wakeline_collector.http import ProviderHttpError
    from wakeline_collector.jobs.weather import RadarJob
    from wakeline_collector.publisher import STREAM_RADAR

    class Down(FakeRainViewer):
        async def frames(self):
            raise ProviderHttpError(503, "maintenance")

    r = FakeRedis()
    ctx = make_ctx(r, limits={"rainviewer": 1000})
    await RadarJob(Down(), ctx).run_once()
    assert STREAM_RADAR not in r.streams and ctx.db.names == ["ingest_run(radar)"]  # type: ignore[attr-defined]
    st = await r.hgetall("wakeline:provider:rainviewer")
    assert st["last_http_status"] == "503" and st["consecutive_failures"] == "1"
    assert "radar_at" not in await r.hgetall("wakeline:collector")  # 실패한 주기는 heartbeat 를 쓰지 않는다


async def test_r42_metar_run_once_writes_airports_before_metar_and_isolates_bad_items():
    from wakeline_collector.jobs.weather import MetarJob

    items = orjson.loads((FIX / "awc_metar_region.json").read_bytes())
    good = len(items)
    items.append({"icaoId": "ZZZZ", "lat": 1.0, "lon": 2.0, "obsTime": "not-a-time"})  # 해석 불가 → 격리
    items.append({"icaoId": "YYYY"})  # 필수 값 없음 → 건너뜀(격리 아님)
    r = FakeRedis()
    ctx = make_ctx(r, limits={"awc": 1000})
    runs: list[dict] = []
    real = ctx.db.record_run
    ctx.db.record_run = lambda job, prov, started, **kw: (runs.append(kw), real(job, prov, started, **kw))  # type: ignore[method-assign]
    await MetarJob(FakeAwcMetar(items), ctx).run_once()
    assert ctx.db.names == ["airport", "metar_obs", "ingest_run(metar)"]  # type: ignore[attr-defined] # FK 순서
    (run,) = runs
    assert run["status"] == "ok" and run["records_in"] == good and run["records_quarantined"] == 1
    assert [q[0] for q in run["quality"]] == ["metar_parse_error"] and run["quality"][0][2]["icao"] == "ZZZZ"
    assert (await r.hgetall("wakeline:collector"))["metar_at"]
    assert "wakeline:metar" not in r.streams  # METAR 의 출력은 DB 뿐


async def test_r42_metar_db_arguments_match_column_names_one_to_one():
    import re

    from wakeline_collector import db as dbmod
    from wakeline_collector.jobs.weather import MetarJob, metar_row

    items = orjson.loads((FIX / "awc_metar_region.json").read_bytes())
    r = FakeRedis()
    ctx = make_ctx(r, limits={"awc": 1000})
    await MetarJob(FakeAwcMetar(items), ctx).run_once()
    pool = await _drain_db(ctx)
    (air_sql, air_args), (met_sql, met_args) = pool.calls
    assert air_sql.startswith("INSERT INTO airport (icao, iata, name, country, geom, elev_ft, watched, updated_at)")
    cols = [c.strip() for c in re.search(r"INSERT INTO metar_obs \(([^)]*)\)", dbmod._METAR_UPSERT).group(1).split(",")]
    assert len(cols) == 17 and met_sql == " ".join(dbmod._METAR_UPSERT.split())
    fetched = None
    for it, args in zip(items, met_args, strict=True):
        fetched = fetched or args[cols.index("fetched_at")]
        _airport, obs = metar_row(it, "awc", fetched)
        assert args == tuple(obs[c] for c in cols), it["icaoId"]  # 인자 순서 = 컬럼 순서
    for it, a in zip(items, air_args, strict=True):
        airport, _obs = metar_row(it, "awc", fetched)
        assert a == (
            airport["icao"],
            None,
            airport["name"],
            airport["country"],
            airport["lon"],
            airport["lat"],
            airport["elev_ft"],
        )


async def test_r42_weather_guard_budget_exhausted_does_not_call_the_provider():
    from wakeline_collector.jobs.weather import MetarJob

    r = FakeRedis()
    ctx = make_ctx(r, limits={"awc": 1})
    awc = FakeAwcMetar()
    job = MetarJob(awc, ctx)
    runs: list[dict] = []
    real = ctx.db.record_run
    ctx.db.record_run = lambda job_, prov, started, **kw: (runs.append(kw), real(job_, prov, started, **kw))  # type: ignore[method-assign]
    await job.run_once()
    await job.run_once()  # 하루 예산 1 → 두 번째는 호출하지 않는다
    assert len(awc.bboxes) == 1
    assert [x["status"] for x in runs] == ["ok", "budget_exhausted"] and "used=1" in runs[1]["error_text"]
    r.down = True  # 예산 저장소 장애: awc 는 엄격 공급자가 아니므로 호출은 계속(fail open) — 사용량은 모름
    runs.clear()
    await job.run_once()
    assert len(awc.bboxes) == 2
