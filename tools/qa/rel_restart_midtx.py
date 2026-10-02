#!/usr/bin/env python3
"""QA 신뢰성(계획 §3.4 '작업 중 재시작'): 운영 쓰기 트랜잭션이 커밋 전일 때 api 를 kill -9 해도 반쪽 결과가 남지 않는가 — 격리 스택 B 전용.

방법: audit_log 를 EXCLUSIVE 로 잡아(psql 트랜잭션 12 s) 설정 저장(PUT /ops/settings — UPDATE app_setting 뒤 감사 INSERT)과 통계 재집계
(POST /ops/stats/aggregate — stats_daily 를 지우고 다시 넣은 뒤 감사 INSERT)가 '본 작업은 했고 감사에서 기다리는' 상태로 만든 다음 api 를 죽인다.
불변식: 설정 version · 값 그대로, 감사 행 없음, 그날 stats_daily(완료 표식 시각 포함) 그대로, Redis 미러 그대로. 어긋나면 종료 코드 1.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
from qa_session import OpsSession  # noqa: E402

P = "wakeline-qa"
BASE = "http://localhost:8702"
KEY = "metar_poll_s"


def psql(sql: str) -> list[list[str]]:
    out = subprocess.run(["docker", "exec", f"{P}-db-1", "psql", "-X", "-U", "postgres", "-d", "wakeline", "-At", "-F", "\t", "-c", sql],
                         check=True, capture_output=True, text=True).stdout
    return [line.split("\t") for line in out.splitlines() if line]


def redis(*a: str) -> str:
    return subprocess.run(["docker", "exec", f"{P}-redis-1", "sh", "-c", 'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli --no-auth-warning "$@"', "sh", *a],
                          check=True, capture_output=True, text=True).stdout.strip()


def state(day: str) -> dict:
    v, val = psql(f"SELECT version, value::text FROM app_setting WHERE key = '{KEY}'")[0]
    stats = psql(f"SELECT coalesce(md5(string_agg(s::text, '|' ORDER BY s::text)), '-'), count(*) FROM stats_daily s WHERE day = '{day}'")[0]
    return {"version": int(v), "value": val, "mirror": redis("HGET", "wakeline:settings", KEY), "stats_md5": stats[0], "stats_rows": int(stats[1]),
            "audit_setting": int(psql(f"SELECT count(*) FROM audit_log WHERE action = 'SETTING_UPDATE' AND target = '{KEY}'")[0][0]),
            "audit_aggregate": int(psql(f"SELECT count(*) FROM audit_log WHERE action = 'STATS_AGGREGATE' AND target = '{day}'")[0][0])}


def main() -> int:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "docs/qa/2026-10/evidence/reliability/restart-midtx"
    os.makedirs(out_dir, exist_ok=True)
    day = (datetime.now(timezone(timedelta(hours=9))).date() - timedelta(days=1)).isoformat()
    s = OpsSession(BASE, "qa-a")
    st, _, body = s.request("GET", "/api/v1/ops/settings")
    item = next(i for i in json.loads(body)["items"] if i["key"] == KEY)
    new_value = 900 if item["value"] != 900 else 600  # 바뀌면 보이게 다른 값
    # 그날 통계를 한 번 만들어 두고(재집계가 커밋되면 완료 표식 시각이 바뀐다) 1초 넘게 기다린다
    s.request("POST", f"/api/v1/ops/stats/aggregate?day={day}")
    time.sleep(1.5)
    before = state(day)
    lock = subprocess.Popen(["docker", "exec", "-i", f"{P}-db-1", "psql", "-X", "-U", "postgres", "-d", "wakeline", "-v", "ON_ERROR_STOP=1"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lock.stdin.write("BEGIN; LOCK TABLE audit_log IN EXCLUSIVE MODE; SELECT 'locked'; SELECT pg_sleep(12); COMMIT;\n")
    lock.stdin.flush()
    time.sleep(1.5)
    res: dict = {}

    def put():
        res["put"] = s.request("PUT", f"/api/v1/ops/settings/{KEY}", {"value": new_value}, {"If-Match": str(item["version"])})[0]

    def agg():
        res["aggregate"] = s.request("POST", f"/api/v1/ops/stats/aggregate?day={day}")[0]

    ths = [threading.Thread(target=put), threading.Thread(target=agg)]
    for t in ths:
        t.start()
    time.sleep(2.0)  # 두 트랜잭션이 감사 INSERT 에서 기다리는 중(lock_timeout 5 s 안)
    waiting = psql("SELECT count(*) FROM pg_stat_activity WHERE datname = 'wakeline' AND wait_event_type = 'Lock' AND usename = 'wakeline_api'")[0][0]
    subprocess.run(["docker", "exec", f"{P}-api-1", "sh", "-c", "kill -9 -1"], capture_output=True)
    killed_at = time.time()
    for t in ths:
        t.join(timeout=40)
    lock.communicate(timeout=30)
    # 다시 떠서 시작을 마칠 때까지(기동 때 설정 미러가 다시 돈다)
    for _ in range(120):
        try:
            if subprocess.run(["curl", "-s", "-m", "3", BASE + "/healthz"], capture_output=True, text=True).stdout.startswith("{"):
                break
        except Exception:  # noqa: BLE001
            pass
        time.sleep(1)
    time.sleep(5)
    after = state(day)
    ok = (after["version"] == before["version"] and after["value"] == before["value"] and after["audit_setting"] == before["audit_setting"]
          and after["stats_md5"] == before["stats_md5"] and after["audit_aggregate"] == before["audit_aggregate"] and after["mirror"] == before["mirror"])
    r = {"ok": ok, "day": day, "waiting_on_lock_before_kill": int(waiting), "responses": res, "before": before, "after": after,
         "recovered_s": round(time.time() - killed_at, 1)}
    print(json.dumps(r, ensure_ascii=False, indent=1))
    json.dump(r, open(os.path.join(out_dir, "restart-midtx.json"), "w"), ensure_ascii=False, indent=1)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
