"""원천 보관: gzip 저장 · 보관 기간 정리 · 저장 실패가 수집을 막지 않음."""

from __future__ import annotations

import gzip
import logging
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

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


def test_r21_already_gzipped_body_is_stored_as_is(tmp_path):
    """리뷰 R-21: KMA 본문은 이미 gzip 인데 한 번 더 압축했다(1.09 MB → 1.08 MB, 수십 ms). 그대로 .bin.gz 로 쓴다."""
    rs = RawStore(str(tmp_path))
    body = gzip.compress(b"\x00RDR" * 1000)
    at = datetime(2026, 9, 28, 1, 2, 3, 456000, tzinfo=UTC)
    ref = rs.save("kma_radar", body, at)
    assert ref == "kma_radar/20260928/010203_456000.bin.gz"
    assert (tmp_path / ref).read_bytes() == body  # 두 번 압축하지 않았다 — gunzip 한 번이면 원본 바이너리


def test_purge_missing_root_and_save_failure(tmp_path):
    assert RawStore(str(tmp_path / "none")).purge() == 0
    blocker = tmp_path / "file"
    blocker.write_text("x")
    assert RawStore(str(blocker)).save("p", b"x").startswith("unsaved:")


def test_failed_saves_are_counted_and_warned_at_most_once_a_minute(tmp_path, caplog, monkeypatch):
    """F6(collector-review · PLAN C2): 보관 실패가 조용했다 — 로그도 지표도 없이 raw_ref 'unsaved:…' 만 남아, 가득 차거나 읽기 전용인 /data/raw 가
    보관을 멈춰도 아무도 몰랐다. 실패마다 센다(heartbeat raw_unsaved) · WARN 은 분에 한 번(그 사이 실패 수를 싣는다)."""
    from wakeline_collector import raw_store

    clock = [1000.0]
    monkeypatch.setattr(raw_store, "time", SimpleNamespace(monotonic=lambda: clock[0], time=time.time))
    blocker = tmp_path / "file"
    blocker.write_text("x")
    rs = RawStore(str(blocker))  # 뿌리가 파일이라 mkdir 이 실패한다
    with caplog.at_level(logging.WARNING, logger="raw_store"):
        assert rs.save("p", b"x").startswith("unsaved:")
        assert rs.save("p", b"y").startswith("unsaved:")
        clock[0] += 61
        assert rs.save("p", b"z").startswith("unsaved:")
    assert rs.unsaved == 3
    warns = [r.getMessage() for r in caplog.records if r.name == "raw_store"]
    assert len(warns) == 2
    assert warns[0].startswith("raw archive: could not save p (") and "1 unsaved since start" in warns[0]
    assert "3 unsaved since start" in warns[1]


def test_failed_purges_are_counted_and_warned(tmp_path, caplog, monkeypatch):
    rs = RawStore(str(tmp_path))
    ref = rs.save("adsb_lol", b"{}")
    old = time.time() - 80 * 3600
    os.utime(tmp_path / ref, (old, old))

    def refuse(self, missing_ok=False):
        raise PermissionError(13, "read-only file system")

    monkeypatch.setattr(Path, "unlink", refuse)
    with caplog.at_level(logging.WARNING, logger="raw_store"):
        assert rs.purge(72) == 0
    assert rs.purge_failed == 1 and (tmp_path / ref).exists()
    (warn,) = [r.getMessage() for r in caplog.records if r.name == "raw_store"]
    assert warn.startswith("raw archive: could not purge ") and "PermissionError" in warn and "1 not purged since start" in warn
