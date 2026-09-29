"""infra/redis/start.sh 가 만드는 ACL 규칙 정책 시험(계약 §6 · 계약 v2 §C · 계약 v4 §A · 계약 v5 §C3) — 컨테이너를 띄우지 않는다.

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

    # --- ADR-022: 한국 항만 입출항 — 임대 wakeline:demand:portcalls(읽기 전용) · 캐시 wakeline:portcalls:{호출부호} ---
    def test_collector_reads_port_call_leases_and_writes_the_port_call_cache(self):
        keys = self.keys("wakeline_collector")
        self.assertIn("%R~wakeline:demand:portcalls", keys, "임대는 api 만 쓴다 — 수집기는 ZRANGEBYSCORE 로 읽기만")
        self.assertNotIn("~wakeline:demand:portcalls", keys)
        self.assertIn("~wakeline:portcalls:*", keys, "수집기가 SET EX · EXISTS 로 입출항 캐시를 쓴다")
        self.assertNotIn("~wakeline:demand:*", keys, "임대 키를 와일드카드로 넓히지 않는다")

    def test_ais_has_no_port_call_access(self):
        self.assertFalse([k for k in self.keys("wakeline_ais") if "portcalls" in k])

    def test_collector_key_rules_stay_narrow(self):
        keys = self.keys("wakeline_collector")
        for broad in ("~*", "~wakeline:*", "allkeys", "~wakeline:r*"):
            self.assertNotIn(broad, keys)
        self.assertNotIn("allkeys", self.users["wakeline_collector"])

    # --- R-86 · ADR-017 §4: 생산자(collector·ais)는 허용 목록 — 키를 지우거나 덮어쓰거나 만료시키는 명령은 쓰는 키에만 ---
    def commands(self, user: str) -> set[str]:
        """루트 규칙에서 허용한 명령(+x)과 카테고리(+@x)."""
        return {r[1:] for r in self.users[user] if r.startswith("+")}

    def selectors(self, user: str) -> list[list[str]]:
        return [r.strip("()").split() for r in self.users[user] if r.startswith("(")]

    def test_producers_start_from_nothing(self):
        for user in ("wakeline_collector", "wakeline_ais"):
            with self.subTest(user=user):
                rules = self.users[user]
                self.assertIn("-@all", rules, "허용 목록 방식(+@all -@dangerous 가 아니다)")
                self.assertLess(rules.index("-@all"), min(i for i, r in enumerate(rules) if r.startswith("+")), "-@all 이 먼저")
                self.assertFalse({c for c in self.commands(user) if c.startswith("@")}, "카테고리 통째 허용 없음")

    def test_producers_have_no_delete_rename_overwrite_or_expire_in_root(self):
        risky = {"del", "unlink", "rename", "renamenx", "xtrim", "xdel", "set", "mset", "getdel", "getex", "copy", "move", "restore",
                 "expire", "pexpire", "expireat", "pexpireat", "persist", "select", "swapdb", "flushdb", "flushall", "eval", "eval_ro",
                 "function", "script|flush", "sunionstore", "zunionstore", "sort", "xgroup", "xreadgroup", "xack", "xclaim", "xautoclaim",
                 "xsetid", "scan", "randomkey", "keys", "client|tracking", "client|caching", "monitor", "config", "debug", "acl"}
        for user in ("wakeline_collector", "wakeline_ais"):
            with self.subTest(user=user):
                self.assertFalse(self.commands(user) & risky, "루트 규칙(모든 키)에는 파괴적 명령이 없다")

    def test_collector_destructive_commands_are_scoped_to_the_keys_it_writes(self):
        sel = {tuple(sorted(c[1:] for c in s if c.startswith("+"))): sorted(k for k in s if k.startswith(("~", "%"))) for s in self.selectors("wakeline_collector")}
        self.assertEqual(sel, {
            ("set",): ["~wakeline:portcalls:*", "~wakeline:radar_kr:frame:*", "~wakeline:radar_kr:frames", "~wakeline:route:*"],
            ("del",): ["~wakeline:radar_kr:frame:*", "~wakeline:radar_kr:frames"],
            ("expire",): ["~budget:*", "~wakeline:provider:*:ratelimit:*"],
        }, "SET 은 문자열 키에만, DEL 은 레이더 프레임에만, EXPIRE 는 예산 키(Lua)·429 이력 해시에만 — 스트림·다른 해시에는 닿지 않는다")

    def test_collector_expire_reaches_only_the_429_history_among_provider_keys(self):
        # R-17 보존의 429 이력 해시(wakeline:provider:{공급자}:ratelimit:{작업})에 TTL 을 건다. 같은 접두어의 공급자 상태 해시
        # wakeline:provider:{공급자}(api StatusService 가 읽는다)는 EXPIRE 로 지울 수 없어야 한다
        import fnmatch

        (expire,) = [s for s in self.selectors("wakeline_collector") if "+expire" in s]
        pats = [k.split("~", 1)[1] for k in expire if k.startswith("~")]
        def hits(key: str) -> bool:
            return any(fnmatch.fnmatchcase(key, p) for p in pats)
        self.assertTrue(hits("wakeline:provider:adsb_lol:ratelimit:region"))
        self.assertTrue(hits("wakeline:provider:adsb_fi:ratelimit:global"))
        for key in ("wakeline:provider:adsb_lol", "wakeline:provider:kma_radar", "wakeline:aircraft", "wakeline:collector",
                    "wakeline:active", "wakeline:route:ZZX123", "wakeline:portcalls:230025", "wakeline:demand:portcalls", "wakeline:logs"):
            with self.subTest(key=key):
                self.assertFalse(hits(key))
        self.assertEqual(self.selectors("wakeline_ais"), [], "ais 는 지우거나 덮어쓰는 명령이 필요 없다")

    def test_producer_commands_are_exactly_what_the_code_uses(self):
        base = {"hello", "ping", "info", "client|setinfo", "client|setname", "client|id"}
        self.assertEqual(self.commands("wakeline_collector"), base | {
            "xadd", "xrevrange", "hset", "hget", "hgetall", "hmget", "hincrby", "hdel", "hkeys", "exists", "get", "zrangebyscore",
            "script|load", "evalsha"})
        self.assertEqual(self.commands("wakeline_ais"), base | {"xadd", "hset", "hget", "hgetall"})

    # --- 계약 v5 §C3 · ADR-018: 시스템 로그 스트림 wakeline:logs ---
    def test_producers_write_logs_stream_write_only(self):
        for user in ("wakeline_collector", "wakeline_ais"):
            with self.subTest(user=user):
                keys = self.keys(user)
                self.assertIn("%W~wakeline:logs", keys, "XADD wakeline:logs MAXLEN ~ 3000 (계약 v5 §C2)")
                # 쓰기 전용 — 수집기의 XREVRANGE 가 다른 서비스(api · web-client)의 로그를 읽지 못하게(조회는 운영 세션 전용, ADR-018)
                self.assertEqual([k for k in keys if "logs" in k], ["%W~wakeline:logs"], "정확한 이름 하나 · 읽기 권한 없음 · 와일드카드 없음")
                self.assertFalse([s for s in self.selectors(user) if any("logs" in r for r in s)], "셀렉터로도 로그 스트림에 명령을 더 주지 않는다")

    def test_producer_key_patterns_are_pinned(self):
        # 키 규칙 전체를 고정한다 — 넓히려면 이 목록과 redis_acl_test.sh 를 함께 바꾼다
        self.assertEqual(sorted(self.keys("wakeline_collector")), sorted([
            "~wakeline:aircraft", "~wakeline:sigmet", "~wakeline:radar", "~wakeline:events", "~wakeline:collector", "~wakeline:active",
            "~wakeline:provider:*", "~wakeline:radar_kr:*", "%R~wakeline:settings", "~budget:*",
            "%R~wakeline:demand:hot", "%R~wakeline:demand:focus", "%R~wakeline:demand:hot:meta", "%R~wakeline:demand:focus:meta",
            "~wakeline:demand:status", "~wakeline:route:*", "%R~wakeline:demand:portcalls", "~wakeline:portcalls:*", "%W~wakeline:logs"]))
        self.assertEqual(sorted(self.keys("wakeline_ais")), sorted([
            "~wakeline:ships", "~wakeline:ais:*", "%R~wakeline:settings", "%W~wakeline:logs"]))

    def test_api_logs_stream_access_is_not_narrowed(self):
        # api 는 자기 로그 · 브라우저 오류(client-errors)를 XADD 로 싣고 /api/v1/ops/logs 에서 XREVRANGE 로 읽는다.
        # 키는 ~wakeline:*(test_api_can_read_route_cache) 그대로 — 로그 스트림만 좁히는 규칙이나 스트림 명령 빼기가 없어야 한다
        rules = self.users["wakeline_api"]
        self.assertFalse([r for r in rules if "logs" in r], "api 에 wakeline:logs 전용 규칙(%R~ · %W~ · 셀렉터)이 없다")
        removed = {r[1:] for r in rules if r.startswith("-")}
        self.assertFalse(removed & {"xadd", "xrevrange", "xrange", "@stream", "@read", "@write"}, "XADD · XREVRANGE 를 빼지 않는다")

    # --- 계약 v5 §G2: 브라우저 오류 스트림 wakeline:logs:client(MAXLEN ~ 1000) — api 만 싣고 읽는다 ---
    def test_browser_error_stream_is_api_only(self):
        import fnmatch

        def covers(user: str, key: str) -> list[str]:
            # ~p · %R~p · %W~p · %RW~p — 키 패턴(glob) 부분만 비교한다
            return [r for r in self.keys(user) if fnmatch.fnmatchcase(key, r.split("~", 1)[1])]

        self.assertEqual(covers("wakeline_api", "wakeline:logs:client"), ["~wakeline:*"], "api 가 client-errors 를 싣고 /ops/logs 로 읽는다")
        for user in ("wakeline_collector", "wakeline_ais"):
            with self.subTest(user=user):
                # %W~wakeline:logs 는 정확한 이름 — 뚫린 수집기가 익명 입력 스트림을 채우거나 읽지 못한다
                self.assertEqual(covers(user, "wakeline:logs:client"), [])
                self.assertEqual(covers(user, "wakeline:logs"), ["%W~wakeline:logs"])

    def test_api_rules_unchanged(self):
        self.assertIn("+@all", self.users["wakeline_api"])
        self.assertIn("-@dangerous", self.users["wakeline_api"])

    def test_without_ais_password_no_ais_user(self):
        env = {k: v for k, v in FAKE_ENV.items() if k != "REDIS_AIS_PASSWORD"}
        users = acl_rules(env)
        self.assertEqual(set(users), {"wakeline_api", "wakeline_collector"})
        self.assertIn("~wakeline:route:*", [r for r in users["wakeline_collector"] if r.startswith("~")])
        self.assertIn("%W~wakeline:logs", users["wakeline_collector"])


if __name__ == "__main__":
    unittest.main()
