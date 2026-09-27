import gzip
import io
import math
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from skywx_collector.kma_grid import HEADER_BYTES, NULL_OUTSIDE, parse_header, read_echo, render_mercator_png
from skywx_collector.providers.kma_radar import kst_now, parse_file_list

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
