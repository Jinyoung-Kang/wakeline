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
    from wakeline_collector.jobs.kma_radar import select_candidates

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
    """속도 상한(429 쿨다운 등)으로 허가를 못 받으면 그 주기는 실패로 기록하고 끝낸다(예외가 스케줄러로 새지 않는다)."""
    from wakeline_collector.ratelimit import Throttled

    mod, r, ctx, clock = kma_env

    class Limited(FakeKma):
        async def binary(self, tm):
            self.binaries.append(tm)
            raise Throttled("apihub.kma.go.kr", "cooling down 30 s after HTTP 429")

    prov = Limited(_tms("202609272000"))
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert len(prov.binaries) == 1
    assert "throttled" in (await r.hgetall("wakeline:provider:kma_radar"))["last_error"]


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
    for _ in range(mod.MAX_NOT_READY_TRIES + 2):
        await job.run_once()
    assert prov.binaries.count(gone) == mod.MAX_NOT_READY_TRIES  # 예산을 무한히 쓰지 않는다
    assert gone in job._bad
    rules = [q[0] for run in runs for q in (run.get("quality") or [])]
    assert rules.count("kma_radar_missing") == 1 and "kma_radar_parse" not in rules


def test_r03_candidates_backfill_holes_inside_storage_window():
    from wakeline_collector.jobs.kma_radar import KEEP_FRAMES, select_candidates

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
