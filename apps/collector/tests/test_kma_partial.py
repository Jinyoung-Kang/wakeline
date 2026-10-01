"""기상청 합성 레이더의 부분 합성 프레임(2026-09-29 관찰, ADR-021).

관찰(개발 스택 · 읽기 전용): HSR 합성은 tm 마다 일찍 올라오고 레이더 지점이 보고하는 대로 채워진다. 수집기는 tm 마다 한 번(tm 뒤 약 3.5–3.8분)
받고 바꾸지 않았다 — 저장된 14:15/14:30/14:40/14:45/14:50 KST 는 지점 5/7/7/9/7곳 · 에코 셀 1,455–17,548 이었고 이웃 프레임은 12–15곳 ·
28,000–38,000 셀이었다. 약 17분 뒤 14:40 · 14:50 을 다시 받으니 15 · 12곳, 에코 셀 42,275 · 38,652 였다.

규칙(값은 선택값 — 잰 값이 아니다):
- 프레임마다 헤더 STN_LIST 의 지점 수(stations)와 코드(station_ids). 기준(stations_ref) = 가장 새 저장 tm 에서 60분 안(경계 포함)의 저장된
  프레임 중 가장 많은 지점 수(그 프레임 포함). partial = stations < stations_ref — 참이면 더 많은 다른 프레임이 근거다. 거짓('기준 도달')은 기준에
  닿은 프레임이 2개 이상일 때만(REF_MIN_SUPPORT) — 기준이 이 프레임 하나뿐이면(첫 기동 · 공백 뒤 · 가장 많은 프레임이 하나) 판정하지 않는다.
  기준 도달도 '완전'이 아니다(기상청 합성이 완전한지는 자료에 없다). 모르는 값(옛 항목)은 세지 않고 표시도 두지 않는다.
- 다시 받기: 정규 후보 뒤, 부분 합성 프레임 중 tm 이 30분 안이고 마지막 시도가 4분 넘게 지난 것을 주기마다 최대 2개(다시 받은 횟수가 적은 것 →
  마지막 시도가 오래된 것 → 오래된 tm). 지점 수가 늘었을 때만 바꾼다(헤더만 풀어 비교). meta fetched_at(STALE 시계)은 옮기지 않는다. 예산 1 씩, 정규 주기 몫(남은 하루 × 주기당 3)을 남기고만. 오류는 INFO, 주기를 끝내지 않고 다시 부르지 않는다.
"""

from __future__ import annotations

import functools
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path

import orjson
import pytest

KST = timedelta(hours=9)
REAL_HEADER = Path(__file__).resolve().parents[3] / "fixtures" / "kma_rdr_cmp_head.bin"  # 실제 HSR 헤더(17곳)


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
    from wakeline_collector.kma_rules import annotate_partial

    # 관찰한 모양(13:55–14:50 KST): 12 15 15 15 5 15 15 7 12 7 9 7
    tms = [f"20260929{h:02d}{m:02d}" for h, m in [(13, 55)] + [(14, m) for m in range(0, 55, 5)]]
    sites = [12, 15, 15, 15, 5, 15, 15, 7, 12, 7, 9, 7]
    frames = annotate_partial([_entry(t, s) for t, s in zip(tms, sites, strict=True)])
    assert [f["stations_ref"] for f in frames] == [15] * 12
    assert [f["partial"] for f in frames] == [s < 15 for s in sites]
    assert [f["tm"][-4:] for f in frames if f["partial"]] == ["1355", "1415", "1430", "1435", "1440", "1445", "1450"]


def _verdicts(frames: list[dict]) -> list[tuple[int | None, bool | None]]:
    return [(f.get("stations_ref"), f.get("partial")) for f in frames]


def test_reference_window_includes_its_60_min_edge_and_leaves_older_frames_as_they_were():
    from wakeline_collector.kma_rules import annotate_partial

    old = _entry("202609291340", 15, stations_ref=15, partial=False)  # 창 밖(65분 전) — 창 안에 있을 때 받은 값 그대로
    edge = _entry("202609291345", 12)  # 정확히 60분 전 — 창 안
    edge2 = _entry("202609291350", 12)
    newest = _entry("202609291445", 7)
    frames = annotate_partial([old, edge, edge2, newest])
    assert _verdicts(frames) == [(15, False), (12, False), (12, False), (12, True)]  # 15곳 프레임은 창 밖이라 세지 않는다


