#!/usr/bin/env python3
"""QA 2026-10-aws(api-live) 재현 — 라이브 격리 스택(8701 · 8702)에서 QA-1310 · QA-1311 을 HTTP · WS 로 보인다. 표준 라이브러리만.

QA-1310: ASCII 가 아닌 글자가 유니코드 대소문자 접기로 정해진 값(§G42 group · kind · detail) · 항공기 검색어가 된다(ı → I · ſ → S · ß → SS).
QA-1311: 10진 표기로 정확히 50° × 50°(= 2,500 sq°, 상한 안)인 bbox 가 경계 값에 따라 422 "bbox area 2500 sq° exceeds 2500"(REST · WS 같은 규칙).

    python3 tools/qa/qa_1310_1311_live.py [--base http://localhost:8701]   # 결함이 보이면 종료 코드 1
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ws_probe import WS  # noqa: E402

ACCEPT = "application/geo+json, application/json;q=0.9, application/problem+json;q=0.8"


def get(base: str, path: str):
    time.sleep(0.2)
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, headers={"Accept": ACCEPT}), timeout=15) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except ValueError:
            return e.code, {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8701")
    a = ap.parse_args()
    u = urlparse(a.base)
    if u.port not in (8701, 8702):
        raise SystemExit("QA 는 격리 스택만")
    bad = 0
    print("## QA-1310 — 비 ASCII 대소문자 접기(기대: 400)")
    # 정해진 값 필터와 항공기 검색 — 대조군(ASCII 대문자 · 선박 검색 · 공항)은 기대대로
    for path, want in [
        ("/api/v1/stats/sigmet?group=FIR", 200), ("/api/v1/stats/sigmet?group=f%C4%B1r", 400), ("/api/v1/stats/sigmet?group=f%C4%B0r", 400),
        ("/api/v1/alerts?kind=OBSERVED", 200), ("/api/v1/alerts?kind=ob%C5%BFerved", 400), ("/api/v1/alerts?kind=pred%C4%B1cted", 400),
        ("/api/v1/aircraft?bbox=124,33,132,39&detail=l%C4%B1te", 400),
        ("/api/v1/aircraft/search?q=SJO", 200), ("/api/v1/aircraft/search?q=%C5%BFJO", 400), ("/api/v1/aircraft/search?q=IBX", 200),
        ("/api/v1/aircraft/search?q=%C4%B1BX", 400), ("/api/v1/aircraft/search?q=%C3%9F%C3%9F", 400),
        ("/api/v1/ships/search?q=ev%C4%B1er", 400), ("/api/v1/airports/rks%C4%B1/wx", 400),
    ]:
        st, b = get(a.base, path)
        extra = ""
        if isinstance(b, dict):
            if "items" in b and isinstance(b["items"], list):
                extra = "items=" + json.dumps([(i.get("hex"), (i.get("callsign") or "").strip()) for i in b["items"][:3] if isinstance(i, dict)])
            if "group" in b:
                extra += f" group={b['group']}"
            if b.get("code"):
                extra += f" code={b['code']}"
        mark = "ok  " if st == want else "BUG "
        bad += st != want
        print(f"{mark} {st} (기대 {want}) {path} {extra}")

    print("\n## QA-1311 — 정확히 50° × 50° bbox(기대: 200)")
    for bbox in ["124.1,10.1,174.1,60.1", "0,0,50,50", "100.3,10.3,150.3,60.3", "0,14.4,50,64.4", "101.8,14.9,151.8,64.9"]:
        p = [float(x) for x in bbox.split(",")]
        area = (p[2] - p[0]) * (p[3] - p[1])
        for route in ("/api/v1/aircraft?bbox=", "/api/v1/ships?bbox=", "/api/v1/replay?at=" + time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 120)) + "&bbox="):
            st, b = get(a.base, route + bbox)
            mark = "ok  " if st == 200 else "BUG "
            bad += st != 200
            print(f"{mark} {st} {route.split('?')[0]} bbox={bbox} (double 넓이 {area!r}) {b.get('code', '') if isinstance(b, dict) else ''} {b.get('detail', '') if isinstance(b, dict) else ''}")
        ws = WS(u.hostname, u.port, f"http://{u.hostname}:{u.port}")
        ws.send(json.dumps({"type": "hello", "proto": 1}))
        ws.send(json.dumps({"type": "subscribe", "bbox": p, "zoom": 7}))
        msgs, _ = ws.drain(2.0, stop=lambda m: m.get("type") in ("snapshot", "error"))
        ws.close()
        got = [m.get("code") if m.get("type") == "error" else m.get("type") for m in msgs if m.get("type") in ("snapshot", "error")]
        mark = "ok  " if got[:1] == ["snapshot"] else "BUG "
        bad += got[:1] != ["snapshot"]
        print(f"{mark} WS subscribe zoom 7 bbox={p} → {got[:1]}")
        time.sleep(0.5)
    print(f"\n결함으로 보인 줄: {bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
