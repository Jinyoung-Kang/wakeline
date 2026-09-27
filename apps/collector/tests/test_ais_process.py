"""진입점 프로세스(`python -m wakeline_collector.ais`): SIGTERM 에 정리하고 0 으로 끝난다(Redis 가 없어도 수신·정리는 돈다)."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX 신호")
def test_entrypoint_graceful_sigterm_without_redis():
    env = {
        **os.environ,
        "WAKELINE_FIXTURE_MODE": "1",
        "FIXTURES_DIR": str(ROOT / "fixtures"),
        "REDIS_HOST": "127.0.0.1",
        "REDIS_PORT": "1",  # 열려 있지 않은 포트 — Redis 장애 중에도 프로세스가 버티는지
        "AISSTREAM_API_KEY": "",
        "AIS_FLUSH_S": "1",
    }
    p = subprocess.Popen(
        [sys.executable, "-m", "wakeline_collector.ais"],
        cwd=ROOT / "apps" / "collector",
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        time.sleep(3.0)
        assert p.poll() is None  # Redis 가 없다고 죽지 않는다
        t0 = time.monotonic()
        p.send_signal(signal.SIGTERM)
        _out, err = p.communicate(timeout=15)
    finally:
        if p.poll() is None:
            p.kill()
    assert p.returncode == 0, err[-2000:]
    assert time.monotonic() - t0 < 10  # compose 기본 stop 유예(10 s) 안
    assert "fixture mode" in err and "ais stopped" in err
