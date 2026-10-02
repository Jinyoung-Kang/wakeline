"""QA 성능(계획 §3.5): 격리 스택 A(wakeline-e2e)의 실시간 상태를 운영 규모로 채우는 합성 생산자.

fixture 모드는 전세계 항공기가 0대(providers/fixture.py fetch_global — 빈 목록)이고 선박이 약 380척이라, 운영(전세계 약 10,000대 · 선박 1.4–3만 척,
docs/PERF.md §1 · §7)보다 api 메모리 · WS 팬아웃 · /aircraft · /ships 가 훨씬 가볍다. 이 스크립트는 생산자 ACL 사용자로(수집기 · ais 와 같은 권한)
Redis 스트림에 운영 모양의 메시지를 넣는다:

- 전세계(scope global): 10,000대를 120 s 마다. fixture 의 빈 전세계 메시지가 오면(2 s 마다 확인) 곧바로 뒤따라 실어 빈 스냅샷이 2 s 넘게 남지 않게 한다.
  hex 는 seed_perf.sql 이 DB 에 넣은 전세계 합성 항적의 것(상세 · 항적 조회가 이력을 찾는다), 위치는 운영의 밀도를 흉내 내 다시 놓는다
  (유럽 30 % · 북미 30 % · 동아시아 15 % · 나머지 25 % — 넓은 bbox 응답이 운영처럼 커지게).
- 선박(scope ships): 15,000척(MMSI 300000000–300014999)을 5 s 마다 200척씩 돌아가며(초당 40건 → 각 375 s 마다 한 번 · 분당 약 2,400행 저장),
  열 번에 한 번 정적 정보도. 12,000척은 DB 의 합성 위치에서 이어 간다.
관심 지역(region)은 fixture 수집기가 그대로 싣는다(127대 — 운영 70–190대).

    python3 tools/qa/perf_feed.py [초]      # 기본 7200 s. 8701 스택(wakeline-e2e)만.
    touch /tmp/wakeline-qa-perf-feed.stop    # 다음 루프(0.2 s 안)에서 스스로 끝난다(프로세스를 죽이지 않고 멈추는 길)
비밀번호는 redis 컨테이너 자신의 환경 변수에서 redis-cli 가 읽는다(inject_stream.py 와 같은 방식 — 출력하지 않는다).
"""

from __future__ import annotations

import base64
import gzip
import json
import math
import os
import random
import subprocess
import sys
import time
from datetime import datetime, timezone

PROJECT = "wakeline-e2e"
REDIS = f"{PROJECT}-redis-1"
DB = f"{PROJECT}-db-1"
GLOBAL_N = 10_000
SHIPS_N = 15_000
SHIP_BATCH = 200
SHIP_EVERY_S = 5.0
STOP_FILE = "/tmp/wakeline-qa-perf-feed.stop"


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def redis(user: str, env_var: str, *args: str, stdin: str | None = None) -> str:
    cmd = ["docker", "exec", "-i", REDIS, "sh", "-c",
           f'REDISCLI_AUTH="${env_var}" exec redis-cli --no-auth-warning --user {user} "$@"', "sh"]
    if stdin is not None:
        cmd.append("-x")
    cmd += list(args)
    r = subprocess.run(cmd, input=stdin, capture_output=True, text=True)
    if r.returncode != 0 or r.stdout.startswith(("NOPERM", "ERR", "WRONGPASS")):
        raise RuntimeError(f"redis-cli failed: {r.stdout.strip()[:200]} {r.stderr.strip()[:200]}")
    return r.stdout


def psql(sql: str) -> list[list[str]]:
    r = subprocess.run(["docker", "exec", DB, "psql", "-U", "postgres", "-d", "wakeline", "-AtF", "|", "-c", sql], capture_output=True, text=True, check=True)
    return [line.split("|") for line in r.stdout.splitlines() if line]


def pack(obj) -> str:
    return base64.b64encode(gzip.compress(json.dumps(obj, separators=(",", ":")).encode())).decode()


def xadd(user: str, env_var: str, key: str, kind: str, scope: str, payload, count: int, raw_ref: str, t: float) -> str:
    fields = ["schema_version", "1", "kind", kind, "scope", scope, "provider", "fixture", "fetched_at", iso(t), "raw_ref", raw_ref,
              "encoding", "gzip+base64", "count", str(count), "payload"]
    return redis(user, env_var, "XADD", key, "*", *fields, stdin=pack(payload)).strip()


