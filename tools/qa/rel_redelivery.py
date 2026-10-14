#!/usr/bin/env python3
"""QA 2026-10 AWS(계획 §3.4 '같은 메시지 재전달'): 스택 B(wlqa-b · 8702)의 스트림에 같은 엔트리를 다시 넣어(수집기 Publisher 의 재전송 · PEL 재처리와
같은 모양 — 새 ID, 같은 내용) 저장이 멱등인지 본다. 생산자 ACL 사용자로 XADD 한다(tools/qa/inject_stream.py 의 cli · envelope — 비밀번호는 컨테이너 안에서만).

  R1 특보(wakeline:wxwarn): 시험 구역 S9 · L9 목록을 같은 fetched_at 으로 세 번 → 자연키(구역 · 종류 · 수준 · 발표)마다 한 행, 끝난 행 없음.
     더 옛 fetched_at 의 빈 목록(complete) 재전달 → 아무것도 끝나지 않음(순서 바뀐 옛 목록).
  R2 AIS 공백(wakeline:ships · ais_gap): 같은 공백을 세 번 → ingest_gap 한 행.
  R3 선박 위치(wakeline:ships · ships): 같은 MMSI · seen_at 을 세 번 → ship_position 한 행.
  R4 SIGMET(wakeline:sigmet): 가장 최근 엔트리를 그대로 두 번 더 → sigmet 행 수 그대로, 열린 알림이 (hex, 구역, 종류)마다 하나.
  R5 항공기(wakeline:aircraft region): 가장 최근 region 엔트리를 그대로 두 번 더 → 그 상태들의 (hex, ts) 마다 track_point 한 행.
결과는 JSON(증거 폴더) · 실패가 있으면 종료 코드 1. 시험 자료(S9/L9 구역 · MMSI 440999240 · 공백 1건)는 끝에 지운다.

    python3 tools/qa/rel_redelivery.py [증거 폴더]
"""

from __future__ import annotations

import base64
import gzip
import json
import os
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import inject_stream as inj  # noqa: E402

inj.PROJECT = "wlqa-b"
DB = "wlqa-b-db-1"
OUT = sys.argv[1] if len(sys.argv) > 1 else "docs/qa/2026-10-aws/evidence/reliability/redelivery"
LOG: list[dict] = []
FAIL: list[str] = []
MMSI = "440999240"


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def psql(sql: str) -> list[list[str]]:
    r = subprocess.run(["docker", "exec", DB, "psql", "-X", "-U", "postgres", "-d", "wakeline", "-At", "-F", "\t", "-c", "SET TIME ZONE 'UTC'", "-c", sql],
                       capture_output=True, text=True, check=True)
    return [line.split("\t") for line in r.stdout.splitlines() if line and line != "SET"]


def one(sql: str) -> str:
    return psql(sql)[0][0]


def note(name: str, ok: bool, **kw) -> None:
    LOG.append({"check": name, "ok": ok, **kw})
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f" {kw}"))
    if not ok:
        FAIL.append(name)


def xadd(user: str, env_var: str, stream: str, fields: list[str]) -> str:
    return inj.cli(user, env_var, "XADD", stream, "*", *fields).strip()


def settle(s: float = 6) -> None:
    time.sleep(s)


def latest(stream: str, scope: str | None = None) -> list[str]:
    """스트림의 가장 최근 엔트리(scope 가 맞는 것)의 필드 목록 — 그대로 다시 XADD 할 수 있는 모양."""
    out = inj.cli("wakeline_collector", "REDIS_COLLECTOR_PASSWORD", "XREVRANGE", stream, "+", "-", "COUNT", "30").split("\n")
    keys = ("schema_version", "kind", "scope", "provider", "fetched_at", "raw_ref", "encoding", "count", "payload", "run_id")
    entries, cur, i = [], None, 0
    while i < len(out):
        if out[i] == "schema_version":
            cur = []
            entries.append(cur)
        if cur is not None and i + 1 < len(out) and out[i] in keys:
            cur += [out[i], out[i + 1]]
            i += 2
            continue
        i += 1
    for e in entries:
        d = dict(zip(e[::2], e[1::2]))
        if scope is None or d.get("scope") == scope:
            return e
    raise SystemExit(f"no entry in {stream} (scope {scope})")


