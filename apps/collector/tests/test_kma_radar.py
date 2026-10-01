import gzip
import io
import math
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from wakeline_collector.kma_grid import HEADER_BYTES, NULL_OUTSIDE, parse_header, read_echo, render_mercator_png
from wakeline_collector.providers.kma_radar import kst_now, parse_file_list

FIX = Path(__file__).resolve().parents[3] / "fixtures" / "kma_rdr_cmp_head.bin"


def test_parse_real_header():
    h = parse_header(FIX.read_bytes())
    assert (h.version, h.ptype, h.product) == (1, 5, "HSR")
    assert (h.nx, h.ny, h.nz, h.dxy, h.map_code) == (2305, 2881, 1, 500, 1)
    assert h.tm == datetime(2026, 9, 27, 19, 30) and h.tm_in == datetime(2026, 9, 27, 19, 36, 42)
    assert h.num_stn == 17 and len(h.stations) == 17 and h.stations[0] == "KWK"
    assert h.data_code == [1, 2, 3]


def _synthetic(header: bytes) -> tuple[bytes, np.ndarray]:
    h = parse_header(header)
    grid = np.full((h.ny, h.nx), NULL_OUTSIDE, dtype="<i2")
    grid[1000:2300, 800:1500] = -20000  # 관측 반경 안, 에코 없음
    grid[1681:1700, 1121:1140] = 3500  # 기준점(N38 E126) 바로 북동쪽 35 dBZ
    return header + grid.tobytes(), grid


def test_read_echo_and_render_reference_point_lands_at_38n_126e():
    header = FIX.read_bytes()
    raw, grid = _synthetic(header)
    h, g = read_echo(gzip.compress(raw))
    assert g.shape == (2881, 2305) and g[1685, 1125] == 3500
    png, meta = render_mercator_png(h, g, width=576)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    (w, n), (e, _n2), (_e2, s), _ = meta["coordinates"]
    assert w < 126 < e and s < 38 < n
    # 기준점의 픽셀 위치: 메르카토르 경계 안에서 lon 126 / lat 38 의 비율로 예상 → 그 픽셀이 에코 색이어야 한다
    img = Image.open(io.BytesIO(png)).convert("RGBA")
    bx0, by0, bx1, by1 = meta["mercator_bounds"]
    R = 6378137.0
    mx, my = math.radians(126.05) * R, R * math.log(math.tan(math.pi / 4 + math.radians(38.05) / 2))
    px = int((mx - bx0) / (bx1 - bx0) * meta["width"])
    py = int((by1 - my) / (by1 - by0) * meta["height"])
    assert img.getpixel((px, py))[3] >= 200  # 에코(불투명)
    assert img.getpixel((px - 40, py + 60))[3] < 60  # 관측 반경 밖/에코 없음 → 투명·연한 마스크
    assert meta["echo_cells"] == 19 * 19


def test_truncated_data_rejected():
    header = FIX.read_bytes()
    with pytest.raises(ValueError):
        read_echo(gzip.compress(header + b"\0" * 100))


def test_file_list_parse_and_kst():
    text = "RDR_CMP_HSR_EXT_202609270000.bin.gz,=\nRDR_CMP_HSR_EXT_202609270005.bin.gz,=\nRDR_CMP_PPI_EXT_202609270005.bin.gz,=\n"
    assert parse_file_list(text, "HSR") == ["202609270000", "202609270005"]
    assert kst_now(datetime(2026, 9, 27, 15, 5, tzinfo=UTC)).strftime("%Y%m%d%H%M") == "202609280005"


def test_header_bytes_constant():
    assert HEADER_BYTES == 1024 and FIX.stat().st_size == 1024


