"""QA 보안 점검(계획 §3.1): 세션 · 계정 — 격리 스택 A(8701)만.

- 두 계정(qa-a · qa-b): 한 운영자가 만든 해결 표시를 다른 운영자가 id 로 되돌릴 수 있는가(역할이 하나 — 설계 판단은 findings 에)
- 세션 고정: 다른 계정의 세션 쿠키 · 없는 id 를 심은 채 로그인하면 새 id 가 되고 심은 세션은 끝나는가
- CSRF 토큰이 로그인 때 바뀌는가 · 쿠키 속성(HttpOnly · SameSite · Path)
- 비밀번호 교체(CLI) 뒤 기존 세션이 모두 끝나는가 · 옛 비밀번호 401
- 잠금: 5회 실패 → 맞는 비밀번호도 401, 감사 ACCOUNT_LOCKED — 끝나면 CLI 로 풀어 둔다(비밀번호 재설정은 잠금도 푼다)
- 절대 수명(R-54): 세션의 로그인 시각(ops_auth_at)을 Redis 에서 9 h 전으로 바꾸면 다음 운영 요청이 404 인가
- 로그아웃은 그 세션만 끝내는가

시험 계정 qa-sec(이 점검 전용 — 비밀번호 교체 · 잠금으로 다른 QA 에이전트의 qa-a · qa-b 를 건드리지 않는다)은 0600 파일
QA_SEC_CREDS 에 있다. 비밀번호는 출력하지 않는다. 로그인 요청 제한(IP 분당 10, 다른 에이전트와 공유) 때문에 로그인 사이를 7 s 띄운다.

    python3 tools/qa/session_checks.py   # 기대와 다른 것이 있으면 종료 코드 1
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import struct
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import qa_session  # noqa: E402
from qa_session import OpsSession  # noqa: E402

BASE = "http://localhost:8701"
PROJECT = "wakeline-e2e"
SEC_CREDS = os.environ.get("QA_SEC_CREDS", os.path.join(os.path.dirname(qa_session.CREDS), "qa-creds-sec.json"))
OUT = os.environ.get("QA_EVIDENCE", os.path.join(os.path.dirname(__file__), "../../docs/qa/2026-10/evidence/security"))
LOG: list[dict] = []
FAIL: list[str] = []
_last_login = [0.0]


def note(what: str, ok: bool, **kw):
    LOG.append({"check": what, "ok": ok, **kw})
    print(("ok   " if ok else "FAIL ") + what + " " + json.dumps(kw, ensure_ascii=False))
    if not ok:
        FAIL.append(what)


def login_pause():
    wait = _last_login[0] + 7 - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    _last_login[0] = time.monotonic()


def sec_password() -> str:
    with open(SEC_CREDS) as f:
        return json.load(f)["users"]["qa-sec"]


def set_sec_password(pw: str) -> None:
    """CLI 로 qa-sec 비밀번호를 바꾼다(잠금도 풀린다). 0600 파일을 먼저 고친다."""
    fd = os.open(SEC_CREDS, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"note": "isolated QA stack A only (8701) — security agent test account", "users": {"qa-sec": pw}}, f)
    r = subprocess.run(["docker", "exec", "-i", "-e", "WAKELINE_OPS_USER=qa-sec", f"{PROJECT}-api-1", "java", "-jar", "/app/app.jar",
                        "--create-ops-user", "--password-stdin"], input=(pw + "\n").encode(), capture_output=True)
    out = (r.stdout + r.stderr).decode(errors="replace")
    assert pw not in out
    if r.returncode != 0:
        raise RuntimeError("ops-user failed rc=%d" % r.returncode)


def sec_session(password: str | None = None) -> OpsSession:
    login_pause()
    s = OpsSession(BASE, None, login=False)
    st, hd, body = s.request("POST", "/api/v1/ops/session", {"username": "qa-sec", "password": password or sec_password()})
    s.login_status = st  # type: ignore[attr-defined]
    s.login_headers = hd  # type: ignore[attr-defined]
    return s


def cookie(s: OpsSession, name: str) -> str | None:
    for c in s.jar:
        if c.name == name:
            return c.value
    return None


def redis_admin(*args: str, stdin: bytes | None = None) -> bytes:
    """스택 A redis 의 관리 사용자로 redis-cli(비밀번호는 컨테이너 자신의 환경 변수에서 — 출력하지 않는다)."""
    cmd = ["docker", "exec", "-i", f"{PROJECT}-redis-1", "sh", "-c", 'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli --no-auth-warning "$@"', "sh", *args]
    return subprocess.run(cmd, input=stdin, capture_output=True, check=True).stdout


def java_long(v: int) -> bytes:
    """java.lang.Long 의 JDK 직렬화 바이트(세션 속성 ops_auth_at 모양)."""
    return LONG_HEADER + struct.pack(">q", v)


LONG_HEADER = bytes.fromhex(
    "aced0005" "7372000e" + b"java.lang.Long".hex() + "3b8be490cc8f23df" "020001" "4a0005" + b"value".hex() +
    "78" "720010" + b"java.lang.Number".hex() + "86ac951d0b94e08b" "020000" "78" "70")


def audit_rows(s: OpsSession, n: int = 30) -> list[dict]:
    st, _, body = s.request("GET", f"/api/v1/ops/audit?limit={n}")
    return json.loads(body)["items"] if st == 200 else []


def main() -> int:
    # ---------------------------------------------------------------- A. 두 계정 — 해결 표시를 다른 운영자가 되돌린다
    login_pause()
    a = OpsSession(BASE, "qa-a")
    login_pause()
    b = OpsSession(BASE, "qa-b")
    fp = "0" + secrets.token_hex(8)[1:]  # 로그 묶음과 겹치지 않을 지문 모양(16자리 16진)
    st, _, body = a.request("POST", "/api/v1/ops/resolutions", {"kind": "log_group", "key": fp, "note": "qa-sec authz probe (fake fp)"})
    rid = json.loads(body).get("id") if st == 201 else None
    note("qa-a creates resolution", st == 201, status=st, id=rid, fp=fp)
    st, _, body = b.request("DELETE", f"/api/v1/ops/resolutions/{rid}")
    note("qa-b revokes qa-a's resolution (shared operator role)", True, status=st, observed="204=revoked by another operator" if st == 204 else body[:200].decode())
    rows = [r for r in audit_rows(a) if str(r.get("target", "")).endswith(fp)]
    note("audit shows RESOLVE by qa-a and UNRESOLVE by qa-b", any(r.get("action") == "UNRESOLVE" for r in rows),
         audit=[{k: r.get(k) for k in ("id", "action", "username", "target")} for r in rows])

    # ---------------------------------------------------------------- H. 쿠키 속성
    login_pause()
    x = OpsSession(BASE, None, login=False)
    st, hd, _ = x.request("POST", "/api/v1/ops/session", {"username": "qa-b", "password": qa_session.password("qa-b")})
    note("login 200 for qa-b", st == 200, status=st)
    sess_c = next((c for c in x.jar if c.name == "WAKELINE_SESSION"), None)
    csrf_c = next((c for c in x.jar if c.name == "WAKELINE_CSRF"), None)
    note("session cookie Path=/api", sess_c is not None and sess_c.path == "/api", path=getattr(sess_c, "path", None))
    note("session cookie HttpOnly", sess_c is not None and sess_c.has_nonstandard_attr("HttpOnly"), )
    note("session cookie SameSite=Strict", sess_c is not None and (sess_c.get_nonstandard_attr("SameSite") or "").lower() == "strict")
    note("csrf cookie SameSite=Strict, Path=/", csrf_c is not None and csrf_c.path == "/" and (csrf_c.get_nonstandard_attr("SameSite") or "").lower() == "strict")

    # ---------------------------------------------------------------- B. 세션 고정 · C. CSRF 회전
    attacker_sid = cookie(x, "WAKELINE_SESSION")
    victim = OpsSession(BASE, None, login=False)
    t0 = victim.csrf()
    import http.cookiejar as cj
    planted = cj.Cookie(0, "WAKELINE_SESSION", attacker_sid, None, False, "localhost.local", False, False, "/api", True, False, None, False, None, None, {"HttpOnly": None})
    victim.jar.set_cookie(planted)
    login_pause()
    st, _, body = victim.request("POST", "/api/v1/ops/session", {"username": "qa-sec", "password": sec_password()})
    new_sid = cookie(victim, "WAKELINE_SESSION")
    t1 = victim.csrf()
    note("victim login with planted attacker session cookie", st == 200, status=st)
    note("session id changed at login (fixation)", new_sid is not None and new_sid != attacker_sid)
    st2, _, body2 = victim.request("GET", "/api/v1/ops/session")
    note("victim session is qa-sec", st2 == 200 and json.loads(body2).get("username") == "qa-sec", status=st2)
    st3, _, _ = x.request("GET", "/api/v1/ops/session")
    note("attacker's planted session no longer valid", st3 == 404, status=st3)
    note("CSRF token rotated at login", t0 is not None and t1 is not None and t0 != t1)
    # 옛(로그인 전) 토큰 쌍을 그대로 실은 쓰기 — 쿠키 저장소가 새 값으로 바뀐 브라우저에서는 오지 않는 모양(정보)
    hdr = {"Cookie": f"WAKELINE_SESSION={new_sid}; WAKELINE_CSRF={t1}", "X-CSRF-Token": t0 or "", "Origin": BASE,
           "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", "If-Match": "0"}
    import urllib.request, urllib.error
    def put(h):
        try:
            with urllib.request.urlopen(urllib.request.Request(BASE + "/api/v1/ops/settings/region_poll_s", data=b'{"value":15}', method="PUT", headers=h), timeout=30) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code
    note("pre-login CSRF token rejected after login", put(hdr) == 403)
    # 없는 id 를 심고 로그인 → 심은 값이 아닌 새 id
    v2 = OpsSession(BASE, None, login=False)
    fake = base64.b64encode(b"11111111-2222-3333-4444-555555555555").decode()
    v2.jar.set_cookie(cj.Cookie(0, "WAKELINE_SESSION", fake, None, False, "localhost.local", False, False, "/api", True, False, None, False, None, None, {}))
    login_pause()
    st, _, _ = v2.request("POST", "/api/v1/ops/session", {"username": "qa-sec", "password": sec_password()})
    note("login with planted nonexistent session id gets a fresh id", st == 200 and cookie(v2, "WAKELINE_SESSION") not in (None, fake), status=st)

    # ---------------------------------------------------------------- F. 로그아웃은 그 세션만
    st, _, _ = v2.request("DELETE", "/api/v1/ops/session")
    note("logout v2", st == 204, status=st)
    st, _, _ = victim.request("GET", "/api/v1/ops/session")
    note("other session of the same user survives logout", st == 200, status=st)

    # ---------------------------------------------------------------- G. 절대 수명(R-54) — 로그인 시각을 9 h 전으로
    sid = base64.b64decode(cookie(victim, "WAKELINE_SESSION") + "==").decode()
    key = f"wakeline:session:sessions:{sid}"
    fields = redis_admin("HKEYS", key).decode().split()
    note("session hash has ops_auth_at", "sessionAttr:ops_auth_at" in fields, fields=fields)
    cur = redis_admin("HGET", key, "sessionAttr:ops_auth_at")
    note("serialized Long header matches the stored ops_auth_at", cur.startswith(LONG_HEADER), stored_len=len(cur))
    old = int((time.time() - 9 * 3600) * 1000)
    redis_admin("-x", "HSET", key, "sessionAttr:ops_auth_at", stdin=java_long(old))
    st, _, _ = victim.request("GET", "/api/v1/ops/providers")
    note("session older than 8 h (absolute) ends: 404", st == 404, status=st)
    note("expired session key removed from redis", redis_admin("EXISTS", key).strip() == b"0")

    # ---------------------------------------------------------------- D. 비밀번호 교체 → 기존 세션 모두 끝
    s1 = sec_session()
    s2 = sec_session()
    note("two qa-sec sessions", s1.login_status == 200 and s2.login_status == 200, s1=s1.login_status, s2=s2.login_status)
    old_pw = sec_password()
    set_sec_password(secrets.token_urlsafe(18))
    for i, s in enumerate((s1, s2), 1):
        st, _, _ = s.request("GET", "/api/v1/ops/providers")
        note(f"session {i} ends after password change", st == 404, status=st)
    s3 = sec_session(old_pw)
    note("old password rejected (401)", s3.login_status == 401, status=s3.login_status)
    s4 = sec_session()
    note("new password works", s4.login_status == 200, status=s4.login_status)

    # ---------------------------------------------------------------- E. 잠금 5회 → 맞는 비밀번호도 401
    statuses = []
    for _ in range(5):
        s = sec_session("wrong-password-" + secrets.token_hex(4))
        statuses.append(s.login_status)
    s5 = sec_session()
    note("5 failures then correct password is refused (locked)", statuses == [401] * 5 and s5.login_status == 401, failures=statuses, after=s5.login_status)
    rows = audit_rows(a, 20)
    acts = [r.get("action") for r in rows if r.get("target") == "qa-sec"]
    note("audit has ACCOUNT_LOCKED for qa-sec", "ACCOUNT_LOCKED" in acts, recent=acts[:8])
    # 풀기: 비밀번호 재설정(CLI)이 잠금을 푼다
    set_sec_password(secrets.token_urlsafe(18))
    s6 = sec_session()
    note("unlock via CLI reset", s6.login_status == 200, status=s6.login_status)
    s6.request("DELETE", "/api/v1/ops/session")
    for s in (a, b, x):
        s.request("DELETE", "/api/v1/ops/session")

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "session_checks.json"), "w") as f:
        json.dump(LOG, f, ensure_ascii=False, indent=1)
    print(f"checks={len(LOG)} failures={len(FAIL)}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
