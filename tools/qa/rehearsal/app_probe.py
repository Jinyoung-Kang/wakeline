#!/usr/bin/env python3
"""QA 2026-10 AWS 리허설(R): RDS 흉내 위의 wakeline(wlqa-aws, edge 18710)이 '정상으로 뜨고 읽고 쓰는가'를 본다 — 복원 전후 같은 잣대.

    python3 -B tools/qa/rehearsal/app_probe.py probe [--wait 75] [--json 출력.json]   # 기대와 다르면 종료 코드 1
    python3 -B tools/qa/rehearsal/app_probe.py acl                                  # 소유자 · 권한 · SECURITY DEFINER 구조(값 아님) — 복원 전후 diff 용
    python3 -B tools/qa/rehearsal/app_probe.py acl-diff <원본> <복원본>                # 위 구조를 '소유자만 = NULL' 로 맞춘 뒤 비교(다르면 1)
    python3 -B tools/qa/rehearsal/app_probe.py rows                                 # 표마다 행 수(복원 전후 대조)

probe 가 보는 것:
  1) /healthz 와 공개 읽기 9경로(상태 코드) — 직접 edge(18710)로, 요청 수 적음
  2) 운영자 로그인(세션 임시 폴더 ops-creds.json — 출력 안 함) → 운영 읽기 3경로 (ops_user · audit_log 쓰기 포함)
  3) DB 쓰기: --wait 초 사이 api 가 쓰는 표(track_point · ship_position · aircraft · ship)와 collector 가 쓰는 표(ingest_run · provider_budget_day)의 증가
  4) 파티션 함수: track_point · ship_position 의 오늘 ~ +2일 파티션이 있는가, 함수 소유자 · SECURITY DEFINER · EXECUTE 권한
  5) api · collector 로그의 권한 오류(permission denied · 42501 · InsufficientPrivilege) 수 — 컨테이너 시작 이후
DB 는 RDS 흉내 안 로컬 소켓 슈퍼유저로 관찰만 한다(r.sh sql). 비밀번호는 출력하지 않는다.
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.environ.get("WLQA_R_DIR", "/private/tmp/claude-501/-Users-jinyoung-Projects-wakeline/3b40667d-7c26-4f92-9be9-6efb0a86ebea/scratchpad/qa/rehearsal")
BASE = "http://127.0.0.1:18710"
ORIGIN = "http://localhost:18710"
PUBLIC = ["/api/v1/status", "/api/v1/aircraft?bbox=124,33,132,39", "/api/v1/ships?bbox=124,33,132,39", "/api/v1/warnings", "/api/v1/warnings/history",
          "/api/v1/airspace", "/api/v1/alerts/history?limit=5", "/api/v1/stats/traffic", "/api/v1/sigmets"]
API_TABLES = ["track_point", "ship_position", "aircraft", "ship"]
COLLECTOR_TABLES = ["ingest_run", "provider_budget_day"]
PERM = r"permission denied|42501|InsufficientPrivilege|must be owner"


def sql(q: str, db: str = "wakeline") -> list[list[str]]:
    r = subprocess.run([os.path.join(HERE, "r.sh"), "sql", db, q], capture_output=True, text=True)
    if r.returncode != 0:
        raise subprocess.CalledProcessError(r.returncode, "r.sh sql", r.stdout, r.stderr.strip()[:300])
    out = r.stdout
    return [line.split("\t") for line in out.splitlines() if line]


def acl() -> str:
    q = """
    SELECT 'database', datname, pg_get_userbyid(datdba), coalesce(array_to_string(array(SELECT unnest(datacl)::text ORDER BY 1), ','), '-')
      FROM pg_database WHERE datname = 'wakeline'
    UNION ALL
    SELECT 'schema', nspname, pg_get_userbyid(nspowner), coalesce(array_to_string(array(SELECT unnest(nspacl)::text ORDER BY 1), ','), '-')
      FROM pg_namespace WHERE nspname = 'public'
    UNION ALL
    SELECT 'default-acl', coalesce(n.nspname, '*') || ' ' || d.defaclobjtype::text, pg_get_userbyid(d.defaclrole),
           coalesce(array_to_string(array(SELECT unnest(d.defaclacl)::text ORDER BY 1), ','), '-')
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
    UNION ALL
    SELECT 'rel:' || c.relkind::text, regexp_replace(c.relname, '_[0-9]{8}$', '_YYYYMMDD'), pg_get_userbyid(c.relowner),
           coalesce(array_to_string(array(SELECT unnest(c.relacl)::text ORDER BY 1), ','), '-')
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm') AND c.relname <> 'spatial_ref_sys'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
    UNION ALL
    SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_userbyid(p.proowner),
           (CASE WHEN p.prosecdef THEN 'SECURITY DEFINER ' ELSE '' END) || CASE WHEN p.proacl IS NULL THEN '(NULL = PUBLIC EXECUTE)' ELSE array_to_string(array(SELECT unnest(p.proacl)::text ORDER BY 1), ',') END
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
    ORDER BY 1, 2"""
    rows = sql(q)
    seen, out = set(), []
    for r in rows:  # 날짜 파티션은 이름을 접어 한 줄로(같은 구조면 같은 줄)
        line = "\t".join(r)
        if line not in seen:
            seen.add(line)
            out.append(line)
    return "\n".join(out) + "\n"


def normalize(line: str) -> str:
    """NULL 권한(소유자만 — 기본값)과 '소유자=모든 권한/소유자' 한 항목은 같은 뜻이다 — pg_dump 는 기본값과 같은 권한을 적지 않아 복원본은 NULL 이 된다."""
    p = line.split("\t")
    if len(p) == 4 and p[0].startswith("rel:"):
        owner, acl_ = p[2], p[3]
        full = {"rel:S": "rwU"}.get(p[0], "arwdDxtm")
        if acl_ in ("-", "", f"{owner}={full}/{owner}"):
            p[3] = "(owner only)"
    return "\t".join(p)


def acl_diff(a: str, b: str) -> int:
    import difflib
    la = [normalize(l) for l in open(a, encoding="utf-8").read().splitlines()]
    lb = [normalize(l) for l in open(b, encoding="utf-8").read().splitlines()]
    d = [l for l in difflib.unified_diff(la, lb, a, b, lineterm="", n=0) if not l.startswith("@@")]
    print("\n".join(d))
    return 1 if d else 0


def rows() -> dict:
    tables = [r[0] for r in sql("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                                "WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'spatial_ref_sys' ORDER BY 1")]
    q = " UNION ALL ".join(f"SELECT '{t}', count(*) FROM public.{t}" for t in tables)
    return {t: int(n) for t, n in sql(q)}


def http_req(opener, method: str, path: str, body=None, csrf_jar=None):
    h = {"Accept": "application/json, application/geo+json, application/problem+json"}
    data = None
    if method != "GET":
        h.update({"Origin": ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json"})
        tok = next((c.value for c in csrf_jar if c.name == "WAKELINE_CSRF"), None) if csrf_jar is not None else None
        if tok:
            h["X-CSRF-Token"] = tok
        data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with opener.open(req, timeout=20) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # noqa: BLE001
        return f"ERR {type(e).__name__}", b""


def container_started(name: str) -> str:
    return subprocess.run(["docker", "inspect", "-f", "{{.State.StartedAt}}", name], capture_output=True, text=True).stdout.strip()


def log_count(name: str, pattern: str) -> tuple[int, list[str]]:
    since = container_started(name)
    if not since:
        return -1, ["(컨테이너 없음)"]
    out = subprocess.run(["docker", "logs", "--since", since, name], capture_output=True, text=True)
    lines = [l for l in (out.stdout + out.stderr).splitlines() if __import__("re").search(pattern, l)]
    return len(lines), [l[:240] for l in lines[:6]]


def table_marks() -> dict:
    marks = {}
    for t in API_TABLES + COLLECTOR_TABLES:
        try:
            marks[t] = int(sql(f"SELECT count(*) FROM public.{t}")[0][0])
        except subprocess.CalledProcessError as e:
            marks[t] = f"ERR {e.stderr.strip()[:80]}"
    return marks


def probe(wait_s: int, json_out: str | None) -> int:
    res: dict = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    fail: list[str] = []
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    st, body = http_req(op, "GET", "/healthz")
    res["healthz"] = [st, body[:120].decode("utf-8", "replace")]
    if st != 200:
        fail.append(f"healthz {st}")
    res["public"] = {}
    for p in PUBLIC:
        st, body = http_req(op, "GET", p)
        res["public"][p] = st
        if st != 200:
            fail.append(f"GET {p} → {st}")
        time.sleep(0.2)
    # 운영자 로그인 — ops_user 읽기 · 쓰기(실패 횟수 · 마지막 로그인), audit_log 쓰기
    cred = json.load(open(os.path.join(R, "ops-creds.json")))
    http_req(op, "GET", "/api/v1/status")
    http_req(op, "GET", "/api/v1/ops/session")
    st, _ = http_req(op, "POST", "/api/v1/ops/session", {"username": cred["username"], "password": cred["password"]}, jar)
    res["ops_login"] = st
    if st != 200:
        fail.append(f"ops login → {st}")
    res["ops"] = {}
    for p in ["/api/v1/ops/providers", "/api/v1/ops/settings", "/api/v1/ops/audit"]:
        st, _ = http_req(op, "GET", p)
        res["ops"][p] = st
        if st != 200:
            fail.append(f"GET {p} → {st}")
    # DB 쓰기
    before = table_marks()
    time.sleep(wait_s)
    after = table_marks()
    res["writes"] = {t: [before[t], after[t]] for t in before}
    for t in ["track_point", "ship_position", "ingest_run"]:
        b, a = before[t], after[t]
        if not (isinstance(b, int) and isinstance(a, int) and a > b):
            fail.append(f"{t} 가 {wait_s}s 동안 늘지 않음 ({b} → {a})")
    # 파티션 함수
    res["partitions"] = sql("""
        SELECT p.relname, c.relname, pg_get_userbyid(c.relowner)
          FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
         WHERE p.relname IN ('track_point', 'ship_position')
           AND c.relname >= p.relname || '_' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD') ORDER BY 1, 2""")
    for parent in ("track_point", "ship_position"):
        mine = [r for r in res["partitions"] if r[0] == parent]
        if len(mine) < 3:
            fail.append(f"{parent} 의 오늘 ~ +2일 파티션 {len(mine)}개")
    res["functions"] = sql("""
        SELECT p.proname, pg_get_userbyid(p.proowner), p.prosecdef::text,
               CASE WHEN p.proacl IS NULL THEN '(NULL = PUBLIC EXECUTE)' ELSE array_to_string(array(SELECT unnest(p.proacl)::text ORDER BY 1), ',') END,
               has_function_privilege('wakeline_api', p.oid, 'EXECUTE')::text, has_function_privilege('wakeline_collector', p.oid, 'EXECUTE')::text
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname ~ '^(track_point|ship_position)_(ensure_partitions|drop_old)$' ORDER BY 1""")
    for name, owner, secdef, _acl, api_x, col_x in res["functions"]:
        if owner != "wakeline_migrator" or secdef != "true":
            fail.append(f"함수 {name}: 소유자 {owner} · SECURITY DEFINER {secdef}")
        if api_x != "true":
            fail.append(f"함수 {name}: wakeline_api 실행 권한 없음")
        if col_x != "false":
            fail.append(f"함수 {name}: wakeline_collector 도 실행할 수 있음(최소 권한 아님)")
    # 로그
    for name in ("wlqa-aws-api-1", "wlqa-aws-collector-1"):
        n, sample = log_count(name, PERM)
        res[f"perm_errors:{name}"] = {"count": n, "sample": sample}
        if n:
            fail.append(f"{name} 권한 오류 {n}줄")
    res["fail"] = fail
    print(json.dumps(res, ensure_ascii=False, indent=1))
    if json_out:
        with open(json_out, "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False, indent=1)
    print(("FAIL: " + " | ".join(fail)) if fail else "OK: 기동 · 공개 읽기 · 운영 로그인 · api/collector 쓰기 · 파티션 함수 모두 정상")
    return 1 if fail else 0


def main(argv: list[str]) -> int:
    cmd = argv[0] if argv else "probe"
    if cmd == "acl":
        sys.stdout.write(acl())
        return 0
    if cmd == "acl-diff":  # 정규화(소유자만 = NULL)한 뒤 비교 — 다르면 1
        return acl_diff(argv[1], argv[2])
    if cmd == "rows":
        print(json.dumps(rows(), indent=1, sort_keys=True))
        return 0
    wait_s = int(argv[argv.index("--wait") + 1]) if "--wait" in argv else 75
    json_out = argv[argv.index("--json") + 1] if "--json" in argv else None
    return probe(wait_s, json_out)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
