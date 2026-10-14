#!/usr/bin/env python3
"""QA 2026-10 AWS 리허설(R) 항목 4 · 5: 앞단(Caddy :8103 → gate → wakeline edge 18710)의 경로 차단과 응답 헤더 — 평범한 요청 몇 개만.

    python3 -B tools/qa/rehearsal/front_check.py [증거.json]      # 기대와 다르면 종료 코드 1

하는 일(요청 약 30개, 사이 0.3 s — 우회 시도 · 대량 요청 · gate 시도 제한 시험은 하지 않는다):
  1) 비밀 헤더(X-Origin-Verify) 없이 GET / → 403(CloudFront 를 거치지 않은 요청), 있어도 잠금 쿠키가 없으면 401(잠금화면 · JSON)
  2) 접근 코드로 한 번 잠금 해제(POST /__gate/unlock) → 쿠키
  3) 쿠키로 /ops · /ops/x · /logs · /logs/x · /api/v1/ops/session(GET · POST) → 404 이고 본문이 Caddy 의 것(앱까지 가지 않음)
     공개 경로(/ · /replay · /stats · /about · /guide · /m · /airports/RKSI · /api/v1/status · /api/v1/aircraft · /api/v1/warnings · /_next/static/… · /healthz) → 통과(200)
  4) 모든 응답의 보안 헤더(HSTS · CSP · X-Frame-Options · nosniff · Referrer-Policy · Server · X-Robots-Tag · Permissions-Policy · COOP)가 한 번씩만인지,
     같은 경로를 edge(18710)에 직접 물어 어느 층이 붙였는지 대조한다.
비밀값(ORIGIN_SECRET · 접근 코드 · 쿠키)은 출력 · 기록하지 않는다(세션 임시 폴더의 front.env · gate-code 에서 읽음).
"""
from __future__ import annotations

import http.client
import json
import os
import re
import sys
import time
import urllib.parse

R = os.environ.get("WLQA_R_DIR", "/private/tmp/claude-501/-Users-jinyoung-Projects-wakeline/3b40667d-7c26-4f92-9be9-6efb0a86ebea/scratchpad/qa/rehearsal")
FRONT = ("127.0.0.1", 8103)
EDGE = ("127.0.0.1", 18710)
WATCH = ["strict-transport-security", "content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "server",
         "x-robots-tag", "permissions-policy", "cross-origin-opener-policy", "x-powered-by"]
CADDY_404 = "데모에서는 쓸 수 없는 경로입니다"


def env_value(path: str, key: str) -> str:
    for line in open(path, encoding="utf-8"):
        if line.startswith(key + "="):
            return line.split("=", 1)[1].strip()
    raise SystemExit(f"없음: {key}")


ORIGIN_SECRET = env_value(f"{R}/front.env", "ORIGIN_SECRET")
CODE = open(f"{R}/gate-code", encoding="utf-8").read().strip()
LOG: list[dict] = []
FAIL: list[str] = []


def req(target, method: str, path: str, *, headers: dict | None = None, body: bytes | None = None):
    time.sleep(0.3)
    c = http.client.HTTPConnection(*target, timeout=30)
    h = {"Host": f"localhost:{target[1]}", "Accept-Encoding": "identity", **(headers or {})}
    c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
    for k, v in h.items():
        c.putheader(k, v)
    if body is not None:
        c.putheader("Content-Length", str(len(body)))
    c.endheaders(body)
    r = c.getresponse()
    data = r.read()
    hd: dict[str, list[str]] = {}
    for k, v in r.getheaders():
        hd.setdefault(k.lower(), []).append(v)
    c.close()
    return r.status, hd, data


def note(what: str, ok: bool, **kw) -> None:
    LOG.append({"check": what, "ok": ok, **kw})
    print(("ok   " if ok else "FAIL ") + what + ("  " + json.dumps(kw, ensure_ascii=False)[:300] if kw else ""))
    if not ok:
        FAIL.append(what)


def summary(hd: dict) -> dict:
    out = {}
    for k in WATCH:
        if k in hd:
            vals = hd[k]
            out[k] = [v if k != "content-security-policy" else (v[:60] + "…") for v in vals]
    return out


