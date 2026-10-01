#!/usr/bin/env python3
"""QA 도우미(백업 → 복원 대조): 격리 스택 B 의 wakeline DB 에서 public 표마다 정확한 행 수와 행 내용의 지문(md5 — 행 글자를 정렬해 이은 것)을 JSON 으로.

    python3 tools/qa/db_snapshot.py > before.json
    python3 tools/qa/db_snapshot.py --compare before.json after.json [--expect-empty 'track_point_2*,ship_position_2*']

ops_user 는 비밀번호 해시를 읽지 않는다(id · username · role · failed_count · locked_until 만). psql 은 db 컨테이너 안 로컬 소켓(비밀번호 없음).
비교: 같은 표의 수 · 지문이 다르거나, 한쪽에만 있는 표가 있으면 종료 코드 1. --expect-empty 의 표는 '복원본에서 0행' 이면 맞다(기본 백업이 원해상도 행을 빼므로).
"""

from __future__ import annotations

import fnmatch
import json
import subprocess
import sys

P = "wakeline-qa"
SAFE_COLUMNS = {"ops_user": "id, username, role, failed_count, locked_until"}


def psql(sql: str) -> list[list[str]]:
    out = subprocess.run(["docker", "exec", f"{P}-db-1", "psql", "-X", "-U", "postgres", "-d", "wakeline", "-At", "-F", "\t", "-c", sql],
                         check=True, capture_output=True, text=True).stdout
    return [line.split("\t") for line in out.splitlines() if line]


def snapshot() -> dict:
    tables = [r[0] for r in psql("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                                 "WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'spatial_ref_sys' ORDER BY 1")]
    out = {}
    for t in tables:
        cols = SAFE_COLUMNS.get(t, "x.*")
        src = f"(SELECT {cols} FROM public.{t}) x" if t in SAFE_COLUMNS else f"public.{t} x"
        n, md5 = psql(f"SELECT count(*), coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '-') FROM {src}")[0]
        out[t] = {"rows": int(n), "md5": md5}
    seq = psql("SELECT sequencename, coalesce(last_value, 0) FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1")
    out["_sequences"] = {s: int(v) for s, v in seq}
    out["_flyway"] = psql("SELECT max(version::int) FROM flyway_schema_history WHERE success")[0][0]
    return out


def compare(a: dict, b: dict, expect_empty: list[str]) -> int:
    bad = 0
    for t in sorted(set(a) | set(b)):
        if t.startswith("_"):
            if a.get(t) != b.get(t):
                print(f"DIFF {t}: {a.get(t)} -> {b.get(t)}")
                bad += 1
            continue
        if t not in a or t not in b:
            print(f"MISSING {t}: before={t in a} after={t in b}")
            bad += 1
            continue
        if any(fnmatch.fnmatch(t, p) for p in expect_empty):
            ok = b[t]["rows"] == 0
            print(f"{'ok  ' if ok else 'DIFF'} {t}: {a[t]['rows']} -> {b[t]['rows']} (원해상도 — 기본 백업은 행을 담지 않는다)")
            bad += not ok
            continue
        same = a[t] == b[t]
        print(f"{'ok  ' if same else 'DIFF'} {t}: rows {a[t]['rows']} -> {b[t]['rows']}  md5 {'same' if a[t]['md5'] == b[t]['md5'] else 'DIFFERENT'}")
        bad += not same
    return 1 if bad else 0


def main() -> int:
    if len(sys.argv) >= 4 and sys.argv[1] == "--compare":
        pats = sys.argv[sys.argv.index("--expect-empty") + 1].split(",") if "--expect-empty" in sys.argv else []
        return compare(json.load(open(sys.argv[2])), json.load(open(sys.argv[3])), pats)
    print(json.dumps(snapshot(), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
