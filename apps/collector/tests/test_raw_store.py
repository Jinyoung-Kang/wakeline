"""원천 보관: gzip 저장 · 보관 기간 정리 · 저장 실패가 수집을 막지 않음."""

from __future__ import annotations

import gzip
import os
import time
from datetime import UTC, datetime

from wakeline_collector.raw_store import RawStore


def test_save_and_purge(tmp_path):
    rs = RawStore(str(tmp_path))
    at = datetime(2026, 9, 28, 1, 2, 3, 456000, tzinfo=UTC)
    ref = rs.save("adsb_fi_focus", b'{"ac":[]}', at)
    assert ref == "adsb_fi_focus/20260928/010203_456000.json.gz"
    p = tmp_path / ref
    assert gzip.decompress(p.read_bytes()) == b'{"ac":[]}'
    fresh = rs.save("adsb_lol", b"{}")
    old = time.time() - 80 * 3600
    os.utime(p, (old, old))
    assert rs.purge(72) == 1 and not p.exists() and (tmp_path / fresh).exists()


def test_purge_missing_root_and_save_failure(tmp_path):
    assert RawStore(str(tmp_path / "none")).purge() == 0
    blocker = tmp_path / "file"
    blocker.write_text("x")
    assert RawStore(str(blocker)).save("p", b"x").startswith("unsaved:")
