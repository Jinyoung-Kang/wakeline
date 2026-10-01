#!/usr/bin/env python3
"""QA 쓰기 경로 점검(QA 2026-10 §3.2 — 쓰기): POST /api/v1/client-errors 와 운영 쓰기(설정 PUT · 공급자 켜고 끔 · 해결 표시 · 통계 재집계)의
정상 · 경계 · 비정상 본문. 표준 라이브러리만, 격리 스택(8701 · 8702)만, 운영은 tools/qa/qa_session.py(시험 계정 qa-b).

스택 A 는 같이 쓰는 스택이라 상태를 바꾸지 않는 방법을 먼저 쓴다:
- 설정 값 범위는 일부러 틀린 If-Match(현재 version + 1000)로 보낸다 — 검증(SettingsService.validate)이 version 비교보다 먼저라서 범위 안 값은
  409 VERSION_MISMATCH, 범위 밖 값은 400 BAD_VALUE 로 갈린다. 아무것도 바뀌지 않는다.
- 성공 경로는 한 번씩만 하고 곧바로 되돌린다: 설정은 지금 값 그대로 다시 저장(값은 같고 version 만 오른다), 공급자는 fixture 모드에서 쓰지 않는
  opensky 를 끄고 바로 켠다, 해결 표시는 만들고 바로 되돌린다(행은 revoked 로 남는다 — 설계), 재집계는 어제(KST — 매일 03:30 에 어차피 다시 센다).
- /client-errors 는 IP 당 분당 10 건이라 사례 사이를 7 s 띄운다. 정상 보고 몇 건은 로그 스트림(wakeline:logs:client)에 'QA-func probe' 로 남는다.

    python3 tools/qa/write_probe.py [--skip-client-errors] [--skip-ops]   # → docs/qa/2026-10/evidence/functional/writes-<UTC>.md
"""

from __future__ import annotations

import argparse
import datetime as dt
import http.client
import json
import os
import sys
import time
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fuzz_api import OUT_DIR, PROBLEM_KEYS, RESERVE  # noqa: E402

rows = []


def record(area, name, expect, status, body, note=""):
    try:
        j = json.loads(body) if body else None
    except ValueError:
        j = None
    code = j.get("code") if isinstance(j, dict) else None
    ok = status in expect if isinstance(expect, (set, tuple, list)) else status == expect
    shape = ""
    if status >= 400 and status != 413 or (status == 413 and isinstance(j, dict)):
        if not (isinstance(j, dict) and all(k in j for k in PROBLEM_KEYS)):
            shape = "problem 모양 아님"
    rows.append({"area": area, "name": name, "expect": sorted(expect) if isinstance(expect, (set, tuple, list)) else expect, "status": status,
                 "code": code, "ok": ok and not shape, "note": (note + (" · " + shape if shape else "")).strip(" ·"),
                 "detail": (j or {}).get("detail") if isinstance(j, dict) else (body[:120].decode("utf-8", "replace") if isinstance(body, bytes) else None)})
    print(f"{'ok  ' if ok and not shape else 'FAIL'} {area} {name}: {status} {code or ''} {note} {shape}", file=sys.stderr)
    return j


def raw(base, method, path, body: bytes | None, headers: dict, chunked=False):
    u = urlparse(base)
    c = http.client.HTTPConnection(u.hostname, u.port, timeout=30)
    try:
        c.putrequest(method, path, skip_accept_encoding=True)
        for k, v in headers.items():
            c.putheader(k, v)
        if body is not None and not chunked:
            c.putheader("Content-Length", str(len(body)))
        if chunked:
            c.putheader("Transfer-Encoding", "chunked")
        c.endheaders()
        if body is not None:
            if chunked:
                for i in range(0, len(body), 1000):
                    part = body[i:i + 1000]
                    c.send(f"{len(part):x}\r\n".encode() + part + b"\r\n")
                c.send(b"0\r\n\r\n")
            else:
                c.send(body)
        r = c.getresponse()
        return r.status, dict(r.getheaders()), r.read()
    finally:
        c.close()


# ------------------------------------------------------------------ /client-errors

