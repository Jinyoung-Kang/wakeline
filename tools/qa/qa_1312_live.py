#!/usr/bin/env python3
"""QA-1312 라이브 재현(QA 2026-10-aws · api-live): 질의 문자열을 Tomcat 이 해석하지 못하면(잘못된 퍼센트 인코딩 · 파라미터 1,000개 초과) 파라미터를 읽는
공개 GET 이 익명 요청에 500 + 서버 ERROR. 격리 스택(8701 · 8702)만, 표준 라이브러리만. 운영 로그 확인은 tools/qa/qa_session.py(QA_CREDS)로.

    QA_CREDS=<시험 운영자 JSON> python3 tools/qa/qa_1312_live.py [--base http://localhost:8701]   # 500 이 있으면 종료 코드 1
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import sys
import time
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ACCEPT = "application/geo+json, application/json;q=0.9, application/problem+json;q=0.8, image/png;q=0.5"
ROUTES = ["/healthz", "/api/v1/status", "/api/v1/aircraft?bbox=124,33,132,39", "/api/v1/aircraft/search?q=KAL", "/api/v1/aircraft/71aa64",
          "/api/v1/aircraft/71aa64/track", "/api/v1/ships?bbox=120,30,135,40", "/api/v1/ships/search?q=44", "/api/v1/ships/440095870",
          "/api/v1/ships/440095870/track", "/api/v1/ships/coverage", "/api/v1/ais/gaps", "/api/v1/traffic/grid", "/api/v1/sigmets", "/api/v1/alerts",
          "/api/v1/alerts/history", "/api/v1/radar/frames", "/api/v1/radar/kr", "/api/v1/airports", "/api/v1/airports/RKSI/wx",
          "/api/v1/replay?at={at}&bbox=124,33,132,39", "/api/v1/stats/sigmet", "/api/v1/stats/traffic", "/api/v1/stats/alerts", "/api/v1/airspace",
          "/api/v1/warnings", "/api/v1/warnings/history", "/api/v1/watch", "/api/v1/openapi"]


def get(host, port, target):
    c = http.client.HTTPConnection(host, port, timeout=15)
    c.request("GET", target, headers={"Accept": ACCEPT})
    r = c.getresponse()
    b = r.read()
    c.close()
    time.sleep(0.55)  # api 분당 120 · edge 초당 10 안
    code = None
    try:
        code = json.loads(b).get("code")
    except ValueError:
        pass
    return r.status, code


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8701")
    a = ap.parse_args()
    u = urlparse(a.base)
    if u.port not in (8701, 8702):
        raise SystemExit("QA 는 격리 스택만")
    at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 120))
    fives = 0
    print("| 경로 | &x=%zz | 파라미터 합쳐 1,001개 | 합쳐 1,000개 |\n|---|---|---|---|")
    for r in ROUTES:
        p = r.format(at=at)
        sep = "&" if "?" in p else "?"
        n_have = p.count("&") + 1 if "?" in p else 0
        bad_pct = get(u.hostname, u.port, p + sep + "x=%zz")
        many = get(u.hostname, u.port, p + sep + "&".join(["x"] * (1001 - n_have)))
        ok = get(u.hostname, u.port, p + sep + "&".join(["x"] * (1000 - n_have)))
        fives += (bad_pct[0] >= 500) + (many[0] >= 500)
        print(f"| `{r}` | {bad_pct[0]} {bad_pct[1] or ''} | {many[0]} {many[1] or ''} | {ok[0]} {ok[1] or ''} |")
    print(f"\n500 응답: {fives}")
    if os.environ.get("QA_CREDS"):
        from qa_session import OpsSession
        time.sleep(2)
        s = OpsSession(a.base, "qa-a")
        st, _, body = s.request("GET", "/api/v1/ops/logs?level=ERROR&service=api&limit=20")
        items = json.loads(body).get("items", [])
        hits = [i for i in items if "InvalidParameterException" in json.dumps(i)]
        print(f"\n운영 로그(/api/v1/ops/logs?level=ERROR&service=api): 최근 20건 중 InvalidParameterException {len(hits)}건 — 예:")
        for i in hits[:3]:
            ex = i.get("exception") or {}
            print(f"  {i.get('ts')} fp={i.get('fp')} suppressed={i.get('suppressed')} {i.get('message')} | {str(ex.get('message'))[:140]}")
        s.request("DELETE", "/api/v1/ops/session")
    return 1 if fives else 0


if __name__ == "__main__":
    sys.exit(main())
