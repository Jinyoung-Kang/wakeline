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


def common(label: str, st: int, hd: dict):
    for k, v in COMMON.items():