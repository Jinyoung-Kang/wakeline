#!/usr/bin/env python3
"""QA 2026-10-aws 공개 데모(A1 — 풀 6 · 공개 조회 허가 3 · 읽기 풀 2): 공개 조회 동시 요청 10 · 20 · 30개가 언제 503 + Retry-After 가 되는가(작은 부하 — 성능 단계가 아님).

1) 보통 DB: 공개 조회 경로 섞음 N = 10 · 20 · 30 을 한꺼번에 — 상태 · Retry-After · 걸린 시간 · 문제 응답 code 를 센다.
2) 느린 DB 흉내: stats_daily 를 ACCESS EXCLUSIVE 로 LOCK_S 초 잡은 동안 /stats/traffic N 개(허가 3 을 모두 잡게) + 그 사이 다른 공개 조회(알림 이력 · 공항 기상 ·
   선박 검색)와 실시간 경로(/aircraft · /status · /healthz)를 보낸다 — 허가 3 이 막히면 다른 경로의 공개 조회도 503 인지, 실시간은 그대로인지.
api 의 IP 당 분당 120 · edge 의 IP 당 10 r/s(burst 30)를 넘지 않게 단계 사이를 쉰다(429 는 따로 센다). 스택 A1(8701)만.

  python3 tools/qa/pd_public_reads_threshold.py [증거 폴더]
"""
import collections, json, os, subprocess, sys, threading, time, urllib.error, urllib.request
from datetime import UTC, datetime, timedelta
from urllib.parse import quote

BASE = os.environ.get("QA_BASE_URL", "http://localhost:8701")
if not BASE.endswith(":8701"):
    sys.exit("A1(8701)만")
DB = os.environ.get("WLQA_DB", "wlqa-a-db-1")
LOCK_S = int(os.environ.get("LOCK_S", "8"))
out_dir = sys.argv[1] if len(sys.argv) > 1 else "docs/qa/2026-10-aws/evidence/public-demo"
os.makedirs(out_dir, exist_ok=True)
ACCEPT = "application/geo+json, application/json;q=0.9, application/problem+json;q=0.8"


def get(p, timeout=30):
    t = time.time()
    try:
        with urllib.request.urlopen(urllib.request.Request(BASE + p, headers={"Accept": ACCEPT}), timeout=timeout) as r:
            r.read()
            return {"path": p, "status": r.status, "retry_after": r.headers.get("Retry-After"), "s": round(time.time() - t, 3), "code": None}
    except urllib.error.HTTPError as e:
        body = e.read()
        code = detail = None
        try:
            j = json.loads(body)
            code, detail = j.get("code"), j.get("detail")
        except Exception:
            detail = body[:120].decode("utf-8", "replace")
        return {"path": p, "status": e.code, "retry_after": e.headers.get("Retry-After"), "s": round(time.time() - t, 3), "code": code, "detail": detail,
                "ctype": e.headers.get("Content-Type")}
    except Exception as e:  # 끊김 · 시간 초과
        return {"path": p, "status": None, "error": type(e).__name__, "s": round(time.time() - t, 3)}


def burst(paths):
    res = [None] * len(paths)
    def run(i, p): res[i] = get(p)
    ths = [threading.Thread(target=run, args=(i, p)) for i, p in enumerate(paths)]
    t0 = time.time()
    for t in ths: t.start()
    for t in ths: t.join()
    return res, round(time.time() - t0, 3)


def summary(res):
    c = collections.Counter(f"{r['status']}{'/' + r['code'] if r.get('code') else ''}{' RA=' + r['retry_after'] if r.get('retry_after') else ''}" for r in res)
    ss = sorted(r["s"] for r in res)
    return {"counts": dict(c), "p50_s": ss[len(ss) // 2], "max_s": ss[-1]}


now = datetime.now(UTC)
at = quote((now - timedelta(minutes=20)).strftime("%Y-%m-%dT%H:%M:%SZ"))
day = (now + timedelta(hours=9)).strftime("%Y-%m-%d")
feats = json.loads(urllib.request.urlopen(BASE + "/api/v1/aircraft?bbox=120,30,135,45").read())["features"]
hexes = [f["properties"]["hex"] for f in feats[:10]]
MIX = [f"/api/v1/replay?at={at}&bbox=120,30,135,45", "/api/v1/alerts/history?limit=200", f"/api/v1/stats/traffic?day={day}", "/api/v1/stats/alerts",
       "/api/v1/warnings/history", "/api/v1/airports/RKSI/wx", "/api/v1/ships/search?q=KO", "/api/v1/aircraft/search?q=KAL"] + \
      [f"/api/v1/aircraft/{h}/track" for h in hexes]
out = {"base": BASE, "started": now.isoformat(), "phase1_normal_db": [], "phase2_locked_stats_daily": None}

# 1) 보통 DB — 10 · 20 · 30 (합 60 — 분당 120 아래)
for n in (10, 20, 30):
    paths = [MIX[i % len(MIX)] for i in range(n)]
    res, wall = burst(paths)
    out["phase1_normal_db"].append({"n": n, "wall_s": wall, **summary(res), "non200": [r for r in res if r["status"] != 200]})
    print(f"phase1 n={n} wall={wall}s {summary(res)}", flush=True)
    time.sleep(4)

print("분당 상한이 비도록 62 s 쉰다", flush=True)
time.sleep(62)

# 2) 느린 DB 흉내 — stats_daily 잠금
lock = subprocess.Popen(["docker", "exec", "-i", DB, "psql", "-X", "-q", "-U", "postgres", "-d", "wakeline"], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
lock.stdin.write(f"BEGIN; LOCK TABLE stats_daily IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep({LOCK_S}); COMMIT;\n")
lock.stdin.flush()
time.sleep(0.8)
t_lock = time.time()
slow = [f"/api/v1/stats/traffic?day={day}"] * 10
res_slow = [None] * len(slow)
def run_slow(i, p): res_slow[i] = get(p)
ths = [threading.Thread(target=run_slow, args=(i, p)) for i, p in enumerate(slow)]
for t in ths: t.start()
time.sleep(0.4)
others, _ = burst(["/api/v1/alerts/history?limit=50", "/api/v1/airports/RKSI/wx", "/api/v1/ships/search?q=KO", f"/api/v1/aircraft/{hexes[0]}/track",
                   "/api/v1/warnings/history"])
live, _ = burst(["/api/v1/aircraft?bbox=120,30,135,45", "/api/v1/status", "/healthz", "/api/v1/alerts", "/api/v1/sigmets"])
for t in ths: t.join()
lock.communicate(timeout=60)
time.sleep(1)
after, _ = burst(["/api/v1/alerts/history?limit=50", f"/api/v1/stats/traffic?day={day}"])
out["phase2_locked_stats_daily"] = {
    "lock_s": LOCK_S,
    "stats_traffic_x10": {**summary(res_slow), "items": res_slow},
    "other_public_reads_during": {**summary(others), "items": others},
    "live_paths_during": {**summary(live), "items": live},
    "after_unlock": after,
}
for k in ("stats_traffic_x10", "other_public_reads_during", "live_paths_during"):
    print("phase2", k, json.dumps(summary(out["phase2_locked_stats_daily"][k]["items"]), ensure_ascii=False), flush=True)
print("after", json.dumps([(r["path"], r["status"]) for r in after]), flush=True)
json.dump(out, open(os.path.join(out_dir, "public-reads-threshold.json"), "w"), indent=1, ensure_ascii=False)
