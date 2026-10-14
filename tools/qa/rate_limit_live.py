#!/usr/bin/env python3
"""QA 2026-10-aws(api-live): 공개 요청 제한(IP당 분당 120 — 기본값)의 경계와 무엇이 세지는지를 라이브 격리 스택(8701 · 8702)에서 본다. 표준 라이브러리만.

1. 새 분이 시작될 때까지 기다린 뒤 공개 GET 125건 → 120번째까지 200 · 121번째부터 429 RATE_LIMITED + Retry-After · X-RateLimit-* · 문제 응답 모양
2. 다음 분: 익명 운영 GET(/api/v1/ops/providers — 404) 60건 다음 공개 GET 1건 — 공개 GET 의 X-RateLimit-Remaining 이 운영 요청을 셌는가(119 이면 세지 않음)
3. 다음 분: 400(형식 오류 · 경로 방화벽) 60건 다음 공개 GET 1건 — 같은 방식
4. 다음 분: /healthz · /api/v1/openapi 를 섞어 세는가

edge 의 IP당 초당 10(burst 30)을 넘지 않게 0.13 s 간격으로 보낸다.

    python3 tools/qa/rate_limit_live.py [--base http://localhost:8701]
"""

from __future__ import annotations

import argparse
import collections
import http.client
import json
import sys
import time
from urllib.parse import urlparse


def req(host, port, path):
    c = http.client.HTTPConnection(host, port, timeout=10)
    c.request("GET", path, headers={"Accept": "application/json, application/problem+json"})
    r = c.getresponse()
    b = r.read()
    h = {k.lower(): v for k, v in r.getheaders()}
    c.close()
    time.sleep(0.13)
    return r.status, h, b


def next_minute():
    time.sleep(61 - time.time() % 60 + 0.3)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8701")
    a = ap.parse_args()
    u = urlparse(a.base)
    if u.port not in (8701, 8702):
        raise SystemExit("QA 는 격리 스택만")
    H, P = u.hostname, u.port
    bad = 0

    print("## 1. 경계 120/121(공개 GET /api/v1/status)")
    next_minute()
    rows = []
    for i in range(1, 126):
        st, h, b = req(H, P, "/api/v1/status")
        code = None
        if st >= 400:
            try:
                j = json.loads(b)
                code = (j.get("code"), sorted(j.keys()), h.get("content-type"))
            except ValueError:
                code = b[:60]
        rows.append((i, st, h.get("x-ratelimit-limit"), h.get("x-ratelimit-remaining"), h.get("x-ratelimit-reset"), h.get("retry-after"), code))
    for r in rows[:2] + rows[118:]:
        print("  ", r)
    c = collections.Counter(r[1] for r in rows)
    print("  상태:", dict(c))
    if c.get(200) != 120 or rows[120][1] != 429 or not rows[120][5]:
        bad += 1
        print("  BUG 경계가 120/121 이 아니다")

    for label, paths in (("2. 익명 운영 GET 60건(404)", ["/api/v1/ops/providers"] * 60),
                         ("3. 400 60건(형식 오류 30 · 방화벽 30)", ["/api/v1/aircraft?bbox=x"] * 30 + ["/api/v1/ops;x/providers"] * 30),
                         ("4. /healthz 30 · /api/v1/openapi 30", ["/healthz"] * 30 + ["/api/v1/openapi"] * 30)):
        print(f"## {label} 다음 공개 GET")
        next_minute()
        sts = collections.Counter()
        for p in paths:
            st, h, _ = req(H, P, p)
            sts[st] += 1
        st, h, _ = req(H, P, "/api/v1/status")
        rem = h.get("x-ratelimit-remaining")
        print(f"   보낸 것 {dict(sts)} → 공개 GET {st} X-RateLimit-Remaining={rem} (120 − 1 − 센 수)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
