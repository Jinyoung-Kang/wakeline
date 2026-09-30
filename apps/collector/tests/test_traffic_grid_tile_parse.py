"""격자4단계 WFS bbox 응답 해석(ADR-023 2026-10-01 bbox 개정) — 한 번에 여러 지물: 지물마다 한 칸 조회와 같은 검사(grid_no 형식 · 다각형 하나 ·
안쪽 고리 없음 · EPSG:5179 → WGS84 · 0.025° 격자), 잘렸을 수 있는 응답(maxFeatures 에 닿음 · numberOfFeatures 와 지물 수가 다름) 표시,
크기 상한, 나쁜 지물 하나는 그 지물만. 실제 응답 모양(fixtures/mof_grid4_wfs_GR4_F2K41_C3.xml) 그대로 만든 합성 응답만 쓴다(tests/wfs_tiles)."""

from __future__ import annotations

import pytest
from wfs_tiles import FIX, FakeGrid, collection, extent, feature, ring

from wakeline_collector.marine_grid import (
    MAX_WFS_BYTES,
    MAX_WFS_TILE_BYTES,
    TILE_MAX_FEATURES,
    Cell,
    WfsError,
    WfsTooLarge,
    parse_wfs,
    parse_wfs_tile,
)

VERIFIED_10KM = (916000, 1935000, 926000, 1945000)  # 2026-10-01 실제 호출 — 28칸 · 18,635 B
VERIFIED_50KM = (896000, 1915000, 946000, 1965000)  # 2026-10-01 실제 호출 — 450칸 · 289,093 B


