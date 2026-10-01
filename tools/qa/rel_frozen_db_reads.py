#!/usr/bin/env python3
"""QA 신뢰성(느린 의존성): DB 가 답하지 않는 동안(docker pause — 서버가 멈춤, TCP 는 열려 있음) 공개 조회가 문장 상한(3 s, R-62)을 지키는가 — 스택 B 전용.

pause 직후 DB 를 읽는 공개 경로 8개를 동시에 부르고(그중 일부는 연결을 이미 빌린 뒤 멈춘 서버를 기다린다) 상태 · 걸린 시간을 적는다. pause 는 HOLD_S(기본 45 s).
불변식: 모든 응답이 '문장 상한 + 연결 대기' 안(≤ 10 s)에 503 + Retry-After 또는 200. 넘으면(edge 의 30 s 504 · 끊김) 종료 코드 1.
"""
import json, os, subprocess, sys, threading, time, urllib.error, urllib.request
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

PROJECT = os.environ.get("QA_PROJECT", "wakeline-qa")  # 격리 스택만 — B(기본) · A(고친 빌드 재확인)
if PROJECT not in ("wakeline-qa", "wakeline-e2e"):
    raise SystemExit("QA_PROJECT must be wakeline-qa or wakeline-e2e")
BASE = {"wakeline-qa": "http://localhost:8702", "wakeline-e2e": "http://localhost:8701"}[PROJECT]
HOLD_S = int(os.environ.get("HOLD_S", "45"))
out_dir = sys.argv[1] if len(sys.argv) > 1 else "docs/qa/2026-10/evidence/reliability/db-frozen-reads"
now = datetime.now(UTC)
at = quote((now - timedelta(minutes=3)).strftime("%Y-%m-%dT%H:%M:%SZ"))
paths = [f"/api/v1/replay?at={at}&bbox=124,33,132,39", "/api/v1/alerts/history", "/api/v1/stats/traffic?day=" + (now + timedelta(hours=9)).date().isoformat(),
         "/api/v1/airports?bbox=124,33,132,39", f"/api/v1/replay?at={at}&bbox=120,30,135,40", "/api/v1/alerts/history?limit=10",
         "/api/v1/ais/gaps", "/api/v1/airports/RKSI/wx"]
res = [None] * len(paths)

def hit(i, p):
    t = time.time()
    try:
        with urllib.request.urlopen(urllib.request.Request(BASE + p, headers={"Accept": "application/geo+json, application/json;q=0.9, application/problem+json;q=0.8"}), timeout=60) as r:
            r.read(); res[i] = {"path": p, "status": r.status, "retry_after": r.headers.get("Retry-After"), "s": round(time.time() - t, 1)}
    except urllib.error.HTTPError as e:
        res[i] = {"path": p, "status": e.code, "retry_after": e.headers.get("Retry-After"), "s": round(time.time() - t, 1)}
    except Exception as e:
        res[i] = {"path": p, "status": None, "error": type(e).__name__, "s": round(time.time() - t, 1)}

subprocess.run(["docker", "pause", f"{PROJECT}-db-1"], check=True)
t_pause = time.time()
try:
    ths = [threading.Thread(target=hit, args=(i, p)) for i, p in enumerate(paths)]
    for th in ths: th.start()
    for th in ths: th.join(timeout=HOLD_S + 30)
    elapsed = time.time() - t_pause
    if elapsed < HOLD_S: time.sleep(HOLD_S - elapsed)
finally:
    subprocess.run(["docker", "unpause", f"{PROJECT}-db-1"], check=True)
for th in ths: th.join(timeout=60)
over = [r for r in res if r is None or r["s"] > 10 or r["status"] not in (200, 503) or (r["status"] == 503 and not r.get("retry_after"))]
summary = {"hold_s": HOLD_S, "results": res, "over_limit": len(over)}
print(json.dumps(summary, indent=1))
os.makedirs(out_dir, exist_ok=True)
json.dump(summary, open(os.path.join(out_dir, "frozen-db-reads.json"), "w"), indent=1)
sys.exit(1 if over else 0)