def move(lat: float, lon: float, trk: float, kt: float, dt_s: float) -> tuple[float, float]:
    d = kt * dt_s / 3600.0 / 60.0
    lat2 = lat + d * math.cos(math.radians(trk))
    lon2 = lon + d * math.sin(math.radians(trk)) / max(0.2, math.cos(math.radians(lat)))
    if lat2 > 80 or lat2 < -70:
        lat2 = max(-70.0, min(80.0, lat2))
    lon2 = (lon2 + 180) % 360 - 180
    return lat2, lon2


class Feed:
    def __init__(self) -> None:
        rnd = random.Random(42)
        rows = psql("SELECT DISTINCT ON (hex) hex, extract(epoch FROM ts), ST_Y(geom), ST_X(geom), coalesce(track_deg, 0), coalesce(gs_kt, 420), coalesce(alt_ft, 33000) "
                    "FROM track_point WHERE provider = 'qa_synthetic' AND ts > now() - interval '3 hours' AND hex >= 'f20000' AND hex < 'f60000' ORDER BY hex, ts DESC")
        self.aircraft = [dict(hex=r[0], t=float(r[1]), lat=float(r[2]), lon=float(r[3]), trk=float(r[4]), kt=float(r[5]), alt=int(r[6])) for r in rows]
        # 이전 6 h 비행의 hex 도 3 h 안에 끝점이 있으면 들어온다 — 칸(slot)마다 가장 늦은 hex 하나만
        by_slot: dict[int, dict] = {}
        for a in self.aircraft:
            slot = (int(a["hex"], 16) - 0xF20000) // 12
            if slot not in by_slot or a["t"] > by_slot[slot]["t"]:
                by_slot[slot] = a
        self.aircraft = list(by_slot.values())[:GLOBAL_N]
        while len(self.aircraft) < GLOBAL_N:
            i = len(self.aircraft)
            self.aircraft.append(dict(hex=f"{0xF60000 + 80000 + i:06x}", t=time.time(), lat=0.0, lon=0.0,
                                      trk=rnd.uniform(0, 360), kt=rnd.uniform(380, 500), alt=rnd.randrange(28000, 41000, 1000)))
        # 위치는 운영의 밀도를 흉내 내 다시 놓는다(hex 는 DB 이력과 같다): 유럽 30 % · 북미 30 % · 동아시아 15 % · 나머지 25 % 전세계
        for k, a in enumerate(self.aircraft):
            r = rnd.random()
            if r < 0.30:
                a["lat"], a["lon"] = rnd.uniform(35, 60), rnd.uniform(-10, 30)
            elif r < 0.60:
                a["lat"], a["lon"] = rnd.uniform(25, 50), rnd.uniform(-125, -70)
            elif r < 0.75:
                a["lat"], a["lon"] = rnd.uniform(20, 45), rnd.uniform(100, 145)
            else:
                a["lat"], a["lon"] = rnd.uniform(-50, 65), rnd.uniform(-180, 180)
            a["t"] = time.time()
        srows = psql("SELECT DISTINCT ON (mmsi) mmsi, extract(epoch FROM ts), ST_Y(geom), ST_X(geom), coalesce(cog_deg, 0), coalesce(sog_kn, 0) "
                     "FROM ship_position WHERE provider = 'qa_synthetic' AND ts > now() - interval '6 hours' ORDER BY mmsi, ts DESC")
        ships = {r[0]: dict(mmsi=r[0], t=float(r[1]), lat=float(r[2]), lon=float(r[3]), cog=float(r[4]), sog=float(r[5])) for r in srows}
        for i in range(SHIPS_N):
            m = str(300000000 + i)
            if m not in ships:
                ships[m] = dict(mmsi=m, t=time.time(), lat=rnd.uniform(-40, 60), lon=rnd.uniform(-180, 180), cog=rnd.uniform(0, 359), sog=rnd.uniform(0, 20))
        self.ships = [ships[str(300000000 + i)] for i in range(SHIPS_N)]
        self.ship_cursor = 0
        self.ship_round = 0
        self.last_global_id = ""
        self.last_global_at = 0.0
        print(f"feed: {len(self.aircraft)} global aircraft (from DB {len(by_slot)}), {len(self.ships)} ships (from DB {len(srows)})", flush=True)

    def publish_global(self) -> None:
        now = time.time()
        states = []
        for a in self.aircraft:
            a["lat"], a["lon"] = move(a["lat"], a["lon"], a["trk"], a["kt"], now - a["t"])
            a["t"] = now
            seen = now - random.uniform(0, 30)
            states.append({"hex": a["hex"], "callsign": "QA" + a["hex"][2:], "registration": None, "type_code": None, "category": "A3",
                           "lat": round(a["lat"], 5), "lon": round(a["lon"], 5), "alt_ft": a["alt"], "gs_kt": round(a["kt"], 1), "track_deg": round(a["trk"], 1),
                           "vrate_fpm": 0.0, "on_ground": False, "squawk": None, "seen_at": iso(seen), "provider": "opensky", "fetched_at": iso(now),
                           "quality": 1, "estimated": False})
        xid = xadd("wakeline_collector", "REDIS_COLLECTOR_PASSWORD", "wakeline:aircraft", "aircraft", "global", {"region": None, "states": states},
                   len(states), "qa_synthetic:global", now)
        self.last_global_at = now
        print(f"{iso(now)} global {len(states)} -> {xid}", flush=True)

    def publish_ships(self) -> None:
        now = time.time()
        batch = [self.ships[(self.ship_cursor + k) % SHIPS_N] for k in range(SHIP_BATCH)]
        self.ship_cursor = (self.ship_cursor + SHIP_BATCH) % SHIPS_N
        if self.ship_cursor < SHIP_BATCH:
            self.ship_round += 1
        states, statics, received = [], [], {}
        for s in batch:
            s["lat"], s["lon"] = move(s["lat"], s["lon"], s["cog"], s["sog"], now - s["t"])
            s["t"] = now
            states.append({"mmsi": s["mmsi"], "lat": round(s["lat"], 5), "lon": round(s["lon"], 5), "sog_kn": round(s["sog"], 1), "cog_deg": round(s["cog"], 1),
                           "heading_deg": int(s["cog"]) % 360, "nav_status": 0, "rot": 0, "position_source": "epfs", "seen_at": iso(now - random.uniform(0, 5)),
                           "provider": "fixture", "msg_type": "PositionReport", "class": "A"})
            i = int(s["mmsi"]) - 300000000
            if (i + self.ship_round) % 10 == 0:
                statics.append({"mmsi": s["mmsi"], "name": f"QA VESSEL {i}", "call_sign": f"Q{i:05X}"[:7], "imo": 9000000 + i, "ship_type": 70, "dim_a": 100,
                                "dim_b": 30, "dim_c": 10, "dim_d": 10, "draught_m": 8.5, "destination": "BUSAN", "eta_month": 10, "eta_day": 3, "eta_hour": 12,
                                "eta_minute": 0, "updated_at": iso(now), "provider": "fixture"})
                received[s["mmsi"]] = ["name", "call_sign", "imo", "ship_type", "dim_a", "dim_b", "dim_c", "dim_d", "draught_m", "destination",
                                       "eta_month", "eta_day", "eta_hour", "eta_minute"]
        payload = {"ships": states, "static": statics, "static_received": received,
                   "stats": {"msgs": len(states), "msgs_per_s": len(states) / SHIP_EVERY_S, "dropped": 0, "quarantined": 0, "invalid": 0,
                             "window_s": SHIP_EVERY_S, "connected": True},
                   "part": 1, "parts": 1}
        xadd("wakeline_ais", "REDIS_AIS_PASSWORD", "wakeline:ships", "ships", "ships", payload, len(states), "qa_synthetic:ships", now)

    def latest_global_is_fixture(self) -> bool:
        out = redis("wakeline_collector", "REDIS_COLLECTOR_PASSWORD", "XREVRANGE", "wakeline:aircraft", "+", "-", "COUNT", "6").split("\n")
        # 출력: id, 필드, 값 … — 첫 global 엔트리의 raw_ref 를 본다
        cur_id = None
        scope = raw_ref = None
        i = 0
        while i < len(out) - 1:
            tok = out[i]
            if "-" in tok and tok.replace("-", "").isdigit() and (i == 0 or out[i - 1] not in ("fetched_at", "raw_ref", "payload", "count")):
                if scope == "global":
                    break
                cur_id, scope, raw_ref = tok, None, None
                i += 1
                continue
            if tok == "scope":
                scope = out[i + 1]
            elif tok == "raw_ref":
                raw_ref = out[i + 1]
            i += 1
        if scope != "global" or cur_id is None:
            return False
        if raw_ref == "fixture:empty_global" and cur_id != self.last_global_id:
            self.last_global_id = cur_id
            return True
        return False


def main() -> int:
    dur = float(sys.argv[1]) if len(sys.argv) > 1 else 7200.0
    f = Feed()
    end = time.monotonic() + dur
    f.publish_global()
    next_ships = time.monotonic()
    next_check = time.monotonic()
    while time.monotonic() < end and not os.path.exists(STOP_FILE):
        now = time.monotonic()
        if now >= next_ships:
            f.publish_ships()
            next_ships += SHIP_EVERY_S
        if now >= next_check:
            next_check = now + 2.0
            try:
                if f.latest_global_is_fixture() or time.time() - f.last_global_at > 125:
                    f.publish_global()
            except RuntimeError as e:
                print("warn:", e, flush=True)
        time.sleep(0.2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
