"""QA 도우미: 격리 스택(8701 · 8702)에 시험 운영자로 로그인한 세션(쿠키 · CSRF 헤더)을 만든다 — 표준 라이브러리만.

자격 증명은 QA_CREDS(기본: 세션 임시 폴더의 qa-creds.json, 0600)에서 읽고 출력하지 않는다. 운영 스택(8700)에는 쓰지 않는다(막는다).

    from qa_session import OpsSession
    s = OpsSession("http://localhost:8701", "qa-a")
    status, headers, body = s.request("GET", "/api/v1/ops/providers")
"""

from __future__ import annotations

import http.cookiejar
import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlparse

CREDS = os.environ.get(
    "QA_CREDS",
    "/private/tmp/claude-501/-Users-jinyoung-Projects-wakeline/75437490-c65b-4783-9ac0-e224c92a9bab/scratchpad/qa-creds.json",
)
ALLOWED_PORTS = {8701, 8702}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # 리다이렉트는 그대로 돌려받는다(시험이 본다)
        return None


def password(user: str) -> str:
    with open(CREDS) as f:
        return json.load(f)["users"][user]


class OpsSession:
    def __init__(self, base: str, user: str | None = None, *, origin: str | None = None, login: bool = True):
        port = urlparse(base).port
        if port not in ALLOWED_PORTS:
            raise SystemExit(f"QA 는 격리 스택만: {base}")
        self.base = base.rstrip("/")
        self.origin = origin or self.base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), _NoRedirect)
        self.user = user
        self.request("GET", "/api/v1/status")  # 첫 응답이 CSRF 쿠키를 준다(ops 경로가 아니어도 같은 저장소)
        self.request("GET", "/api/v1/ops/session")
        if user and login:
            st, _, body = self.request("POST", "/api/v1/ops/session", {"username": user, "password": password(user)})
            if st != 200:
                raise RuntimeError(f"login failed for {user}: {st} {body[:200]!r}")

    def csrf(self) -> str | None:
        for c in self.jar:
            if c.name == "WAKELINE_CSRF":
                return c.value
        return None

    def request(self, method: str, path: str, body=None, headers: dict | None = None, *, csrf: bool = True, raw: bytes | None = None):
        h = {"Accept": "application/json, application/problem+json"}
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        if method not in ("GET", "HEAD", "OPTIONS") :
            h["Origin"] = self.origin
            h["Sec-Fetch-Site"] = "same-origin"
            tok = self.csrf()
            if csrf and tok:
                h["X-CSRF-Token"] = tok
        h.update(headers or {})
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with self.opener.open(req, timeout=30) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()


if __name__ == "__main__":
    import sys

    base = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8701"
    s = OpsSession(base, "qa-a")
    st, _, body = s.request("GET", "/api/v1/ops/session")
    print("session", st, json.loads(body).get("username"))