def test_a_frame_that_alone_sets_the_reference_gets_no_verdict_until_another_frame_reaches_it():
    """기준 도달(partial=False)은 기준에 닿은 프레임이 둘 이상일 때만. 기준이 자기 자신뿐이면 비교할 근거가 없다 — 판정 없음(모름).
    부분 합성(partial=True)은 늘 더 많은 다른 프레임이 근거라 그대로 둔다."""
    from wakeline_collector.kma_rules import REF_MIN_SUPPORT, annotate_partial

    assert REF_MIN_SUPPORT == 2
    first = annotate_partial([_entry("202609291450", 7)])  # 첫 기동 · 공백 뒤 — 비교할 프레임이 없다
    assert _verdicts(first) == [(7, None)]  # 기준은 둔다(창 안 최대 — 사실), 판정은 두지 않는다
    both = annotate_partial([*first, _entry("202609291455", 15)])  # 더 많은 프레임이 오면 앞 프레임은 부분 합성
    assert _verdicts(both) == [(15, True), (15, None)]  # 15곳은 아직 혼자 — 판정 없음
    three = annotate_partial([*both, _entry("202609291500", 15)])
    assert _verdicts(three) == [(15, True), (15, False), (15, False)]
    # 일찍 받은 부분 합성만 모인 창(다시 받기가 멈췄거나 실패): 가장 많은 9곳 프레임이 혼자면 '기준 도달' 로 보이지 않는다
    early = annotate_partial([_entry(f"2026092914{m}", n) for m, n in (("30", 7), ("35", 5), ("40", 9), ("45", 7))])
    assert _verdicts(early) == [(9, True), (9, True), (9, None), (9, True)]
    # 다시 받아 기준에 닿으면 판정이 생긴다
    early[1] |= {"stations": 9, "station_ids": [f"S{i:02d}" for i in range(9)]}
    assert _verdicts(annotate_partial(early)) == [(9, True), (9, False), (9, False), (9, True)]


def test_unknown_site_counts_are_not_counted_and_get_no_reference_or_flag():
    from wakeline_collector.kma_rules import annotate_partial

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
    assert _verdicts(frames)[2] == (9, None)  # 지점 수를 아는 프레임이 하나뿐 — 판정 없음
    only_unknown = annotate_partial([dict(legacy)])
    assert "stations_ref" not in only_unknown[0] and "partial" not in only_unknown[0]


# ---- 다시 받은 자료: 지점 수가 늘었을 때만 영상을 만든다(실제 _decode_if_more) ---------------------------------------------------
@functools.cache
def _rdr_gz(sites: int) -> bytes:
    """실제 헤더의 STN_LIST 를 앞 sites 곳만 남긴 합성 파일(gzip). 자료 블록은 관측 반경 밖 + 35 dBZ 9×9 칸."""
    import gzip

    import numpy as np

    from wakeline_collector.kma_grid import NULL_OUTSIDE, parse_header

    head = bytearray(REAL_HEADER.read_bytes())
    assert sites <= len(parse_header(bytes(head)).stations)
    head[17] = sites  # num_stn
    for i in range(sites, 48):
        head[64 + 20 * i : 64 + 20 * (i + 1)] = b"\0" * 20
    h = parse_header(bytes(head))
    grid = np.full((h.ny, h.nx), NULL_OUTSIDE, dtype="<i2")
    grid[1681:1690, 1121:1130] = 3500
    return gzip.compress(bytes(head) + grid.tobytes(), compresslevel=1)


def test_decode_if_more_renders_only_when_the_header_lists_more_sites_than_stored(monkeypatch):
    """같거나 적으면 영상을 만들지 않고 자료 블록(해제 약 40 MB)도 풀지 않는다 — 헤더(앞 1,024 B)만 본다. 많을 때만 전체 해석 · 재투영."""
    from wakeline_collector.jobs import kma_radar as mod

    full = []
    real_read_echo = mod.read_echo
    monkeypatch.setattr(mod, "read_echo", lambda raw, *a, **k: full.append(len(raw)) or real_read_echo(raw, *a, **k))
    gz = _rdr_gz(12)
    for have in (12, 13, 17):
        header, png, meta = mod._decode_if_more(gz, have)
        assert (len(header.stations), png, meta) == (12, None, None), have
        assert header.stations == parse_stations(REAL_HEADER)[:12]
    assert full == []
    header, png, meta = mod._decode_if_more(gz, 11)
    assert len(header.stations) == 12 and png[:8] == b"\x89PNG\r\n\x1a\n" and meta["echo_cells"] == 9 * 9
    assert full == [len(gz)]


def test_decode_if_more_rejects_what_is_not_an_rdr_file():
    from wakeline_collector.jobs.kma_radar import _decode_if_more

    with pytest.raises(ValueError):
        _decode_if_more(b"# file not exist (RDR_CMP_HSR_PUB_202609291440.bin.gz)", 7)
    with pytest.raises(ValueError):
        _decode_if_more(_rdr_gz(12)[:40], 7)  # 헤더도 다 오지 않았다


