"""QA 보안 점검(계획 §3.1): 운영 API 19개 경로의 인증 · 인가 · CSRF · Origin 표 — 격리 스택(8701 · 8702)만.

요청 표 → 기대 상태. 익명 · 위조 쿠키 · 로그아웃한 세션 · 다른 메서드 · 경로 속임수(%6Fps · // · ; · 끝 / · 대소문자 · ..)는
데이터(2xx)를 돌려받으면 안 되고, 세션이 있어도 CSRF · Origin 이 틀린 쓰기는 컨트롤러에 닿으면 안 된다.

쓰기 탐침은 닿아도 상태가 바뀌지 않는 요청을 쓴다: PUT /ops/settings/region_poll_s 에 맞지 않는 If-Match(0) → 컨트롤러에 닿으면 409
(VERSION_MISMATCH), 막히면 403/404. 공급자 끄기 같은 실제 변경은 보내지 않는다(공유 스택 A).

    python3 tools/qa/authz_matrix.py [http://localhost:8701]   # 기대와 다른 줄이 있으면 종료 코드 1
"""

from __future__ import annotations

import base64
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(__file__))
from qa_session import OpsSession as _OpsSession, _NoRedirect  # noqa: E402

# 스택 A 는 다른 QA 에이전트와 같은 IP(도커 게이트웨이)를 쓴다 — edge(초당 10)와 api(분당 120) 요청 제한을 나눠 쓰므로 천천히 보낸다.
PACE_S = float(os.environ.get("QA_PACE_S", "0.5"))
_last = [0.0]


def pace() -> None:
    wait = _last[0] + PACE_S - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    _last[0] = time.monotonic()


class OpsSession(_OpsSession):
    def request(self, *a, **k):
        pace()
        return super().request(*a, **k)

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8701"
YESTERDAY = (date.today() - timedelta(days=2)).isoformat()

# 운영 경로 19개(계획 §1). 쓰기는 닿아도 바뀌지 않는 값으로.
ROUTES: list[tuple[str, str, dict | None, dict | None]] = [
    ("POST", "/api/v1/ops/session", {"username": "qa-nobody", "password": "not-a-password-x"}, None),
    ("GET", "/api/v1/ops/session", None, None),
    ("DELETE", "/api/v1/ops/session", None, None),
    ("GET", "/api/v1/ops/providers", None, None),
    ("POST", "/api/v1/ops/providers/nosuch/disable", None, None),
    ("GET", "/api/v1/ops/runs", None, None),
    ("GET", "/api/v1/ops/quality", None, None),
    ("GET", "/api/v1/ops/dlq", None, None),
    ("GET", "/api/v1/ops/pipeline", None, None),
    ("GET", "/api/v1/ops/settings", None, None),
    ("PUT", "/api/v1/ops/settings/region_poll_s", {"value": 15}, {"If-Match": "0"}),
    ("GET", "/api/v1/ops/audit", None, None),
    ("POST", f"/api/v1/ops/stats/aggregate?day={date.today().isoformat()}", None, None),  # 오늘 = 400 BAD_DAY(닿으면) — 바뀌지 않음
    ("POST", "/api/v1/ops/resolutions", {"kind": "nope", "key": "x"}, None),  # 400 BAD_RESOLUTION(닿으면)
    ("GET", "/api/v1/ops/resolutions", None, None),
    ("DELETE", "/api/v1/ops/resolutions/999999999999", None, None),  # 404(닿으면 — 없는 id)
    ("GET", "/api/v1/ops/logs", None, None),
    ("GET", "/api/v1/ops/logs/groups", None, None),
    ("GET", "/api/v1/ops/logs/1-0", None, None),
]

results: list[dict] = []
failures: list[dict] = []


def raw(method: str, path: str, *, headers: dict | None = None, body: bytes | None = None, jar=None):
    pace()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar or http.cookiejar.CookieJar()), _NoRedirect)
    req = urllib.request.Request(BASE + path, data=body, method=method, headers=headers or {})
    t0 = time.monotonic()
    try:
        with opener.open(req, timeout=30) as r:
            return r.status, dict(r.headers), r.read(), time.monotonic() - t0
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read(), time.monotonic() - t0


