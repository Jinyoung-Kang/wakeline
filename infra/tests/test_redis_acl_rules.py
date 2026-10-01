"""infra/redis/start.sh 가 만드는 ACL 규칙 정책 시험(계약 §6 · 계약 v2 §C · 계약 v4 §A · 계약 v5 §C3) — 컨테이너를 띄우지 않는다.

start.sh 를 그대로 실행하되 PATH 앞에 가짜 redis-server(받은 인자를 파일에 한 줄에 하나씩 적는다)를 두고 TMPDIR 을 임시 디렉터리로 바꿔,
redis-server 가 받는 인자(argv)와 start.sh 가 쓴 ACL 파일(--aclfile)을 읽는다. 사용자별 키 · 명령 규칙은 ACL 파일에서 읽는다.
동작 시험(명령이 실제로 거부되는지)은 redis_acl_test.sh(docker)가 한다.

실행: python3 -m unittest discover -s infra/tests -v
"""
from __future__ import annotations

import hashlib
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from dataclasses import dataclass
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
OWNER = {"default": "REDIS_PASSWORD", "wakeline_api": "REDIS_API_PASSWORD",
         "wakeline_collector": "REDIS_COLLECTOR_PASSWORD", "wakeline_ais": "REDIS_AIS_PASSWORD"}


def sha256_rule(password: str) -> str:
    """Redis ACL 의 해시 비밀번호 규칙(#<SHA-256 소문자 16진수 64자>)."""
    return "#" + hashlib.sha256(password.encode()).hexdigest()


def merge_selectors(tokens: list[str]) -> list[str]:
    """공백으로 나뉜 셀렉터 '(~a ~b +set)' 를 인자 하나로 다시 합친다(Redis 의 ACL 파일 읽기와 같다)."""
    out: list[str] = []
    buf: list[str] = []
    for tok in tokens:
        if buf or tok.startswith("("):
            buf.append(tok)
            if tok.endswith(")"):
                out.append(" ".join(buf))
                buf = []
        else:
            out.append(tok)
    assert not buf, f"닫히지 않은 셀렉터: {buf}"
    return out


@dataclass
class StartResult:
    argv: list[str]          # 가짜 redis-server 가 받은 인자
    output: str              # start.sh 의 표준 출력 + 표준 오류
    aclfile: Path | None     # --aclfile 로 넘긴 경로(TMPDIR 안)
    acl_text: str            # ACL 파일 내용
    acl_mode: int            # ACL 파일 권한 비트
    users: dict[str, list[str]]  # ACL 파일의 사용자 → 규칙(on · 비밀번호 규칙 포함, 셀렉터는 인자 하나)


def run_start(extra_env: dict[str, str]) -> StartResult:
    """start.sh 를 가짜 redis-server 로 실행해 argv 와 ACL 파일을 돌려준다."""
    with tempfile.TemporaryDirectory() as tmp:
        bin_dir = Path(tmp) / "bin"
        bin_dir.mkdir()
        tmpdir = Path(tmp) / "tmp"
        tmpdir.mkdir()
        argv_file = Path(tmp) / "argv"
        stub = bin_dir / "redis-server"
        stub.write_text(f'#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done > "{argv_file}"\n')
        stub.chmod(0o755)
        env = {"PATH": f"{bin_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}", "TMPDIR": str(tmpdir), **extra_env}
        r = subprocess.run(["sh", str(START)], env=env, capture_output=True, text=True, check=True)
        argv = argv_file.read_text().splitlines()
        aclfile = Path(argv[argv.index("--aclfile") + 1]) if "--aclfile" in argv else None
        acl_text, acl_mode = "", 0
        if aclfile is not None and aclfile.is_file():
            acl_text = aclfile.read_text()
            acl_mode = stat.S_IMODE(aclfile.stat().st_mode)
        users: dict[str, list[str]] = {}
        for line in acl_text.splitlines():
            tokens = line.split()
            if not tokens:
                continue
            assert tokens[0] == "user", line
            users[tokens[1]] = merge_selectors(tokens[2:])
        return StartResult(argv, r.stdout + r.stderr, aclfile, acl_text, acl_mode, users)


