"""QA 보안 점검(계획 §3.1 XSS): 조작한 글자를 실은 선박 · 항공기 엔트리를 격리 스택 A 의 Redis 스트림에 넣는다(생산자 ACL 사용자로).

- ship: wakeline_ais 사용자로 XADD wakeline:ships — 선박 1척(MMSI 440999001, 부산 앞바다)의 위치 + 정적 정보(이름 · 호출부호 · 목적지에 표식)
- aircraft: wakeline_collector 사용자로 XADD wakeline:aircraft — 가장 최근 region 엔트리를 읽어(XREVRANGE) 그 상태들 + 조작한
  항공기 1대(hex 0a5ec1 — 호출부호 · 등록 · 기종에 표식)를 같은 scope 로 다시 싣는다(region 은 통째로 바뀌므로 기존 항공기를 지우지 않게).
  --loop N 이면 N 초 동안 3 s 마다 되풀이한다(수집기의 다음 region 발행이 덮으므로).

비밀번호는 redis 컨테이너 자신의 환경 변수에서 읽어 redis-cli 에 넘긴다(tools/chaos.sh 와 같은 방식 — 출력하지 않는다). 8701 스택(wakeline-e2e)만.

    python3 tools/qa/inject_stream.py ship
    python3 tools/qa/inject_stream.py aircraft --loop 90
"""

from __future__ import annotations

import base64
import gzip
import json
import subprocess
import sys
import time
from datetime import datetime, timezone

PROJECT = "wakeline-e2e"
MMSI = "440999001"
HEX = "0a5ec1"
# 스키마 길이 한도 안(name · destination ≤ 20, call_sign ≤ 7, callsign ≤ 8, registration ≤ 16, type_code ≤ 8)
SHIP_STATIC = {"name": "<i id=qaxn>N</i>", "call_sign": "\"><i>c", "destination": "<svg onload=q=1>"}
AIRCRAFT = {"callsign": "<i id=k>", "registration": "<i id=qr>R</i>", "type_code": "\"><b>T"}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def cli(user: str, env_var: str, *args: str) -> str:
    cmd = ["docker", "exec", f"{PROJECT}-redis-1", "sh", "-c",
           f'REDISCLI_AUTH="${env_var}" exec redis-cli --no-auth-warning --user {user} "$@"', "sh", *args]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or r.stdout.startswith(("NOPERM", "ERR", "WRONGPASS")):
        raise SystemExit(f"redis-cli failed: {r.stdout.strip()[:200]} {r.stderr.strip()[:200]}")
    return r.stdout


def pack(obj) -> str:
    return base64.b64encode(gzip.compress(json.dumps(obj, separators=(",", ":")).encode())).decode()


def envelope(kind: str, scope: str, payload, count: int, raw_ref: str) -> list[str]:
    env = {"schema_version": "1", "kind": kind, "scope": scope, "provider": "fixture", "fetched_at": now_iso(), "raw_ref": raw_ref,
           "encoding": "gzip+base64", "count": str(count), "payload": pack(payload)}
    out: list[str] = []
    for k, v in env.items():
        out += [k, v]
    return out


def ship() -> str:
    t = now_iso()
    state = {"mmsi": MMSI, "lat": 35.02, "lon": 129.12, "sog_kn": 3.2, "cog_deg": 45.0, "heading_deg": 45, "nav_status": 0, "rot": 0,
             "position_source": "epfs", "seen_at": t, "provider": "fixture", "msg_type": "PositionReport", "class": "A"}
    static = {"mmsi": MMSI, **SHIP_STATIC, "imo": None, "ship_type": 70, "dim_a": 10, "dim_b": 10, "dim_c": 5, "dim_d": 5, "draught_m": 4.0,
              "eta_month": None, "eta_day": None, "eta_hour": None, "eta_minute": None, "updated_at": t, "provider": "fixture"}
    payload = {"ships": [state], "static": [static], "static_received": {MMSI: ["name", "call_sign", "destination", "ship_type", "dim_a", "dim_b", "dim_c", "dim_d", "draught_m"]},
               "stats": {"msgs": 1, "msgs_per_s": 0.1, "dropped": 0, "quarantined": 0, "invalid": 0, "window_s": 10.0, "connected": True},
               "part": 1, "parts": 1}
    return cli("wakeline_ais", "REDIS_AIS_PASSWORD", "XADD", "wakeline:ships", "*", *envelope("ships", "ships", payload, 1, "qa/xss-probe")).strip()


def aircraft_once() -> str:
    out = cli("wakeline_collector", "REDIS_COLLECTOR_PASSWORD", "XREVRANGE", "wakeline:aircraft", "+", "-", "COUNT", "20").split("\n")
    # 출력: id, 필드, 값, … (엔트리 사이 구분 없음 — 필드 이름으로 나눈다)
    entries, cur = [], None
    i = 0
    while i < len(out):
        if out[i] == "schema_version":
            cur = {}
            entries.append(cur)
        if cur is not None and i + 1 < len(out) and out[i] in ("schema_version", "kind", "scope", "provider", "fetched_at", "raw_ref", "encoding", "count", "payload", "run_id"):
            cur[out[i]] = out[i + 1]
            i += 2
            continue
        i += 1
    region = next(e for e in entries if e.get("scope") == "region")
    p = json.loads(gzip.decompress(base64.b64decode(region["payload"])))
    t = now_iso()
    states = [s for s in p["states"] if s["hex"] != HEX]
    states.append({"hex": HEX, **AIRCRAFT, "category": "A3", "lat": 35.6, "lon": 127.2, "alt_ft": 31000, "gs_kt": 450.0, "track_deg": 90.0,
                   "vrate_fpm": 0.0, "on_ground": False, "squawk": None, "seen_at": t, "provider": "fixture", "fetched_at": t, "quality": 1,
                   "estimated": False})
    p["states"] = states
    return cli("wakeline_collector", "REDIS_COLLECTOR_PASSWORD", "XADD", "wakeline:aircraft", "*",
               *envelope("aircraft", "region", p, len(states), region.get("raw_ref", "qa/xss-probe"))).strip()


def main() -> int:
    what = sys.argv[1] if len(sys.argv) > 1 else "ship"
    loop = int(sys.argv[sys.argv.index("--loop") + 1]) if "--loop" in sys.argv else 0
    if what == "ship":
        print("ship", MMSI, ship())
        return 0
    end = time.monotonic() + loop
    while True:
        print("aircraft", HEX, aircraft_once(), flush=True)
        if time.monotonic() >= end:
            return 0
        time.sleep(3)


if __name__ == "__main__":
    sys.exit(main())