# ---- SEC-15: 압축 폭탄 · 격자 크기 -------------------------------------------------------------------------------
def _gzip_zeros(total: int, chunk: int = 1 << 20) -> bytes:
    import zlib

    c = zlib.compressobj(9, zlib.DEFLATED, 16 + zlib.MAX_WBITS)
    z = b"\0" * chunk
    out = [c.compress(z) for _ in range(total // chunk)]
    out.append(c.flush())
    return b"".join(out)


def test_decompression_bomb_rejected_at_default_cap():
    from wakeline_collector.gz import DecompressedTooLarge, gunzip_bounded
    from wakeline_collector.kma_grid import MAX_RAW_BYTES

    bomb = _gzip_zeros(MAX_RAW_BYTES + (8 << 20))  # 72 MB 로 부풀고 압축본은 수십 KB
    assert len(bomb) < 1 << 20
    with pytest.raises(DecompressedTooLarge):
        gunzip_bounded(bomb, MAX_RAW_BYTES)
    with pytest.raises(ValueError):  # read_echo 경로도 같은 상한(ValueError 하위)
        read_echo(bomb)


def test_small_cap_and_truncated_stream_rejected():
    from wakeline_collector.gz import DecompressedTooLarge, gunzip_bounded

    header = FIX.read_bytes()
    raw, _ = _synthetic(header)
    gz = gzip.compress(raw)
    with pytest.raises(DecompressedTooLarge):
        read_echo(gz, max_raw_bytes=len(raw) - 1)
    assert read_echo(gz, max_raw_bytes=len(raw))[1].shape == (2881, 2305)
    with pytest.raises(ValueError):
        gunzip_bounded(gz[: len(gz) // 2], 1 << 30)  # 잘린 gzip
    with pytest.raises(ValueError):
        gunzip_bounded(b"not gzip at all", 1 << 20)


def test_grid_size_out_of_range_rejected():
    import struct

    header = bytearray(FIX.read_bytes())
    struct.pack_into("<hh", header, 20, 5000, 100)  # nx 5000 > 4096
    with pytest.raises(ValueError, match="grid size"):
        read_echo(gzip.compress(bytes(header) + b"\0" * 64))
    struct.pack_into("<hh", header, 20, -3, 100)
    with pytest.raises(ValueError, match="grid size"):
        read_echo(gzip.compress(bytes(header) + b"\0" * 64))


def test_pixel_map_cached_between_frames():
    from wakeline_collector.kma_grid import _pixel_map

    header = FIX.read_bytes()
    raw, _ = _synthetic(header)
    h, g = read_echo(gzip.compress(raw))
    _pixel_map.cache_clear()
    render_mercator_png(h, g, width=288)
    render_mercator_png(h, g, width=288)
    info = _pixel_map.cache_info()
    assert info.misses == 1 and info.hits == 1


# ---- COR-13 / PERF-13: 후보 선택 ---------------------------------------------------------------------------------
def test_candidates_only_newer_than_newest_stored():
    from wakeline_collector.kma_rules import select_candidates

    day = [f"20260927{h:02d}{m:02d}" for h in range(0, 24) for m in range(0, 60, 5)]
    listing = [t for t in day if t <= "202609272100"]
    stored = [t for t in listing if "202609271900" < t <= "202609272000"]  # 12 프레임 보관 중
    assert len(stored) == 12
    # 새 프레임 1개만 — 보관 창보다 오래된 1850/1855/1900 을 다시 받지 않는다(이전 버그)
    assert select_candidates(listing[: listing.index("202609272005") + 1], stored, "202609272007") == ["202609272005"]
    # 첫 기동(보관 없음): 최신 4개
    assert select_candidates(listing, [], "202609272100") == listing[-4:]
    # 오래 멈췄다 재개: 최신 4개만(중간 공백은 받지 않는다)
    assert select_candidates(listing, ["202609271200"], "202609272100") == listing[-4:]
    # 미래 tm 제외, 해석 불가 tm 제외
    assert select_candidates(listing, stored, "202609272012", bad={"202609272005"}) == ["202609272010"]


# ---- REL-17 / REL-19: 작업 흐름(예산·목록/이미지 일관성) ---------------------------------------------------------
class _Hdr:
    def __init__(self, tm: str):
        self.tm = datetime.strptime(tm, "%Y%m%d%H%M")
        self.product = "HSR"
        self.stations = ["KWK"]


class FakeKma:
    name = "kma_radar"
    cmp = "HSR"
    configured = True

    def __init__(self, listing):
        self.listing = listing
        self.binaries: list[str] = []

    async def file_list(self, day):
        from wakeline_collector.models import ProviderResult

        return ProviderResult(self.name, b"", datetime.now(UTC), 200, 5, data=list(self.listing))

    async def binary(self, tm):
        from wakeline_collector.models import ProviderResult

        self.binaries.append(tm)
        return ProviderResult(self.name, tm.encode(), datetime.now(UTC), 200, 7, data={"tm": tm})


def _fake_decode(raw: bytes):
    tm = raw.decode()
    if tm.endswith("BAD"):
        raise ValueError("corrupt block")
    meta = {
        "coordinates": [[0, 1], [1, 1], [1, 0], [0, 0]],
        "width": 1,
        "height": 1,
        "projection": "lcc",
        "grid": {},
        "legend": [],
        "min_dbz": 5.0,
        "observed_cells": 1,
        "echo_cells": 0,
    }
    return _Hdr(tm[:12]), b"PNG" + raw, meta


@pytest.fixture
def kma_env(monkeypatch):
    from fakes import FakeRedis, make_ctx

    from wakeline_collector.jobs import kma_radar as mod

    monkeypatch.setattr(mod, "_decode", _fake_decode)
    clock = {"now": "202609272000"}  # KST 벽시계(YYYYMMDDHHMM)
    monkeypatch.setattr(mod, "kst_now", lambda: datetime.strptime(clock["now"], "%Y%m%d%H%M"))
    r = FakeRedis()
    ctx = make_ctx(r, limits={"kma_radar": 1000})
    return mod, r, ctx, clock


def _tms(until: str) -> list[str]:
    day = [f"20260927{h:02d}{m:02d}" for h in range(0, 24) for m in range(0, 60, 5)]
    return [t for t in day if t <= until]


async def test_job_steady_state_downloads_one_frame_per_cycle_and_keeps_list_consistent(kma_env):
    import orjson

    mod, r, ctx, clock = kma_env
    prov = FakeKma(_tms("202609272000"))
    job = mod.KmaRadarJob(prov, ctx)
    await job.run_once()
    assert prov.binaries == _tms("202609272000")[-4:]  # 첫 기동: 최신 4개
    fetched = set(prov.binaries)
    total = len(prov.binaries)
    for i in range(1, 12):  # 5분마다 새 프레임 1개
        t = _tms("202609272359")[_tms("202609272359").index("202609272000") + i]
        clock["now"] = t
        prov.listing = _tms(t)
        prov.binaries.clear()
        await job.run_once()
        assert prov.binaries[-1] == t  # 새 프레임을 가장 먼저 챙긴다(최신 4개 안)
        assert not fetched & set(prov.binaries)  # 이미 받은 프레임을 다시 받지 않는다
        assert set(prov.binaries) <= set(_tms(t)[-mod.KEEP_FRAMES :])  # 보관 창보다 오래된 프레임은 받지 않는다
        if i >= 3:
            assert prov.binaries == [t]  # 보관 창을 채운 뒤에는 주기마다 1개(R-03: 처음 몇 주기는 창 안 빈 곳을 채운다)
        fetched |= set(prov.binaries)
        total += len(prov.binaries)
    frames = orjson.loads(await r.get(mod.KEY_FRAMES))
    assert len(frames) == mod.KEEP_FRAMES and frames[-1]["tm"] == clock["now"]
    assert all("expires_at" in f for f in frames)
    # 목록에서 빠진 이미지는 지워졌고, 목록의 이미지는 모두 있다
    image_keys = {k for k in r.kv if k.startswith("wakeline:radar_kr:frame:")}
    assert image_keys == {mod.KEY_FRAME.format(tm=f["tm"]) for f in frames}
    assert mod.KEY_FRAMES in r.ttl  # 목록 키도 TTL 을 갖는다
    # 예산이 연결되어 있다: 목록 12회 + 받은 바이너리 전부
    used, limit = await ctx.budget.usage("kma_radar")
    assert (used, limit) == (12 + total, 1000)


async def test_decode_runs_on_one_dedicated_thread_not_the_shared_pool(kma_env, monkeypatch):
    """큰 격자 해석(수십 MB numpy 버퍼)은 전용 스레드 하나에서만 — 공용 기본 풀의 아무 스레드에서 돌면 스레드마다 malloc 아레나가
    최고점을 따로 쥐어 RSS 가 계단식으로 늘었다(리뷰 4단계 측정: 기본 설정 40분에 99 → 297 MiB)."""
    import threading

    mod, r, ctx, clock = kma_env
    names: list[str] = []

    def recording_decode(raw: bytes):
        names.append(threading.current_thread().name)
        return _fake_decode(raw)

    monkeypatch.setattr(mod, "_decode", recording_decode)
    prov = FakeKma(_tms("202609272000"))
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert len(names) == 4
    assert all(n.startswith("kma-decode") for n in names), names
    assert len(set(names)) == 1, "한 스레드에서만"


async def test_job_prunes_entries_whose_image_expired(kma_env):
    import orjson

    mod, r, ctx, clock = kma_env
    prov = FakeKma(_tms("202609272000"))
    job = mod.KmaRadarJob(prov, ctx)
    await job.run_once()
    oldest = orjson.loads(await r.get(mod.KEY_FRAMES))[0]["tm"]
    r.expire_now(mod.KEY_FRAME.format(tm=oldest))
    kept = await job.prune()
    assert oldest not in [f["tm"] for f in kept] and len(kept) == 3
    assert oldest not in [f["tm"] for f in orjson.loads(await r.get(mod.KEY_FRAMES))]
    for f in kept:
        r.expire_now(mod.KEY_FRAME.format(tm=f["tm"]))
    assert await job.prune() == []
    assert await r.get(mod.KEY_FRAMES) is None and (await r.hgetall(mod.KEY_META))["available"] == "0"


async def test_job_skips_bad_frame_and_does_not_retry_it(kma_env):
    mod, r, ctx, clock = kma_env
    listing = _tms("202609272000")
    listing[-2] = listing[-2] + "BAD"  # 해석 불가 프레임(정렬상 마지막 두 번째)
    prov = FakeKma(listing)
    job = mod.KmaRadarJob(prov, ctx)
    await job.run_once()
    assert len(prov.binaries) == 4 and listing[-2] in job._bad
    stored = {k.rsplit(":", 1)[1] for k in r.kv if k.startswith("wakeline:radar_kr:frame:")}
    assert listing[-2] not in stored and listing[-1] in stored


async def test_job_respects_budget_limit(kma_env):
    from fakes import FakeRedis, make_ctx

    mod, _r, _ctx, clock = kma_env
    r = FakeRedis()
    ctx = make_ctx(r, limits={"kma_radar": 3})  # 목록 1 + 바이너리 2 까지만
    prov = FakeKma(_tms("202609272000"))
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert len(prov.binaries) == 2
    assert (await ctx.budget.usage("kma_radar"))[0] == 3


def test_main_limits_include_kma_radar():
    from wakeline_collector.config import Settings
    from wakeline_collector.main import build_limits

    limits = build_limits(Settings(budget_kma_radar=777))
    assert limits["kma_radar"] == 777 and limits["opensky"] == 2880


async def test_job_stops_cycle_when_rate_limited(kma_env):
    """속도 상한(429 쿨다운 등)으로 허가를 못 받으면 그 주기를 끝낸다(예외가 스케줄러로 새지 않는다). 실행은 'throttled' — 공급자 오류가
    아니므로 공급자 last_error 에 적지 않는다(2026-09-30 — 전에는 'error' + last_error, 계약 v5 §G14 의 '공급자 오류는 error 만'과 어긋났다)."""
    from wakeline_collector.ratelimit import Throttled

    mod, r, ctx, clock = kma_env
    runs = _recording_runs(ctx)

    class Limited(FakeKma):
        async def binary(self, tm):
            self.binaries.append(tm)
            raise Throttled("apihub.kma.go.kr", "cooling down 30 s after HTTP 429")

    prov = Limited(_tms("202609272000"))
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert len(prov.binaries) == 1
    assert [x["status"] for x in runs] == ["throttled"] and "cooling down 30 s" in runs[0]["error_text"]
    assert "last_error" not in await r.hgetall("wakeline:provider:kma_radar")


# ---- R-03: 목록에 있으나 아직 받을 수 없는 프레임(file not exist)은 일시 상태 -------------------------------------------
class NotYetKma(FakeKma):
    """tm 별로 처음 n 번은 'file not exist'(gzip 아님, 200) — 목록에 올라왔지만 바이너리가 아직 없는 상태."""

    def __init__(self, listing, not_ready: dict[str, int], by_day: dict[str, list[str]] | None = None):
        super().__init__(listing)
        self.not_ready = dict(not_ready)
        self.by_day = by_day
        self.days: list[str] = []

    async def file_list(self, day):
        from wakeline_collector.models import ProviderResult

        self.days.append(day)
        data = self.by_day.get(day, []) if self.by_day is not None else list(self.listing)
        return ProviderResult(self.name, b"", datetime.now(UTC), 200, 5, data=list(data))

    async def binary(self, tm):
        if self.not_ready.get(tm, 0) > 0:
            self.not_ready[tm] -= 1
            self.binaries.append(tm)
            raise ValueError(f"not gzip: '# file not exist (RDR_CMP_HSR_PUB_{tm}.bin.gz)'")
        return await super().binary(tm)


def _recording_runs(ctx):
    runs: list[dict] = []
    real = ctx.db.record_run

    def rec(job, provider, started_at, **kw):
        runs.append(kw)
        real(job, provider, started_at, **kw)

    ctx.db.record_run = rec
    return runs


async def test_r20_radar_kr_heartbeat_lag_is_unknown_not_zero(kma_env):
    mod, r, ctx, clock = kma_env
    await mod.KmaRadarJob(FakeKma(_tms("202609272000")), ctx).run_once()
    hb = await r.hgetall("wakeline:collector")
    assert hb["radar_kr_at"] and hb["radar_kr_lag_s"] == ""


async def test_r03_frame_not_yet_available_is_retried_next_cycle(kma_env):
    mod, r, ctx, clock = kma_env
    listing = _tms("202609272000")
    late = listing[-2]  # 목록에는 있으나 첫 요청 때 바이너리가 아직 없음
    prov = NotYetKma(listing, {late: 1})
    job = mod.KmaRadarJob(prov, ctx)
    await job.run_once()
    assert late not in job._bad  # 일시 상태 — 영구 제외하지 않는다
    clock["now"] = "202609272005"
    prov.listing = _tms("202609272005")
    prov.binaries.clear()
    await job.run_once()
    assert late in prov.binaries  # 다음 주기에 다시 받는다
    stored = {k.rsplit(":", 1)[1] for k in r.kv if k.startswith("wakeline:radar_kr:frame:")}
    assert late in stored and "202609272005" in stored


async def test_r03_missing_frame_gives_up_after_bounded_tries(kma_env):
    mod, r, ctx, clock = kma_env
    runs = _recording_runs(ctx)
    listing = _tms("202609272000")
    gone = listing[-1]
    prov = NotYetKma(listing, {gone: 99})  # 끝내 생기지 않는 프레임
    job = mod.KmaRadarJob(prov, ctx)
    for _ in range(mod.MAX_NOT_READY_TRIES):
        await job.run_once()
    assert prov.binaries.count(gone) == mod.MAX_NOT_READY_TRIES
    assert gone in job._bad
    # 세 번 뒤 포기하고(품질 이벤트 한 번) '파일 없음' 연속을 연다 — 그 뒤로는 주기마다 목록의 가장 새 tm 하나만 확인한다(예산을 무한히 쓰지 않는다:
    # 주기마다 목록 1 + 확인 1 — test_kma_missing)
    assert job.missing is not None and job.missing.since_tm == gone
    for _ in range(2):
        prov.binaries.clear()
        await job.run_once()
        assert prov.binaries == [gone]
    rules = [q[0] for run in runs for q in (run.get("quality") or [])]
    assert rules.count("kma_radar_missing") == 1 and "kma_radar_parse" not in rules


def test_r03_candidates_backfill_holes_inside_storage_window():
    from wakeline_collector.kma_rules import KEEP_FRAMES, select_candidates

    listing = _tms("202609272000")
    window = listing[-KEEP_FRAMES:]
    hole = window[5]
    stored = [t for t in window if t != hole]
    # 저장된 최신보다 오래됐어도 보관 창 안의 빈 프레임은 다시 채운다
    assert select_candidates(listing, stored, "202609272002") == [hole]
    # 보관 창보다 오래된 프레임은 받지 않는다(받아도 곧바로 밀려난다)
    assert select_candidates(listing, window, "202609272002") == []
    # 새 프레임과 빈 프레임이 함께 있으면 둘 다(오름차순), 해석 불가 tm 은 제외
    nxt = _tms("202609272005")
    assert select_candidates(nxt, stored, "202609272007") == [hole, "202609272005"]
    assert select_candidates(nxt, stored, "202609272007", bad={hole}) == ["202609272005"]


async def test_r03_just_after_kst_midnight_previous_day_listing_is_consulted(kma_env):
    mod, r, ctx, clock = kma_env
    prev = [f"20260927{h:02d}{m:02d}" for h in range(23, 24) for m in range(0, 60, 5)]
    stored_prev = prev[:-1]  # 23:55 는 23:57 실행 때 아직 목록에 없어서 받지 못했다
    prov = NotYetKma([], {}, by_day={"20260927": prev, "20260928": []})
    job = mod.KmaRadarJob(prov, ctx)
    for tm in stored_prev:
        await r.set(mod.KEY_FRAME.format(tm=tm), "png", ex=mod.FRAME_TTL_S)
    await job._save_frames([{"tm": tm} for tm in stored_prev])
    clock["now"] = "202609280002"
    await job.run_once()
    assert "20260927" in prov.days and "202609272355" in prov.binaries
    clock["now"] = "202609280020"  # 자정 직후 창이 지나면 전날 목록은 부르지 않는다
    prov.days.clear()
    await job.run_once()
    assert prov.days == ["20260928"]


async def test_r03_backfilling_an_older_hole_keeps_meta_on_the_latest_frame(kma_env, monkeypatch):
    """리뷰 R-03 후속: 보관 창 안의 빈 프레임(저장된 최신보다 오래된 tm)만 채운 주기가 meta 의 헤더 값(stations·observed_cells)과
    fetched_at 을 그 옛 프레임 것으로 덮었다. latest_tm 은 최신 프레임인데 fetched_at 은 방금 받은 옛 프레임 시각이라, 새 프레임이
    오지 않아도 웹의 STALE 표시(meta.fetched_at 기준)가 가려졌다. meta 는 latest_tm 프레임을 설명해야 한다."""
    import orjson

    mod, r, ctx, clock = kma_env

    def decode(raw: bytes):
        header, png, meta = _fake_decode(raw)
        hhmm = raw.decode()[8:12]
        header.stations = [f"S{hhmm}"]  # 프레임마다 다른 헤더 값
        return header, png, {**meta, "observed_cells": int(hhmm)}

    monkeypatch.setattr(mod, "_decode", decode)
    listing = _tms("202609272000")
    hole = "202609271955"  # 첫 주기에는 목록에 있으나 아직 받을 수 없음
    prov = NotYetKma(listing, {hole: 1})
    job = mod.KmaRadarJob(prov, ctx)
    await job.run_once()
    first = await r.hgetall(mod.KEY_META)
    # stations 는 지점 수, station_ids 는 코드(ADR-021 — 전에는 stations 가 코드 목록이었다)
    assert (first["latest_tm"], first["station_ids"], first["observed_cells"]) == ("202609272000", "S2000", "2000")
    prov.binaries.clear()
    await job.run_once()  # 목록이 아직 그대로인 다음 주기: 창 안의 오래된 빈 곳만 채운다
    assert prov.binaries == ["202609271930", "202609271935", "202609271940", hole]
    meta = await r.hgetall(mod.KEY_META)
    frames = orjson.loads(await r.get(mod.KEY_FRAMES))
    assert frames[-1]["tm"] == meta["latest_tm"] == "202609272000"
    assert (meta["station_ids"], meta["observed_cells"]) == ("S2000", "2000")  # 최신 프레임의 헤더 값 그대로
    assert meta["fetched_at"] == frames[-1]["fetched_at"] == first["fetched_at"]  # 옛 프레임을 받은 시각이 아니다
    assert meta["checked_at"] >= first["checked_at"] and meta["available"] == "1"


def _prev_day_error_cases():
    from wakeline_collector.http import ProviderHttpError, RequestTimedOut

    return [
        RequestTimedOut("total 40 s exceeded"),
        ValueError('unexpected list response: {"result": "error"}'),  # 목록이 아닌 JSON 응답
        ProviderHttpError(502, "bad gateway"),
    ]


@pytest.mark.parametrize("error", _prev_day_error_cases(), ids=lambda e: type(e).__name__)
async def test_r03_previous_day_listing_failure_keeps_todays_cycle(kma_env, error):
    """리뷰 R-03 후속: KST 00:00–00:14 에만 더하는 전날 목록 호출이 실패하면 예외가 _listing 밖으로 나가 주기 전체를 실패로
    기록했다(_fail) — 오늘 목록은 이미 받았는데 오늘 프레임도 저장하지 못했다. 전날 목록 실패는 로그만 남기고 오늘 목록으로 계속한다."""
    import orjson

    mod, r, ctx, clock = kma_env
    runs = _recording_runs(ctx)

    class PrevDayFails(NotYetKma):
        async def file_list(self, day):
            if day == "20260927":
                self.days.append(day)
                raise error
            return await super().file_list(day)

    prov = PrevDayFails([], {}, by_day={"20260928": ["202609280000"]})
    clock["now"] = "202609280002"
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.days == ["20260928", "20260927"]  # 전날 목록을 부르긴 했다
    assert prov.binaries == ["202609280000"]
    assert [f["tm"] for f in orjson.loads(await r.get(mod.KEY_FRAMES))] == ["202609280000"]
    assert [run["status"] for run in runs] == ["ok"]
    assert "last_error" not in await r.hgetall("wakeline:provider:kma_radar")


async def test_previous_day_listing_that_was_never_sent_gives_back_its_budget_unit(kma_env):
    """전날 목록(KST 00:00–00:14)도 보내지 않은 호출(연결 전 실패)이면 예산 1 을 돌려준다 — 오늘 목록 1 + 바이너리 1 만 남는다."""
    import httpx

    mod, r, ctx, clock = kma_env

    class PrevDayRefused(NotYetKma):
        async def file_list(self, day):
            if day == "20260927":
                self.days.append(day)
                raise httpx.ConnectError("connection refused")
            return await super().file_list(day)

    prov = PrevDayRefused([], {}, by_day={"20260928": ["202609280000"]})
    clock["now"] = "202609280002"
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.days == ["20260928", "20260927"] and prov.binaries == ["202609280000"]
    assert (await ctx.budget.usage("kma_radar"))[0] == 1 + 1


async def test_r03_previous_day_listing_without_budget_records_no_run_of_its_own(kma_env):
    """리뷰 R-03 후속: 전날 목록용 추가 예약이 예산 부족이면 _reserve 가 따로 'budget_exhausted' 실행을 남기고, 같은 주기가 다시
    'ok' 를 남겨 한 주기에 실행 기록이 둘이었다. 추가 예약은 실행 기록 없이 확인만 하고, 안 되면 오늘 목록만 쓴다."""
    from fakes import FakeRedis, make_ctx

    mod, _r, _ctx, clock = kma_env
    r = FakeRedis()
    ctx = make_ctx(r, limits={"kma_radar": 1})  # 오늘 목록 1회분만
    runs = _recording_runs(ctx)
    prov = NotYetKma([], {}, by_day={"20260927": ["202609272355"], "20260928": ["202609280000"]})
    job = mod.KmaRadarJob(prov, ctx)
    await r.set(mod.KEY_FRAME.format(tm="202609280000"), "png", ex=mod.FRAME_TTL_S)  # 오늘 프레임은 이미 있다(바이너리 예약 없음)
    await job._save_frames([{"tm": "202609280000"}])
    clock["now"] = "202609280002"
    await job.run_once()
    assert prov.days == ["20260928"]  # 예산이 없으면 전날 목록은 부르지 않는다
    assert [run["status"] for run in runs] == ["ok"]  # 한 주기 = 실행 기록 하나


# ---- 운영 관찰(2026-09-29): 'kma radar: ReadTimeout('')' 가 5분 주기 약 27회 중 7회 — 어느 단계인지·얼마나 걸렸는지 몰랐다 ------------
# 읽기 제한은 KMA 호출만 15 s(선택값), 일시 오류는 같은 주기 안에서 5 s 뒤 한 번 다시 부른다. HTTP 오류(403 등)는 다시 부르지 않는다.
_KMA_TIMEOUT = {"connect": 4.0, "read": 15.0, "write": 8.0, "pool": 8.0}


def _kma_req(path: str = "typ01/url/rdr_cmp_file_list.php"):
    import httpx

    return httpx.Request("GET", f"https://apihub.kma.go.kr/api/{path}", extensions={"timeout": dict(_KMA_TIMEOUT)})


def _read_timeout():
    import httpx

    e = httpx.ReadTimeout("")
    e.request = _kma_req()
    return e


class FlakyKma(FakeKma):
    """목록·바이너리가 정해 둔 횟수만큼 먼저 실패한다."""

    def __init__(self, listing, *, list_errors=(), binary_errors=None):
        super().__init__(listing)
        self.list_errors = list(list_errors)
        self.binary_errors = {k: list(v) for k, v in (binary_errors or {}).items()}
        self.list_calls = 0

    async def file_list(self, day):
        self.list_calls += 1
        if self.list_errors:
            raise self.list_errors.pop(0)
        return await super().file_list(day)

    async def binary(self, tm):
        errs = self.binary_errors.get(tm)
        if errs:
            self.binaries.append(tm)
            raise errs.pop(0)
        return await super().binary(tm)


@pytest.fixture
def no_wait(kma_env, monkeypatch):
    mod = kma_env[0]
    waits: list[float] = []

    async def fake_sleep(s):
        waits.append(s)

    monkeypatch.setattr(mod, "_sleep", fake_sleep)
    return waits


def _kma_warnings(caplog) -> list[str]:
    import logging

    return [r.getMessage() for r in caplog.records if r.name == "job.kma_radar" and r.levelno >= logging.WARNING]


async def test_kma_calls_use_their_own_read_timeout_and_keep_the_total_cap():
    import httpx
    import respx

    from wakeline_collector.errors import describe_error
    from wakeline_collector.http import HttpClient
    from wakeline_collector.providers import kma_radar as prov_mod
    from wakeline_collector.providers.kma_radar import KmaRadarProvider
    from wakeline_collector.ratelimit import RateLimiter

    assert prov_mod.KMA_READ_S == 15.0 and prov_mod.KMA_TOTAL_S == 40.0
    http = HttpClient(RateLimiter(100, 100))
    seen: list[dict] = []

    def capture(request):
        seen.append(dict(request.extensions["timeout"]))
        if "rdr_cmp_file_list" in str(request.url):
            return httpx.Response(200, content=b"RDR_CMP_HSR_EXT_202609272000.bin.gz,=\n")
        return httpx.Response(200, content=b"\x1f\x8b" + b"\0" * 10)

    p = KmaRadarProvider(http, "k" * 12)
    with respx.mock:
        respx.get(url__regex=r"https://apihub\.kma\.go\.kr/.*").mock(side_effect=capture)
        await p.file_list("20260927")
        await p.binary("202609272000")
    assert seen == [_KMA_TIMEOUT, _KMA_TIMEOUT]
    with respx.mock:
        respx.get(url__regex=r"https://apihub\.kma\.go\.kr/.*").mock(side_effect=httpx.ReadTimeout(""))
        with pytest.raises(httpx.ReadTimeout) as ei:
            await p.file_list("20260927")
    assert describe_error(ei.value) == "ReadTimeout — read 제한 15 s 초과 (apihub.kma.go.kr)"
    await http.aclose()


async def test_kma_listing_timeout_retried_once_then_cycle_is_ok_without_warning(kma_env, no_wait, caplog):
    import logging

    caplog.set_level(logging.INFO, logger="job.kma_radar")
    mod, r, ctx, clock = kma_env
    runs = _recording_runs(ctx)
    prov = FlakyKma(_tms("202609272000"), list_errors=[_read_timeout()])
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.list_calls == 2 and no_wait == [5.0]
    assert len(prov.binaries) == 4
    assert [run["status"] for run in runs] == ["ok"]
    assert _kma_warnings(caplog) == []
    assert any("retrying once in 5 s" in m for m in caplog.messages)
    assert (await ctx.budget.usage("kma_radar"))[0] == 1 + 1 + 4  # 다시 부른 목록도 예산을 쓴다


async def test_kma_binary_connect_error_retried_once(kma_env, no_wait, caplog):
    import httpx

    mod, r, ctx, clock = kma_env
    runs = _recording_runs(ctx)
    tms = _tms("202609272000")
    prov = FlakyKma(tms, binary_errors={tms[-4]: [httpx.ConnectError("")]})
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.binaries == [tms[-4], *tms[-4:]]  # 첫 tm 을 한 번 더 부르고 나머지를 이어 받았다
    assert [run["status"] for run in runs] == ["ok"] and _kma_warnings(caplog) == []


async def test_kma_retry_that_fails_again_gives_one_warning_with_step_and_elapsed(kma_env, no_wait, caplog):
    import logging
    import re

    caplog.set_level(logging.INFO, logger="job.kma_radar")
    mod, r, ctx, clock = kma_env
    runs = _recording_runs(ctx)
    prov = FlakyKma(_tms("202609272000"), list_errors=[_read_timeout(), _read_timeout()])
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.list_calls == 2 and prov.binaries == []
    warns = _kma_warnings(caplog)
    assert len(warns) == 1, warns
    assert re.fullmatch(
        r"kma radar: listing 20260927 — ReadTimeout — read 제한 15 s 초과 \(apihub\.kma\.go\.kr\) after \d+\.\d s"
        r"; retried once after 5 s \(first attempt: ReadTimeout after \d+\.\d s\)",
        warns[0],
    ), warns[0]
    st = await r.hgetall("wakeline:provider:kma_radar")
    assert st["last_error"].startswith("ReadTimeout — read 제한 15 s 초과 (apihub.kma.go.kr) · listing 20260927 · ")
    assert [run["status"] for run in runs] == ["error"] and runs[0]["error_text"] == st["last_error"]


async def test_kma_http_error_is_never_retried(kma_env, no_wait, caplog):
    from wakeline_collector.http import ProviderHttpError

    mod, r, ctx, clock = kma_env
    prov = FlakyKma(_tms("202609272000"), list_errors=[ProviderHttpError(403, '{"result":"unauthorized"}')])
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.list_calls == 1 and no_wait == []
    assert (await ctx.budget.usage("kma_radar"))[0] == 1
    assert (await r.hgetall("wakeline:provider:kma_radar"))["last_error"].startswith("활용신청 필요")
    warns = _kma_warnings(caplog)
    assert len(warns) == 1 and warns[0].startswith("kma radar: listing 20260927 — 활용신청 필요")


async def test_kma_each_failing_call_is_retried_once(kma_env, no_wait, caplog):
    """'한 번 다시 부른다'는 실패한 호출마다다 — 목록에서 다시 불렀어도 뒤의 바이너리가 일시 오류면 그것도 한 번 다시 부른다
    (이전: 한 주기에 한 번뿐이라 이 경우 주기를 잃었다)."""
    import httpx

    mod, r, ctx, clock = kma_env
    runs = _recording_runs(ctx)
    tms = _tms("202609272000")
    prov = FlakyKma(tms, list_errors=[_read_timeout()], binary_errors={tms[-4]: [httpx.RemoteProtocolError("")]})
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.list_calls == 2 and prov.binaries == [tms[-4], *tms[-4:]]
    assert no_wait == [5.0, 5.0]
    assert [run["status"] for run in runs] == ["ok"] and _kma_warnings(caplog) == []
    assert (await ctx.budget.usage("kma_radar"))[0] == 2 + 4 + 1  # 목록 2 · 바이너리 4 · 다시 부른 바이너리 1


async def test_kma_binary_that_fails_twice_ends_the_cycle_with_one_warning(kma_env, no_wait, caplog):
    import httpx

    mod, r, ctx, clock = kma_env
    runs = _recording_runs(ctx)
    tms = _tms("202609272000")
    errs = [httpx.RemoteProtocolError(""), httpx.RemoteProtocolError("")]
    prov = FlakyKma(tms, binary_errors={tms[-3]: errs})
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.binaries == [tms[-4], tms[-3], tms[-3]]  # 두 번 실패한 호출에서 주기를 끝낸다(남은 tm 은 다음 주기)
    warns = _kma_warnings(caplog)
    assert len(warns) == 1 and warns[0].startswith(f"kma radar: binary tm={tms[-3]} — RemoteProtocolError — 연결 실패")
    assert "retried once after 5 s" in warns[0]
    assert [run["status"] for run in runs] == ["error"]


@pytest.mark.parametrize(
    ("errors", "used"),
    [
        (["connect", "connect"], 0),  # 두 시도 모두 연결 전 실패 — 보내지 않았으니 둘 다 돌려준다
        (["connect", "read"], 1),  # 다시 부른 시도는 보낸 뒤 시간 초과 — 보낸 호출로 센다
        (["read", "read"], 2),
        (["throttled"], 0),  # 속도 상한이 막았다 — 보내지 않았다(다시 부르지도 않는다)
    ],
    ids=["connect-twice", "connect-then-read", "read-twice", "throttled"],
)
async def test_kma_listing_attempts_that_were_never_sent_give_back_their_budget_unit(kma_env, no_wait, errors, used):
    """기상 작업과 같은 규칙(retry.py): 보내지 않은 시도(NOT_SENT_ERRORS · Throttled)는 예산 1 을 돌려준다 — aircraft · route 와 같다."""
    import httpx

    from wakeline_collector.ratelimit import Throttled

    make = {
        "connect": lambda: httpx.ConnectError("connection refused"),
        "read": _read_timeout,
        "throttled": lambda: Throttled("apihub.kma.go.kr", "cooling down 30 s after HTTP 429"),
    }
    mod, r, ctx, clock = kma_env
    prov = FlakyKma(_tms("202609272000"), list_errors=[make[e]() for e in errors])
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.binaries == [] and (await ctx.budget.usage("kma_radar"))[0] == used


async def test_kma_retry_needs_budget(kma_env, no_wait):
    from fakes import FakeRedis, make_ctx

    mod, _r, _ctx, clock = kma_env
    r = FakeRedis()
    ctx = make_ctx(r, limits={"kma_radar": 1})  # 목록 한 번분만 — 다시 부를 예산이 없다
    prov = FlakyKma(_tms("202609272000"), list_errors=[_read_timeout()])
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.list_calls == 1 and no_wait == []
    assert (await r.hgetall("wakeline:provider:kma_radar"))["last_error"].startswith("ReadTimeout")
