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


class NoOutboundCalls(unittest.TestCase):
    """edge 는 인터넷에 닿는 bridge(public)에 있다(게시 포트) — 외부로 나가지 않는 것은 설정이 지킨다(R-77 후속)."""

    def setUp(self):
        self.lines = directives((EDGE / "nginx.conf").read_text(encoding="utf-8"))

    def test_upstreams_are_only_the_internal_services(self):
        servers = [ln for ln in self.lines if ln.startswith("upstream ")]
        self.assertEqual(sorted(re.findall(r"server\s+([\w.-]+:\d+)", " ".join(servers))), ["api:8000", "web:3000"])
        targets = [re.search(r"proxy_pass\s+(\S+);", ln).group(1) for ln in self.lines if ln.startswith("proxy_pass")]
        self.assertTrue(targets)
        for t in targets:
            self.assertRegex(t, r"^http://(api|web)(/|$)", "proxy_pass 는 upstream 이름만(주소·변수 금지)")

    def test_no_resolver_and_no_variable_upstreams(self):
        joined = "\n".join(self.lines)
        self.assertNotRegex(joined, r"(?m)^resolver\b", "resolver 가 있으면 변수 proxy_pass 로 외부 이름을 풀 수 있다")
        self.assertNotRegex(joined, r"proxy_pass\s+\S*\$", "변수 proxy_pass 금지")


class StaticAssetsTest(unittest.TestCase):
    """버전이 붙은 불변 정적 파일(/_next/static · /maplibre/<버전>)은 IP당 제한 밖이고 1년 immutable 캐시다."""

    def test_versioned_static_locations_are_not_rate_limited(self):
        conf = (EDGE / "nginx.conf").read_text(encoding="utf-8")
        for loc in ("/_next/static/", "/maplibre/"):
            with self.subTest(location=loc):
                m = re.search(r"location \^~ " + re.escape(loc) + r" \{(.*?)\n        \}", conf, re.S)
                self.assertIsNotNone(m, f"location ^~ {loc}")
                self.assertNotIn("limit_req", m.group(1))
                self.assertIn('add_header Cache-Control "public, max-age=31536000, immutable" always;', m.group(1))
                self.assertIn("include /etc/nginx/security_headers.conf;", m.group(1), "add_header 상속 함정")



class EdgeProblemJsonTest(unittest.TestCase):
    """edge 가 직접 만든 오류(400 · 413 · 414 · 429 · 502 · 503 · 504)도 api 와 같은 problem+json — QA 2026-10 기능 개선 제안 9 (edge_test.sh 가 실제 응답을 본다)."""

    def setUp(self):
        self.conf = (EDGE / "nginx.conf").read_text(encoding="utf-8")

    def test_every_problem_location_uses_the_shared_snippet_and_returns_its_own_status(self):
        pages = (EDGE / "problem_pages.conf").read_text(encoding="utf-8")
        locs = re.findall(r"location = /\.edge-problem/(\d{3}) \{(.*?)\}\s*$", pages, re.M)
        self.assertEqual(sorted(code for code, _ in locs), ["400", "413", "414", "429", "502", "503", "504"])
        for code, body in locs:
            with self.subTest(status=code):
                self.assertIn("internal;", body, "밖에서 이 URI 로 부를 수 없다")
                self.assertIn("include /etc/nginx/problem.conf;", body)
                self.assertIn(f"return {code} '", body)
                self.assertIn(f'"status":{code},', body)
                self.assertIn('"request_id":"$request_id"', body)

    def test_api_location_maps_its_errors_to_problem_json(self):
        m = re.search(r"location /api/ \{(.*?)\n        \}", self.conf, re.S)
        self.assertIsNotNone(m)
        for code in ("400", "413", "414", "429", "502", "503", "504"):
            self.assertIn(f"error_page {code} /.edge-problem/{code};", m.group(1))
        self.assertNotIn("proxy_intercept_errors on", self.conf, "api 가 만든 오류는 가로채지 않는다")

    def test_snippet_keeps_the_security_headers_and_compose_mounts_it(self):
        snippet = (EDGE / "problem.conf").read_text(encoding="utf-8")
        self.assertIn("default_type application/problem+json;", snippet)
        self.assertIn("include /etc/nginx/security_headers.conf;", snippet, "add_header 상속 함정")
        compose = (EDGE.parent / "compose.yml").read_text(encoding="utf-8")
        self.assertIn("./edge/problem.conf:/etc/nginx/problem.conf:ro", compose)
        self.assertIn("./edge/problem_pages.conf:/etc/nginx/problem_pages.conf:ro", compose)

    def test_both_servers_send_parse_errors_to_problem_json(self):
        """요청 줄을 해석하다 난 400 · 414 는 Host 를 읽기 전이면 기본 서버(421)로 간다 — 두 server 모두 같은 error_page 와 include."""
        servers = re.findall(r"\n    server \{(.*?)\n    \}", self.conf, re.S)
        self.assertEqual(len(servers), 2)
        for body in servers:
            for line in ("error_page 400 /.edge-problem/400;", "error_page 414 /.edge-problem/414;", "include /etc/nginx/problem_pages.conf;"):
                self.assertIn(line, body)


if __name__ == "__main__":
    unittest.main()
