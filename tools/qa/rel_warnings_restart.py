#!/usr/bin/env python3
"""출시 QA 2차 신뢰성(docs/qa/2026-10-release QA-PLAN §3.4): 기상특보 이력(V20 wx_warning)이 api 재시작 · 재전달 · 순서 바뀐 옛 목록에서 틀어지지 않는가.

격리 스택 A(wakeline-e2e · 8701)만. 수집기와 같은 경로(wakeline_collector ACL 사용자 · wakeline:wxwarn · kind wx_warnings)로 목록을 넣는다
(tools/qa/inject_stream.py 의 cli · envelope 을 쓴다 — 비밀번호는 컨테이너 안 환경에서만). DB 는 db 컨테이너의 로컬 소켓 psql 로 읽기만 한다.

시나리오(구역 코드는 시험 전용 S9xxxxxx · L9xxxxxx — fixture 의 실제 구역과 겹치지 않는다):
  1. 목록 A = {W1, W2} (fetched f1) → 두 행 열림
  2. 목록 B = {W1}      (f2)        → W2 가 f2 로 끝남, W1 열림
  3. api kill → 목록 C = {W1, W2} (f3, api 가 꺼진 동안 스트림에) → api 시작 → W2 가 다시 열림(ended_at NULL), 행이 겹치지 않음
  4. 옛 목록 A'= {W1} (fetched f1 — B · C 보다 옛것) 을 다시 넣음 → 아무것도 끝나지 않음(W2 열린 채), 실시간 목록은 C 그대로
불변식: 자연키(구역 · 종류 · 수준 · 발표)마다 한 행 · first_seen ≤ last_seen · 끝난 행의 ended_at 은 그 목록의 수신 시각.

    python3 tools/qa/rel_warnings_restart.py     # 기대와 다르면 종료 코드 1, 기록은 evidence/reliability/rel_warnings_restart.json
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import inject_stream as inj  # noqa: E402

BASE = "http://localhost:8701"
PROJECT = "wakeline-e2e"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../docs/qa/2026-10-release/evidence/reliability")
LOG: list[dict] = []
FAIL: list[str] = []


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def warning(code: str, kind: str, level: str, issued: datetime, sea: bool) -> dict:
    w = {"zone_code": code, "zone_name": f"QA {code}", "sea": sea, "kind": kind, "level": level, "command": "발표", "preliminary": False,
         "issued_at": iso(issued), "effective_at": iso(issued), "raw": f"QA, {code},="}
    return w


def publish(ws: list[dict], fetched: datetime) -> str:
    env = inj.envelope("wx_warnings", "-", {"complete": True, "dropped": 0, "warnings": ws}, len(ws), "qa/rel-warnings")
    i = env.index("fetched_at")
    env[i + 1] = iso(fetched)
    return inj.cli("wakeline_collector", "REDIS_COLLECTOR_PASSWORD", "XADD", "wakeline:wxwarn", "*", *env).strip()


def psql(sql: str) -> list[list[str]]:
    r = subprocess.run(["docker", "exec", f"{PROJECT}-db-1", "psql", "-X", "-U", "postgres", "-d", "wakeline", "-At", "-F", "\t",
                        "-c", "SET TIME ZONE 'UTC'", "-c", sql], capture_output=True, text=True, check=True)
    return [line.split("\t") for line in r.stdout.splitlines() if line and line != "SET"]


def rows() -> dict[str, dict]:
    out = {}
    for code, n, first, last, ended in psql("""SELECT zone_code, count(*) OVER (PARTITION BY zone_code, kind, level, issued_at), first_seen, last_seen, coalesce(ended_at::text, '')
                                             FROM wx_warning WHERE zone_code LIKE '_9%' ORDER BY zone_code"""):
        out[code] = {"dup": int(n), "first": first, "last": last, "ended": ended or None}
    return out


def wait(pred, what: str, timeout: float = 60) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            if pred():
                return True
        except Exception:  # noqa: BLE001 — 기다리는 동안의 일시 오류(api 기동 중)
            pass
        time.sleep(1)
    FAIL.append(f"timeout: {what}")
    return False


def note(name: str, ok: bool, **kw) -> None:
    LOG.append({"check": name, "ok": ok, **kw})
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f" {kw}"))
    if not ok:
        FAIL.append(name)


def live() -> list[str]:
    with urllib.request.urlopen(BASE + "/api/v1/warnings", timeout=10) as r:
        return sorted(w["zone_code"] for w in json.load(r)["items"])


def compose(*args: str) -> None:
    env = {**os.environ, "WAKELINE_FIXTURE_MODE": "1", "WAKELINE_PORT": "8701", "WAKELINE_NET_PREFIX": "10.78.0"}
    subprocess.run(["docker", "compose", "-p", PROJECT, "-f", "infra/compose.yml", "--env-file", ".env", *args], check=True, env=env,
                   cwd=os.path.join(os.path.dirname(os.path.abspath(__file__)), "../.."), capture_output=True)


def main() -> int:
    psql("DELETE FROM wx_warning WHERE zone_code LIKE '_9%'")  # 이 시험의 구역만(격리 스택)
    t0 = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=30)
    w1, w2 = warning("S9000001", "풍랑", "주의보", t0, True), warning("L9000002", "호우", "주의보", t0, False)
    f1 = datetime.now(timezone.utc)
    publish([w1, w2], f1)
    wait(lambda: len(rows()) == 2, "list A persisted")
    f2 = f1 + timedelta(seconds=5)
    publish([w1], f2)
    wait(lambda: rows().get("L9000002", {}).get("ended") is not None, "W2 ended by list B")
    r = rows()
    note("B: W2 ended at list B's fetched time", (r["L9000002"]["ended"] or "").startswith(iso(f2)[:19].replace("T", " ")), row=r["L9000002"])
    note("B: W1 still open", r["S9000001"]["ended"] is None, row=r["S9000001"])

    subprocess.run(["docker", "kill", f"{PROJECT}-api-1"], check=True, capture_output=True)
    f3 = f2 + timedelta(seconds=5)
    publish([w1, w2], f3)  # api 가 꺼진 동안
    compose("up", "-d", "--no-build", "--wait", "api")
    wait(lambda: rows().get("L9000002", {}).get("ended") is None, "W2 reopened after restart", 120)
    r = rows()
    note("C after restart: W2 reopened (ended_at NULL)", r["L9000002"]["ended"] is None, row=r["L9000002"])
    note("C after restart: one row per natural key", all(v["dup"] == 1 for v in r.values()), rows=r)
    wait(lambda: "L9000002" in live(), "live list shows C")

    publish([w1], f1)  # 옛 목록(수신 시각이 B · C 보다 앞)
    time.sleep(5)
    r = rows()
    note("old list A': W2 stays open", r["L9000002"]["ended"] is None, row=r["L9000002"])
    note("old list A': live list unchanged (C)", live() == ["L9000002", "S9000001"] or {"L9000002", "S9000001"} <= set(live()), live=live())
    note("invariants: first_seen ≤ last_seen", all(v["first"] <= v["last"] for v in r.values()), rows=r)

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "rel_warnings_restart.json"), "w") as f:
        json.dump({"checks": LOG, "failures": FAIL}, f, ensure_ascii=False, indent=1)
    print(f"checks={len(LOG)} failures={len(FAIL)}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
