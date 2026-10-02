#!/usr/bin/env python3
"""QA 도우미(신뢰성): 장애를 넣는 동안 공개 API · /healthz 를 일정 간격으로 불러 상태 코드 · Retry-After · 걸린 시간을 JSON 줄로 남긴다.

격리 스택(8701 · 8702)만 — 운영(8700)은 막는다. 공개 요청 제한(IP 당 분당 120)을 넘지 않게 기본 4 s 간격 · 경로 4개(분당 60).

    python3 tools/qa/probe.py --base http://localhost:8702 --seconds 120 --out evidence.jsonl
    python3 tools/qa/probe.py --summary evidence.jsonl [t0_epoch_s]     # 경로마다 같은 결과의 구간
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

PATHS = [
    "/healthz",
    "/api/v1/aircraft?bbox=124,33,132,39",
    "/api/v1/alerts/history",
    "/api/v1/ships?bbox=120,30,135,40",
]


def hit(base: str, path: str, timeout: float) -> dict:
    t0 = time.time()
    rec: dict = {"t": round(t0, 3), "path": path}
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, headers={"Accept": "application/geo+json, application/json;q=0.9, application/problem+json;q=0.8"}), timeout=timeout) as r:
            body = r.read()
            rec.update(status=r.status, retry_after=r.headers.get("Retry-After"))
    except urllib.error.HTTPError as e:
        body = e.read()
        rec.update(status=e.code, retry_after=e.headers.get("Retry-After"))
    except Exception as e:  # 연결 끊김 · 시간 초과
        body = b""
        rec.update(status=None, error=type(e).__name__ + ": " + str(e)[:120])
    rec["ms"] = round((time.time() - t0) * 1000)
    if path == "/healthz" and body:
        try:
            d = json.loads(body)
            rec["health"] = d.get("status")
            rec["reasons"] = d.get("reasons")
        except ValueError:
            pass
    elif body and rec.get("status") and rec["status"] >= 400:
        try:
            d = json.loads(body)
            rec["code"] = d.get("code")
        except ValueError:
            pass
    elif body and rec.get("status") == 200 and path.startswith("/api/v1/aircraft"):
        try:
            d = json.loads(body)
            rec["db_unavailable"] = (d.get("meta") or {}).get("db_unavailable")
        except ValueError:
            pass
    return rec


def summary(path: str, t0: float = 0.0) -> str:
    """JSON 줄 → 경로마다 같은 결과가 이어진 구간(시작 · 끝 초는 t0 기준) · 최대 걸린 시간."""
    by: dict[str, list[dict]] = {}
    for line in open(path):
        r = json.loads(line)
        by.setdefault(r["path"], []).append(r)
    out = []
    for p, rs in by.items():
        rs.sort(key=lambda r: r["t"])
        base = t0 or rs[0]["t"]
        runs: list[list] = []
        for r in rs:
            key = (r.get("status"), r.get("retry_after"), r.get("health"), tuple(r.get("reasons") or []), r.get("code"), r.get("db_unavailable"),
                   (r.get("error") or "")[:40])
            if runs and runs[-1][0] == key:
                runs[-1][2] = r["t"] - base
                runs[-1][3] += 1
                runs[-1][4] = max(runs[-1][4], r["ms"])
            else:
                runs.append([key, r["t"] - base, r["t"] - base, 1, r["ms"]])
        out.append(f"{p}")
        for key, a, b, n, mx in runs:
            st, ra, h, rsn, code, dbu, err = key
            desc = f"status={st}" + (f" retry-after={ra}" if ra else "") + (f" health={h}" if h else "") + (f" reasons={list(rsn)}" if rsn else "") \
                + (f" code={code}" if code else "") + (f" db_unavailable={dbu}" if dbu else "") + (f" err={err}" if err else "")
            out.append(f"  {a:7.1f}s .. {b:7.1f}s  n={n:3d}  max_ms={mx:6d}  {desc}")
    return "\n".join(out)


def main() -> int:
    if len(sys.argv) >= 3 and sys.argv[1] == "--summary":
        print(summary(sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 0.0))
        return 0
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8702")
    ap.add_argument("--seconds", type=float, default=120)
    ap.add_argument("--interval", type=float, default=4)
    ap.add_argument("--timeout", type=float, default=35)
    ap.add_argument("--out", required=True)
    ap.add_argument("--paths", nargs="*", default=PATHS)
    a = ap.parse_args()
    if urlparse(a.base).port not in (8701, 8702):
        raise SystemExit("QA 는 격리 스택만")
    end = time.time() + a.seconds
    lock = threading.Lock()
    with open(a.out, "a") as fh:
        def run(path: str) -> None:
            rec = hit(a.base, path, a.timeout)
            with lock:
                fh.write(json.dumps(rec) + "\n")
                fh.flush()

        while time.time() < end:
            t0 = time.time()
            for p in a.paths:  # 경로마다 따로(한 요청이 걸려도 다른 경로의 표본은 이어진다)
                threading.Thread(target=run, args=(p,), daemon=True).start()
            time.sleep(max(0.0, a.interval - (time.time() - t0)))
        time.sleep(min(a.timeout, 5))
    return 0


if __name__ == "__main__":
    sys.exit(main())
