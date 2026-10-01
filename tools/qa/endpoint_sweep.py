#!/usr/bin/env python3
"""QA 도우미(신뢰성): 공개 GET 경로 전부를 한 번씩 불러 상태 · Retry-After · 걸린 시간 · 오류 코드를 표로 남긴다(장애 중 · 회복 뒤 비교용).
500 이거나, 503 인데 Retry-After 가 없으면 결함 후보로 표시하고 종료 코드 1. 격리 스택(8701 · 8702)만.

    python3 tools/qa/endpoint_sweep.py --base http://localhost:8702 --label redis-down --out sweep.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from urllib.parse import quote, urlparse

ACCEPT = "application/geo+json, application/json;q=0.9, application/problem+json;q=0.8, image/png;q=0.5"


def get(base: str, path: str, timeout: float = 40) -> dict:
    t0 = time.time()
    rec: dict = {"path": path}
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, headers={"Accept": ACCEPT}), timeout=timeout) as r:
            body = r.read()
            rec.update(status=r.status, retry_after=r.headers.get("Retry-After"))
    except urllib.error.HTTPError as e:
        body = e.read()
        rec.update(status=e.code, retry_after=e.headers.get("Retry-After"))
    except Exception as e:  # noqa: BLE001
        body = b""
        rec.update(status=None, error=f"{type(e).__name__}: {e}"[:120])
    rec["ms"] = round((time.time() - t0) * 1000)
    if body[:1] == b"{":
        try:
            d = json.loads(body)
            if rec.get("status") and rec["status"] >= 400:
                rec["code"] = d.get("code")
            meta = d.get("meta") if isinstance(d.get("meta"), dict) else {}
            for k in ("db_unavailable", "stale", "redis_unavailable"):
                if meta.get(k):
                    rec[k] = meta[k]
            if path == "/healthz":
                rec["health"] = [d.get("status"), d.get("reasons")]
        except ValueError:
            pass
    return rec


def paths(base: str) -> list[str]:
    """표본 값(hex · mmsi · SIGMET id · 레이더 tm)은 지금 스택에서 고른다 — 장애 전에 한 번 부른다."""
    now = datetime.now(UTC)
    iso = lambda t: quote(t.strftime("%Y-%m-%dT%H:%M:%SZ"))  # noqa: E731
    day = (now + timedelta(hours=9)).date() - timedelta(days=1)
    return [
        "/healthz", "/api/v1/status",
        "/api/v1/aircraft?bbox=124,33,132,39", "/api/v1/aircraft/search?q=B-", "/api/v1/aircraft/{hex}", "/api/v1/aircraft/{hex}/track",
        "/api/v1/ships?bbox=120,30,135,40", "/api/v1/ships/search?q=44", "/api/v1/ships/{mmsi}", "/api/v1/ships/{mmsi}/track",
        "/api/v1/ships/coverage", f"/api/v1/ais/gaps?from={iso(now - timedelta(hours=6))}", "/api/v1/traffic/grid",
        "/api/v1/sigmets", "/api/v1/sigmets/{sigmet}", "/api/v1/alerts", "/api/v1/alerts/history",
        "/api/v1/radar/frames", "/api/v1/radar/kr", "/api/v1/airports?bbox=124,33,132,39", "/api/v1/airports/RKSI/wx",
        f"/api/v1/replay?at={iso(now - timedelta(minutes=5))}&bbox=124,33,132,39",
        f"/api/v1/stats/sigmet?from={day}&to={day}", f"/api/v1/stats/traffic?day={day}", f"/api/v1/stats/alerts?from={day}&to={day}",
    ]


def samples(base: str) -> dict[str, str]:
    s = {"hex": "71bf50", "mmsi": "440095870", "sigmet": "x"}
    try:
        a = json.loads(urllib.request.urlopen(urllib.request.Request(base + "/api/v1/aircraft?bbox=124,33,132,39", headers={"Accept": ACCEPT}), timeout=10).read())
        s["hex"] = a["features"][0]["properties"]["hex"]
        sh = json.loads(urllib.request.urlopen(urllib.request.Request(base + "/api/v1/ships?bbox=120,30,135,40", headers={"Accept": ACCEPT}), timeout=10).read())
        s["mmsi"] = sh["features"][0]["properties"]["mmsi"]
        sg = json.loads(urllib.request.urlopen(urllib.request.Request(base + "/api/v1/sigmets", headers={"Accept": ACCEPT}), timeout=10).read())
        s["sigmet"] = quote(sg["features"][0]["properties"]["id"], safe="")
    except Exception:  # noqa: BLE001 — 장애 중이면 기본값
        pass
    return s


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8702")
    ap.add_argument("--label", default="sweep")
    ap.add_argument("--samples", help="JSON {hex, mmsi, sigmet} — 장애 전에 고른 값")
    ap.add_argument("--save-samples", help="표본 값을 이 파일에 쓰고 끝낸다")
    ap.add_argument("--out")
    a = ap.parse_args()
    if urlparse(a.base).port not in (8701, 8702):
        raise SystemExit("QA 는 격리 스택만")
    if a.save_samples:
        json.dump(samples(a.base), open(a.save_samples, "w"))
        return 0
    sm = json.load(open(a.samples)) if a.samples else samples(a.base)
    rows = []
    for p in paths(a.base):
        rows.append(get(a.base, p.format(**sm)))
        time.sleep(0.3)
    bad = [r for r in rows if r.get("status") == 500 or (r.get("status") == 503 and not r.get("retry_after")) or r.get("status") is None]
    for r in rows:
        extra = " ".join(f"{k}={r[k]}" for k in ("retry_after", "code", "db_unavailable", "stale", "health", "error") if r.get(k))
        print(f"{a.label:12s} {str(r.get('status')):4s} {r['ms']:6d} ms  {r['path'][:70]:70s} {extra}")
    if a.out:
        json.dump({"label": a.label, "at": datetime.now(UTC).isoformat(), "rows": rows, "suspect": bad}, open(a.out, "w"), indent=1)
    if bad:
        print(f"SUSPECT ({len(bad)}): " + ", ".join(f"{r['path']}={r.get('status')}" for r in bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