def r1_warnings() -> None:
    psql("DELETE FROM wx_warning WHERE zone_code LIKE '_9%'")
    t0 = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=20)
    ws = [{"zone_code": "S9002401", "zone_name": "QA S9002401", "sea": True, "kind": "풍랑", "level": "주의보", "command": "발표", "preliminary": False,
           "issued_at": iso(t0), "effective_at": iso(t0), "raw": "QA, S9002401,="},
          {"zone_code": "L9002402", "zone_name": "QA L9002402", "sea": False, "kind": "호우", "level": "주의보", "command": "발표", "preliminary": False,
           "issued_at": iso(t0), "effective_at": iso(t0), "raw": "QA, L9002402,="}]
    f1 = datetime.now(UTC)
    env = inj.envelope("wx_warnings", "-", {"complete": True, "dropped": 0, "warnings": ws}, len(ws), "qa/redelivery")
    env[env.index("fetched_at") + 1] = iso(f1)
    for _ in range(3):
        xadd("wakeline_collector", "REDIS_COLLECTOR_PASSWORD", "wakeline:wxwarn", env)
        time.sleep(0.5)
    settle()
    rows = psql("SELECT zone_code, count(*), count(*) FILTER (WHERE ended_at IS NOT NULL) FROM wx_warning WHERE zone_code LIKE '_9%' GROUP BY 1 ORDER BY 1")
    note("R1 wx_warning: same list ×3 → one row per natural key, none ended", rows == [["L9002402", "1", "0"], ["S9002401", "1", "0"]], rows=rows)
    # 순서 바뀐 옛 목록(빈 complete 목록 — 수신 시각이 앞)이 늦게 다시 와도 끝내지 않는다
    old = inj.envelope("wx_warnings", "-", {"complete": True, "dropped": 0, "warnings": []}, 0, "qa/redelivery")
    old[old.index("fetched_at") + 1] = iso(f1 - timedelta(minutes=5))
    xadd("wakeline_collector", "REDIS_COLLECTOR_PASSWORD", "wakeline:wxwarn", old)
    settle()
    rows = psql("SELECT zone_code, count(*), count(*) FILTER (WHERE ended_at IS NOT NULL) FROM wx_warning WHERE zone_code LIKE '_9%' GROUP BY 1 ORDER BY 1")
    note("R1 wx_warning: older empty list re-delivered late → nothing ended", rows == [["L9002402", "1", "0"], ["S9002401", "1", "0"]], rows=rows)


def r2_gap() -> None:
    s = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=50)
    ev = {"started_at": iso(s), "ended_at": iso(s + timedelta(seconds=40)), "reason": "qa redelivery 1240"}
    env = inj.envelope("ais_gap", "ships", ev, 1, "qa/redelivery")
    for _ in range(3):
        xadd("wakeline_ais", "REDIS_AIS_PASSWORD", "wakeline:ships", env)
        time.sleep(0.3)
    settle()
    n = one(f"SELECT count(*) FROM ingest_gap WHERE source = 'ais' AND started_at = '{iso(s)}'")
    note("R2 ingest_gap: same gap ×3 → one row", n == "1", rows=n)


