"""기상청 레이더 합성자료(RDR_CMP_HSR) 바이너리 해석과 웹 메르카토르 재투영(FR-31).

출처(2026-09-27 확인):
- 포맷: API허브 첨부 "레이더 합성자료 포맷 정보" — 헤더 1024 B(RDR_CMP_HEAD 64 B + STN_LIST 20 B × 48), 반사도 short×nx×ny,
  값 = dBZ×100, -20000 표시 최소, -25000 관측영역 내 비관측, -30000 관측반경 밖. 지도 HB: LCC, 기준 N38 E126, 기준 격자점 (1121, 1681), 500 m.
- 투영: 기상기후데이터위키 "레이더:기상레이더" 6.3 —
  "+proj=lcc +lat_1=30 +lat_2=60 +lat_0=38 +lon_0=126 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs",
  Affine.scale(500, 500) * Affine.translation(-1121, -1681) (행 0 이 남쪽, 열 0 이 서쪽).
격자점 중심/모서리 관습 차이(≤ 250 m)는 500 m 해상도 아래이므로 무시하고 위 정의를 그대로 쓴다.
"""

from __future__ import annotations

import gzip
import io
import struct
from dataclasses import dataclass
from datetime import datetime

import numpy as np
from PIL import Image
from pyproj import Transformer

LCC = "+proj=lcc +lat_1=30 +lat_2=60 +lat_0=38 +lon_0=126 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs"
REF_COL, REF_ROW, RES_M = 1121, 1681, 500.0
HEADER_BYTES = 1024
NULL_OUTSIDE, NULL_UNOBSERVED, DISPLAY_MIN = -30000, -25000, -20000
PTYPE_NAMES = {
    0: "PPI0",
    1: "CAPPI",
    2: "CMAX",
    3: "ETOP",
    4: "EBASE",
    5: "HSR",
    6: "HCI",
    7: "VIL",
    8: "WIND",
    9: "LNG",
    10: "PCP",
    15: "NUM",
}

# 반사도(dBZ) 색상 램프 — 값 구간은 표시용 선택이며(자료가 아님) 범례에 그대로 표기한다.
DBZ_STOPS: list[tuple[float, tuple[int, int, int, int]]] = [
    (5, (120, 190, 255, 150)),
    (10, (60, 150, 255, 170)),
    (15, (0, 200, 120, 180)),
    (20, (0, 160, 0, 190)),
    (25, (200, 220, 0, 200)),
    (30, (255, 190, 0, 210)),
    (35, (255, 120, 0, 220)),
    (40, (255, 40, 0, 230)),
    (45, (200, 0, 60, 235)),
    (50, (160, 0, 160, 240)),
    (55, (120, 60, 220, 245)),
    (65, (255, 255, 255, 255)),
]


@dataclass
class Header:
    version: int
    ptype: int
    tm: datetime
    tm_in: datetime
    num_stn: int
    map_code: int
    nx: int
    ny: int
    nz: int
    dxy: int
    num_data: int
    data_code: list[int]
    stations: list[str]

    @property
    def product(self) -> str:
        return PTYPE_NAMES.get(self.ptype, str(self.ptype))


def _time_ss(b: bytes) -> datetime:
    yy, mm, dd, hh, mi, ss = struct.unpack("<HBBBBB", b)
    return datetime(yy, mm, dd, hh, mi, min(ss, 59))


def parse_header(buf: bytes) -> Header:
    if len(buf) < HEADER_BYTES:
        raise ValueError("header too short")
    version, ptype = buf[0], struct.unpack_from("<h", buf, 1)[0]
    tm, tm_in = _time_ss(buf[3:10]), _time_ss(buf[10:17])
    num_stn, map_code = buf[17], buf[18]
    nx, ny, nz, dxy, _dz, _zmin = struct.unpack_from("<hhhhhh", buf, 20)
    num_data = buf[32]
    data_code = [c for c in buf[33:49] if c]
    stations = []
    for i in range(min(num_stn, 48)):
        off = 64 + 20 * i
        code = buf[off : off + 6].split(b"\0")[0].decode("ascii", "replace").strip()
        if code:
            stations.append(code)
    return Header(version, ptype, tm, tm_in, num_stn, map_code, nx, ny, nz, dxy, num_data, data_code, stations)


