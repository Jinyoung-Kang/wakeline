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

import io
import math
import struct
import zlib
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache

import numpy as np
from PIL import Image
from pyproj import Transformer

from wakeline_collector.gz import gunzip_bounded

LCC = "+proj=lcc +lat_1=30 +lat_2=60 +lat_0=38 +lon_0=126 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs"
REF_COL, REF_ROW, RES_M = 1121, 1681, 500.0
HEADER_BYTES = 1024
# 해제 결과 상한: HSR 은 2305×2881×2 B × 자료블록 3개 ≈ 40 MB. 이를 넘는 파일은 압축 폭탄으로 보고 거부한다.
MAX_RAW_BYTES = 64 * 1024 * 1024
MAX_GRID = 4096  # nx·ny 상한(포맷상 short 이지만 이 이상은 합성장 크기로 비정상)
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


def read_header(gz_bytes: bytes) -> Header:
    """gzip 파일의 앞 HEADER_BYTES 만 풀어 헤더를 읽는다 — 자료 블록(해제 약 40 MB)은 풀지 않는다(지점 수만 볼 때).
    해제 결과를 HEADER_BYTES 로 자르므로 압축 폭탄도 부풀지 않는다. gzip 이 아니거나 헤더가 다 오지 않았으면 ValueError."""
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)  # 16+: gzip 헤더 검사
    try:
        head = d.decompress(gz_bytes, HEADER_BYTES)
    except zlib.error as e:
        raise ValueError(f"invalid gzip: {e}") from e
    return parse_header(head)


def read_echo(gz_bytes: bytes, max_raw_bytes: int = MAX_RAW_BYTES) -> tuple[Header, np.ndarray]:
    """첫 자료블록(반사도, dBZ×100)을 (ny, nx) int16 배열로. 행 0 = 남쪽. 해제 결과가 상한을 넘으면 거부(ValueError)."""
    raw = gunzip_bounded(gz_bytes, max_raw_bytes)
    h = parse_header(raw)
    if h.map_code != 1 or h.dxy != int(RES_M):
        raise ValueError(f"unsupported map_code={h.map_code} dxy={h.dxy}")
    if not (0 < h.nx <= MAX_GRID and 0 < h.ny <= MAX_GRID):
        raise ValueError(f"grid size out of range nx={h.nx} ny={h.ny}")
    n = h.nx * h.ny
    if len(raw) < HEADER_BYTES + n * 2:
        raise ValueError("data block truncated")
    grid = np.frombuffer(raw, dtype="<i2", count=n, offset=HEADER_BYTES).reshape(h.ny, h.nx)
    return h, grid


def lcc_extent(h: Header) -> tuple[float, float, float, float]:
    """(xmin, ymin, xmax, ymax) in LCC metres."""
    return (-REF_COL * RES_M, -REF_ROW * RES_M, (h.nx - REF_COL) * RES_M, (h.ny - REF_ROW) * RES_M)


_TO_MERC = Transformer.from_crs(LCC, "EPSG:3857", always_xy=True)
_TO_LCC = Transformer.from_crs("EPSG:3857", LCC, always_xy=True)
_TO_LL = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)


def mercator_bounds(h: Header) -> tuple[float, float, float, float]:
    """격자 네 변을 따라 투영해 웹 메르카토르(EPSG:3857) 축 정렬 경계를 구한다."""
    return _mercator_bounds(h.nx, h.ny)


@lru_cache(maxsize=4)
def _mercator_bounds(nx: int, ny: int) -> tuple[float, float, float, float]:
    xmin, ymin, xmax, ymax = -REF_COL * RES_M, -REF_ROW * RES_M, (nx - REF_COL) * RES_M, (ny - REF_ROW) * RES_M
    xs = np.concatenate([np.linspace(xmin, xmax, 200), np.full(200, xmax), np.linspace(xmax, xmin, 200), np.full(200, xmin)])
    ys = np.concatenate([np.full(200, ymin), np.linspace(ymin, ymax, 200), np.full(200, ymax), np.linspace(ymax, ymin, 200)])
    mx, my = _TO_MERC.transform(xs, ys)
    return float(mx.min()), float(my.min()), float(mx.max()), float(my.max())


@dataclass(frozen=True)
class _PixelMap:
    """출력 픽셀 → 격자 대응(격자 크기·출력 폭에만 의존). 프레임마다 150만 점 재투영을 하지 않도록 캐시한다."""

    height: int
    inside: np.ndarray  # (height*width,) bool — 격자 범위 안의 픽셀
    flat_idx: np.ndarray  # inside 픽셀의 격자 1차원 인덱스(row*nx + col)