def r3_ship() -> None:
    t = iso(datetime.now(UTC) - timedelta(seconds=3))
    state = {"mmsi": MMSI, "lat": 35.11, "lon": 129.21, "sog_kn": 5.0, "cog_deg": 90.0, "heading_deg": 90, "nav_status": 0, "rot": 0,
             "position_source": "epfs", "seen_at": t, "provider": "fixture", "msg_type": "PositionReport", "class": "A"}
    payload = {"ships": [state], "static": [], "static_received": {},
               "stats": {"msgs": 1, "msgs_per_s": 0.1, "dropped": 0, "quarantined": 0, "invalid": 0, "window_s": 10.0, "connected": True}, "part": 1, "parts": 1}
    env = inj.envelope("ships", "ships", payload, 1, "qa/redelivery")
    for _ in range(3):
        xadd("wakeline_ais", "REDIS_AIS_PASSWORD", "wakeline:ships", env)
        time.sleep(0.3)
    settle(14)  # 선박 저장기 배치 · 60 s 창
    n = one(f"SELECT count(*) FROM ship_position WHERE mmsi = '{MMSI}' AND ts = '{t}'")
    note("R3 ship_position: same report ×3 → one row", n == "1", rows=n)


def r4_sigmet() -> None:
    before = one("SELECT count(*) FROM sigmet")
    e = latest("wakeline:sigmet")
    for _ in range(2):
        xadd("wakeline_collector", "REDIS_COLLECTOR_PASSWORD", "wakeline:sigmet", e)
        time.sleep(0.5)
    settle()
    after = one("SELECT count(*) FROM sigmet")
    note("R4 sigmet: latest set re-delivered ×2 → row count unchanged", before == after, before=before, after=after)
    dup = psql("SELECT hex, coalesce(sigmet_id, airspace_id::text), kind, count(*) FROM alert_event WHERE left_at IS NULL GROUP BY 1, 2, 3 HAVING count(*) > 1")
    note("R4 alert_event: one open alert per (hex, zone, kind)", not dup, dup=dup[:5])


def r5_aircraft() -> None:
    e = latest("wakeline:aircraft", "region")
    d = dict(zip(e[::2], e[1::2]))
    p = json.loads(gzip.decompress(base64.b64decode(d["payload"])))
    keys = [(s["hex"], s["seen_at"]) for s in p["states"]][:50]
    for _ in range(2):
        xadd("wakeline_collector", "REDIS_COLLECTOR_PASSWORD", "wakeline:aircraft", e)
        time.sleep(0.5)
    settle(8)
    cond = " OR ".join(f"(hex = '{h}' AND ts = '{t}')" for h, t in keys)
    rows = psql(f"SELECT hex, ts, count(*) FROM track_point WHERE {cond} GROUP BY 1, 2 HAVING count(*) <> 1")
    have = one(f"SELECT count(*) FROM track_point WHERE {cond}")
    note("R5 track_point: region entry re-delivered ×2 → one row per (hex, ts)", not rows and int(have) == len(set(keys)), have=have, expected=len(set(keys)))
    dup = psql("SELECT hex, coalesce(sigmet_id, airspace_id::text), kind, count(*) FROM alert_event WHERE left_at IS NULL GROUP BY 1, 2, 3 HAVING count(*) > 1")
    note("R5 alert_event: one open alert per (hex, zone, kind)", not dup, dup=dup[:5])


def main() -> int:
    for f in (r1_warnings, r2_gap, r3_ship, r4_sigmet, r5_aircraft):
        try:
            f()
        except Exception as e:  # noqa: BLE001 — 한 점검의 실패가 나머지를 막지 않게
            note(f.__name__ + " raised", False, error=f"{type(e).__name__}: {e}"[:300])
    # 시험 자료 정리(격리 스택 B)
    psql("DELETE FROM wx_warning WHERE zone_code LIKE '_9%'")
    psql("DELETE FROM ingest_gap WHERE source = 'ais' AND reason = 'qa redelivery 1240'")
    psql(f"DELETE FROM ship_position WHERE mmsi = '{MMSI}'")
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "redelivery.json"), "w") as fh:
        json.dump({"checks": LOG, "failures": FAIL}, fh, ensure_ascii=False, indent=1)
    print(f"checks={len(LOG)} failures={len(FAIL)}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
