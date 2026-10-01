"""QA 보안 점검(계획 §3.1 보안 헤더 · CSP): edge 를 거친 화면 · API 응답의 헤더, Host 허용 목록(421), X-Forwarded-For · X-Request-Id 위조.
격리 스택(8701 · 8702)만. 요청 수가 적다(약 40) — 요청 제한을 시험하지 않는다(있는지만 응답 헤더 · 설정으로 본다).

    python3 tools/qa/headers_check.py [http://localhost:8701]   # 기대와 다르면 종료 코드 1, 표는 evidence/security/headers_check.json
"""

from __future__ import annotations

import http.client
import json
import os
import re
import sys
import time
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(__file__))
from qa_session import OpsSession  # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8701"
U = urlparse(BASE)
if U.port not in (8701, 8702):
    raise SystemExit("QA 는 격리 스택만")
OUT = os.environ.get("QA_EVIDENCE", os.path.join(os.path.dirname(__file__), "../../docs/qa/2026-10/evidence/security"))
LOG: list[dict] = []
FAIL: list[str] = []

COMMON = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cross-origin-opener-policy": "same-origin",
}


def note(what: str, ok: bool, **kw):
    LOG.append({"check": what, "ok": ok, **kw})
    print(("ok   " if ok else "FAIL ") + what + (" " + json.dumps(kw, ensure_ascii=False)[:400] if kw else ""))
    if not ok:
        FAIL.append(what)


def raw(method: str, path: str, headers: dict | None = None, *, version11: bool = True):
    time.sleep(0.4)
    c = http.client.HTTPConnection(U.hostname, U.port, timeout=30)
    h = {"Host": f"{U.hostname}:{U.port}", **(headers or {})}
    c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
    for k, v in h.items():
        if v is not None:
            c.putheader(k, v)
    c.endheaders()
    r = c.getresponse()
    body = r.read()
    hd: dict[str, list[str]] = {}
    for k, v in r.getheaders():
        hd.setdefault(k.lower(), []).append(v)
    c.close()
    return r.status, hd, body


def one(hd: dict, k: str) -> str | None:
    v = hd.get(k)
    return None if not v else v[0]


def common(label: str, hd: dict):
    for k, v in COMMON.items():
        note(f"{label}: {k}={v}", one(hd, k) == v, got=one(hd, k))


def main() -> int:
    # 화면(HTML) — CSP nonce · strict-dynamic · script 에 unsafe-inline 없음
    for path in ["/", "/logs", "/ops", "/replay", "/stats", "/about", "/guide", "/airports/RKSI"]:
        st, hd, _ = raw("GET", path)
        common(f"page {path}", hd)
        csp = one(hd, "content-security-policy") or ""
        note(f"page {path}: CSP present", "default-src 'self'" in csp, csp=csp[:80])
        m = re.search(r"script-src ([^;]+)", csp)
        script = m.group(1) if m else ""
        note(f"page {path}: script-src has nonce+strict-dynamic, no unsafe-inline",
             "'nonce-" in script and "'strict-dynamic'" in script and "'unsafe-inline'" not in script, script_src=script)
        note(f"page {path}: object-src none · base-uri self · frame-ancestors none · form-action self",
             all(x in csp for x in ("object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'")))
        note(f"page {path}: html not publicly cacheable", "no-store" in (one(hd, "cache-control") or ""), cc=one(hd, "cache-control"))

    # API(JSON) — default-src 'none', CSRF 쿠키 SameSite=Strict
    st, hd, _ = raw("GET", "/api/v1/status")
    common("api /status", hd)
    note("api /status: CSP default-src none", (one(hd, "content-security-policy") or "").startswith("default-src 'none'"), csp=one(hd, "content-security-policy"))
    sc = " ".join(hd.get("set-cookie", []))
    note("api /status: CSRF cookie SameSite=Strict", "WAKELINE_CSRF" in sc and "SameSite=Strict" in sc, set_cookie=sc[:120])
    note("api /status: rate-limit headers present", one(hd, "x-ratelimit-limit") is not None)

    # 정적 — 1년 immutable
    import urllib.request
    html = urllib.request.urlopen(BASE + "/", timeout=30).read().decode("utf-8", "replace")
    m = re.search(r'/_next/static/[^"\']+\.js', html)
    if m:
        st, hd, _ = raw("GET", m.group(0))
        note("static: 1y immutable cache", "immutable" in (one(hd, "cache-control") or ""), cc=one(hd, "cache-control"))
        common("static", hd)

    # 인증 운영 응답 — 공개 캐시 없음
    s = OpsSession(BASE, "qa-a")
    st, hdd, _ = s.request("GET", "/api/v1/ops/providers")
    cc = hdd.get("Cache-Control", "")
    note("ops response is no-store (not publicly cached)", "no-store" in cc, status=st, cache_control=cc)
    s.request("DELETE", "/api/v1/ops/session")

    # Host 허용 목록(421) — DNS rebinding 방어
    for host, exp in [("localhost", 200), ("127.0.0.1", 200), ("evil.example", 421), ("wakeline.dev", 421), ("localhost.evil.com", 421)]:
        time.sleep(0.4)
        c = http.client.HTTPConnection(U.hostname, U.port, timeout=30)
        c.putrequest("GET", "/api/v1/status", skip_host=True, skip_accept_encoding=True)
        c.putheader("Host", f"{host}:{U.port}")
        c.endheaders()
        r = c.getresponse()
        r.read()
        c.close()
        note(f"Host={host} → {exp}", r.status == exp, got=r.status)

    # X-Request-Id · X-Forwarded-For 위조 → edge 가 덮어쓴다(응답 · 본문에 위조 값이 아니다)
    st, hd, _ = raw("GET", "/api/v1/status", {"X-Request-Id": "spoofed-id-123", "X-Forwarded-For": "1.2.3.4"})
    rid = one(hd, "x-request-id")
    note("X-Request-Id spoof overwritten by edge", rid != "spoofed-id-123", response_rid=rid)
    st, hd, body = raw("GET", "/api/v1/ops/providers", {"X-Request-Id": "spoofed-id-123"})
    try:
        body_rid = json.loads(body).get("request_id")
    except Exception:
        body_rid = None
    note("X-Request-Id not reflected into problem body", body_rid != "spoofed-id-123", body_rid=body_rid)

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "headers_check.json"), "w") as f:
        json.dump(LOG, f, ensure_ascii=False, indent=1)
    print(f"\nchecks={len(LOG)} failures={len(FAIL)}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())