@lru_cache(maxsize=4)
def _pixel_map(nx: int, ny: int, width: int) -> _PixelMap:
    bx0, by0, bx1, by1 = _mercator_bounds(nx, ny)
    height = int(round(width * (by1 - by0) / (bx1 - bx0)))
    px = bx0 + (np.arange(width) + 0.5) * (bx1 - bx0) / width
    py = by1 - (np.arange(height) + 0.5) * (by1 - by0) / height  # 위 → 아래
    mxx, myy = np.meshgrid(px, py)
    lx, ly = _TO_LCC.transform(mxx.ravel(), myy.ravel())
    col = np.floor(lx / RES_M + REF_COL).astype(np.int64)
    row = np.floor(ly / RES_M + REF_ROW).astype(np.int64)
    inside = (col >= 0) & (col < nx) & (row >= 0) & (row < ny)
    flat_idx = (row[inside] * nx + col[inside]).astype(np.int32)
    inside.setflags(write=False)
    flat_idx.setflags(write=False)
    return _PixelMap(height, inside, flat_idx)


def dbz_threshold(min_dbz: float) -> int:
    """격자 값(dBZ×100, int16) v 가 'float32(v) / 100 ≥ min_dbz' 인 가장 작은 v — 정수 비교 grid ≥ 이 값이 그 실수 식과 같은 칸을 고른다
    (collector-review F9: 실수 식은 격자 전체를 float32 로 두 번 복사했다 — 2305 × 2881 에서 +57 MiB). ⌈min_dbz × 100⌉ 에서 시작해 실수 식(float32 —
    전과 같은 계산)으로 경계를 한 칸씩 확인하므로 어떤 min_dbz 에서도 같다. 어느 int16 도 넘지 못하면 32768."""

    def meets(v: int) -> bool:
        return bool(np.float32(v) / np.float32(100.0) >= np.float32(min_dbz))

    t = max(-32768, min(32768, math.ceil(min_dbz * 100)))
    while t > -32768 and meets(t - 1):
        t -= 1
    while t <= 32767 and not meets(t):
        t += 1
    return t


def render_mercator_png(
    h: Header, grid: np.ndarray, width: int = 1152, min_dbz: float = 5.0, mask_alpha: int = 22
) -> tuple[bytes, dict]:
    """웹 메르카토르 축 정렬 RGBA PNG 와 그 경계(lon/lat 네 모서리)를 만든다. 최근접 표본화. CPU 작업 — 이벤트 루프 밖(스레드)에서 부른다."""
    if grid.shape != (h.ny, h.nx):
        raise ValueError(f"grid shape {grid.shape} != header ({h.ny}, {h.nx})")
    bx0, by0, bx1, by1 = _mercator_bounds(h.nx, h.ny)
    pm = _pixel_map(h.nx, h.ny, width)
    height = pm.height
    vals = np.full(pm.inside.shape, NULL_OUTSIDE, dtype=np.int16)
    vals[pm.inside] = grid.ravel()[pm.flat_idx]
    vals = vals.reshape(height, width)

    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    observed = vals > NULL_OUTSIDE  # 관측 반경 안(에코 없음 포함)
    rgba[observed] = (90, 90, 90, mask_alpha)
    floor = dbz_threshold(min_dbz)  # 정수 임계값(dbz_threshold) — 실수 식과 같은 픽셀, float32 복사 없이
    for lo, color in DBZ_STOPS:
        rgba[vals >= max(dbz_threshold(lo), floor)] = color
    img = Image.fromarray(rgba, "RGBA")
    out = io.BytesIO()
    img.save(out, format="PNG", compress_level=6)  # optimize=True 는 프레임당 수백 ms 를 더 쓴다

    w, n = _TO_LL.transform(bx0, by1)
    e, s = _TO_LL.transform(bx1, by0)
    meta = {
        "width": width,
        "height": height,
        "coordinates": [[w, n], [e, n], [e, s], [w, s]],  # MapLibre image source: TL, TR, BR, BL
        "mercator_bounds": [bx0, by0, bx1, by1],
        "projection": LCC,
        "grid": {"nx": h.nx, "ny": h.ny, "res_m": RES_M, "ref": [REF_COL, REF_ROW]},
        "min_dbz": min_dbz,
        "legend": [[lo, list(c[:3])] for lo, c in DBZ_STOPS],
        "echo_cells": int(((grid > DISPLAY_MIN) & (grid >= floor)).sum()),
        "observed_cells": int((grid > NULL_OUTSIDE).sum()),
    }
    return out.getvalue(), meta