def parse_stations(path: Path) -> list[str]:
    from wakeline_collector.kma_grid import parse_header

    return parse_header(path.read_bytes()).stations


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
    """KST 벽시계(kst_now) · UTC 순간(_now) · 받은 시각을 한 시계로. 해석은 가짜(_decode · read_header) — 지점 수 비교는 실제 _decode_if_more."""
    from fakes import FakeRedis, make_ctx

    from wakeline_collector.jobs import kma_radar as mod

    clock: dict = {}

    def set_kst(t: str, sec: int = 0) -> None:
        clock["kst"] = _tm(t) + timedelta(seconds=sec)
        clock["utc"] = (clock["kst"] - KST).replace(tzinfo=UTC)

    clock["set"] = set_kst
    set_kst("202609291455")
    monkeypatch.setattr(mod, "_decode", _decode_with_sites)
    monkeypatch.setattr(mod, "read_header", lambda raw: _decode_with_sites(raw)[0])
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
    assert [(f["tm"][-4:], f["stations"], f["stations_ref"], f.get("partial")) for f in frames] == [
        ("1435", 12, 12, None),  # 12곳은 이 프레임뿐 — 기준 도달이라고 하지 않는다
        ("1440", 7, 12, True),
        ("1445", 9, 12, True),
        ("1450", 7, 12, True),
    ]
    assert frames[0]["station_ids"] == [f"K{i:02d}" for i in range(12)]
    assert all(f["refetches"] == 0 and f["upgrades"] == 0 for f in frames)
    # 다시 받을 수 있는 마지막 시각(tm + 30분, UTC) — 웹이 '기한까지 다시 받기 대상' / '기한 지남'(+ 다시 받은 횟수)을 가른다(추정하지 않는다)
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
    meta = await r.hgetall(mod.KEY_META)
    # 비교할 프레임이 없다 — 판정 없음(완전하다고도 하지 않는다)
    assert (meta["stations"], meta["stations_ref"], meta["partial"]) == ("7", "7", "")
    clock["set"]("202609291458", 40)
    prov.listing = ["202609291450", "202609291455"]
    prov.sites["202609291455"] = [15]
    prov.sites["202609291450"] = [7]  # 다시 받아도 7곳(이 시험은 저장 규칙만 본다)
    await job.run_once()
    frames = orjson.loads(await r.get(mod.KEY_FRAMES))
    assert [(f["stations"], f["stations_ref"], f.get("partial")) for f in frames] == [(7, 15, True), (15, 15, None)]
    meta = await r.hgetall(mod.KEY_META)
    assert (meta["latest_tm"], meta["stations"], meta["stations_ref"], meta["partial"]) == ("202609291455", "15", "15", "")
    clock["set"]("202609291503", 40)
    prov.listing = [*prov.listing, "202609291500"]
    await job.run_once()  # 15곳이 한 번 더 — 기준에 닿은 프레임이 둘
    meta = await r.hgetall(mod.KEY_META)
    assert (meta["latest_tm"], meta["stations"], meta["stations_ref"], meta["partial"]) == ("202609291500", "15", "15", "0")


# ---- 다시 받기: 고르기 ---------------------------------------------------------------------------------------------------
def test_refetch_picks_partial_frames_at_most_30_min_old_spaced_4_min_oldest_first_at_most_2():
    from wakeline_collector.kma_rules import annotate_partial, select_refetch

    now_kst = _tm("202609291455")
    now_utc = _utc_of("202609291455")
    frames = annotate_partial(
        [
            _entry("202609291415", 15),  # 기준 15
            _entry("202609291420", 7),  # 35분 — 다시 받지 않는다
            _entry("202609291425", 7),  # 정확히 30분 — 받는다
            _entry("202609291430", 7, refetched_at=_iso(now_utc - timedelta(minutes=3))),  # 마지막 시도 3분 전 — 아직
            _entry("202609291435", 7),  # 처음 받은 뒤 16분 — 받는다
            _entry("202609291440", 7),  # 조건은 맞지만 주기당 2개까지
            _entry("202609291445", 15),  # 부분 합성 아님
            _entry("202609291450", None),  # 지점 수 모름 — 판정 없음
        ]
    )
    assert select_refetch(frames, now_kst, now_utc) == ["202609291425", "202609291435"]

    # 간격 경계: 마지막 시도가 정확히 4분 전이면 받는다. 처음 받은 시각보다 나중의 다시 받기 시도가 마지막 시도다.
    def spaced(minutes_ago: float) -> list[dict]:
        at = _iso(now_utc - timedelta(minutes=minutes_ago))
        return annotate_partial([_entry("202609291440", 15), _entry("202609291445", 7, refetched_at=at)])  # 처음 받은 뒤 6분 20초

    assert select_refetch(spaced(4), now_kst, now_utc) == ["202609291445"]
    assert select_refetch(spaced(3.9), now_kst, now_utc) == []
    recent = annotate_partial([_entry("202609291445", 15), _entry("202609291450", 7, fetched_after_s=60 * 2)])
    assert select_refetch(recent, now_kst, now_utc) == []  # 14:52 에 받았다 — 3분 전