def read_echo(gz_bytes: bytes) -> tuple[Header, np.ndarray]:
    """첫 자료블록(반사도, dBZ×100)을 (ny, nx) int16 배열로. 행 0 = 남쪽."""
    raw = gzip.decompress(gz_bytes)
    h = parse_header(raw)
    if h.map_code != 1 or h.dxy != int(RES_M):
        raise ValueError(f"unsupported map_code={h.map_code} dxy={h.dxy}")
    n = h.nx * h.ny
    if len(raw) < HEADER_BYTES + n * 2:
        raise ValueError("data block truncated")
    grid = np.frombuffer(raw, dtype="<i2", count=n, offset=HEADER_BYTES).reshape(h.ny, h.nx)
    return h, grid


def lcc_extent(h: Header) -> tuple[float, float, float, float]:
    """(xmin, ymin, xmax, ymax) in LCC metres."""
    return (-REF_COL * RES_M, -REF_ROW * RES_M, (h.nx - REF_COL) * RES_M, (h.ny - REF_ROW) * RES_M)


def mercator_bounds(h: Header) -> tuple[float, float, float, float]:
    """격자 네 변을 따라 투영해 웹 메르카토르(EPSG:3857) 축 정렬 경계를 구한다."""
    xmin, ymin, xmax, ymax = lcc_extent(h)
    to_merc = Transformer.from_crs(LCC, "EPSG:3857", always_xy=True)
    xs = np.concatenate([np.linspace(xmin, xmax, 200), np.full(200, xmax), np.linspace(xmax, xmin, 200), np.full(200, xmin)])
    ys = np.concatenate([np.full(200, ymin), np.linspace(ymin, ymax, 200), np.full(200, ymax), np.linspace(ymax, ymin, 200)])
    mx, my = to_merc.transform(xs, ys)
    return float(mx.min()), float(my.min()), float(mx.max()), float(my.max())


def render_mercator_png(
    h: Header, grid: np.ndarray, width: int = 1152, min_dbz: float = 5.0, mask_alpha: int = 22
) -> tuple[bytes, dict]:
    """웹 메르카토르 축 정렬 RGBA PNG 와 그 경계(lon/lat 네 모서리)를 만든다. 최근접 표본화."""
    bx0, by0, bx1, by1 = mercator_bounds(h)
    height = int(round(width * (by1 - by0) / (bx1 - bx0)))
    px = bx0 + (np.arange(width) + 0.5) * (bx1 - bx0) / width
    py = by1 - (np.arange(height) + 0.5) * (by1 - by0) / height  # 위 → 아래
    mxx, myy = np.meshgrid(px, py)
    to_lcc = Transformer.from_crs("EPSG:3857", LCC, always_xy=True)
    lx, ly = to_lcc.transform(mxx.ravel(), myy.ravel())
    col = np.floor(lx / RES_M + REF_COL).astype(np.int64)
    row = np.floor(ly / RES_M + REF_ROW).astype(np.int64)
    inside = (col >= 0) & (col < h.nx) & (row >= 0) & (row < h.ny)
    vals = np.full(col.shape, NULL_OUTSIDE, dtype=np.int16)
    vals[inside] = grid[row[inside], col[inside]]
    vals = vals.reshape(height, width)

    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    observed = vals > NULL_OUTSIDE  # 관측 반경 안(에코 없음 포함)
    rgba[observed] = (90, 90, 90, mask_alpha)
    dbz = vals.astype(np.float32) / 100.0
    for lo, color in DBZ_STOPS:
        rgba[(dbz >= lo) & (dbz >= min_dbz)] = color
    img = Image.fromarray(rgba, "RGBA")
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)

    to_ll = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
    w, n = to_ll.transform(bx0, by1)
    e, s = to_ll.transform(bx1, by0)
    meta = {
        "width": width,
        "height": height,
        "coordinates": [[w, n], [e, n], [e, s], [w, s]],  # MapLibre image source: TL, TR, BR, BL
        "mercator_bounds": [bx0, by0, bx1, by1],
        "projection": LCC,
        "grid": {"nx": h.nx, "ny": h.ny, "res_m": RES_M, "ref": [REF_COL, REF_ROW]},
        "min_dbz": min_dbz,
        "legend": [[lo, list(c[:3])] for lo, c in DBZ_STOPS],
        "echo_cells": int(((grid > DISPLAY_MIN) & (grid.astype(np.float32) / 100.0 >= min_dbz)).sum()),
        "observed_cells": int((grid > NULL_OUTSIDE).sum()),
    }
    return out.getvalue(), meta
