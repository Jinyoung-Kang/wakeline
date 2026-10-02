#!/usr/bin/env python3
"""QA 신뢰성(계획 §3.4 '동시 요청'): 격리 스택 B(8702)에서 같은 운영 쓰기를 동시에 보내 결과 · 감사 기록 · 원본(DB) · 미러(Redis)가 맞는지 본다.

    python3 tools/qa/rel_concurrency.py [settings|providers|resolutions|aggregate|lockout|ws|client_errors ...] [--out DIR]

불변식(어긋나면 종료 코드 1 — 결과는 DIR/concurrency-<시험>.json):
- settings: 같은 If-Match 로 N 건 → 200 은 정확히 1, 나머지 409 VERSION_MISMATCH(계약: 409 — VERIFICATION 회귀 시나리오), 감사 SETTING_UPDATE 1행, version +1.
- providers: 같은 공급자 켜고 끄기 N 건 → 모두 200, version +N, 감사 N행의 before.version → after.version 이 끊김 없이 이어지고, 마지막 감사 값 = DB = Redis 미러.
- resolutions: 같은 해결 N 건 생성 → 모두 201 · 감사 RESOLVE N행. 한 id 를 N 건 동시 되돌림 → 204 정확히 1, 나머지 404, 감사 UNRESOLVE 1행.
- aggregate: 같은 날 집계 N 건 → 500 없음, 성공 수 = 감사 STATS_AGGREGATE 행 수, stats_daily 의 완료 표식 계열마다 1행.
- lockout(qa-b): 동시 틀린 비밀번호 4 → 잠기지 않고 실패 4, 5 → 정확히 한 번 잠김(ACCOUNT_LOCKED 1), 8 → ACCOUNT_LOCKED 1. 끝나면 잠금을 푼다(DB).
- ws: 같은 IP 에서 WS 7개 → 5개만 남고 나머지는 1013 으로 닫힌다(IP 당 상한 5).
- client_errors: 서로 다른 오류 30건 동시 → 204 ≤ 10(IP 당 분당 10), 나머지 429 + Retry-After, 500 없음.
비밀번호는 qa_session(0600 파일)에서만 읽고 출력하지 않는다. 운영 스택(8700)은 막는다.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(__file__))
from qa_session import OpsSession, password  # noqa: E402

BASE = "http://localhost:8702"
P = "wakeline-qa"
KST = timezone(timedelta(hours=9))
results: dict[str, dict] = {}


def psql(sql: str) -> list[list[str]]:
    out = subprocess.run(["docker", "exec", f"{P}-db-1", "psql", "-X", "-U", "postgres", "-d", "wakeline", "-At", "-F", "\t", "-c", sql],
                         check=True, capture_output=True, text=True).stdout
    return [line.split("\t") for line in out.splitlines() if line]


def redis(*args: str) -> str:
    return subprocess.run(["docker", "exec", f"{P}-redis-1", "sh", "-c", 'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli --no-auth-warning "$@"', "sh", *args],
                          check=True, capture_output=True, text=True).stdout.strip()


def db_now() -> str:
    return psql("SELECT now()")[0][0]


def parallel(n: int, fn) -> list:
    """n 개 스레드를 장벽에서 함께 출발시킨다."""
    barrier = threading.Barrier(n)
    out: list = [None] * n

    def run(i: int) -> None:
        barrier.wait()
        try:
            out[i] = fn(i)
        except Exception as e:  # noqa: BLE001
            out[i] = ("EXC", repr(e))

    ts = [threading.Thread(target=run, args=(i,)) for i in range(n)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    return out


def audit_since(t0: str, action: str, target: str | None = None) -> list[dict]:
    cond = f"AND target = '{target}'" if target else ""
    rows = psql(f"SELECT id, action, coalesce(target,''), coalesce(before::text,'null'), coalesce(after::text,'null') FROM audit_log "
                f"WHERE at >= '{t0}' AND action = '{action}' {cond} ORDER BY id")
    return [{"id": int(r[0]), "action": r[1], "target": r[2], "before": json.loads(r[3]), "after": json.loads(r[4])} for r in rows]


def codes(res: list) -> dict:
    c: dict = {}
    for r in res:
        k = str(r[0]) if isinstance(r, tuple) else str(r)
        c[k] = c.get(k, 0) + 1
    return c


# ------------------------------------------------------------------ 시험들

def t_settings(s: OpsSession, n: int = 8) -> dict:
    key = "metar_poll_s"
    st, _, body = s.request("GET", "/api/v1/ops/settings")
    item = next(i for i in json.loads(body)["items"] if i["key"] == key)
    v0, value = item["version"], item["value"]
    t0 = db_now()
    res = parallel(n, lambda i: s.request("PUT", f"/api/v1/ops/settings/{key}", {"value": value}, {"If-Match": str(v0)}))
    sts = [r[0] for r in res]
    errs = [json.loads(r[2]).get("code") for r in res if r[0] != 200]
    v1 = int(psql(f"SELECT version FROM app_setting WHERE key = '{key}'")[0][0])
    aud = audit_since(t0, "SETTING_UPDATE", key)
    ok = sts.count(200) == 1 and all(c == 409 for c in sts if c != 200) and set(errs) <= {"VERSION_MISMATCH"} and v1 == v0 + 1 and len(aud) == 1
    return {"ok": ok, "n": n, "statuses": codes(sts), "error_codes": errs, "version": [v0, v1], "audit_rows": len(aud)}


def t_providers(s: OpsSession, n: int = 8) -> dict:
    prov = "opensky"
    v0 = int(psql(f"SELECT version FROM provider_switch WHERE provider = '{prov}'")[0][0])
    t0 = db_now()
    res = parallel(n, lambda i: s.request("POST", f"/api/v1/ops/providers/{prov}/{'disable' if i % 2 == 0 else 'enable'}"))
    sts = [r[0] for r in res]
    disabled, v1 = psql(f"SELECT disabled, version FROM provider_switch WHERE provider = '{prov}'")[0]
    mirror = redis("HGET", f"wakeline:provider:{prov}", "disabled")
    aud = audit_since(t0, "PROVIDER_DISABLE", prov) + audit_since(t0, "PROVIDER_ENABLE", prov)
    aud.sort(key=lambda a: a["after"].get("version") or 0)
    chain = [(a["before"].get("version"), a["after"].get("version")) for a in aud]
    chain_ok = all(b == a - 1 for b, a in chain) and [a for _, a in chain] == list(range(v0 + 1, v0 + n + 1))
    last_after = aud[-1]["after"].get("disabled") if aud else None
    db_disabled = disabled == "t"
    mirror_disabled = mirror == "1"
    ok = sts.count(200) == n and int(v1) == v0 + n and len(aud) == n and chain_ok and last_after == db_disabled == mirror_disabled
    s.request("POST", f"/api/v1/ops/providers/{prov}/enable")  # 되돌림(켜짐)
    return {"ok": ok, "n": n, "statuses": codes(sts), "version": [v0, int(v1)], "audit_rows": len(aud), "audit_version_chain": chain,
            "final": {"audit_last_after_disabled": last_after, "db_disabled": db_disabled, "redis_disabled": mirror}}


def t_resolutions(s: OpsSession, n: int = 6) -> dict:
    t0 = db_now()
    body = {"kind": "provider_error", "key": "opensky", "note": "qa concurrency"}
    res = parallel(n, lambda i: s.request("POST", "/api/v1/ops/resolutions", body))
    created = [json.loads(r[2])["id"] for r in res if r[0] == 201]
    aud_c = audit_since(t0, "RESOLVE", "provider_error:opensky")
    rid = created[0] if created else None
    res2 = parallel(n, lambda i: s.request("DELETE", f"/api/v1/ops/resolutions/{rid}"))
    aud_u = audit_since(t0, "UNRESOLVE", "provider_error:opensky")
    revoked = psql(f"SELECT count(*) FROM ops_resolution WHERE id = {rid} AND revoked_at IS NOT NULL")[0][0] if rid else "0"
    for other in created[1:]:
        s.request("DELETE", f"/api/v1/ops/resolutions/{other}")
    sts2 = [r[0] for r in res2]
    ok = len(created) == n and len(aud_c) == n and sts2.count(204) == 1 and sts2.count(404) == n - 1 and len(aud_u) == 1 and revoked == "1"
    return {"ok": ok, "n": n, "create_statuses": codes([r[0] for r in res]), "resolve_audit": len(aud_c),
            "revoke_statuses": codes(sts2), "unresolve_audit": len(aud_u)}


def t_aggregate(s: OpsSession, n: int = 4) -> dict:
    day = (datetime.now(KST).date() - timedelta(days=1)).isoformat()
    t0 = db_now()
    t = time.time()
    res = parallel(n, lambda i: s.request("POST", f"/api/v1/ops/stats/aggregate?day={day}"))
    took = round(time.time() - t, 2)
    sts = [r[0] for r in res]
    bodies = [json.loads(r[2]).get("code") for r in res if r[0] != 200]
    aud = audit_since(t0, "STATS_AGGREGATE", day)
    markers = psql(f"SELECT dim, count(*) FROM stats_daily WHERE day = '{day}' AND metric = 'aggregated_at' GROUP BY dim")
    ok = 500 not in sts and sts.count(200) == len(aud) and all(int(c) == 1 for _, c in markers) and sts.count(200) >= 1
    return {"ok": ok, "n": n, "day": day, "statuses": codes(sts), "error_codes": bodies, "audit_rows": len(aud), "markers": markers, "took_s": took}


def lock_state(user: str) -> tuple[int, bool]:
    fc, locked = psql(f"SELECT failed_count, coalesce(locked_until > now(), false) FROM ops_user WHERE username = '{user}'")[0]
    return int(fc), locked == "t"


def unlock(user: str) -> None:
    psql(f"UPDATE ops_user SET failed_count = 0, locked_until = NULL WHERE username = '{user}'")


def wait_next_minute() -> None:
    """로그인 요청 제한(IP 당 분당 10 — 고정 분 창)을 새 창에서 시작한다."""
    time.sleep(61 - (time.time() % 60))


def t_lockout() -> dict:
    user = "qa-b"
    out: dict = {"ok": True, "cases": []}
    for n, expect_lock in ((4, False), (5, True), (8, True)):
        wait_next_minute()
        unlock(user)
        anon = OpsSession(BASE, None, login=False)
        t0 = db_now()
        res = parallel(n, lambda i: anon.request("POST", "/api/v1/ops/session", {"username": user, "password": f"wrong-password-{i:02d}-qa"}))
        sts = [r[0] for r in res]
        fc, locked = lock_state(user)
        failed = audit_since(t0, "LOGIN_FAILED", user)
        lockrows = audit_since(t0, "ACCOUNT_LOCKED", user)
        case = {"n": n, "statuses": codes(sts), "failed_count": fc, "locked": locked, "login_failed_audit": len(failed),
                "reasons": codes([f["after"].get("reason") for f in failed]), "account_locked_audit": len(lockrows)}
        good = all(c == 401 for c in sts) and len(failed) == n
        if expect_lock:
            good = good and locked and len(lockrows) == 1 and fc == 0
            st, _, _ = anon.request("POST", "/api/v1/ops/session", {"username": user, "password": password(user)})
            case["correct_password_while_locked"] = st
            good = good and st == 401
        else:
            good = good and not locked and len(lockrows) == 0 and fc == n
        case["ok"] = good
        out["ok"] = out["ok"] and good
        out["cases"].append(case)
        unlock(user)
    return out


def ws_open(origin: str) -> socket.socket:
    sk = socket.create_connection(("localhost", 8702), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (f"GET /ws/v1 HTTP/1.1\r\nHost: localhost:8702\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
           f"Sec-WebSocket-Version: 13\r\nOrigin: {origin}\r\n\r\n")
    sk.sendall(req.encode())
    return sk


def ws_status(sk: socket.socket) -> tuple[int, int | None]:
    """핸드셰이크 상태와(101 이면) 3 s 안에 온 닫기 프레임의 코드."""
    sk.settimeout(5)
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sk.recv(4096)
        if not chunk:
            break
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    status = int(head.split(b" ")[1]) if head else 0
    if status != 101:
        return status, None
    sk.settimeout(3)
    data = rest
    try:
        while len(data) < 4:
            more = sk.recv(4096)
            if not more:
                break
            data += more
    except TimeoutError:
        return status, None
    if len(data) >= 2 and (data[0] & 0x0F) == 0x8:
        ln = data[1] & 0x7F
        return status, int.from_bytes(data[2:4], "big") if ln >= 2 and len(data) >= 4 else 1005
    return status, None


def t_ws(n: int = 7) -> dict:
    socks = [ws_open(BASE) for _ in range(n)]
    out = [None] * n
    ths = []
    for i, sk in enumerate(socks):
        def run(i=i, sk=sk):
            out[i] = ws_status(sk)
        th = threading.Thread(target=run)
        th.start()
        ths.append(th)
        time.sleep(0.15)  # edge 의 WS 요청 제한(5 r/s, burst 10) 안
    for th in ths:
        th.join()
    for sk in socks:
        sk.close()
    open_ok = sum(1 for st, code in out if st == 101 and code is None)
    closed_1013 = sum(1 for st, code in out if st == 101 and code == 1013)
    ok = open_ok == 5 and closed_1013 == n - 5
    return {"ok": ok, "n": n, "results": out, "kept_open": open_ok, "closed_1013": closed_1013}


def t_client_errors(n: int = 30) -> dict:
    import urllib.error
    import urllib.request

    def post(i: int):
        body = json.dumps({"message": f"qa flood {time.time()} #{i}", "path": "/qa", "ts": datetime.now(timezone.utc).isoformat()}).encode()
        req = urllib.request.Request(BASE + "/api/v1/client-errors", data=body, method="POST", headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return r.status, r.headers.get("Retry-After")
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Retry-After")

    before = int(redis("XLEN", "wakeline:logs:client") or 0)
    wait_next_minute()
    res = parallel(n, post)
    time.sleep(2)
    after = int(redis("XLEN", "wakeline:logs:client") or 0)
    sts = [r[0] for r in res]
    ok = 500 not in sts and sts.count(204) <= 10 and all(r[1] for r in res if r[0] == 429) and sts.count(204) + sts.count(429) == n
    return {"ok": ok, "n": n, "statuses": codes(sts), "stream_growth": after - before}


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out_dir = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else "docs/qa/2026-10/evidence/reliability/concurrency"
    if "--out" in sys.argv:
        args = [a for a in args if a != out_dir]
    tests = args or ["settings", "providers", "resolutions", "aggregate", "ws", "client_errors", "lockout"]
    os.makedirs(out_dir, exist_ok=True)
    s = OpsSession(BASE, "qa-a") if set(tests) & {"settings", "providers", "resolutions", "aggregate"} else None
    for t in tests:
        fn = {"settings": lambda: t_settings(s), "providers": lambda: t_providers(s), "resolutions": lambda: t_resolutions(s),
              "aggregate": lambda: t_aggregate(s), "lockout": t_lockout, "ws": t_ws, "client_errors": t_client_errors}[t]
        r = fn()
        results[t] = r
        print(t, json.dumps(r, ensure_ascii=False, default=str))
        with open(os.path.join(out_dir, f"concurrency-{t}.json"), "w") as fh:
            json.dump(r, fh, ensure_ascii=False, indent=1, default=str)
    return 0 if all(r["ok"] for r in results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