def test_refetch_takes_the_least_refetched_first_then_the_longest_waiting_then_the_oldest_tm():
    """주기당 2개를 공정하게: 다시 받은 횟수가 적은 것 → 마지막 시도가 오래된 것 → 오래된 tm. 오래된 두 프레임이 계속 부분 합성이어도
    새 부분 합성 프레임이 기한 끝까지 밀려나지 않는다('기한까지 다시 받기 대상' 이 빈말이 되지 않게)."""
    from wakeline_collector.kma_rules import annotate_partial, select_refetch

    now_utc = _utc_of("202609291418", 40)
    at = lambda m: _iso(_utc_of("202609291413", 40) + timedelta(minutes=m))  # noqa: E731
    frames = annotate_partial(
        [
            _entry("202609291350", 15),
            _entry("202609291355", 15),
            _entry("202609291400", 14, refetches=2, refetched_at=at(0)),
            _entry("202609291405", 14, refetches=1, refetched_at=at(0)),
            _entry("202609291410", 14, refetches=0),  # 14:13:40 에 처음 받음 — 다시 받은 적 없다
        ]
    )
    assert select_refetch(frames, _tm("202609291418") + timedelta(seconds=40), now_utc) == ["202609291410", "202609291405"]


async def test_one_radar_offline_every_partial_frame_is_first_refetched_one_spacing_after_its_first_look(env):
    """리뷰 모의(한 지점이 14:00 부터 꺼져 14:xx 프레임이 계속 14/15): 오래된 tm 부터 고르면 14:00 · 14:05 가 주기마다 두 자리를 차지해
    14:10–14:25 는 tm + 23.7분에야 처음 다시 받았다. 이제는 모든 부분 합성 프레임이 처음 받은 뒤 첫 가능한 주기(tm + 8분 40초)에 다시 받는다."""
    mod, r, ctx, clock = env
    await _seed(mod, r, [_entry("202609291350", 15), _entry("202609291355", 15)])
    tms = [f"2026092914{m:02d}" for m in range(0, 35, 5)]
    prov = SitesKma(clock, ["202609291350", "202609291355"], {t: [14] for t in tms})
    job = mod.KmaRadarJob(prov, ctx)
    first_refetch: dict[str, datetime] = {}
    for tm in tms:
        clock["set"](tm, 3 * 60 + 40)  # 새 tm 을 처음 받는 주기(tm + 3분 40초)
        prov.listing.append(tm)
        before = len(prov.binaries)
        await job.run_once()
        assert prov.binaries[before] == tm  # 정규 후보가 먼저
        for again in prov.binaries[before + 1 :]:
            first_refetch.setdefault(again, clock["kst"])
    for tm in tms[:-1]:  # 마지막 tm 은 다음 주기가 없다
        assert first_refetch[tm] - _tm(tm) == timedelta(minutes=8, seconds=40), tm


