#!/usr/bin/env python3
"""QA 신뢰성(느린 DB — 잠금): track_point 부모를 ACCESS EXCLUSIVE 로 20 s 잡은 동안 항적 · 재생 공개 조회 12건을 동시에 보내고, 실시간 경로 · /healthz 가
그동안에도 바로 답하는지 본다 — 스택 B 전용. 불변식: 공개 조회는 상한(문장 3 s · 잠금 대기 5 s · 허가 대기 1 s + 연결 대기 5 s) 안에 200 · 503 + Retry-After,
500 · 504 없음, /healthz · /aircraft 는 1 s 안. 끝나면 스트림 ↔ DB 대조(tools/qa/stream_db_integrity.py)로 기록기 손실이 없는지 본다.
"""
import json, os, subprocess, sys, threading, time, urllib.error, urllib.request
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

BASE = "http://localhost:8702"
out_dir = sys.argv[1] if len(sys.argv) > 1 else "docs/qa/2026-10/evidence/reliability/db-lock-slow"
os.makedirs(out_dir, exist_ok=True)
A = "application/geo+json, application/json;q=0.9, application/problem+json;q=0.8"

def get(p, timeout=40):
    t = time.time()
    try:
        with urllib.request.urlopen(urllib.request.Request(BASE + p, headers={"Accept": A}), timeout=timeout) as r:
            body = r.read(); return {"path": p, "status": r.status, "retry_after": r.headers.get("Retry-After"), "s": round(time.time() - t, 2), "body": body}
    except urllib.error.HTTPError as e:
        return {"path": p, "status": e.code, "retry_after": e.headers.get("Retry-After"), "s": round(time.time() - t, 2), "body": e.read()}
    except Exception as e:
        return {"path": p, "status": None, "error": type(e).__name__, "s": round(time.time() - t, 2), "body": b""}

hexes = [f["properties"]["hex"] for f in json.loads(get("/api/v1/aircraft?bbox=124,33,132,39")["body"])["features"][:6]]
at = quote((datetime.now(UTC) - timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%SZ"))
paths = [f"/api/v1/aircraft/{h}/track" for h in hexes] + [f"/api/v1/replay?at={at}&bbox=124,33,132,39"] * 6
t0_ms = int(time.time() * 1000)
lock = subprocess.Popen(["docker", "exec", "-i", "wakeline-qa-db-1", "psql", "-X", "-U", "postgres", "-d", "wakeline"], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
lock.stdin.write("BEGIN; LOCK TABLE track_point IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(20); COMMIT;\n"); lock.stdin.flush()
time.sleep(1)
res = [None] * len(paths)
def run(i, p): res[i] = get(p)
ths = [threading.Thread(target=run, args=(i, p)) for i, p in enumerate(paths)]
for t in ths: t.start()
time.sleep(1.5)
live = [get("/healthz"), get("/api/v1/aircraft?bbox=124,33,132,39"), get("/api/v1/status")]
for t in ths: t.join()
lock.communicate(timeout=60)
for r in res + live:
    r.pop("body", None)
bad = [r for r in res if r["status"] not in (200, 503) or (r["status"] == 503 and not r.get("retry_after")) or r["s"] > 12]
slow_live = [r for r in live if r["status"] != 200 or r["s"] > 1.0]
out = {"t0_ms": t0_ms, "public_reads": res, "live_paths_during_lock": live, "bad": len(bad), "slow_live": len(slow_live)}
print(json.dumps(out, indent=1))
json.dump(out, open(os.path.join(out_dir, "db-lock-slow.json"), "w"), indent=1)
sys.exit(1 if bad or slow_live else 0)