def leaks_data(status: int, body: bytes) -> bool:
    if 200 <= status < 300:
        return True
    try:
        j = json.loads(body or b"{}")
    except ValueError:
        return False
    return isinstance(j, dict) and any(k in j for k in ("items", "providers", "username", "summary_24h", "rule_counts", "groups"))


def check(scn: str, method: str, path: str, status: int, body: bytes, allowed: set[int], note: str = ""):
    code = None
    try:
        code = json.loads(body).get("code")
    except Exception:
        pass
    ok = status in allowed and not (leaks_data(status, body) and not any(200 <= a < 300 for a in allowed))
    row = {"scenario": scn, "method": method, "path": path, "status": status, "code": code, "allowed": sorted(allowed), "ok": ok, "note": note}
    results.append(row)
    if not ok:
        failures.append(row)


def cookie_header(jar) -> str:
    return "; ".join(f"{c.name}={c.value}" for c in jar)


def main() -> int:
    # ---- 1. 익명(쿠키 없음): 읽기 404, 쓰기는 CSRF 가 먼저라 403(또는 404). 로그인은 없는 계정 → 401.
    for m, p, b, h in ROUTES:
        hdr = {"Accept": "application/json", **(h or {})}
        data = None
        if b is not None:
            data = json.dumps(b).encode()
            hdr["Content-Type"] = "application/json"
        st, _, body, _ = raw(m, p, headers=hdr, body=data)
        if p == "/api/v1/ops/session" and m == "POST":
            check("anon", m, p, st, body, {401, 429})
        else:
            check("anon", m, p, st, body, {404} if m == "GET" else {403, 404})

    # ---- 2. 익명 + CSRF 쌍(쿠키 + 헤더) — CSRF 를 통과해도 인가가 404
    anon = OpsSession(BASE, None, login=False)
    for m, p, b, h in ROUTES:
        if p == "/api/v1/ops/session" and m == "POST":
            continue
        st, _, body = anon.request(m, p, b, h)
        check("anon+csrf", m, p, st, body, {404})

    # ---- 3. 위조 세션 쿠키(없는 id · 깨진 base64 · 아주 긴 값)
    forged = [
        base64.b64encode(str(uuid.uuid4()).encode()).decode(),
        "not-base64-!!",
        "A" * 4000,
        base64.b64encode(b"../../etc/passwd").decode(),
    ]
    for fv in forged:
        for m, p, b, h in ROUTES[1:]:
            if m != "GET":
                continue
            st, _, body, _ = raw(m, p, headers={"Cookie": f"WAKELINE_SESSION={fv}", "Accept": "application/json"})
            check(f"forged:{fv[:12]}", m, p, st, body, {404, 400})

    # ---- 4. 로그인한 qa-a 의 세션: 정상 읽기 200 (기준선)
    a = OpsSession(BASE, "qa-a")
    for m, p, b, h in ROUTES:
        if m == "GET":
            st, _, body = a.request(m, p)
            check("qa-a", m, p, st, body, {200, 404} if p.endswith("/1-0") else {200})

    # ---- 5. 세션 있음 + CSRF 없음/틀림/_csrf 파라미터 → 403 CSRF_INVALID (컨트롤러에 닿으면 409)
    probe = ("PUT", "/api/v1/ops/settings/region_poll_s", {"value": 15}, {"If-Match": "0"})
    m, p, b, h = probe
    st, _, body = a.request(m, p, b, h, csrf=False)
    check("qa-a no-csrf", m, p, st, body, {403})
    st, _, body = a.request(m, p, b, {**h, "X-CSRF-Token": "wrong-" + str(uuid.uuid4())})
    check("qa-a wrong-csrf", m, p, st, body, {403})
    st, _, body = a.request(m, p + "?_csrf=" + (a.csrf() or ""), b, h, csrf=False)
    check("qa-a _csrf-query", m, p, st, body, {403})
    # 폼 본문의 _csrf(단순 요청 모양): 컨트롤러는 JSON 만 받지만 CSRF 가 먼저 막아야 한다
    st, _, body = a.request("POST", "/api/v1/ops/providers/nosuch/disable", None,
                            {"Content-Type": "application/x-www-form-urlencoded"}, csrf=False,
                            raw=f"_csrf={a.csrf()}".encode())
    check("qa-a _csrf-form", "POST", "/api/v1/ops/providers/nosuch/disable", st, body, {403})
    # 헤더 이름 변형(X-XSRF-TOKEN — Spring 기본 이름)
    st, _, body = a.request(m, p, b, {**h, "X-XSRF-TOKEN": a.csrf() or ""}, csrf=False)
    check("qa-a X-XSRF-TOKEN", m, p, st, body, {403})
    # 정상 CSRF 면 컨트롤러에 닿아 409(If-Match 0) — 탐침이 실제로 닿는 것을 보인다
    st, _, body = a.request(m, p, b, h)
    check("qa-a csrf-ok (reach)", m, p, st, body, {409})

    # ---- 6. Origin · Sec-Fetch-Site (세션 + 올바른 CSRF)
    for origin, site, allowed in [
        ("http://localhost:8799", "same-site", {403}),
        ("http://localhost:8799", None, {403}),
        (None, "same-site", {403}),
        (None, "cross-site", {403}),
        ("null", None, {403}),
        ("http://evil.example", "cross-site", {403}),
        ("http://localhost:8701.evil.example", None, {403}),
        ("http://LOCALHOST:8701", None, {403, 409}),  # 대소문자 — 브라우저는 소문자로 보낸다(정보)
        ("http://localhost:8701/", None, {403, 409}),
        (BASE, "same-origin", {409}),
        (BASE, "none", {403}),
    ]:
        hh = {**h, "Origin": origin} if origin else {**h}
        if site is not None:
            hh["Sec-Fetch-Site"] = site
        # OpsSession.request 는 Origin/Sec-Fetch-Site 를 기본으로 붙인다 — 없애야 하는 경우는 빈 값 대신 직접 보낸다
        hdr = {"Accept": "application/json", "Content-Type": "application/json", "X-CSRF-Token": a.csrf() or "",
               "Cookie": cookie_header(a.jar), **hh}
        st, _, body, _ = raw(m, p, headers=hdr, body=json.dumps(b).encode())
        check(f"qa-a origin={origin} site={site}", m, p, st, body, allowed)

    # ---- 7. 경로 속임수 — 익명은 데이터를 받지 않는다 · 세션은 CSRF/Origin 을 건너뛰지 못한다
    tricks = [
        "/api/v1/%6Fps/providers", "/api/v1/%6fps/providers", "/api/v1/o%70s/settings", "//api/v1/ops/providers",
        "/api//v1/ops/providers", "/api/v1/ops//providers", "/api/v1/ops/providers;jsessionid=abc", "/api/v1/ops;x=1/providers",
        "/api/v1/ops/providers/", "/api/v1/ops/settings/", "/API/v1/ops/providers", "/api/v1/OPS/providers", "/api/V1/ops/providers",
        "/api/v1/ops/./providers", "/api/v1/x/../ops/providers", "/api/v1/ops/%2e/providers", "/api/v1/ops%2fproviders",
        "/api/v1/ops/providers%00", "/api/v1/ops/providers%20", "/api/v1/ops/providers.json", "/api/v1/ops/providers?x=1",
        "/api/v1/ops/logs/groups/", "/api/v1/ops/logs/%31-0", "/api/v1/ops/%2e%2e/ops/providers", "/api/v1/ops/providers%2f",
        "/api/v1/ops/providers%23", "/api/v1/ops\\providers", "/api/v1/ops/audit;", "/api/./v1/ops/audit",
    ]
    for t in tricks:
        st, _, body, _ = raw("GET", t, headers={"Accept": "application/json"})
        check("anon trick", "GET", t, st, body, {400, 404, 405})
    write_tricks = [
        "/api/v1/%6Fps/settings/region_poll_s", "/api/v1/ops/settings/region_poll_s/", "/api/v1/OPS/settings/region_poll_s",
        "//api/v1/ops/settings/region_poll_s", "/api/v1/ops/settings/region_poll_s;x", "/api/v1/ops/./settings/region_poll_s",
        "/api/v1/ops/settings/%72egion_poll_s", "/api/v1/o%70s/settings/region_poll_s",
    ]
    for t in write_tricks:
        # 세션 + CSRF 없음 → 403(또는 경로 거절 400/404). 409 면 CSRF 를 건너뛰고 컨트롤러에 닿은 것
        st, _, body = a.request("PUT", t, b, h, csrf=False)
        check("qa-a no-csrf trick", "PUT", t, st, body, {400, 403, 404, 405})
        # 세션 + CSRF + 다른 출처 → 403(또는 400/404). 409 면 Origin 검사를 건너뛴 것
        hdr = {"Accept": "application/json", "Content-Type": "application/json", "X-CSRF-Token": a.csrf() or "",
               "Cookie": cookie_header(a.jar), "Origin": "http://localhost:8799", "Sec-Fetch-Site": "same-site", **h}
        st, _, body, _ = raw("PUT", t, headers=hdr, body=json.dumps(b).encode())
        check("qa-a cross-origin trick", "PUT", t, st, body, {400, 403, 404, 405})

    # ---- 8. 다른 메서드(익명) — 데이터 없음
    for p in ["/api/v1/ops/providers", "/api/v1/ops/settings", "/api/v1/ops/audit", "/api/v1/ops/logs", "/api/v1/ops/session", "/api/v1/ops/resolutions"]:
        for m in ["HEAD", "OPTIONS", "TRACE", "PATCH", "PUT", "DELETE", "POST", "PROPFIND", "FOO"]:
            st, hd, body, _ = raw(m, p, headers={"Accept": "application/json", "Origin": "http://evil.example",
                                                 "Access-Control-Request-Method": "POST"})
            check("anon method", m, p, st, body, {400, 403, 404, 405, 501, 401})
            if any(k.lower().startswith("access-control-allow") for k in hd):
                failures.append({"scenario": "anon method CORS", "method": m, "path": p, "status": st, "headers": {k: v for k, v in hd.items() if k.lower().startswith("access-control")}})
    # 세션이 있어도 HEAD/OPTIONS 는 쓰기 검사를 건너뛰는 길이 되지 않는다(본문 없음)
    for m in ["HEAD", "OPTIONS"]:
        st, hd, body = a.request(m, "/api/v1/ops/settings")
        results.append({"scenario": "qa-a method", "method": m, "path": "/api/v1/ops/settings", "status": st, "len": len(body), "ok": True})

    # ---- 9. 로그아웃 뒤 같은 쿠키 재사용 → 404
    time.sleep(7)  # 로그인 요청 제한(IP 분당 10 — 다른 QA 에이전트와 공유)
    c = OpsSession(BASE, "qa-a")
    saved = cookie_header(c.jar)
    st, _, body = c.request("GET", "/api/v1/ops/session")
    check("before-logout", "GET", "/api/v1/ops/session", st, body, {200})
    st, hd, body = c.request("DELETE", "/api/v1/ops/session")
    check("logout", "DELETE", "/api/v1/ops/session", st, body, {204})
    for m, p, b2, h2 in ROUTES[1:]:
        if m == "GET":
            st, _, body, _ = raw(m, p, headers={"Cookie": saved, "Accept": "application/json"})
            check("after-logout replay", m, p, st, body, {404})
    # 로그아웃 뒤 쓰기 재생(CSRF 값도 옛 값)
    tok = next((x.split("=", 1)[1] for x in saved.split("; ") if x.startswith("WAKELINE_CSRF=")), "")
    st, _, body, _ = raw("PUT", p := "/api/v1/ops/settings/region_poll_s", headers={"Cookie": saved, "X-CSRF-Token": tok, "Content-Type": "application/json",
                                                                                  "If-Match": "0", "Origin": BASE, "Sec-Fetch-Site": "same-origin"},
                         body=b'{"value":15}')
    check("after-logout write replay", "PUT", p, st, body, {403, 404})

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "authz_matrix.jsonl"), "w") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"rows={len(results)} failures={len(failures)}")
    for r in failures:
        print("FAIL", json.dumps(r, ensure_ascii=False))
    return 1 if failures else 0


OUT = os.environ.get("QA_EVIDENCE", os.path.join(os.path.dirname(__file__), "../../docs/qa/2026-10/evidence/security"))

if __name__ == "__main__":
    sys.exit(main())
