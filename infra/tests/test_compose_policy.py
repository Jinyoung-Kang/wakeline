"""infra/compose.yml 정책 시험 (SEC-4 · SEC-5 · SEC-7 · SEC-8 · SEC-13 · REL-20).

`docker compose config` 로 해석한 결과(개발 스택과 격리 E2E 스택 둘 다)를 검사한다 — 컨테이너를 띄우지 않는다.
임시 디렉터리에 init_env 로 만든 .env 를 쓰므로 실제 .env 는 읽지도 바꾸지도 않는다. docker CLI 가 없으면 건너뛴다.

실행: python3 -m unittest discover -s infra/tests -v
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "infra" / "compose.yml"
_spec = importlib.util.spec_from_file_location("init_env", ROOT / "tools" / "init_env.py")
init_env = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(init_env)

ENTRYPOINT_CAPS = {"CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"}
LONG_RUNNING = ["edge", "web", "api", "collector", "redis", "db"]


def _docker_compose_available() -> bool:
    if not shutil.which("docker"):
        return False
    return subprocess.run(["docker", "compose", "version"], capture_output=True).returncode == 0


@unittest.skipUnless(_docker_compose_available(), "docker compose 없음")
class ComposePolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        d = Path(cls._tmp.name)
        cls.env_file = d / ".env"
        init_env.ensure_env(cls.env_file, ROOT / ".env.example", out=io.StringIO())
        cls.secrets = dict(re.findall(r"^([A-Z0-9_]+)=(.*)$", cls.env_file.read_text(), re.M))
        cls.dev = cls._config({})
        cls.iso = cls._config({"SKYWX_FIXTURE_MODE": "1", "SKYWX_PORT": "8701", "SKYWX_NET_PREFIX": "10.78.0"}, project="skywx-e2e")

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    @classmethod
    def _config(cls, extra: dict[str, str], project: str | None = None) -> dict:
        env = {k: v for k, v in os.environ.items() if not k.startswith(("SKYWX_", "REDIS_", "DB_", "COMPOSE_"))}
        env.update(extra)
        cmd = ["docker", "compose"] + (["-p", project] if project else []) + ["-f", str(COMPOSE), "--env-file", str(cls.env_file), "config", "--format", "json"]
        r = subprocess.run(cmd, capture_output=True, text=True, env=env)
        if r.returncode != 0:
            raise AssertionError(f"docker compose config failed: {r.stderr}")
        return json.loads(r.stdout)

    def svc(self, name: str, cfg: dict | None = None) -> dict:
        return (cfg or self.dev)["services"][name]

    # --- SEC-4: 컨테이너 권한 ---
    def test_every_container_is_hardened(self):
        for cfg in (self.dev, self.iso):
            for name, s in cfg["services"].items():
                with self.subTest(service=name):
                    self.assertIn("no-new-privileges:true", s.get("security_opt", []))
                    self.assertEqual(s.get("cap_drop"), ["ALL"])
                    self.assertTrue(s.get("read_only"), "루트 FS 는 read-only")
                    self.assertNotIn("privileged", s)
                    self.assertNotIn("env_file", s, "필요한 값만 environment 로 넘긴다")

    def test_only_db_keeps_entrypoint_caps(self):
        for name, s in self.dev["services"].items():
            with self.subTest(service=name):
                if name == "db":
                    self.assertEqual(set(s.get("cap_add", [])), ENTRYPOINT_CAPS)
                else:
                    self.assertFalse(s.get("cap_add"), "db 외에는 추가 권한이 없다")

    def test_edge_and_redis_run_as_non_root(self):
        self.assertEqual(self.svc("edge").get("user"), "101:101")
        self.assertIn("nginx-unprivileged", self.svc("edge")["image"])
        self.assertEqual(self.svc("redis").get("user"), "999:1000")

    def test_resource_limits(self):
        for name in LONG_RUNNING:
            with self.subTest(service=name):
                lim = self.svc(name).get("deploy", {}).get("resources", {}).get("limits", {})
                self.assertTrue(lim.get("memory"), "memory 상한")
                self.assertTrue(lim.get("pids"), "pids 상한")

    def test_only_edge_publishes_and_only_on_loopback(self):
        for cfg, port in ((self.dev, "8700"), (self.iso, "8701")):
            for name, s in cfg["services"].items():
                with self.subTest(service=name, port=port):
                    ports = s.get("ports", [])
                    if name == "edge":
                        self.assertEqual(len(ports), 1)
                        self.assertEqual(ports[0]["host_ip"], "127.0.0.1")
                        self.assertEqual(str(ports[0]["published"]), port)
                    else:
                        self.assertEqual(ports, [])

    # --- SEC-8: 제3자 이미지 고정 ---
    def test_third_party_images_pinned_by_digest(self):
        for name, s in self.dev["services"].items():
            with self.subTest(service=name):
                if s["image"].startswith("skywx-"):
                    self.assertTrue(s["image"].endswith(":local"))
                else:
                    self.assertRegex(s["image"], r"^[^@]+:[^@]+@sha256:[0-9a-f]{64}$")

    # --- SEC-5: Redis ACL 사용자 ---
    def test_services_use_their_own_redis_user(self):
        admin = self.secrets["REDIS_PASSWORD"]
        expect = {"api": ("skywx_api", "REDIS_API_PASSWORD"), "migrate": ("skywx_api", "REDIS_API_PASSWORD"),
                  "collector": ("skywx_collector", "REDIS_COLLECTOR_PASSWORD")}
        for name, (user, pw_key) in expect.items():
            with self.subTest(service=name):
                env = self.svc(name)["environment"]
                self.assertEqual(env["REDIS_USERNAME"], user)
                self.assertEqual(env["REDIS_PASSWORD"], self.secrets[pw_key])
                self.assertNotIn(admin, env.values(), "관리용 default 비밀번호를 받지 않는다")
        self.assertNotEqual(self.secrets["REDIS_API_PASSWORD"], self.secrets["REDIS_COLLECTOR_PASSWORD"])

    def test_collector_gets_no_other_service_secrets(self):
        env = self.svc("collector")["environment"]
        for k in ("DB_ROOT_PASSWORD", "DB_MIGRATOR_PASSWORD", "DB_API_PASSWORD", "REDIS_API_PASSWORD"):
            with self.subTest(secret=k):
                self.assertNotIn(self.secrets[k], env.values())

    def test_redis_passwords_not_on_command_line(self):
        r = self.svc("redis")
        argv = " ".join((r.get("entrypoint") or []) + (r.get("command") or []) + r["healthcheck"]["test"])
        for k in ("REDIS_PASSWORD", "REDIS_API_PASSWORD", "REDIS_COLLECTOR_PASSWORD"):
            with self.subTest(secret=k):
                self.assertNotIn(self.secrets[k], argv)
                self.assertEqual(r["environment"][k], self.secrets[k])
        self.assertEqual(r["entrypoint"], ["sh", "/etc/redis/start.sh"])
        mounts = {v["target"]: v for v in r["volumes"]}
        self.assertTrue(mounts["/etc/redis/start.sh"]["read_only"])
        self.assertTrue(mounts["/etc/redis/redis.conf"]["read_only"])
        self.assertEqual(mounts["/data"]["type"], "volume")

    # --- SEC-7: WS Origin 허용 목록 ---
    def test_api_allowed_origins_follow_published_port(self):
        self.assertEqual(self.svc("api")["environment"]["SKYWX_ALLOWED_ORIGINS"], "http://localhost:8700,http://127.0.0.1:8700")
        self.assertEqual(self.svc("api", self.iso)["environment"]["SKYWX_ALLOWED_ORIGINS"], "http://localhost:8701,http://127.0.0.1:8701")

    # --- REL-20 · 계약 §8: collector 헬스체크 ---
    def test_collector_healthcheck(self):
        hc = self.svc("collector")["healthcheck"]
        self.assertEqual(hc["test"], ["CMD", "python", "-m", "skywx_collector.health"])
        self.assertIn("start_period", hc)

    def test_every_long_running_service_has_healthcheck(self):
        for name in LONG_RUNNING:
            with self.subTest(service=name):
                self.assertTrue(self.svc(name).get("healthcheck", {}).get("test"))

    def test_isolated_stack_is_separate(self):
        self.assertEqual(self.iso["name"], "skywx-e2e")
        self.assertEqual(self.svc("api", self.iso)["environment"]["SKYWX_FIXTURE_MODE"], "1")
        self.assertEqual(self.svc("collector", self.iso)["environment"]["SKYWX_FIXTURE_MODE"], "1")
        self.assertEqual(self.svc("api", self.iso)["environment"]["SKYWX_TRUSTED_PROXY"], "10.78.0.10")

    def test_api_has_shutdown_grace(self):
        self.assertIn("stop_grace_period", self.svc("api"))


if __name__ == "__main__":
    unittest.main()