def client_errors(base):
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    def rep(**kw):
        d = {"message": "QA-func probe — ignore", "stack": None, "path": "/qa-probe", "component": "qa-func", "ts": now}
        d.update(kw)
        return {k: v for k, v in d.items() if v is not ...}

    J = {"Content-Type": "application/json", "User-Agent": "wakeline-qa-write/1"}
    # 8 KiB 를 넘는 본문(각 필드는 상한 안 — 413 이 크기 때문임을 보이게): 8,433 바이트
    big = (b'{"message":"x","path":"/","ts":"' + now.encode() + b'","stack":"' + b"s" * 7990 + b'","component":"' + b"c" * 150
           + b'","pad":"' + b"p" * 200 + b'"}')
    cases = [
        ("valid_minimal", J, json.dumps(rep()).encode(), 204, {}),
        ("ctype_text_plain", {**J, "Content-Type": "text/plain"}, json.dumps(rep()).encode(), 415, {}),
        ("ctype_missing", {"User-Agent": "x"}, json.dumps(rep()).encode(), 415, {}),
        ("ctype_charset", {**J, "Content-Type": "application/json; charset=utf-8"}, json.dumps(rep(message="QA-func probe — charset")).encode(), 204, {}),
        ("malformed_json", J, b'{"message": "x"', 400, {}),
        ("json_array", J, b"[]", 400, {}),
        ("json_null", J, b"null", 400, {}),
        ("empty_body", J, b"", 400, {}),
        ("message_empty", J, json.dumps(rep(message="")).encode(), 400, {}),
        ("message_number", J, json.dumps(rep(message=5)).encode(), 400, {}),
        ("message_2001", J, json.dumps(rep(message="m" * 2001)).encode(), 400, {}),
        ("message_missing", J, json.dumps(rep(message=...)).encode(), 400, {}),
        ("path_no_slash", J, json.dumps(rep(path="qa")).encode(), 400, {}),
        ("path_absolute_url", J, json.dumps(rep(path="https://evil.example/x")).encode(), 400, {}),
        ("path_301", J, json.dumps(rep(path="/" + "p" * 300)).encode(), 400, {}),
        ("ts_no_offset", J, json.dumps(rep(ts="2026-10-01T00:00:00")).encode(), 400, {}),
        ("ts_garbage", J, json.dumps(rep(ts="yesterday")).encode(), 400, {}),
        ("ts_year_max", J, json.dumps(rep(ts="+999999999-12-31T23:59:59Z", message="QA-func probe — ts max")).encode(), {204, 400}, {}),
        ("ts_year_min", J, json.dumps(rep(ts="-999999999-01-01T00:00:00Z", message="QA-func probe — ts min")).encode(), {204, 400}, {}),
        ("stack_8001", J, json.dumps(rep(stack="s" * 8001)).encode(), 400, {}),
        ("component_201", J, json.dumps(rep(component="c" * 201)).encode(), 400, {}),
        ("body_over_8192", J, big, 413, {}),
        ("body_over_8192_chunked", J, big, 413, {"chunked": True}),
        ("invalid_utf8", J, b'{"message":"\xff\xfe","path":"/","ts":"' + now.encode() + b'"}', 400, {}),
        ("deep_nesting", J, b'{"message":"x","path":"/","ts":"' + now.encode() + b'","x":' + b"[" * 2000 + b"]" * 2000 + b"}", 400, {}),
        ("body_2mb_edge", J, b'{"message":"' + b"m" * (2 * 1024 * 1024) + b'"}', 413, {}),
    ]
    for name, h, body, expect, opt in cases:
        st, hdrs, b = raw(base, "POST", "/api/v1/client-errors", body, h, chunked=opt.get("chunked", False))
        if st == 429:  # 다른 에이전트와 같은 IP — 창이 열릴 때까지 기다렸다 한 번 더
            time.sleep(int(hdrs.get("Retry-After", "30")) + 1)
            st, hdrs, b = raw(base, "POST", "/api/v1/client-errors", body, h, chunked=opt.get("chunked", False))
        edge = hdrs.get("Server", "").startswith("nginx") and "X-Request-Id" not in hdrs
        record("client-errors", name, expect, st, b if not edge else b"", "edge(nginx)" if edge else "")
        time.sleep(7)


# ------------------------------------------------------------------ 운영 쓰기

