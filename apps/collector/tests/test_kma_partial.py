"""기상청 합성 레이더의 부분 합성 프레임(2026-09-29 관찰, ADR-021).

관찰(개발 스택 · 읽기 전용): HSR 합성은 tm 마다 일찍 올라오고 레이더 지점이 보고하는 대로 채워진다. 수집기는 tm 마다 한 번(tm 뒤 약 3.5–3.8분)
받고 바꾸지 않았다 — 저장된 14:15/14:30/14:40/14:45/14:50 KST 는 지점 5/7/7/9/7곳 · 에코 셀 1,455–17,548 이었고 이웃 프레임은 12–15곳 ·
28,000–38,000 셀이었다. 약 17분 뒤 14:40 · 14:50 을 다시 받으니 15 · 12곳, 에코 셀 42,275 · 38,652 였다.

규칙(값은 선택값 — 잰 값이 아니다):
- 프레임마다 헤더 STN_LIST 의 지점 수(stations)와 코드(station_ids). 기준(stations_ref) = 가장 새 저장 tm 에서 60분 안(경계 포함)의 저장된
  프레임 중 가장 많은 지점 수(그 프레임 포함). partial = stations < stations_ref. 모르는 값(옛 항목)은 세지 않고 표시도 두지 않는다.
- 다시 받기: 정규 후보 뒤, 부분 합성 프레임 중 tm 이 30분 안이고 마지막 시도가 4분 넘게 지난 것을 오래된 것부터 주기마다 최대 2개.
  지점 수가 늘었을 때만 바꾼다. 예산 1 씩, 정규 주기 몫(남은 하루 × 주기당 3)을 남기고만. 오류는 INFO, 주기를 끝내지 않고 다시 부르지 않는다.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import orjson
import pytest

KST = timedelta(hours=9)


def _tm(t: str) -> datetime:
    return datetime.strptime(t, "%Y%m%d%H%M")


def _utc_of(tm: str, plus_s: float = 0) -> datetime:
    """KST tm 벽시계 → UTC 순간(+ plus_s 초)."""
    return (_tm(tm) - KST).replace(tzinfo=UTC) + timedelta(seconds=plus_s)


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _entry(tm: str, stations: int | None, *, fetched_after_s: float = 220, **extra) -> dict:
    e: dict = {
        "tm": tm,
        "obs_tm": tm,
        "fetched_at": _iso(_utc_of(tm, fetched_after_s)),
        "echo_cells": 1000,
        "raw_ref": f"raw/{tm}",
    }
    if stations is not None:
        e |= {"stations": stations, "station_ids": [f"S{i:02d}" for i in range(stations)]}
    return e | extra


# ---- 기준 지점 수 · partial ---------------------------------------------------------------------------------------------
def test_reference_is_the_largest_site_count_in_the_60_min_ending_at_the_newest_frame():
    from wakeline_collector.jobs.kma_radar import annotate_partial

    # 관찰한 모양(13:55–14:50 KST): 12 15 15 15 5 15 15 7 12 7 9 7
    tms = [f"20260929{h:02d}{m:02d}" for h, m in [(13, 55)] + [(14, m) for m in range(0, 55, 5)]]
    sites = [12, 15, 15, 15, 5, 15, 15, 7, 12, 7, 9, 7]
    frames = annotate_partial([_entry(t, s) for t, s in zip(tms, sites, strict=True)])
    assert [f["stations_ref"] for f in frames] == [15] * 12
    assert [f["partial"] for f in frames] == [s < 15 for s in sites]
    assert [f["tm"][-4:] for f in frames if f["partial"]] == ["1355", "1415", "1430", "1435", "1440", "1445", "1450"]


def test_reference_window_includes_its_60_min_edge_and_leaves_older_frames_as_they_were():
    from wakeline_collector.jobs.kma_radar import annotate_partial

    old = _entry("202609291340", 15, stations_ref=15, partial=False)  # 창 밖(65분 전) — 창 안에 있을 때 받은 값 그대로
    edge = _entry("202609291345", 12)  # 정확히 60분 전 — 창 안
    newest = _entry("202609291445", 7)
    frames = annotate_partial([old, edge, newest])
    assert (frames[0]["stations_ref"], frames[0]["partial"]) == (15, False)
    assert (frames[1]["stations_ref"], frames[1]["partial"]) == (12, False)  # 15곳 프레임은 창 밖이라 세지 않는다
    assert (frames[2]["stations_ref"], frames[2]["partial"]) == (12, True)


def test_reference_counts_the_frame_itself_so_a_lone_frame_is_not_partial_until_a_fuller_one_arrives():
    from wakeline_collector.jobs.kma_radar import annotate_partial

    first = annotate_partial([_entry("202609291450", 7)])  # 첫 기동 — 비교할 프레임이 없다
    assert (first[0]["stations_ref"], first[0]["partial"]) == (7, False)
    # 다음 프레임이 더 많은 지점으로 오면 앞 프레임이 부분 합성이 된다
    both = annotate_partial([*first, _entry("202609291455", 15)])
    assert [(f["stations_ref"], f["partial"]) for f in both] == [(15, True), (15, False)]


def test_unknown_site_counts_are_not_counted_and_get_no_reference_or_flag():
    from wakeline_collector.jobs.kma_radar import annotate_partial

    legacy = {
        "tm": "202609291440",
        "obs_tm": "202609291440",
        "fetched_at": "x",
        "echo_cells": 5,
        "stations_ref": 3,
        "partial": True,
    }
    bad = _entry("202609291445", None) | {"stations": "15"}  # 형식이 틀린 값도 모름
    frames = annotate_partial([legacy, bad, _entry("202609291450", 9)])
    assert "stations_ref" not in frames[0] and "partial" not in frames[0]  # 모르는 값에서 판정을 남기지 않는다
    assert "stations_ref" not in frames[1] and "partial" not in frames[1]
    assert (frames[2]["stations_ref"], frames[2]["partial"]) == (9, False)
    only_unknown = annotate_partial([dict(legacy)])
    assert "stations_ref" not in only_unknown[0] and "partial" not in only_unknown[0]


# ---- 저장: 프레임 항목과 meta 해시 --------------------------------------------------------------------------------------
class _Hdr:
    def __init__(self, tm: str, n: int):
        self.tm = _tm(tm)
        self.product = "HSR"
        self.stations = [f"K{i:02d}" for i in range(n)]


def _decode_with_sites(raw: bytes):
    """가짜 원본 b'<tm>|<지점 수>' → (헤더, PNG, meta). 에코 셀은 지점 수 × 1000(가짜 값)."""
    tm, n = raw.decode().split("|")
    meta = {
        "coordinates": [[0, 1], [1, 1], [1, 0], [0, 0]],
        "width": 1,
        "height": 1,
        "projection": "lcc",
        "grid": {},
        "legend": [],
        "min_dbz": 5.0,
        "observed_cells": 1,
        "echo_cells": int(n) * 1000,
    }
    return _Hdr(tm, int(n)), b"PNG" + raw, meta


class SitesKma:
    """tm 마다 받을 때의 지점 수를 차례로 돌려준다(마지막 값을 계속). 받은 시각은 시험 시계."""

    name = "kma_radar"
    cmp = "HSR"
    configured = True

    def __init__(self, clock: dict, listing: list[str], sites: dict[str, list[int]] | None = None, errors=None):
        self.clock, self.listing = clock, listing
        self.sites = {k: list(v) for k, v in (sites or {}).items()}
        self.errors = {k: list(v) for k, v in (errors or {}).items()}  # tm → 먼저 낼 예외들
        self.binaries: list[str] = []
        self.list_calls = 0

    async def file_list(self, day):
        from wakeline_collector.models import ProviderResult

        self.list_calls += 1
        return ProviderResult(self.name, b"", self.clock["utc"], 200, 5, data=list(self.listing))

    async def binary(self, tm):
        from wakeline_collector.models import ProviderResult

        self.binaries.append(tm)
        errs = self.errors.get(tm)
        if errs:
            raise errs.pop(0)
        seq = self.sites.get(tm, [15])
        n = seq.pop(0) if len(seq) > 1 else seq[0]
        return ProviderResult(self.name, f"{tm}|{n}".encode(), self.clock["utc"], 200, 7, data={"tm": tm})


class CountingRaw:
    def __init__(self) -> None:
        self.n = 0

    def save(self, provider: str, body: bytes, at: datetime | None = None) -> str:
        self.n += 1
        return f"raw/{provider}/{self.n}"

    def purge(self, retention_h: int | None = None) -> int:
        return 0


@pytest.fixture
def env(monkeypatch):
    """KST 벽시계(kst_now) · UTC 순간(_now) · 받은 시각을 한 시계로. 해석은 가짜(_decode · _decode_if_more)."""
    from fakes import FakeRedis, make_ctx

    from wakeline_collector.jobs import kma_radar as mod

    clock: dict = {}

    def set_kst(t: str, sec: int = 0) -> None:
        clock["kst"] = _tm(t) + timedelta(seconds=sec)
        clock["utc"] = (clock["kst"] - KST).replace(tzinfo=UTC)

    clock["set"] = set_kst
    set_kst("202609291455")
    monkeypatch.setattr(mod, "_decode", _decode_with_sites)

    def decode_if_more(raw: bytes, have: int):
        header, png, meta = _decode_with_sites(raw)
        return (header, png, meta) if len(header.stations) > have else (header, None, None)

    monkeypatch.setattr(mod, "_decode_if_more", decode_if_more)
    monkeypatch.setattr(mod, "kst_now", lambda: clock["kst"])
    monkeypatch.setattr(mod, "_now", lambda: clock["utc"])

    async def no_sleep(s):
        return None

    monkeypatch.setattr(mod, "_sleep", no_sleep)
    r = FakeRedis()
    ctx = make_ctx(r, limits={"kma_radar": 1000})
    ctx.raw = CountingRaw()  # type: ignore[assignment]
    return mod, r, ctx, clock


def _day(until: str) -> list[str]:
    return [f"{until[:8]}{h:02d}{m:02d}" for h in range(24) for m in range(0, 60, 5) if f"{until[:8]}{h:02d}{m:02d}" <= until]


async def test_stored_frames_carry_site_count_ids_reference_and_partial_and_meta_describes_the_latest(env):
    mod, r, ctx, clock = env
    listing = _day("202609291450")
    clock["set"]("202609291453", 40)
    prov = SitesKma(clock, listing, {"202609291435": [12], "202609291440": [7], "202609291445": [9], "202609291450": [7]})
    await mod.KmaRadarJob(prov, ctx).run_once()
    frames = orjson.loads(await r.get(mod.KEY_FRAMES))
    assert [(f["tm"][-4:], f["stations"], f["stations_ref"], f["partial"]) for f in frames] == [
        ("1435", 12, 12, False),
        ("1440", 7, 12, True),
        ("1445", 9, 12, True),
        ("1450", 7, 12, True),
    ]
    assert frames[0]["station_ids"] == [f"K{i:02d}" for i in range(12)]
    assert all(f["refetches"] == 0 and f["upgrades"] == 0 for f in frames)
    # 다시 받을 수 있는 마지막 시각(tm + 30분, UTC) — 웹이 '다음 주기에 다시 받음' / '끝까지 채워지지 않음' 을 가른다(추정하지 않는다)
    assert frames[-1]["refetch_until"] == _iso(_utc_of("202609291450", 30 * 60))
    meta = await r.hgetall(mod.KEY_META)
    assert (meta["latest_tm"], meta["stations"], meta["stations_ref"], meta["partial"]) == ("202609291450", "7", "12", "1")
    assert meta["station_ids"] == ",".join(f"K{i:02d}" for i in range(7))


async def test_a_fuller_frame_arriving_later_flags_the_earlier_ones_and_updates_the_latest_meta(env):
    mod, r, ctx, clock = env
    clock["set"]("202609291453", 40)
    prov = SitesKma(clock, ["202609291450"], {"202609291450": [7]})
    job = mod.KmaRadarJob(prov, ctx)
    await job.run_once()
    assert (await r.hgetall(mod.KEY_META))["partial"] == "0"  # 비교할 프레임이 없다 — 부분 합성이라고 하지 않는다
    clock["set"]("202609291458", 40)
    prov.listing = ["202609291450", "202609291455"]
    prov.sites["202609291455"] = [15]
    prov.sites["202609291450"] = [7]  # 다시 받아도 7곳(이 시험은 저장 규칙만 본다)
    await job.run_once()
    frames = orjson.loads(await r.get(mod.KEY_FRAMES))
    assert [(f["stations"], f["stations_ref"], f["partial"]) for f in frames][:2] == [(7, 15, True), (15, 15, False)]
    meta = await r.hgetall(mod.KEY_META)
    assert (meta["latest_tm"], meta["stations"], meta["stations_ref"], meta["partial"]) == ("202609291455", "15", "15", "0")
