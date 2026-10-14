"""QA-1603 재현(QA 2026-10 AWS · 배포 뒤 · 영역 config): AWS 운영자 로그인이 Safari 에서 곧바로 '세션이 만료되었습니다'로 끝난다.

QA-1600 고침(`AWS_COOKIE_SECURE`, 기본 true)으로 운영 세션 · CSRF 쿠키에 Secure 가 붙었다. 그런데 운영 화면은 공개 주소에서 닫혀 있고(Caddy 404)
SSM 포트 포워딩 터널 http://localhost:8700 으로만 쓴다(compose.aws.yml 의 허용 Origin). Safari 는 http://localhost 에서 Secure 쿠키를 저장하지 않아,
로그인(POST /api/v1/ops/session → 200) 바로 뒤 운영 요청이 세션 없이 가 모두 404 였다(2026-10-14 14:54Z 배포 뒤 · edge 접근 기록 · Safari 27).
QA-1600 의 기록(findings/config.md)은 '단순히 true 로 바꾸면 터널 로그인이 깨진다'고 적었는데, 고침이 그대로 true 로 했다.

기대: AWS 판의 기본값은 Secure 없음(false) — 운영 세션 쿠키가 실리는 길은 평문 터널뿐이라 Secure 가 지킬 것이 없고, 공개 쪽 CSRF 쿠키는 세션 없이는
값이 없으며 CloudFront 가 HTTPS 리디렉트 · HSTS 를 건다. 로컬용 COOKIE_SECURE 는 여전히 AWS 값을 정하지 않고(QA-1600), 터널을 HTTPS 로 바꾸면
AWS_COOKIE_SECURE=true 로 켠다. 컨테이너를 띄우지 않는다(compose 해석만). docker compose 가 없으면 건너뛴다.

실행: python3 -m unittest discover -s infra/tests -p 'test_qa_1603*' -v
"""
from __future__ import annotations

import re
import tempfile
import unittest
from pathlib import Path

from test_qa_1600_aws_cookie_secure import _docker_compose_available, make_aws_env, render_api_env


def _set(env: Path, key: str, value: str) -> Path:
    text = re.sub(rf"^{re.escape(key)}=.*\n", "", env.read_text(), flags=re.M)
    env.write_text(text + f"{key}={value}\n")
    return env


@unittest.skipUnless(_docker_compose_available(), "docker compose 없음")
class Qa1603AwsTunnelCookieTest(unittest.TestCase):
    def test_qa_1603_aws_cookie_is_not_secure_by_default_for_the_http_tunnel(self) -> None:
        """기대: 문서대로 만든 .env(make init + RDS_HOST · PUBLIC_ORIGIN)에서 AWS 판 api 의 쿠키 Secure 는 꺼짐. 실제(고치기 전): true."""
        with tempfile.TemporaryDirectory() as d:
            api = render_api_env(make_aws_env(Path(d)))
        self.assertEqual(api.get("WAKELINE_COOKIE_SECURE"), "false",
                         "운영자는 http://localhost:8700 터널로만 로그인한다 — Secure 쿠키는 Safari 가 저장하지 않는다")

    def test_qa_1603_the_local_cookie_secure_line_still_does_not_decide(self) -> None:
        """로컬용 COOKIE_SECURE=true 가 있어도 AWS 값은 AWS_COOKIE_SECURE 의 기본값(QA-1600 의 분리는 그대로)."""
        with tempfile.TemporaryDirectory() as d:
            api = render_api_env(_set(make_aws_env(Path(d)), "COOKIE_SECURE", "true"))
        self.assertEqual(api.get("WAKELINE_COOKIE_SECURE"), "false")

    def test_qa_1603_control_aws_cookie_secure_true_still_turns_it_on(self) -> None:
        """대조(지금도 통과): 터널을 HTTPS 로 바꿀 때는 AWS_COOKIE_SECURE=true 로 켠다."""
        with tempfile.TemporaryDirectory() as d:
            api = render_api_env(_set(make_aws_env(Path(d)), "AWS_COOKIE_SECURE", "true"))
        self.assertEqual(api.get("WAKELINE_COOKIE_SECURE"), "true")


if __name__ == "__main__":
    unittest.main()