def ops_writes(base, user):
    from qa_session import OpsSession
    s = OpsSession(base, user)

    budget = {"remaining": 120, "reset": 60}

    def req(method, path, body=None, headers=None, raw_body=None, csrf=True):
        # /api/** IP 당 분당 120 을 다른 QA 에이전트와 나눠 쓴다 — 남은 수가 RESERVE 아래면 창이 바뀔 때까지 쉰다, 429 는 기다렸다 한 번 더
        if budget["remaining"] < RESERVE:
            time.sleep(budget["reset"] + 1)
        for attempt in range(2):
            st, h, b = s.request(method, path, body, headers, csrf=csrf, raw=raw_body)
            hl = {k.lower(): v for k, v in h.items()}
            try:
                budget["remaining"] = int(hl.get("x-ratelimit-remaining", budget["remaining"]))
                budget["reset"] = int(hl.get("x-ratelimit-reset", budget["reset"]))
            except ValueError:
                pass
            if st == 429 and attempt == 0:
                time.sleep(int(hl.get("retry-after", "30")) + 1)
                budget["remaining"] = 120
                continue
            break
        time.sleep(0.3)
        return st, h, b

    st, _, b = req("GET", "/api/v1/ops/settings")
    items = {i["key"]: i for i in json.loads(b)["items"]}
    rec = lambda name, expect, st, b, note="": record("settings", name, expect, st, b, note)  # noqa: E731

    def put(key, value, version, wrap=True, headers=None, raw_body=None):
        h = {"If-Match": f'"{version}"'} if version is not None else {}
        h.update(headers or {})
        return req("PUT", f"/api/v1/ops/settings/{key}", {"value": value} if wrap and raw_body is None else (value if raw_body is None else None),
                   h, raw_body=raw_body)

    bounds = {"region_poll_s": (5, 120), "global_poll_s": (60, 3600), "sigmet_poll_s": (60, 3600), "radar_poll_s": (30, 3600),
              "metar_poll_s": (300, 7200), "region_radius_nm": (50, 500)}
    for key, (lo, hi) in bounds.items():
        v = items[key]["version"] + 1000
        for val, exp in ((lo, 409), (hi, 409), (lo - 1, 400), (hi + 1, 400), (float(lo), 400), (str(lo), 400), (None, 400), (True, 400),
                         (2 ** 31, 400), (2 ** 63, 400), (10 ** 400, 400), ([lo], 400), ({"v": lo}, 400)):
            st, _, b = put(key, val, v)
            rec(f"{key}={str(val)[:20]}", exp, st, b)
    v = items["global_enabled"]["version"] + 1000
    for val, exp in ((True, 409), (False, 409), ("true", 400), (1, 400), (None, 400)):
        st, _, b = put("global_enabled", val, v)
        rec(f"global_enabled={val}", exp, st, b)
    v = items["aircraft_providers"]["version"] + 1000
    for val, exp in (("adsb_lol", 409), ("adsb_lol,adsb_fi,opensky", 409), ("opensky,opensky", 409), ("", 400), ("ADSB_LOL", 400), ("adsb_lol,", 400),
                     (" adsb_lol", 400), ("adsb_lol;opensky", 400), (["adsb_lol"], 400), ("x" * 6000, 400)):
        st, _, b = put("aircraft_providers", val, v)
        rec(f"aircraft_providers={val[:24] if isinstance(val, str) else val}", exp, st, b)
    v = items["region_center"]["version"] + 1000
    for val, exp in (("36.5,127.8", 409), ("-85,-180", 409), ("85,180", 409), (" 36.5 , 127.8 ", 409), ("85.0000001,0", 400), ("90,0", 400),
                     ("0,180.5", 400), ("36.5", 400), ("36.5,127.8,1", 400), ("1e1,2", 400), ("NaN,0", 400), ("36.123456789,1", 400),
                     ("٣٦,١٢٧", 400), ([36.5, 127.8], 400), ("", 400)):
        st, _, b = put("region_center", val, v)
        rec(f"region_center={str(val)[:24]}", exp, st, b)
    v = items["ais_bboxes"]["version"] + 1000
    box = "33,124,39,132"
    for val, exp in (("", 409), ("   ", 409), (box, 409), (";".join([box] * 16), 409), (";".join([box] * 17), 400), ("|".join([box] * 3), 409),
                     ("|".join([box] * 4), 400), (box + "|", 400), ("33,124,33,132", 400), ("91,124,39,132", 400), ("33,181,39,132", 400),
                     ("33.1234567,124,39,132", 400), ("1e1,124,39,132", 400), ("+33,124,39,132", 400), ("33,124,39", 400), (" " * 1025, 400),
                     (box + ";" * 1100, 400), (5, 400)):
        st, _, b = put("ais_bboxes", val, v)
        rec(f"ais_bboxes={str(val)[:28]}", exp, st, b)
    # 헤더 · 본문 형식
    k = "metar_poll_s"
    cur = items[k]
    st, _, b = put(k, cur["value"], None)
    rec("If-Match 없음 → 428", 428, st, b)
    for hv, exp in (('"abc"', 400), ("W/\"1\"", 400), ("99999999999", 400), ("-1", 409), ("*", 400), ('"1", "2"', 400)):
        st, _, b = req("PUT", f"/api/v1/ops/settings/{k}", {"value": cur["value"]}, {"If-Match": hv})
        rec(f"If-Match {hv}", exp, st, b)
    st, _, b = put("no_such_key", 5, 1)
    rec("모르는 키 → 404", 404, st, b)
    st, _, b = put("../settings", 5, 1)
    rec("키 '..' → 404", {400, 404}, st, b)
    st, _, b = req("PUT", f"/api/v1/ops/settings/{k}", None, {"If-Match": f'"{cur["version"] + 1000}"', "Content-Type": "application/json"}, raw_body=b"{")
    rec("본문 JSON 깨짐 → 400", 400, st, b)
    st, _, b = req("PUT", f"/api/v1/ops/settings/{k}", None, {"If-Match": f'"{cur["version"] + 1000}"', "Content-Type": "application/json"}, raw_body=b"")
    rec("본문 없음 → 400", 400, st, b)
    st, _, b = req("PUT", f"/api/v1/ops/settings/{k}", None, {"If-Match": f'"{cur["version"] + 1000}"', "Content-Type": "application/json"}, raw_body=b"null")
    rec("본문 null → 400", 400, st, b)
    st, _, b = req("PUT", f"/api/v1/ops/settings/{k}", None, {"If-Match": f'"{cur["version"] + 1000}"', "Content-Type": "text/plain"}, raw_body=b"600")
    rec("text/plain → 415", 415, st, b)
    st, _, b = req("PUT", f"/api/v1/ops/settings/{k}", None, {"If-Match": f'"{cur["version"] + 1000}"', "Content-Type": "application/json"},
                   raw_body=str(cur["value"]).encode())
    rec("값만(감싸지 않음) — 범위 안 → 409", 409, st, b)
    # 성공 한 번: 지금 값 그대로(값 불변 · version + 1) — 곧바로 같은 값이라 되돌릴 것이 없다
    st, _, b = put(k, cur["value"], cur["version"])
    j = rec("같은 값 저장 → 200 · mirrored", 200, st, b)
    if st == 200:
        record("settings", "응답 version = 이전 + 1 · 값 그대로 · mirrored", 200,
               200 if (j["version"] == cur["version"] + 1 and j["value"] == cur["value"] and j.get("mirrored") is True) else 0, b"",
               f"version {cur['version']} → {j.get('version')} · value {j.get('value')} · mirrored {j.get('mirrored')}")
        st, _, b = put(k, cur["value"], cur["version"])
        rec("옛 version 으로 다시 → 409", 409, st, b)

    # 공급자
    rp = lambda name, expect, st, b, note="": record("providers", name, expect, st, b, note)  # noqa: E731
    for path, exp in (("/api/v1/ops/providers/nope/disable", 404), ("/api/v1/ops/providers/opensky/explode", 404),
                      ("/api/v1/ops/providers/opensky/DISABLE", 404), ("/api/v1/ops/providers/OPENSKY/disable", 404),
                      ("/api/v1/ops/providers/opensky%2Fdisable/enable", {400, 404}), ("/api/v1/ops/providers/opensky/disable/extra", 404),
                      ("/api/v1/ops/providers/" + "x" * 3000 + "/disable", 404)):
        st, _, b = req("POST", path)
        rp(path[-60:], exp, st, b)
    st, _, b = req("GET", "/api/v1/ops/providers/opensky/disable")
    rp("GET 으로 → 405", {404, 405}, st, b)
    st, _, b = req("GET", "/api/v1/ops/providers")
    before = {p["provider"]: p for p in json.loads(b).get("provider_switch", [])} if st == 200 else {}
    was_disabled = before.get("opensky", {}).get("disabled", False)
    first, second = ("enable", "disable") if was_disabled else ("disable", "enable")
    st, _, b = req("POST", f"/api/v1/ops/providers/opensky/{first}")
    j = rp(f"opensky {first} → 200", 200, st, b)
    st2, _, b2 = req("POST", f"/api/v1/ops/providers/opensky/{first}")
    rp(f"opensky {first} 두 번째(이미 그 상태) → 200 · 같은 version?", 200, st2, b2,
       f"version {(j or {}).get('version')} → {(json.loads(b2) if st2 == 200 else {}).get('version')}")
    st, _, b = req("POST", f"/api/v1/ops/providers/opensky/{second}")
    rp(f"opensky {second}(되돌림) → 200", 200, st, b)
    # 안전망: 처음 상태로 돌아왔는지 확인하고, 아니면 되돌린다(같이 쓰는 스택)
    for _ in range(3):
        st, _, b = req("GET", "/api/v1/ops/providers")
        now_dis = {p["provider"]: p for p in json.loads(b).get("provider_switch", [])}.get("opensky", {}).get("disabled") if st == 200 else None
        if now_dis == was_disabled:
            break
        req("POST", f"/api/v1/ops/providers/opensky/{'disable' if was_disabled else 'enable'}")
        time.sleep(5)
    rp("opensky 처음 상태로 돌아옴", 200, 200 if now_dis == was_disabled else 0, b"", f"disabled={now_dis}")

    # 해결 표시
    rr = lambda name, expect, st, b, note="": record("resolutions", name, expect, st, b, note)  # noqa: E731
    up = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    bad = [
        ("빈 본문", b""), ("JSON 깨짐", b"{"), ("배열", b"[]"), ("null", b"null"), ("kind 없음", json.dumps({"key": "opensky"}).encode()),
        ("kind 틀림", json.dumps({"kind": "everything", "key": "opensky"}).encode()), ("key 없음", json.dumps({"kind": "provider_error"}).encode()),
        ("모르는 공급자", json.dumps({"kind": "provider_error", "key": "nope"}).encode()),
        ("공급자 대문자", json.dumps({"kind": "provider_error", "key": "OPENSKY"}).encode()),
        ("공급자 앞 공백", json.dumps({"kind": "provider_error", "key": " opensky"}).encode()),
        ("fp 대문자", json.dumps({"kind": "log_group", "key": "0123456789ABCDEF"}).encode()),
        ("fp 15자리", json.dumps({"kind": "log_group", "key": "0123456789abcde"}).encode()),
        ("모르는 필드", json.dumps({"kind": "provider_error", "key": "opensky", "all": True}).encode()),
        ("중복 필드", b'{"kind":"provider_error","key":"opensky","key":"awc"}'),
        ("upto 미래", json.dumps({"kind": "provider_error", "key": "opensky", "upto": "2099-01-01T00:00:00Z"}).encode()),
        ("upto 2000 전", json.dumps({"kind": "provider_error", "key": "opensky", "upto": "1999-12-31T23:59:59Z"}).encode()),
        ("upto 시간대 없음", json.dumps({"kind": "provider_error", "key": "opensky", "upto": "2026-10-01T00:00:00"}).encode()),
        ("upto 숫자", json.dumps({"kind": "provider_error", "key": "opensky", "upto": 1790000000}).encode()),
        ("upto 끝값", json.dumps({"kind": "provider_error", "key": "opensky", "upto": "+999999999-12-31T23:59:59-18:00"}).encode()),
        ("upto 처음값", json.dumps({"kind": "provider_error", "key": "opensky", "upto": "-999999999-01-01T00:00:00+18:00"}).encode()),
        ("note 201", json.dumps({"kind": "provider_error", "key": "opensky", "note": "n" * 201}).encode()),
        ("note 제어문자", json.dumps({"kind": "provider_error", "key": "opensky", "note": "a\nb"}).encode()),
        ("note 숫자", json.dumps({"kind": "provider_error", "key": "opensky", "note": 5}).encode()),
        ("본문 4097자", json.dumps({"kind": "provider_error", "key": "opensky", "note": " " * 4100}).encode()),
        ("깊은 중첩", b'{"kind":"provider_error","key":"opensky","note":' + b"[" * 1500 + b"]" * 1500 + b"}"),
    ]
    for name, body in bad:
        st, _, b = req("POST", "/api/v1/ops/resolutions", None, {"Content-Type": "application/json"}, raw_body=body)
        rr(name, 400, st, b)
    st, _, b = req("POST", "/api/v1/ops/resolutions", None, {"Content-Type": "text/plain"}, raw_body=json.dumps({"kind": "provider_error", "key": "opensky"}).encode())
    rr("text/plain → 415", 415, st, b)
    # 성공 → 곧바로 되돌림
    body = {"kind": "provider_error", "key": "opensky", "upto": up, "note": "QA-func probe — 곧 되돌림 ✓"}
    st, _, b = req("POST", "/api/v1/ops/resolutions", body)
    j = rr("만들기 → 201", 201, st, b)
    if st == 201:
        rid = j["id"]
        record("resolutions", "응답 upto = 보낸 값 · note 그대로", 200, 200 if (j["upto"].startswith(up[:19]) and j["note"] == body["note"]) else 0, b"",
               f"upto {j.get('upto')} · note {j.get('note')!r}")
        st, _, b = req("GET", "/api/v1/ops/resolutions")
        rr("목록에 보임", 200, st, b, "" if any(x["id"] == rid for x in json.loads(b)["items"]) else "목록에 없음")
        st, _, b = req("DELETE", f"/api/v1/ops/resolutions/{rid}")
        rr("되돌림 → 204", 204, st, b)
        st, _, b = req("DELETE", f"/api/v1/ops/resolutions/{rid}")
        rr("다시 되돌림 → 404", 404, st, b)
    # 안전망: 이 점검이 만든 해결 표시(note 'QA-func probe')가 남아 있으면 되돌린다
    st, _, b = req("GET", "/api/v1/ops/resolutions")
    for x in (json.loads(b)["items"] if st == 200 else []):
        if str(x.get("note") or "").startswith("QA-func probe"):
            req("DELETE", f"/api/v1/ops/resolutions/{x['id']}")
    for p, exp in (("abc", {404, 405}), ("-1", {404, 405}), ("1" * 19, {404, 405}), ("999999999999999999", 404), ("0", 404)):
        st, _, b = req("DELETE", f"/api/v1/ops/resolutions/{p}")
        rr(f"DELETE /{p[:20]}", exp, st, b)

    # 통계 재집계
    ra = lambda name, expect, st, b, note="": record("stats.aggregate", name, expect, st, b, note)  # noqa: E731
    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date()
    for q, exp in ((f"day={today.isoformat()}", 400), (f"day={(today + dt.timedelta(days=1)).isoformat()}", 400), ("day=garbage", 400),
                   ("day=2026-02-30", 400), ("day=%2B999999999-12-31", 400), ("day=-999999999-01-01", 400), ("day=%2B300000-01-01", 400),
                   ("day=-5000-01-01", 400), ("day=", {200, 400})):
        st, _, b = req("POST", f"/api/v1/ops/stats/aggregate?{q}")
        ra(q, exp, st, b)
    y = (today - dt.timedelta(days=1)).isoformat()
    st, _, b = req("POST", f"/api/v1/ops/stats/aggregate?day={y}")
    ra(f"day={y}(어제 KST) → 200", 200, st, b)
    st, _, b = req("POST", "/api/v1/ops/stats/aggregate", None, {"Content-Type": "application/json"}, raw_body=b'{"day":"2026-09-30"}')
    ra("본문 day(무시 — 쿼리만) → 어제", {200, 400}, st, b, (json.loads(b) if st == 200 else {}).get("day", ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8701")
    ap.add_argument("--user", default="qa-b")
    ap.add_argument("--skip-client-errors", action="store_true")
    ap.add_argument("--skip-ops", action="store_true")
    ap.add_argument("--out", default=OUT_DIR)
    a = ap.parse_args()
    if urlparse(a.base).port not in (8701, 8702):
        raise SystemExit("QA 는 격리 스택만")
    if not a.skip_ops:
        ops_writes(a.base, a.user)
    if not a.skip_client_errors:
        client_errors(a.base)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    md = os.path.join(a.out, f"writes-{stamp}.md")
    with open(md, "w") as f:
        f.write(f"# 쓰기 경로 점검 — {stamp}\n\n- 대상 {a.base} · 명령 `python3 tools/qa/write_probe.py` · 운영 계정 {a.user}\n\n"
                "| 영역 | 사례 | 기대 | 상태 | code | 결과 | 비고 · detail |\n|---|---|---|---|---|---|---|\n")
        for r in rows:
            f.write(f"| {r['area']} | {r['name'].replace('|', '/')} | {r['expect']} | {r['status']} | {r['code'] or ''} | {'통과' if r['ok'] else '**어긋남**'} | "
                    f"{(r['note'] + ' ' + str(r['detail'] or '')).replace('|', '/')[:200]} |\n")
    fails = [r for r in rows if not r["ok"]]
    print(f"done: {len(rows)} cases, {len(fails)} unexpected → {md}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