def test_refetch_headroom_is_the_regular_share_until_utc_midnight_at_three_calls_per_cycle():
    """정규 주기 몫 = (남은 초 // 주기 + 1) × 3(목록 1 + 새 프레임 1 + 일시 오류 다시 부르기 1 — 선택값). 기상 작업과 같은 규칙(budget.regular_headroom)."""
    from wakeline_collector.budget import regular_headroom
    from wakeline_collector.jobs.kma_radar import refetch_headroom
    from wakeline_collector.kma_rules import REGULAR_CALLS_PER_CYCLE

    assert REGULAR_CALLS_PER_CYCLE == 3
    midnight = datetime(2026, 9, 29, 0, 0, tzinfo=UTC)
    assert refetch_headroom(midnight, 300) == (86400 // 300 + 1) * 3 == 867
    assert refetch_headroom(datetime(2026, 9, 29, 23, 58, tzinfo=UTC), 300) == 3
    assert refetch_headroom(midnight, 300) == regular_headroom(((300, 3),), midnight)


# ---- 다시 받기: 작업 흐름 --------------------------------------------------------------------------------------------------
async def _seed(mod, r, entries: list[dict]) -> list[dict]:
    """저장된 상태를 만든다: 목록(판정 포함) · 이미지 · meta(최신 프레임)."""
    from wakeline_collector.kma_rules import annotate_partial

    for e in entries:
        await r.set(mod.KEY_FRAME.format(tm=e["tm"]), f"old-{e['tm']}", ex=mod.FRAME_TTL_S)
        e.setdefault("expires_at", _iso(datetime.now(UTC) + timedelta(hours=3)))
        e.setdefault("refetches", 0)
        e.setdefault("upgrades", 0)
    annotate_partial(entries)
    await r.set(mod.KEY_FRAMES, orjson.dumps(entries).decode(), ex=mod.FRAME_TTL_S)
    last = entries[-1]
    await r.hset(
        mod.KEY_META,
        mapping={
            "available": "1",
            "latest_tm": last["tm"],
            "fetched_at": last["fetched_at"],
            "stations": str(last.get("stations", "")),
            "partial": "1" if last.get("partial") else "0",
        },
    )
    return entries


async def _stored(mod, r) -> dict[str, dict]:
    return {f["tm"]: f for f in orjson.loads(await r.get(mod.KEY_FRAMES))}


def _runs(ctx) -> list[dict]:
    runs: list[dict] = []
    real = ctx.db.record_run

    def rec(job, provider, started_at, **kw):
        runs.append(kw)
        real(job, provider, started_at, **kw)

    ctx.db.record_run = rec
    return runs


async def test_partial_frame_is_replaced_when_the_refetch_has_more_sites(env):
    mod, r, ctx, clock = env
    seeded = await _seed(
        r=r, mod=mod, entries=[_entry("202609291440", 7), _entry("202609291445", 15), _entry("202609291450", 15)]
    )
    before_meta = await r.hgetall(mod.KEY_META)
    runs = _runs(ctx)
    prov = SitesKma(clock, [e["tm"] for e in seeded], {"202609291440": [15]})
    job = mod.KmaRadarJob(prov, ctx)
    await job.run_once()
    assert prov.binaries == ["202609291440"]  # 정규 후보 없음 · 부분 합성 1개만 다시 받았다
    f = (await _stored(mod, r))["202609291440"]
    assert (f["stations"], f["stations_ref"], f["partial"]) == (15, 15, False)
    assert f["station_ids"] == [f"K{i:02d}" for i in range(15)]
    assert f["echo_cells"] == 15000 and f["raw_ref"] == "raw/kma_radar/1"  # 새 원본만 보관한다
    assert f["fetched_at"] == f["refetched_at"] == _iso(clock["utc"])
    assert (f["refetches"], f["upgrades"]) == (1, 1)
    assert datetime.fromisoformat(f["expires_at"]) > datetime.fromisoformat(seeded[0]["expires_at"])  # 영상 TTL 을 새로
    assert await r.get(mod.KEY_FRAME.format(tm="202609291440")) != "old-202609291440"
    # 최신 프레임이 아니므로 meta 의 헤더 값 · fetched_at 은 그대로(latest_tm 을 설명한다)
    meta = await r.hgetall(mod.KEY_META)
    assert (meta["latest_tm"], meta["fetched_at"]) == ("202609291450", before_meta["fetched_at"])
    assert [run["status"] for run in runs] == ["ok"] and runs[0]["records_in"] == 0
    assert (await ctx.budget.usage("kma_radar"))[0] == 1 + 1  # 목록 1 + 다시 받기 1
    hb = await r.hgetall("wakeline:collector")
    assert (hb["radar_kr_refetches"], hb["radar_kr_upgrades"], hb["radar_kr_partial"]) == ("1", "1", "0")


async def test_refetch_runs_after_the_regular_candidates(env):
    mod, r, ctx, clock = env
    seeded = await _seed(mod, r, [_entry("202609291440", 7), _entry("202609291445", 15), _entry("202609291450", 15)])
    clock["set"]("202609291458", 40)
    prov = SitesKma(clock, [*(e["tm"] for e in seeded), "202609291455"], {"202609291440": [15], "202609291455": [15]})
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.binaries == ["202609291455", "202609291440"]


async def test_upgrading_the_latest_frame_updates_the_meta_that_describes_it(env):
    mod, r, ctx, clock = env
    seeded = await _seed(mod, r, [_entry("202609291440", 15), _entry("202609291445", 15), _entry("202609291450", 7)])
    assert (await r.hgetall(mod.KEY_META))["partial"] == "1"
    clock["set"]("202609291458")  # 14:50 을 받은 뒤 4분 20초
    prov = SitesKma(clock, [e["tm"] for e in seeded], {"202609291450": [12]})
    await mod.KmaRadarJob(prov, ctx).run_once()
    meta = await r.hgetall(mod.KEY_META)
    assert (meta["latest_tm"], meta["stations"], meta["stations_ref"], meta["partial"]) == ("202609291450", "12", "15", "1")
    assert meta["station_ids"] == ",".join(f"K{i:02d}" for i in range(12))
    assert meta["product"] == "HSR" and meta["observed_cells"] == "1"  # 헤더 값은 보이는 영상의 것
    f = (await _stored(mod, r))["202609291450"]
    assert f["fetched_at"] == f["refetched_at"] == _iso(clock["utc"])  # 보이는 영상을 받은 시각은 프레임 항목에
    # meta fetched_at 은 STALE 시계(REL-19: API meta.stale · 웹 KMA STALE 이 이 값의 나이 > 900 s 로 뜬다) — latest_tm 을 처음 저장한 시각 그대로
    assert meta["fetched_at"] == seeded[-1]["fetched_at"]


async def test_a_stalled_latest_tm_still_goes_stale_while_its_partial_frame_keeps_being_upgraded(env):
    """기상청이 새 tm 을 올리지 않고(목록에 없음) 마지막 부분 합성 프레임만 채우는 경우: 다시 받아 바꿔도 STALE 시계는 tm + 3분 40초에 멈춰 있다 —
    tm + 19분에는 이미 STALE(> 900 s), tm + 28분에 또 바꿔도 그대로다(옛 프레임이 지금 것처럼 보이지 않는다)."""
    mod, r, ctx, clock = env
    seeded = await _seed(mod, r, [_entry("202609291440", 15), _entry("202609291445", 15), _entry("202609291450", 5)])
    first = datetime.fromisoformat(seeded[-1]["fetched_at"])
    prov = SitesKma(clock, [e["tm"] for e in seeded], {"202609291450": [7, 9, 11, 13]})
    job = mod.KmaRadarJob(prov, ctx)
    for minutes in (8, 13, 19, 28):  # tm + 분 — 다시 받을 때마다 지점이 늘어 바꾼다
        clock["set"]("202609291450", minutes * 60 + 40)
        await job.run_once()
        meta = await r.hgetall(mod.KEY_META)
        age = (clock["utc"] - datetime.fromisoformat(meta["fetched_at"])).total_seconds()
        assert meta["fetched_at"] == seeded[-1]["fetched_at"] and age == (clock["utc"] - first).total_seconds()
        assert (age > 900) == (minutes >= 19), minutes
    assert prov.binaries == ["202609291450"] * 4 and job.upgrades == 4
    assert (await _stored(mod, r))["202609291450"]["stations"] == 13


async def test_refetch_with_the_same_or_fewer_sites_keeps_the_stored_frame_and_waits_4_min(env, caplog):
    caplog.set_level(logging.INFO, logger="job.kma_radar")
    mod, r, ctx, clock = env
    seeded = await _seed(mod, r, [_entry("202609291440", 7), _entry("202609291445", 15), _entry("202609291450", 15)])
    prov = SitesKma(clock, [e["tm"] for e in seeded], {"202609291440": [7, 5, 5]})
    job = mod.KmaRadarJob(prov, ctx)
    await job.run_once()
    f = (await _stored(mod, r))["202609291440"]
    assert (f["stations"], f["echo_cells"], f["fetched_at"], f["raw_ref"]) == (
        7,
        1000,
        seeded[0]["fetched_at"],
        "raw/202609291440",
    )
    assert (f["refetches"], f["upgrades"], f["refetched_at"]) == (1, 0, _iso(clock["utc"]))
    assert await r.get(mod.KEY_FRAME.format(tm="202609291440")) == "old-202609291440"
    assert ctx.raw.n == 0  # 쓰지 않은 원본은 보관하지 않는다
    assert any("refetch tm=202609291440" in m and "kept" in m for m in caplog.messages)
    clock["set"]("202609291457", 59)  # 3분 59초 뒤 — 아직 다시 받지 않는다
    await job.run_once()
    assert prov.binaries == ["202609291440"]
    clock["set"]("202609291459")  # 4분 뒤
    await job.run_once()
    assert prov.binaries == ["202609291440", "202609291440"]
    f = (await _stored(mod, r))["202609291440"]
    assert (f["stations"], f["refetches"], f["upgrades"], f["partial"]) == (7, 2, 0, True)  # 5곳 — 줄어든 자료로 바꾸지 않는다
    hb = await r.hgetall("wakeline:collector")
    assert (hb["radar_kr_refetches"], hb["radar_kr_upgrades"], hb["radar_kr_partial"]) == ("2", "0", "1")


async def test_frames_older_than_30_min_are_not_refetched_and_at_most_two_per_cycle_oldest_first(env):
    mod, r, ctx, clock = env
    tms = ["202609291415", "202609291420", "202609291425", "202609291430", "202609291435", "202609291440"]
    seeded = await _seed(mod, r, [_entry(tms[0], 15), *(_entry(t, 7) for t in tms[1:])])
    clock["set"]("202609291451")  # 14:20 은 31분 — 다시 받지 않는다
    prov = SitesKma(clock, [e["tm"] for e in seeded], {t: [7] for t in tms[1:]})
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.binaries == ["202609291425", "202609291430"]
    assert (await ctx.budget.usage("kma_radar"))[0] == 1 + 2


def _refetch_errors():
    import httpx

    from wakeline_collector.http import ProviderHttpError, ResponseTooLarge

    return {
        "read-timeout": (httpx.ReadTimeout(""), 1),  # 보낸 뒤 실패 — 보낸 호출로 센다
        "connect": (httpx.ConnectError("refused"), 0),  # 보내지 않았다 — 예산을 돌려준다
        "http-503": (ProviderHttpError(503, "Service Unavailable"), 1),
        "not-gzip": (ValueError("not gzip: '# file not exist'"), 1),
        "too-large": (ResponseTooLarge("body over 8 MB"), 1),
        "unexpected": (RuntimeError("boom"), 1),
    }


@pytest.mark.parametrize("case", list(_refetch_errors()))
async def test_refetch_errors_are_info_never_retried_and_do_not_end_the_cycle(env, caplog, case):
    caplog.set_level(logging.INFO, logger="job.kma_radar")
    mod, r, ctx, clock = env
    error, sent = _refetch_errors()[case]
    seeded = await _seed(mod, r, [_entry("202609291440", 7), _entry("202609291445", 9), _entry("202609291450", 15)])
    runs = _runs(ctx)
    prov = SitesKma(clock, [e["tm"] for e in seeded], {"202609291445": [15]}, errors={"202609291440": [error]})
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.binaries == ["202609291440", "202609291445"]  # 다시 부르지 않고 다음 프레임으로 넘어간다
    warns = [x.getMessage() for x in caplog.records if x.name == "job.kma_radar" and x.levelno >= logging.WARNING]
    assert warns == []
    assert any(m.startswith("kma radar: refetch tm=202609291440") for m in caplog.messages)
    stored = await _stored(mod, r)
    assert (stored["202609291440"]["stations"], stored["202609291440"]["refetches"]) == (7, 1)
    assert stored["202609291445"]["stations"] == 15 and stored["202609291445"]["upgrades"] == 1
    assert [run["status"] for run in runs] == ["ok"]
    assert "last_error" not in await r.hgetall("wakeline:provider:kma_radar")  # 다시 받기 실패는 공급자 실패가 아니다
    assert (await ctx.budget.usage("kma_radar"))[0] == 1 + sent + 1


async def test_a_decode_error_on_refetch_keeps_the_stored_frame(env, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="job.kma_radar")
    mod, r, ctx, clock = env

    def broken(raw: bytes, have: int):
        raise ValueError("data block truncated")

    monkeypatch.setattr(mod, "_decode_if_more", broken)
    seeded = await _seed(mod, r, [_entry("202609291440", 7), _entry("202609291450", 15)])
    await mod.KmaRadarJob(SitesKma(clock, [e["tm"] for e in seeded]), ctx).run_once()
    f = (await _stored(mod, r))["202609291440"]
    assert (f["stations"], f["refetches"], f["upgrades"]) == (7, 1, 0)
    assert not [x for x in caplog.records if x.name == "job.kma_radar" and x.levelno >= logging.WARNING]


class _FramesFailing:
    """job._frames 를 감싸 n 번째 호출(1 부터)에서 Redis 오류를 낸다: 1 prune · 2 다시 받기 고르기 · 3 시도 기록 · 4 끝난 뒤 세기."""

    def __init__(self, job, fail_on: set[int]):
        from redis.exceptions import ConnectionError as RedisConnectionError

        self.real, self.fail_on, self.n, self.err = job._frames, fail_on, 0, RedisConnectionError
        job._frames = self

    async def __call__(self):
        self.n += 1
        if self.n in self.fail_on:
            raise self.err("redis down (test)")
        return await self.real()


@pytest.mark.parametrize(
    ("fail_on", "refetched", "partial_hb"),
    [({2}, [], ""), ({3}, ["202609291440"], "1"), ({4}, ["202609291440"], "")],
    ids=["reading-the-list-to-choose", "reading-the-list-to-record", "counting-afterwards"],
)
async def test_redis_errors_during_refetch_keep_the_cycle_ok(env, caplog, fail_on, refetched, partial_hb):
    """다시 받기 중 목록을 못 읽으면: INFO 한 줄 · 주기는 'ok' · 공급자 실패 아님 · heartbeat 의 부분 합성 수는 모름(빈 값 — 0 이 아니다)."""
    caplog.set_level(logging.INFO, logger="job.kma_radar")
    mod, r, ctx, clock = env
    seeded = await _seed(mod, r, [_entry("202609291440", 7), _entry("202609291445", 15), _entry("202609291450", 15)])
    runs = _runs(ctx)
    prov = SitesKma(clock, [e["tm"] for e in seeded], {"202609291440": [15]})
    job = mod.KmaRadarJob(prov, ctx)
    frames = _FramesFailing(job, fail_on)
    await job.run_once()
    assert frames.n >= max(fail_on)
    assert prov.binaries == refetched
    assert [run["status"] for run in runs] == ["ok"]
    assert "last_error" not in await r.hgetall("wakeline:provider:kma_radar")
    assert not [x for x in caplog.records if x.name == "job.kma_radar" and x.levelno >= logging.WARNING]
    assert (await r.hgetall("wakeline:collector"))["radar_kr_partial"] == partial_hb
    if 3 in fail_on:  # 시도를 기록하지 못했다 — 저장본(영상 · 항목)을 그대로 둔다
        assert await r.get(mod.KEY_FRAME.format(tm="202609291440")) == "old-202609291440"
        assert (await _stored(mod, r))["202609291440"]["stations"] == 7 and job.upgrades == 0


async def test_an_image_write_error_on_upgrade_keeps_the_stored_frame_and_the_cycle_ok(env, caplog):
    caplog.set_level(logging.INFO, logger="job.kma_radar")
    from redis.exceptions import ConnectionError as RedisConnectionError

    mod, r, ctx, clock = env
    seeded = await _seed(mod, r, [_entry("202609291440", 7), _entry("202609291445", 15), _entry("202609291450", 15)])
    runs = _runs(ctx)
    real_set = r.set

    async def set_failing_images(key, value, ex=None):
        if key.startswith("wakeline:radar_kr:frame:"):
            raise RedisConnectionError("redis down (test)")
        return await real_set(key, value, ex=ex)

    r.set = set_failing_images  # type: ignore[method-assign]
    job = mod.KmaRadarJob(SitesKma(clock, [e["tm"] for e in seeded], {"202609291440": [15]}), ctx)
    await job.run_once()
    f = (await _stored(mod, r))["202609291440"]
    assert (f["stations"], f["partial"], f["fetched_at"]) == (7, True, seeded[0]["fetched_at"])  # 항목은 옛 영상을 말한다
    assert await r.get(mod.KEY_FRAME.format(tm="202609291440")) == "old-202609291440"
    assert (job.refetch_attempts, job.upgrades) == (1, 0)
    assert [run["status"] for run in runs] == ["ok"]
    assert any("refetch tm=202609291440" in m and "kept the stored frame" in m for m in caplog.messages)
    assert not [x for x in caplog.records if x.name == "job.kma_radar" and x.levelno >= logging.WARNING]


async def test_a_frame_dropped_from_the_list_while_refetching_is_not_written_back(env):
    """다시 받는 사이 목록에서 빠진 프레임(보관 창에서 밀림 · 이미지 만료로 정리)은 영상도 항목도 다시 만들지 않는다 — 목록에 없는 영상을 두지 않는다."""
    mod, r, ctx, clock = env
    seeded = await _seed(mod, r, [_entry("202609291440", 7), _entry("202609291445", 15), _entry("202609291450", 15)])

    class DroppingKma(SitesKma):
        async def binary(self, tm):
            kept = [f for f in orjson.loads(await r.get(mod.KEY_FRAMES)) if f["tm"] != tm]
            await r.set(mod.KEY_FRAMES, orjson.dumps(kept).decode(), ex=mod.FRAME_TTL_S)
            await r.delete(mod.KEY_FRAME.format(tm=tm))
            return await super().binary(tm)

    runs = _runs(ctx)
    job = mod.KmaRadarJob(DroppingKma(clock, [e["tm"] for e in seeded], {"202609291440": [15]}), ctx)
    await job.run_once()
    assert "202609291440" not in await _stored(mod, r)
    assert await r.get(mod.KEY_FRAME.format(tm="202609291440")) is None
    assert (job.refetch_attempts, job.upgrades) == (1, 0)
    assert [run["status"] for run in runs] == ["ok"]


async def test_refetch_never_takes_the_regular_schedules_share_of_the_budget(env, caplog):
    """다시 받기 예약은 사용량 + 1 ≤ 한도 − 정규 주기 몫(남은 하루)일 때만. 경계에서 한 번은 되고 다음은 안 된다 — 정규 호출은 그대로 한다."""
    caplog.set_level(logging.INFO, logger="job.kma_radar")
    mod, r, ctx, clock = env
    share = mod.refetch_headroom(clock["utc"])
    assert share == ((datetime(2026, 9, 30, tzinfo=UTC) - clock["utc"]).seconds // 300 + 1) * 3
    ok, _ = await ctx.budget.reserve("kma_radar", 1000 - share - 2)  # 목록 1 을 쓰면 경계 − 1
    assert ok
    seeded = await _seed(mod, r, [_entry("202609291440", 7), _entry("202609291445", 7), _entry("202609291450", 15)])
    prov = SitesKma(clock, [e["tm"] for e in seeded], {"202609291440": [15], "202609291445": [15]})
    await mod.KmaRadarJob(prov, ctx).run_once()
    assert prov.list_calls == 1 and prov.binaries == ["202609291440"]
    assert (await ctx.budget.usage("kma_radar"))[0] == 1000 - share
    assert any("refetch" in m and "budget" in m for m in caplog.messages)
    assert not [x for x in caplog.records if x.name == "job.kma_radar" and x.levelno >= logging.WARNING]


async def test_heartbeat_counts_partial_frames_stored_refetches_and_upgrades(env):
    mod, r, ctx, clock = env
    clock["set"]("202609291448", 40)
    prov = SitesKma(clock, ["202609291440", "202609291445"], {"202609291440": [15], "202609291445": [7, 12]})
    job = mod.KmaRadarJob(prov, ctx)
    await job.run_once()  # 15곳 · 7곳 저장 — 1개 부분 합성
    hb = await r.hgetall("wakeline:collector")
    assert (hb["radar_kr_partial"], hb["radar_kr_partial_stored"], hb["radar_kr_refetches"], hb["radar_kr_upgrades"]) == (
        "1",
        "1",
        "0",
        "0",
    )
    clock["set"]("202609291453", 40)
    await job.run_once()  # 14:45 를 다시 받아 12곳 — 늘었으니 바꾸지만 아직 부분 합성
    hb = await r.hgetall("wakeline:collector")
    assert (hb["radar_kr_partial"], hb["radar_kr_partial_stored"], hb["radar_kr_refetches"], hb["radar_kr_upgrades"]) == (
        "1",
        "1",
        "1",
        "1",
    )
