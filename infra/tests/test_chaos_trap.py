"""tools/chaos.sh 복구 트랩 시험 (리뷰 2026-09-28b #18).

실제 컨테이너를 건드리지 않는다: PATH 앞에 가짜 docker·curl·sleep 을 두고, 없는 compose 프로젝트 이름과 닫힌 포트를 쓴다
(가짜가 가려지지 않더라도 스크립트는 "no 'api' container" 로 바로 끝난다). 가짜 docker 는 받은 인자를 로그에 적기만 한다.
확인하는 것:
- ais 시나리오: 끊은 동안 TERM·INT 로 끝나면 ais 를 다시 네트워크에 붙이고 끝난다. 정상 복구 뒤에는 트랩을 지워 두 번 붙이지 않는다.
- db 시나리오: 멈춘 동안 TERM 으로 끝나면 db 를 다시 시작한다. 정상 경로에서는 한 번만 시작한다.

실행: python3 -m unittest discover -s infra/tests -v
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CHAOS = ROOT / "tools" / "chaos.sh"

FAKE_DOCKER = r"""#!/bin/sh
all="$*"
echo "$all" >> "$CHAOS_LOG"
case "$1" in
  ps) case "$all" in *service=*) svc="${all##*service=}"; echo "fake-${svc%% *}" ;; esac ;;
  inspect) case "$all" in *Networks*) echo fakenet ;; *Health*) echo healthy ;; *) echo 0 ;; esac ;;
  exec) case "$all" in
      *psql*) echo 1 ;;
      *HGET*last_msg_at*) echo 2999-01-01T00:00:00Z ;;
      *HGET*connected*) echo 1 ;;
      *) : ;;
    esac ;;
esac
exit 0
"""
FAKE_CURL = """#!/bin/sh
echo '{}'
"""
# FAKE_SLEEP_LONG 과 같은 값만 실제로 기다린다(끊은 동안) — 나머지는 짧게
FAKE_SLEEP = """#!/bin/sh
if [ "$1" = "${FAKE_SLEEP_LONG:-}" ]; then exec /bin/sleep "$1"; fi
exec /bin/sleep 0.01
"""


@unittest.skipUnless(shutil.which("bash") and Path("/bin/sleep").exists(), "bash and /bin/sleep required")
class ChaosTrapTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="chaos-trap-"))
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        for name, body in (("docker", FAKE_DOCKER), ("curl", FAKE_CURL), ("sleep", FAKE_SLEEP)):
            p = self.bin / name
            p.write_text(textwrap.dedent(body))
            p.chmod(0o755)
        self.log = self.tmp / "docker.log"
        self.log.touch()
        self.env = {
            **os.environ,
            "PATH": f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}",
            "CHAOS_LOG": str(self.log),
            "WAKELINE_PROJECT": f"wakeline-chaos-selftest-{os.getpid()}",  # 실제 프로젝트가 아니다
            "WAKELINE_BASE_URL": "http://127.0.0.1:9",
        }
        # 가짜 docker 가 먼저 잡히는지 — 아니면 시험하지 않는다(실제 docker 를 부르지 않기 위해)
        self.assertEqual(shutil.which("docker", path=self.env["PATH"]), str(self.bin / "docker"))
        self.proc: subprocess.Popen[bytes] | None = None

    def tearDown(self) -> None:
        if self.proc is not None:
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)  # 남은 백그라운드 sleep 정리
            except (ProcessLookupError, PermissionError):
                pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def start(self, scenario: str, **env: str) -> subprocess.Popen[bytes]:
        self.proc = subprocess.Popen(
            ["bash", str(CHAOS), scenario], cwd=ROOT, env={**self.env, **env},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
        )
        return self.proc

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines()

    def wait_for_call(self, prefix: str, timeout: float = 20) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if any(c.startswith(prefix) for c in self.calls()):
                time.sleep(0.3)  # 다음 명령(긴 sleep)에 들어갈 시간
                return
            time.sleep(0.05)
        self.fail(f"no '{prefix}' call; calls={self.calls()}")

    def count(self, prefix: str) -> int:
        return sum(1 for c in self.calls() if c.startswith(prefix))

    def test_ais_cut_interrupted_by_term_reconnects(self) -> None:
        p = self.start("ais", AIS_CUT_S="30", FAKE_SLEEP_LONG="30")
        self.wait_for_call("network disconnect fakenet fake-ais")
        self.assertEqual(self.count("network connect"), 0)
        os.kill(p.pid, signal.SIGTERM)
        self.assertEqual(p.wait(timeout=10), 143)
        self.assertEqual(self.count("network connect --alias ais fakenet fake-ais"), 1)

    def test_ais_cut_interrupted_by_ctrl_c_reconnects(self) -> None:
        p = self.start("ais", AIS_CUT_S="30", FAKE_SLEEP_LONG="30")
        self.wait_for_call("network disconnect fakenet fake-ais")
        os.killpg(p.pid, signal.SIGINT)  # 터미널의 Ctrl-C 처럼 프로세스 그룹 전체에
        self.assertEqual(p.wait(timeout=10), 130)
        self.assertEqual(self.count("network connect --alias ais fakenet fake-ais"), 1)

    def test_ais_normal_restore_clears_the_trap(self) -> None:
        p = self.start("ais", AIS_CUT_S="1")
        self.assertEqual(p.wait(timeout=60), 0)
        self.assertEqual(self.count("network disconnect fakenet fake-ais"), 1)
        self.assertEqual(self.count("network connect --alias ais fakenet fake-ais"), 1)  # 끝날 때 다시 붙이지 않는다

    def test_db_stop_interrupted_by_term_restarts_db(self) -> None:
        p = self.start("db", FAKE_SLEEP_LONG="35")
        self.wait_for_call("stop fake-db")
        self.assertEqual(self.count("start fake-db"), 0)
        os.kill(p.pid, signal.SIGTERM)
        self.assertEqual(p.wait(timeout=10), 143)
        self.assertEqual(self.count("start fake-db"), 1)

    def test_db_normal_restore_starts_db_once(self) -> None:
        p = self.start("db")
        self.assertEqual(p.wait(timeout=60), 0)
        self.assertEqual(self.count("stop fake-db"), 1)
        self.assertEqual(self.count("start fake-db"), 1)


if __name__ == "__main__":
    unittest.main()
