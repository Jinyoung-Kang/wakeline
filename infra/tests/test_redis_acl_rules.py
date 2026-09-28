"""infra/redis/start.sh 가 만드는 ACL 규칙 정책 시험(계약 §6 · 계약 v2 §C · 계약 v4 §A) — 컨테이너를 띄우지 않는다.

start.sh 를 그대로 실행하되 PATH 앞에 가짜 redis-server(받은 인자를 한 줄에 하나씩 출력)를 두어,
사용자별로 실제로 넘어가는 키 규칙을 읽는다. 동작 시험(명령이 실제로 거부되는지)은 redis_acl_test.sh(docker)가 한다.

실행: python3 -m unittest discover -s infra/tests -v
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
START = ROOT / "infra" / "redis" / "start.sh"
# 시험용 가짜 비밀번호(실제 값이 아니다)
FAKE_ENV = {
    "REDIS_PASSWORD": "adm-test-not-real",
    "REDIS_API_PASSWORD": "api-test-not-real",
    "REDIS_COLLECTOR_PASSWORD": "col-test-not-real",
    "REDIS_AIS_PASSWORD": "ais-test-not-real",
}


def acl_rules(extra_env: dict[str, str]) -> dict[str, list[str]]:
    """start.sh 가 redis-server 에 넘기는 --user 규칙 → {사용자: [규칙...]}."""
    with tempfile.TemporaryDirectory() as tmp:
        stub = Path(tmp) / "redis-server"
        stub.write_text('#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n')
        stub.chmod(0o755)
        env = {"PATH": f"{tmp}:{os.environ.get('PATH', '/usr/bin:/bin')}", **extra_env}
        out = subprocess.run(["sh", str(START)], env=env, capture_output=True, text=True, check=True).stdout
    users: dict[str, list[str]] = {}
    args = out.splitlines()
    i = 0
    while i < len(args):
        if args[i] == "--user":
            name = args[i + 1]
            j = i + 2
            while j < len(args) and not args[j].startswith("--"):
                j += 1
            users[name] = args[i + 2 : j]
            i = j
        else:
            i += 1
    return users


@unittest.skipUnless(shutil.which("sh"), "sh 없음")
class RedisAclRulesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.users = acl_rules(FAKE_ENV)

    def keys(self, user: str) -> list[str]:
        return [r for r in self.users[user] if r.startswith(("~", "%"))]

    def test_every_service_user_is_created(self):
        self.assertEqual(set(self.users), {"wakeline_api", "wakeline_collector", "wakeline_ais"})

    # --- 계약 v4 §A: 노선 캐시 wakeline:route:{CALLSIGN} ---
    def test_collector_writes_route_cache(self):
        keys = self.keys("wakeline_collector")
        self.assertIn("~wakeline:route:*", keys, "수집기가 SET EX · EXISTS 로 노선 캐시를 쓴다")
        self.assertNotIn("%R~wakeline:route:*", keys)

    def test_ais_has_no_route_cache_access(self):
        keys = self.keys("wakeline_ais")
        self.assertFalse([k for k in keys if "route" in k], keys)
        self.assertFalse([k for k in keys if k in ("~*", "%RW~*", "~wakeline:*", "allkeys")], "ais 는 좁은 키만")

    def test_api_can_read_route_cache(self):
        self.assertIn("~wakeline:*", self.keys("wakeline_api"))

    def test_collector_key_rules_stay_narrow(self):
        keys = self.keys("wakeline_collector")
        for broad in ("~*", "~wakeline:*", "allkeys", "~wakeline:r*"):
            self.assertNotIn(broad, keys)
        self.assertNotIn("allkeys", self.users["wakeline_collector"])

    def test_without_ais_password_no_ais_user(self):
        env = {k: v for k, v in FAKE_ENV.items() if k != "REDIS_AIS_PASSWORD"}
        users = acl_rules(env)
        self.assertEqual(set(users), {"wakeline_api", "wakeline_collector"})
        self.assertIn("~wakeline:route:*", [r for r in users["wakeline_collector"] if r.startswith("~")])


if __name__ == "__main__":
    unittest.main()