def grid_feats(n: int, lat0: float = 37.4, lon0: float = 126.5) -> list[tuple[str, float, float, int]]:
    out = []
    for k in range(n):
        lat, lon = round(lat0 + (k // 20) * 0.025, 3), round(lon0 + (k % 20) * 0.025, 3)
        out.append((f"GR4_T{k:04d}", lat, lon, 1000 + k))
    return out


def body_of(feats, declared=None, **kw) -> bytes:
    return collection([feature(g, la, lo, gid, **kw) for g, la, lo, gid in feats], declared)


# ---- 모형과 확인한 응답 -----------------------------------------------------------------------------------------------------


def test_the_fake_server_reproduces_both_verified_bbox_responses():
    """합성 서버(칸이 빈틈없이 깔렸고 bbox 는 겹치는 칸을 모두 준다 — 가정)가 확인한 두 호출과 같은 수 · 거의 같은 크기를 낸다 — 아래 크기
    계산(ADR-023 개정)은 이 모형으로 한다."""
    g = FakeGrid()
    small, big = g.body(VERIFIED_10KM), g.body(VERIFIED_50KM)
    assert len(g.cells_in(VERIFIED_10KM)) == 28 and len(g.cells_in(VERIFIED_50KM)) == 450
    assert abs(len(small) - 18_635) / 18_635 < 0.02 and abs(len(big) - 289_093) / 289_093 < 0.02
    t = parse_wfs_tile(big)
    assert (len(t.cells), t.declared, t.members, t.truncation) == (450, 450, 450, None)


def test_one_feature_is_641_bytes_like_the_real_one():
    real = FIX.read_bytes()
    one = collection([feature("GR4_F2K41_C3", 37.45, 126.6, 167305)])
    assert len(real) == 1354 and abs(len(one) - len(real)) <= 4  # 좌표 끝자리만 다르다(합성 꼭짓점)


def test_the_size_bound_holds_a_32km_tile_with_room_and_refuses_beyond():
    """ADR-023 개정의 계산: 32 km 타일은 모형으로 176–201칸 · 113–129 KB. 상한 384 KiB(393,216 B)는 가장 큰 32 km 타일의 약 3배이고 확인한 가장
    큰 응답(289,093 B)보다 크다 — 넘으면 해석하지 않는다(WfsTooLarge — 작업은 타일을 넷으로 나눈다)."""
    assert MAX_WFS_TILE_BYTES == 384 * 1024 and TILE_MAX_FEATURES == 1000 and MAX_WFS_BYTES == 256 * 1024
    from wakeline_collector.marine_grid import wgs84_to_tm5179

    g = FakeGrid()
    worst = 0
    for lat in (33.0, 34.5, 36.0, 37.5, 38.9):
        for lon in (124.5, 126.0, 128.0, 130.5, 131.8):
            x, y = wgs84_to_tm5179(lat, lon)
            x0, y0 = (x // 32000) * 32000, (y // 32000) * 32000
            worst = max(worst, len(g.body((x0, y0, x0 + 32000, y0 + 32000))))
    assert 110_000 < worst < 135_000 and worst * 2.9 < MAX_WFS_TILE_BYTES
    with pytest.raises(WfsTooLarge, match="too large"):
        parse_wfs_tile(b"<a>" + b" " * MAX_WFS_TILE_BYTES + b"</a>")
    assert issubclass(WfsTooLarge, WfsError)


# ---- 여러 지물 ---------------------------------------------------------------------------------------------------------------


def test_many_features_become_validated_cells_with_their_projected_extent():
    feats = grid_feats(28)
    t = parse_wfs_tile(body_of(feats))
    assert (t.declared, t.members, t.truncation) == (28, 28, None)
    assert [tc.cell.grid_no for tc in t.cells] == [g for g, *_ in feats]
    first = t.cells[0]
    assert first.cell == Cell("GR4_T0000", 37.4, 126.5, 37.425, 126.525, 1000)
    ex = extent(37.4, 126.5)
    assert first.extent == pytest.approx(ex, abs=1e-6)  # 받은 꼭짓점 그대로(EPSG:5179) — 타일 가장자리 판정용
    assert t.off_grid == () and t.rejected == ()


def test_the_verified_single_feature_parses_the_same_as_a_one_id_lookup():
    body = FIX.read_bytes()
    t = parse_wfs_tile(body)
    assert [tc.cell for tc in t.cells] == [parse_wfs(body, "GR4_F2K41_C3").cell]
    assert t.truncation is None


def test_an_empty_tile_is_complete_and_holds_no_cells():
    """numberOfFeatures 0 — 그 상자에 칸이 없다는 실제 답이다. 어느 칸 번호도 '해양격자에 없음'이 되지 않는다(칸 번호를 묻지 않았다)."""
    t = parse_wfs_tile(collection([], 0))
    assert (t.cells, t.off_grid, t.rejected, t.declared, t.members, t.truncation) == ((), (), (), 0, 0, None)


# ---- 잘렸을 수 있는 응답 ----------------------------------------------------------------------------------------------------


def test_reaching_max_features_means_possibly_truncated():
    t = parse_wfs_tile(body_of(grid_feats(10)), max_features=10)
    assert len(t.cells) == 10
    assert t.truncation is not None and "maxFeatures 10" in t.truncation


def test_a_count_mismatch_means_possibly_truncated():
    t = parse_wfs_tile(body_of(grid_feats(28), declared=30))
    assert len(t.cells) == 28 and t.truncation is not None and "numberOfFeatures 30" in t.truncation
    t = parse_wfs_tile(body_of(grid_feats(28), declared=27))
    assert t.truncation is not None and "numberOfFeatures 27" in t.truncation


@pytest.mark.parametrize("new", ["", 'numberOfFeatures="unknown" ', 'numberOfFeatures="-1" '])
def test_a_missing_or_non_count_number_of_features_is_an_error(new):
    """확인한 응답은 모두 numberOfFeatures 를 싣는다 — 없거나 수가 아니면 잘렸는지 알 수 없다(짐작하지 않는다)."""
    body = body_of(grid_feats(3)).decode()
    assert 'numberOfFeatures="3" ' in body
    with pytest.raises(WfsError, match="numberOfFeatures"):
        parse_wfs_tile(body.replace('numberOfFeatures="3" ', new).encode())


# ---- 나쁜 지물 ---------------------------------------------------------------------------------------------------------------


def test_a_bad_feature_among_good_ones_is_set_aside_alone():
    feats = grid_feats(6)
    parts = [feature(g, la, lo, gid) for g, la, lo, gid in feats]
    g1, la1, lo1, gid1 = feats[1]
    parts[1] = feature(g1, la1, lo1, gid1, srs="urn:ogc:def:crs:EPSG::5179")  # 모양 오류(다른 srsName) — 그 지물만
    g2, la2, lo2, gid2 = feats[2]
    parts[2] = feature(g2, la2, lo2, gid2, pts=[(x + 50.0, y) for x, y in ring(la2, lo2)])  # 격자 밖 — 격리
    parts.append("<ofbd-DB:opn_grid_4_step_a><ofbd-DB:gid>9</ofbd-DB:gid></ofbd-DB:opn_grid_4_step_a>")  # grid_no · geom 없음
    t = parse_wfs_tile(collection(parts))
    assert [tc.cell.grid_no for tc in t.cells] == [feats[k][0] for k in (0, 3, 4, 5)]
    assert [(g, "off the 0.025" in d) for g, d in t.off_grid] == [(g2, True)]
    assert [(g, ("srsName" in d) or ("grid_no" in d)) for g, d in t.rejected] == [(g1, True), (None, True)]
    assert (t.members, t.declared, t.truncation) == (7, 7, None)


def test_a_malformed_grid_no_is_rejected_not_stored():
    feats = grid_feats(3)
    parts = [feature(g, la, lo, gid) for g, la, lo, gid in feats]
    parts[0] = feature("GR4 BAD;x", feats[0][1], feats[0][2], 1)
    t = parse_wfs_tile(collection(parts))
    assert [tc.cell.grid_no for tc in t.cells] == ["GR4_T0001", "GR4_T0002"]
    assert t.rejected[0][0] is None and "grid_no" in t.rejected[0][1]


def test_every_feature_rejected_is_an_error_not_an_empty_tile():
    """모든 지물이 모양 오류(예: 공급자가 좌표계 표기를 바꿈)면 '칸 없음'이 아니라 오류다 — 빈 타일로 끝났다고 적지 않는다."""
    body = body_of(grid_feats(5), srs="urn:ogc:def:crs:EPSG::5179")
    with pytest.raises(WfsError, match="all 5 features rejected"):
        parse_wfs_tile(body)


def test_duplicates_collapse_and_conflicting_duplicates_are_rejected():
    feats = grid_feats(3)
    parts = [feature(g, la, lo, gid) for g, la, lo, gid in feats]
    parts.append(parts[0])  # 같은 지물 두 번 — 한 칸
    g2, la2, lo2, gid2 = feats[2]
    parts.append(feature(g2, round(la2 + 0.025, 3), lo2, gid2))  # 같은 번호 · 다른 기하 — 어느 쪽도 쓰지 않는다
    t = parse_wfs_tile(collection(parts))
    assert [tc.cell.grid_no for tc in t.cells] == ["GR4_T0000", "GR4_T0001"]
    assert [g for g, _d in t.rejected] == [g2] and "different geometry" in t.rejected[0][1]


# ---- 응답 전체 ---------------------------------------------------------------------------------------------------------------


def test_doctype_error_documents_and_non_gml_are_errors():
    with pytest.raises(WfsError, match="DOCTYPE"):
        parse_wfs_tile(b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><wfs:FeatureCollection numberOfFeatures="0"/>')
    with pytest.raises(WfsError, match="InvalidParameterValue"):
        parse_wfs_tile(
            b'<ServiceExceptionReport><ServiceException code="InvalidParameterValue">bbox</ServiceException></ServiceExceptionReport>'
        )
    for bad in (b"", b"<html></html>", b"{}", b"<a><b></a>"):
        with pytest.raises(WfsError):
            parse_wfs_tile(bad)


def test_a_feature_outside_feature_members_is_an_error():
    body = FIX.read_text().replace("<gml:featureMembers>", "").replace("</gml:featureMembers>", "").encode()
    with pytest.raises(WfsError, match="outside"):
        parse_wfs_tile(body)