@unittest.skipUnless(shutil.which("sh"), "sh 없음")
class RedisSecretsTest(unittest.TestCase):
    """S7 · L-3: 서비스 비밀번호는 redis-server 의 명령행(argv — 기동 직후 ps · /proc/<pid>/cmdline 에 보인다)에 오지 않는다.
    start.sh 는 환경변수에서 읽어 소유자 전용(0600) ACL 파일에 SHA-256 해시(#…)로만 쓰고 redis-server 는 --aclfile 로 그 파일을 읽는다."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.result = run_start(FAKE_ENV)

    def test_no_password_reaches_the_redis_server_argv(self):
        for name, value in FAKE_ENV.items():
            with self.subTest(secret=name):
                self.assertFalse([a for a in self.result.argv if value in a], "비밀번호가 redis-server 의 argv 에 있다")
        self.assertNotIn("--requirepass", self.result.argv)
        self.assertNotIn("--user", self.result.argv, "사용자는 ACL 파일로만 만든다")

    def test_users_come_from_an_owner_only_aclfile_in_tmpdir(self):
        self.assertIn("--aclfile", self.result.argv)
        self.assertIsNotNone(self.result.aclfile)
        self.assertTrue(self.result.acl_text, "ACL 파일이 비어 있지 않다")
        self.assertEqual(self.result.acl_mode, 0o600, "소유자만 읽는다(umask 077)")
        self.assertEqual(set(self.result.users), set(OWNER), "관리용 default 와 서비스 사용자 셋")

    def test_aclfile_holds_only_hashes_of_the_env_passwords(self):
        for name, value in FAKE_ENV.items():
            with self.subTest(secret=name):
                self.assertNotIn(value, self.result.acl_text, "평문 비밀번호는 파일에도 남기지 않는다")
        for user, var in OWNER.items():
            with self.subTest(user=user):
                rules = self.result.users[user]
                self.assertEqual(rules[:2], ["on", sha256_rule(FAKE_ENV[var])], "환경변수 값의 SHA-256 하나만")
                self.assertFalse([r for r in rules if r.startswith((">", "<", "!")) or r in ("nopass", "resetpass")])

    def test_default_user_keeps_its_full_admin_rules(self):
        """requirepass 가 하던 일(관리용 default 에 비밀번호)과 같은 권한 — 헬스체크 · 운영 redis-cli 용."""
        self.assertEqual(self.result.users["default"], ["on", sha256_rule(FAKE_ENV["REDIS_PASSWORD"]), "~*", "&*", "+@all"])

    def test_start_sh_prints_no_secret(self):
        for name, value in FAKE_ENV.items():
            with self.subTest(secret=name):
                self.assertNotIn(value, self.result.output)

    def test_password_with_spaces_or_newlines_cannot_add_acl_rules(self):
        """ACL 파일은 줄 · 공백 단위로 읽힌다 — 평문을 쓰면 비밀번호 안의 줄바꿈 · 공백이 규칙이 된다. 해시는 늘 16진수 64자다."""
        tricky = {**FAKE_ENV, "REDIS_API_PASSWORD": "pw with space\nuser evil on nopass ~* +@all"}
        run = run_start(tricky)
        self.assertEqual(set(run.users), set(OWNER))
        self.assertEqual(run.users["wakeline_api"][:2], ["on", sha256_rule(tricky["REDIS_API_PASSWORD"])])
        self.assertNotIn("evil", run.acl_text)


def acl_rules(extra_env: dict[str, str]) -> dict[str, list[str]]:
    """start.sh 가 ACL 파일에 쓰는 서비스 사용자 규칙 → {사용자: [규칙...]} (관리용 default 는 RedisSecretsTest 가 본다)."""
    return {u: r for u, r in run_start(extra_env).users.items() if u != "default"}


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

    # --- ADR-022 개정: 한국 항만 입출항은 DB 색인(port_call) — 선택마다 쓰던 임대 · 캐시 키는 없앴고 규칙도 없다 ---
    def test_no_producer_reaches_the_retired_port_call_keys(self):
        import fnmatch

        for user in ("wakeline_collector", "wakeline_ais"):
            with self.subTest(user=user):
                self.assertFalse([k for k in self.keys(user) if "portcalls" in k], "예전 임대 · 캐시 이름을 다시 열지 않는다")
                for sel in self.selectors(user):
                    self.assertFalse([k for k in sel if "portcalls" in k])
                pats = [r.split("~", 1)[1] for r in self.keys(user)]
                for key in ("wakeline:demand:portcalls", "wakeline:portcalls:V7A3884"):
                    self.assertFalse([p for p in pats if fnmatch.fnmatchcase(key, p)], key)
        self.assertNotIn("~wakeline:demand:*", self.keys("wakeline_collector"), "임대 키를 와일드카드로 넓히지 않는다")

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
            ("set",): ["~wakeline:radar_kr:frame:*", "~wakeline:radar_kr:frames", "~wakeline:route:*", "~wakeline:traffic_grid"],
            ("del",): ["~wakeline:radar_kr:frame:*", "~wakeline:radar_kr:frames"],
            ("expire",): ["~budget:*", "~wakeline:provider:*:ratelimit:*"],
            ("hgetall", "hset"): ["~wakeline:traffic_grid:negative", "~wakeline:traffic_grid:tiles"],
        }, "SET 은 문자열 키에만, DEL 은 레이더 프레임에만, EXPIRE 는 예산 키(Lua)·429 이력 해시에만, 연안 교통량 부정 캐시 · 타일 상태는 HSET·HGETALL 만 — "
           "스트림·다른 해시에는 닿지 않는다")

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
            "~wakeline:demand:status", "~wakeline:route:*", "%W~wakeline:logs"]))
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

    # --- ADR-023: 연안 교통량 스냅샷 wakeline:traffic_grid(SET) · 부정 캐시 wakeline:traffic_grid:negative · bbox 타일 상태
    #     wakeline:traffic_grid:tiles(2026-10-01 bbox 개정)(HSET · HGETALL) ---
    def test_collector_reaches_the_traffic_grid_keys_only_through_selectors(self):
        """루트 키 목록에 두면 루트 명령 전부(HDEL · HINCRBY · XADD …)가 그 키에 닿는다(검토 지적) — 셀렉터로 쓰는 명령만 준다.
        SET 에 EX 를 붙이게 강제하는 ACL 은 없다: 수집기가 늘 EX 1200 을 붙이고, 실제 방어선은 api 의 regDt 나이 판정(stale)이다."""
        import fnmatch

        self.assertFalse([k for k in self.keys("wakeline_collector") if "traffic" in k], "루트 키 목록에 없다")
        sels = self.selectors("wakeline_collector")
        traffic = [s for s in sels if any("traffic" in k for k in s)]
        self.assertEqual(sorted(sorted(s) for s in traffic), sorted([
            sorted(["~wakeline:route:*", "~wakeline:radar_kr:frames", "~wakeline:radar_kr:frame:*", "~wakeline:traffic_grid", "+set"]),
            sorted(["~wakeline:traffic_grid:negative", "~wakeline:traffic_grid:tiles", "+hset", "+hgetall"]),
        ]), "스냅샷은 SET 만, 부정 캐시 · 타일 상태는 HSET · HGETALL 만 — 정확한 이름(와일드카드 없음)")
        for sel in sels:
            pats = [k.split("~", 1)[1] for k in sel if k.startswith("~")]
            cmds = {c for c in sel if c.startswith("+")}
            for key in ("wakeline:traffic_grid", "wakeline:traffic_grid:negative", "wakeline:traffic_grid:tiles"):
                if any(fnmatch.fnmatchcase(key, p) for p in pats):
                    self.assertFalse(cmds & {"+del", "+expire", "+hdel", "+hincrby", "+xadd", "+get"}, f"{key}: {cmds}")

    def test_ais_has_no_traffic_grid_access_and_api_reads_it(self):
        self.assertFalse([k for k in self.keys("wakeline_ais") if "traffic" in k])
        self.assertIn("~wakeline:*", self.keys("wakeline_api"))

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
