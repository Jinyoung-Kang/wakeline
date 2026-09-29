"""tools/init_env.py 단위 시험 (SEC-13). 실제 .env 는 건드리지 않고 임시 디렉터리에서 돈다.

실행: python3 -m unittest discover -s infra/tests -v
"""
from __future__ import annotations

import importlib.util
import io
import os
import re
import stat
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("init_env", ROOT / "tools" / "init_env.py")
init_env = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(init_env)


def mode(p: Path) -> int:
    return stat.S_IMODE(p.stat().st_mode)


def values(text: str) -> dict[str, str]:
    return dict(re.findall(r"^([A-Z0-9_]+)=(.*)$", text, re.M))


class InitEnvTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.example = self.dir / ".env.example"
        self.env = self.dir / ".env"
        # 저장소의 실제 .env.example 을 쓴다 — 새 내부 비밀값 key 가 예시 파일에 빠지면 여기서 드러난다
        self.example.write_text((ROOT / ".env.example").read_text())
        self.out = io.StringIO()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_example_lists_every_internal_secret_empty(self):
        v = values(self.example.read_text())
        for key in init_env.INTERNAL:
            self.assertIn(key, v, f"{key} 가 .env.example 에 없음")
            self.assertEqual(v[key], "", f"{key} 는 예시 파일에서 비어 있어야 한다")

    def test_creates_env_owner_only_with_all_internal_secrets(self):
        old = os.umask(0o022)  # 느슨한 umask 에서도 0600 이어야 한다
        try:
            generated = init_env.ensure_env(self.env, self.example, out=self.out)
        finally:
            os.umask(old)
        self.assertEqual(mode(self.env), 0o600)
        self.assertEqual(sorted(generated), sorted(init_env.INTERNAL))
        v = values(self.env.read_text())
        for key in init_env.INTERNAL:
            self.assertGreaterEqual(len(v[key]), 32, key)
        self.assertIn("REDIS_API_PASSWORD", v)
        self.assertIn("REDIS_COLLECTOR_PASSWORD", v)
        self.assertIn("REDIS_AIS_PASSWORD", v)                   # 계약 v2 §C: wakeline_ais
        # 서비스별 비밀번호는 서로 달라야 한다
        self.assertEqual(len({v[k] for k in init_env.INTERNAL}), len(init_env.INTERNAL))
        # 외부 키는 만들지 않는다
        self.assertEqual(v.get("OPENSKY_CLIENT_SECRET"), "")
        self.assertEqual(v.get("KMA_APIHUB_KEY"), "")
        self.assertRegex(self.env.read_text(), r"(?m)^aisstream_key=$")
        self.assertNotIn("aisstream_key", init_env.INTERNAL)
        self.assertIn("ships layer", self.out.getvalue())       # 없으면 무엇이 꺼지는지 알려 준다(값은 출력하지 않음)
        # ADR-022: 공공데이터포털 키도 사람이 넣는 외부 키 — 만들지 않고, 없으면 꺼지는 기능을 알려 준다
        self.assertEqual(v.get("DATA_GO_KR_SERVICE_KEY"), "")
        self.assertNotIn("DATA_GO_KR_SERVICE_KEY", init_env.INTERNAL)
        self.assertIn("Korean port calls", self.out.getvalue())

    def test_owner_env_with_lowercase_ais_key_and_no_trailing_newline(self):
        """사용자 .env 처럼 마지막 줄이 소문자 aisstream_key=… 이고 줄바꿈이 없어도: 키는 그대로, REDIS_AIS_PASSWORD 는 새 줄에 추가."""
        key = "owner-ais-key-" + "x" * 26
        base = init_env.fill_secrets((ROOT / ".env.example").read_text().replace("REDIS_AIS_PASSWORD=\n", ""), [k for k in init_env.INTERNAL if k != "REDIS_AIS_PASSWORD"])[0]
        base = base.replace("\naisstream_key=\n", "\n").rstrip("\n")
        self.env.write_text(base + f"\naisstream_key={key}")      # 줄바꿈 없음
        before = values(self.env.read_text())
        generated = init_env.ensure_env(self.env, self.example, out=self.out)
        self.assertEqual(generated, ["REDIS_AIS_PASSWORD"])
        text = self.env.read_text()
        self.assertIn(f"\naisstream_key={key}\n", text)            # 원래 줄은 그대로(뒤에 줄바꿈만)
        v = values(text)
        self.assertGreaterEqual(len(v["REDIS_AIS_PASSWORD"]), 32)
        for k, old in before.items():
            self.assertEqual(v[k], old, k)                         # 이미 있던 값은 하나도 바뀌지 않는다
        self.assertNotIn(key, self.out.getvalue())
        self.assertNotIn("ships layer", self.out.getvalue())       # 키가 있으면 '꺼짐' 안내 없음

    def test_existing_world_readable_env_is_tightened_and_values_kept(self):
        self.env.write_text("DB_ROOT_PASSWORD=keep-me\nOPENSKY_CLIENT_ID=my-id\nREDIS_PASSWORD=\n")
        os.chmod(self.env, 0o644)
        generated = init_env.ensure_env(self.env, self.example, out=self.out)
        self.assertEqual(mode(self.env), 0o600)
        v = values(self.env.read_text())
        self.assertEqual(v["DB_ROOT_PASSWORD"], "keep-me")        # 이미 있는 값은 그대로
        self.assertEqual(v["OPENSKY_CLIENT_ID"], "my-id")         # 사람이 넣은 외부 키도 그대로
        self.assertTrue(v["REDIS_PASSWORD"])                      # 빈 값은 채운다
        self.assertIn("REDIS_API_PASSWORD", generated)            # 빠진 key 는 추가한다
        self.assertIn("REDIS_COLLECTOR_PASSWORD", generated)
        self.assertNotIn("DB_ROOT_PASSWORD", generated)
        self.assertIn("tightened", self.out.getvalue())

    def test_idempotent_no_rewrite_when_complete(self):
        init_env.ensure_env(self.env, self.example, out=self.out)
        before = self.env.read_text()
        os.chmod(self.env, 0o640)
        generated = init_env.ensure_env(self.env, self.example, out=io.StringIO())
        self.assertEqual(generated, [])
        self.assertEqual(self.env.read_text(), before)
        self.assertEqual(mode(self.env), 0o600)

    def test_secrets_never_printed(self):
        init_env.ensure_env(self.env, self.example, out=self.out)
        v = values(self.env.read_text())
        printed = self.out.getvalue()
        for key in init_env.INTERNAL:
            self.assertNotIn(v[key], printed)

    def test_missing_trailing_newline_does_not_merge_lines(self):
        self.env.write_text("DB_ROOT_PASSWORD=x")  # 마지막 줄바꿈 없음
        init_env.ensure_env(self.env, self.example, out=self.out)
        v = values(self.env.read_text())
        self.assertEqual(v["DB_ROOT_PASSWORD"], "x")
        self.assertTrue(v["REDIS_API_PASSWORD"])

    def test_no_temp_files_left_behind(self):
        init_env.ensure_env(self.env, self.example, out=self.out)
        leftovers = [p.name for p in self.dir.iterdir() if p.name.endswith(".tmp")]
        self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main()
