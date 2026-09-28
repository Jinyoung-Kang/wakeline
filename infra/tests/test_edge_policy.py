"""edge(nginx) 설정 정책 — 컨테이너 없이 파일만 본다. 실제 동작은 edge_test.sh(버리는 컨테이너)."""
import re
import unittest
from pathlib import Path

EDGE = Path(__file__).resolve().parents[1] / "edge"


def directives(text: str) -> list[str]:
    """주석을 뺀 지시문 줄."""
    return [ln.split("#", 1)[0].strip() for ln in text.splitlines() if ln.split("#", 1)[0].strip()]


class ProxyHeaders(unittest.TestCase):
    def setUp(self):
        self.lines = directives((EDGE / "proxy_headers.conf").read_text(encoding="utf-8"))

    def test_client_supplied_forwarding_headers_are_overwritten(self):
        self.assertIn("proxy_set_header X-Forwarded-For $remote_addr;", self.lines)
        self.assertIn('proxy_set_header X-Forwarded-Host "";', self.lines)

    def test_request_id_is_the_edge_request_id(self):
        # R-49: api(RequestIdFilter)는 edge 에서 온 X-Request-Id 를 믿는다 — 클라이언트 값이 그대로 흘러가면 로그 상관 id 를 고를 수 있다
        self.assertIn("proxy_set_header X-Request-Id $request_id;", self.lines)


class AccessLog(unittest.TestCase):
    def test_access_log_carries_the_request_id(self):
        conf = (EDGE / "nginx.conf").read_text(encoding="utf-8")
        fmt = re.search(r"log_format\s+(\w+)\s+(.*?);", conf, re.S)
        self.assertIsNotNone(fmt, "log_format 정의")
        self.assertIn("$request_id", fmt.group(2))
        self.assertRegex(conf, rf"access_log\s+/dev/stdout\s+{fmt.group(1)}\s*;")


if __name__ == "__main__":
    unittest.main()