def main() -> int:
    out_path = sys.argv[1] if len(sys.argv) > 1 else None
    secret = {"X-Origin-Verify": ORIGIN_SECRET}
    # 1) 비밀 헤더 없음 → 403, 잠금 쿠키 없음 → 401
    st, hd, _ = req(FRONT, "GET", "/")
    note("비밀 헤더 없음 GET / → 403", st == 403, status=st)
    st, hd, body = req(FRONT, "GET", "/api/v1/status", headers={**secret, "Accept": "application/json"})
    note("잠금 쿠키 없음 GET /api/v1/status → 401", st == 401, status=st, body=body[:80].decode("utf-8", "replace"))
    st, hd, body = req(FRONT, "GET", "/ops", headers={**secret, "Accept": "text/html"})
    note("잠금 쿠키 없음 GET /ops → 401 잠금화면", st == 401, status=st)
    # 2) 잠금 해제 한 번
    form = urllib.parse.urlencode({"code": CODE, "next": "/"}).encode()
    st, hd, _ = req(FRONT, "POST", "/__gate/unlock", headers={**secret, "Content-Type": "application/x-www-form-urlencoded"}, body=form)
    m = re.match(r"([^=;]+)=([^;]*)", (hd.get("set-cookie") or [""])[0])
    note("잠금 해제 POST /__gate/unlock → 303 + 쿠키", st == 303 and bool(m), status=st, cookie_name=m.group(1) if m else None)
    if not m:
        return finish(out_path)
    cookie = {"Cookie": f"{m.group(1)}={m.group(2)}"}
    auth = {**secret, **cookie}

    # 3-a) 운영 경로 → Caddy 404
    blocked = [("GET", "/ops"), ("GET", "/ops/"), ("GET", "/ops/settings"), ("GET", "/logs"), ("GET", "/logs/abc"),
               ("GET", "/api/v1/ops/session"), ("GET", "/api/v1/ops/providers"), ("POST", "/api/v1/ops/session"), ("GET", "/api/v1/ops")]
    for method, path in blocked:
        body = b'{"username":"x","password":"y"}' if method == "POST" else None
        h = {**auth, "Accept": "text/html" if not path.startswith("/api") else "application/json"}
        if body:
            h["Content-Type"] = "application/json"
        st, hd, data = req(FRONT, method, path, headers=h, body=body)
        text = data.decode("utf-8", "replace")
        note(f"{method} {path} → 404 (Caddy 가 닫음)", st == 404 and CADDY_404 in text, status=st,
             content_type=(hd.get("content-type") or [None])[0], body=text[:80], headers=summary(hd))

    # 3-b) 공개 경로 → 통과
    st, hd, data = req(FRONT, "GET", "/", headers={**auth, "Accept": "text/html"})
    chunk = re.search(r'/_next/static/[^"\']+\.js', data.decode("utf-8", "replace"))
    public = ["/", "/replay", "/stats", "/about", "/guide", "/m", "/airports/RKSI", "/api/v1/status", "/api/v1/aircraft?bbox=124,33,132,39",
              "/api/v1/warnings", "/healthz"] + ([chunk.group(0)] if chunk else [])
    rows = []
    for path in public:
        accept = "*/*" if path.startswith(("/api", "/healthz", "/_next")) else "text/html"
        st, hd, _ = req(FRONT, "GET", path, headers={**auth, "Accept": accept})
        est, ehd, _ = req(EDGE, "GET", path, headers={"Accept": accept})
        dup = {k: len(v) for k, v in hd.items() if k in WATCH and len(v) > 1}
        rows.append({"path": path, "front": st, "edge": est, "front_headers": summary(hd), "edge_headers": summary(ehd)})
        note(f"GET {path} → 통과 {st}", st == 200, edge=est)
        note(f"GET {path}: 보안 헤더가 한 번씩만", not dup, duplicated=dup, headers=summary(hd))
        note(f"GET {path}: HSTS 한 번 · Server 없음 · X-Robots-Tag 한 번",
             len(hd.get("strict-transport-security", [])) == 1 and "server" not in hd and len(hd.get("x-robots-tag", [])) == 1,
             hsts=hd.get("strict-transport-security"), server=hd.get("server"))
        if accept == "text/html":
            csp = (hd.get("content-security-policy") or [""])[0]
            note(f"GET {path}: CSP 한 번 · frame-ancestors 'none' · X-Frame-Options DENY 한 번",
                 len(hd.get("content-security-policy", [])) == 1 and "frame-ancestors 'none'" in csp and hd.get("x-frame-options") == ["DENY"],
                 csp_count=len(hd.get("content-security-policy", [])), xfo=hd.get("x-frame-options"))
        if path != "/healthz":
            note(f"GET {path}: nosniff · Referrer-Policy 한 번",
                 hd.get("x-content-type-options") == ["nosniff"] and len(hd.get("referrer-policy", [])) == 1,
                 nosniff=hd.get("x-content-type-options"), referrer=hd.get("referrer-policy"))
    LOG.append({"compare_front_vs_edge": rows})
    return finish(out_path)


def finish(out_path: str | None) -> int:
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({"checks": LOG, "fail": FAIL}, f, ensure_ascii=False, indent=1)
    print(f"\n{len(FAIL)} FAIL" if FAIL else "\nall ok")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
