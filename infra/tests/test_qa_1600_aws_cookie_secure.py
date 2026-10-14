"""QA-1600 재현(QA 2026-10 AWS · 영역 config): AWS 판 api 의 세션 · CSRF 쿠키 Secure 가 꺼진 채 배포된다.

infra/compose.aws.yml 은 api 에 `WAKELINE_COOKIE_SECURE: "${COOKIE_SECURE:-true}"` 를 준다 — 기본값 true 는 .env 에 COOKIE_SECURE 줄이
'없을 때만' 든다. AWS 의 .env 는 aws-deploy README 3단계대로 `make init`(tools/init_env.py)이 .env.example 을 복사해 만들고
RDS_HOST · PUBLIC_ORIGIN 을 더한 것이다(.env.aws.example 은 이름 목록일 뿐이고 COOKIE_SECURE 가 없다). 그런데 .env.example 에
로컬용 `COOKIE_SECURE=false` 가 있어 그 값이 기본값을 이긴다. AWS 읽기 점검(2026-10-14 — docs/qa/2026-10-aws/evidence/aws-readonly)에서
실행 중인 api 컨테이너의 값이 실제로 false 였다.

이 시험은 그 배포 절차를 그대로 흉내 낸다: 임시 디렉터리에 init_env 로 .env 를 만들고(실제 .env 는 읽지도 바꾸지도 않는다) 더미 RDS_HOST ·
PUBLIC_ORIGIN 을 더한 뒤 `docker compose -f infra/compose.yml -f infra/compose.aws.yml --env-file <임시> config` 의 해석 결과를 본다.
컨테이너를 띄우지 않는다. docker compose 가 없으면 건너뛴다.

뒤따른 결정(QA-1603 — 2026-10-14 배포 뒤): AWS 기본값을 true 로 둔 이 고침은 Safari 의 터널 로그인을 깨 기본값을 false 로 되돌렸다.
그래서 이 시험은 남은 뜻만 본다 — 로컬용 COOKIE_SECURE 줄(.env.example)이 AWS 값을 정하지 않고, AWS_COOKIE_SECURE 만 정한다.

실행: python3 -m unittest discover -s infra/tests -p 'test_qa_1600*' -v
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
AWS = ROOT / "infra" / "compose.aws.yml"
_spec = importlib.util.spec_from_file_location("init_env_qa1600", ROOT / "tools" / "init_env.py")
init_env = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(init_env)

# aws-deploy README 3단계 '공통: RDS_HOST · PUBLIC_ORIGIN' — 더미 값(접속하지 않는다)
AWS_ADDED = {"RDS_HOST": "rds.qa1600.invalid", "PUBLIC_ORIGIN": "https://dqa1600.cloudfront.net"}
# 호스트 셸 값이 해석에 섞이지 않게(시험은 임시 .env 만 본다) — test_compose_policy.py 와 같은 규칙 + 이 시험이 보는 이름
DROP = ("WAKELINE_", "REDIS_", "EDGE_", "DB_", "COMPOSE_", "OPENSKY_", "KMA_", "AIS_", "aisstream", "EXTRA_ALLOWED_ORIGINS",
        "COOKIE_", "RDS_", "PUBLIC_")


def _docker_compose_available() -> bool:
    if not shutil.which("docker"):
        return False
    return subprocess.run(["docker", "compose", "version"], capture_output=True).returncode == 0


def make_aws_env(directory: Path, *, drop_keys: tuple[str, ...] = ()) -> Path:
    """`make init` 으로 만든 .env 에 README 대로 RDS_HOST · PUBLIC_ORIGIN 을 더한 것(비밀값은 init_env 가 만든 임시 값)."""
    env = directory / ".env"
    init_env.ensure_env(env, ROOT / ".env.example", out=io.StringIO())
    text = env.read_text()
    for key in drop_keys:
        text = re.sub(rf"^{re.escape(key)}=.*\n", "", text, flags=re.M)
    text += "".join(f"{k}={v}\n" for k, v in AWS_ADDED.items())
    env.write_text(text)
    return env


def render_api_env(env_file: Path) -> dict[str, str]:
    """AWS 판 compose 해석 결과에서 api 의 environment 만(다른 서비스 · 비밀값은 돌려주지 않는다)."""
    shell = {k: v for k, v in os.environ.items() if not k.startswith(DROP)}
    cmd = ["docker", "compose", "-p", "qa1600", "-f", str(COMPOSE), "-f", str(AWS), "--env-file", str(env_file), "config", "--format", "json"]
    r = subprocess.run(cmd, capture_output=True, text=True, env=shell)
    if r.returncode != 0:
        raise AssertionError(f"docker compose config failed: {r.stderr.strip()[-500:]}")
    return json.loads(r.stdout)["services"]["api"]["environment"]


@unittest.skipUnless(_docker_compose_available(), "docker compose 없음")
class Qa1600AwsCookieSecureTest(unittest.TestCase):
    def test_qa_1600_the_local_cookie_secure_line_does_not_decide_the_aws_value(self) -> None:
        """기대: .env.example 의 로컬용 COOKIE_SECURE=false 가 남아 있어도 AWS_COOKIE_SECURE=true 면 Secure(고치기 전: 로컬 줄이 이겼다)."""
        with tempfile.TemporaryDirectory() as d:
            env = make_aws_env(Path(d))
            env.write_text(env.read_text() + "AWS_COOKIE_SECURE=true\n")
            api = render_api_env(env)
        self.assertEqual(
            api.get("WAKELINE_COOKIE_SECURE"), "true",
            "AWS 판 api 의 WAKELINE_COOKIE_SECURE — make init(.env.example 복사) + RDS_HOST · PUBLIC_ORIGIN + AWS_COOKIE_SECURE=true",
        )

    def test_qa_1600_control_without_the_example_line_the_value_is_the_same(self) -> None:
        """대조: .env 에 COOKIE_SECURE 줄이 없어도 값은 같다(AWS 기본값 — QA-1603 뒤 false)."""
        with tempfile.TemporaryDirectory() as d:
            a, b = Path(d, "a"), Path(d, "b")
            a.mkdir()
            b.mkdir()
            with_line = render_api_env(make_aws_env(a))
            without = render_api_env(make_aws_env(b, drop_keys=("COOKIE_SECURE",)))
        self.assertEqual(with_line.get("WAKELINE_COOKIE_SECURE"), without.get("WAKELINE_COOKIE_SECURE"))
        self.assertEqual(without.get("WAKELINE_COOKIE_SECURE"), "false")

if __name__ == "__main__":
    unittest.main()
