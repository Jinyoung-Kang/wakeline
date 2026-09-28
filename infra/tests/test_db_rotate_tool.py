"""tools/db_rotate_passwords.py 의 안전 규칙(R-80) — docker 없이. 실제 교체 동작은 db_rotate_test.sh(버리는 컨테이너)."""
import importlib.util
import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("db_rotate_passwords", ROOT / "tools" / "db_rotate_passwords.py")
rotate = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(rotate)

ENV = "DB_MIGRATOR_PASSWORD=m-old\nDB_API_PASSWORD=a-old\nDB_COLLECTOR_PASSWORD=c-old\n"


class SharedEnvFileTest(unittest.TestCase):
    """격리 스택(wakeline-e2e)은 개발 스택과 같은 .env 를 읽는다 — 새 값으로 바꾸면 다른 스택의 DB 와 어긋난다."""

    def setUp(self):
        self._d = tempfile.TemporaryDirectory()
        self.env = Path(self._d.name) / ".env"
        self.env.write_text(ENV)
        os.chmod(self.env, 0o600)

    def tearDown(self):
        self._d.cleanup()

    def test_isolated_project_refuses_new_values_before_touching_docker(self):
        with mock.patch.dict(os.environ, {"WAKELINE_PROJECT": "wakeline-e2e"}), \
                mock.patch.object(rotate.subprocess, "run", side_effect=AssertionError("docker 를 부르면 안 된다")):
            with self.assertRaises(SystemExit) as cm:
                rotate.main(["--env-file", str(self.env)])
        self.assertIn("sync=1", str(cm.exception))
        self.assertEqual(self.env.read_text(), ENV, ".env 는 그대로")

    def test_isolated_project_may_sync_to_the_shared_values(self):
        calls = []

        def fake_run(cmd, **kw):
            calls.append(cmd)
            if cmd[:2] == ["docker", "ps"]:
                return mock.Mock(returncode=0, stdout="cid\n", stderr="")
            if cmd[:2] == ["docker", "inspect"]:
                return mock.Mock(returncode=0, stdout="10.78.0.60 ", stderr="")
            if "pg_authid" in (kw.get("input") or ""):
                return mock.Mock(returncode=0, stdout="wakeline_migrator x\nwakeline_api y\nwakeline_collector z\n", stderr="")
            if "SELECT 1" in cmd:
                return mock.Mock(returncode=0, stdout="1\n", stderr="")
            return mock.Mock(returncode=0, stdout="", stderr="")

        with mock.patch.dict(os.environ, {"WAKELINE_PROJECT": "wakeline-e2e"}), mock.patch.object(rotate.subprocess, "run", side_effect=fake_run), \
                redirect_stderr(io.StringIO()), mock.patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(rotate.main(["--env-file", str(self.env), "--sync"]), 0)
        self.assertEqual(self.env.read_text(), ENV)
        self.assertTrue(any(c[:2] == ["docker", "ps"] and "label=com.docker.compose.project=wakeline-e2e" in c for c in calls))

    def test_dev_rotation_names_the_other_stack_to_resync(self):
        out = io.StringIO()

        def fake_run(cmd, **kw):
            if cmd[:2] == ["docker", "ps"] and "label=com.docker.compose.project=wakeline" in cmd:
                return mock.Mock(returncode=0, stdout="cid\n", stderr="")
            if cmd[:3] == ["docker", "volume", "ls"]:  # 같은 .env 를 읽는 다른 프로젝트의 DB 볼륨(옛 비밀번호가 남아 있다)
                return mock.Mock(returncode=0, stdout="wakeline\nwakeline-e2e\n", stderr="")
            if cmd[:2] == ["docker", "inspect"]:
                return mock.Mock(returncode=0, stdout="10.77.0.60 ", stderr="")
            if "pg_authid" in (kw.get("input") or ""):
                return mock.Mock(returncode=0, stdout="wakeline_migrator x\nwakeline_api y\nwakeline_collector z\n", stderr="")
            if "SELECT 1" in cmd:
                return mock.Mock(returncode=0, stdout="1\n", stderr="")
            return mock.Mock(returncode=0, stdout="", stderr="")

        with mock.patch.dict(os.environ, {"WAKELINE_PROJECT": "wakeline"}), mock.patch.object(rotate.subprocess, "run", side_effect=fake_run), \
                mock.patch("sys.stdout", out):
            self.assertEqual(rotate.main(["--env-file", str(self.env)]), 0)
        self.assertNotEqual(self.env.read_text(), ENV, "개발 스택은 새 값으로 바뀐다")
        self.assertIn("P=wakeline-e2e sync=1", out.getvalue())
        for secret in rotate.re.findall(r"=(.*)", self.env.read_text()):
            self.assertNotIn(secret, out.getvalue(), "새 값은 출력하지 않는다")


if __name__ == "__main__":
    unittest.main()
