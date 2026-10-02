"""QA 성능(계획 §3.5 '큰 응답'): 공개 GET 마다 가장 큰 합법 파라미터로 edge(http://localhost:8701)를 거쳐 받아 크기(압축 전 · 전송)와 시간을 잰다.

    python3 tools/qa/perf_large_responses.py [반복=3] [--json 출력.json] [--check]

- 요청은 브라우저처럼 `Accept-Encoding: gzip`. 전송 = 받은 본문 바이트(압축된 그대로), 원본 = 푼 바이트. 시간 = 요청 시작 → 본문 끝(파이썬 urllib, 같은 기계).
- 판정(--check 이면 하나라도 걸릴 때 종료 코드 1): 원본 1 MiB 초과(BIG) · JSON 인데 1 KiB 이상이면서 edge 가 압축하지 않음(NOGZIP) · 상태 5xx(5XX).
- edge 의 IP 당 제한(10 r/s · burst 30, 그리고 api 의 분당 120)에 걸리지 않게 요청 사이를 0.6 s 띄운다. 8701(격리 스택 A)만 부른다.
- 시각 · 범위: 항적 24 h(상한) · 알림 이력 30 일 · AIS 공백 31 일 · 통계 92 일(상한) · bbox 2,500 sq°(상한 — 전세계 bbox 는 422).
"""

from __future__ import annotations

import gzip
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "http://localhost:8701"


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def routes() -> list[tuple[str, str]]:
    now = datetime.now(timezone.utc)
    kst_today = (now + timedelta(hours=9)).date()
    wide = "100,10,150,60"
    return [
        ("aircraft wide full", f"/api/v1/aircraft?bbox={wide}&detail=full"),
        ("aircraft wide lite", f"/api/v1/aircraft?bbox={wide}&detail=lite"),
        ("aircraft world (422)", "/api/v1/aircraft?bbox=-180,-90,180,90&detail=full"),
        ("aircraft search", "/api/v1/aircraft/search?q=F2"),
        ("aircraft detail", "/api/v1/aircraft/f10000"),
        ("aircraft track 24h", f"/api/v1/aircraft/f10000/track?from={iso(now - timedelta(hours=24))}&to={iso(now)}"),
        ("aircraft track 24h step60", f"/api/v1/aircraft/f10000/track?from={iso(now - timedelta(hours=24))}&to={iso(now)}&stepS=60"),
        ("airports all", "/api/v1/airports?watched=false"),
        ("airport wx", "/api/v1/airports/RKSI/wx"),
        ("ais gaps 31d", f"/api/v1/ais/gaps?from={iso(now - timedelta(days=31) + timedelta(minutes=5))}&to={iso(now)}"),
        ("alerts active", "/api/v1/alerts"),
        ("alerts history 30d x200", f"/api/v1/alerts/history?from={iso(now - timedelta(days=30) + timedelta(minutes=5))}&to={iso(now)}&limit=200"),
        ("radar frames", "/api/v1/radar/frames"),
        ("radar kr", "/api/v1/radar/kr"),
        ("replay wide recent", f"/api/v1/replay?at={iso(now - timedelta(minutes=30))}&bbox={wide}"),
        ("replay wide 1m (10d)", f"/api/v1/replay?at={iso(now - timedelta(days=10))}&bbox={wide}"),
        ("ships wide", f"/api/v1/ships?bbox={wide}"),
        ("ships atlantic", "/api/v1/ships?bbox=-60,0,-10,50"),
        ("ships coverage", "/api/v1/ships/coverage"),
        ("ships search x20", "/api/v1/ships/search?q=QA%20VESSEL&limit=20"),
        ("ship detail", "/api/v1/ships/300000001"),
        ("ship track 24h", f"/api/v1/ships/300000001/track?from={iso(now - timedelta(hours=24))}&to={iso(now)}"),
        ("sigmets all", "/api/v1/sigmets?active=false"),
        ("sigmets active", "/api/v1/sigmets?active=true"),
        ("stats sigmet fir 92d", f"/api/v1/stats/sigmet?from={kst_today - timedelta(days=92)}&to={kst_today}&group=fir"),
        ("stats sigmet hazard 92d", f"/api/v1/stats/sigmet?from={kst_today - timedelta(days=92)}&to={kst_today}&group=hazard"),
        ("stats alerts 92d", f"/api/v1/stats/alerts?from={kst_today - timedelta(days=92)}&to={kst_today}"),
        ("stats traffic", f"/api/v1/stats/traffic?day={kst_today - timedelta(days=1)}"),
        ("status", "/api/v1/status"),
        ("traffic grid", "/api/v1/traffic/grid"),
        ("healthz", "/healthz"),
    ]


def fetch(path: str) -> dict:
    req = urllib.request.Request(BASE + path, headers={"Accept-Encoding": "gzip", "User-Agent": "wakeline-qa-perf"})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
            status, hdr = r.status, r.headers
    except urllib.error.HTTPError as e:
        body = e.read()
        status, hdr = e.code, e.headers
    ms = (time.perf_counter() - t0) * 1000
    enc = hdr.get("Content-Encoding", "")
    raw = gzip.decompress(body) if enc == "gzip" else body
    return {"status": status, "ms": ms, "wire": len(body), "raw": len(raw), "enc": enc or "-", "ctype": (hdr.get("Content-Type") or "").split(";")[0],
            "cache": hdr.get("Cache-Control", "")}


def main() -> int:
    reps = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 3
    out_json = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
    check = "--check" in sys.argv
    rows, flagged = [], []
    print(f"{'route':28} {'st':>3} {'raw B':>10} {'wire B':>9} {'enc':>4} {'ms p50':>7} {'ms min–max':>14}  flags")
    for name, path in routes():
        runs = []
        for _ in range(reps):
            runs.append(fetch(path))
            time.sleep(0.6)
        last = runs[-1]
        ms = [r["ms"] for r in runs]
        flags = []
        if last["raw"] > 1_048_576:
            flags.append("BIG")
        if "json" in last["ctype"] and last["raw"] >= 1024 and last["enc"] != "gzip":
            flags.append("NOGZIP")
        if last["status"] >= 500:
            flags.append("5XX")
        print(f"{name:28} {last['status']:>3} {last['raw']:>10,} {last['wire']:>9,} {last['enc']:>4} {statistics.median(ms):>7.0f} {min(ms):>6.0f}–{max(ms):<6.0f}  {' '.join(flags)}")
        rows.append({"name": name, "path": path, "runs": runs, "flags": flags})
        if flags:
            flagged.append(name)
    if out_json:
        with open(out_json, "w") as f:
            json.dump({"at": iso(datetime.now(timezone.utc)), "base": BASE, "reps": reps, "rows": rows}, f, indent=1)
    print(f"flagged: {flagged}")
    return 1 if check and flagged else 0


if __name__ == "__main__":
    sys.exit(main())
