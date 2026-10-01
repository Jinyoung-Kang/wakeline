"""QA-002 재현(격리 스택 8701 · 8702만): 운영 조회 /api/v1/ops/runs 의 자유 글자 필터(job · provider · status)에 NUL 바이트(U+0000)를 넣으면
400 이 아니라 500(INTERNAL)이 난다. 이 값은 검증 없이 SQL 파라미터로 가, Postgres 가 'invalid byte sequence for encoding "UTF8": 0x00' 로
거부한다(DataIntegrityViolationException → ProblemAdvice 가 500). 공개 검색(/ships/search · /aircraft/search)은 q 를 검증해 같은 입력을 400 으로 막는다.

기대: 400(BAD_REQUEST) — NUL 은 DB 에 닿기 전에 걸러야 한다. 실제: 500 INTERNAL + 서버 ERROR 로그(실패한 SQL). 운영 세션이 필요하다(qa-a).

NUL 이 든 요청이 하나라도 500 이면 종료 코드 1. 고치면 400 이 되어 0.

    python3 tools/qa/qa_002_nul_ops_runs.py [http://localhost:8701]
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(__file__))
from qa_session import OpsSession  # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8701"
NUL = urllib.parse.quote("a\x00b")


def main() -> int:
    s = OpsSession(BASE, "qa-a")
    bad = []
    for p in ("job", "provider", "status"):
        time.sleep(0.6)
        st, _, body = s.request("GET", f"/api/v1/ops/runs?{p}={NUL}")
        code = None
        try:
            code = json.loads(body).get("code")
        except Exception:
            pass
        ok = st == 400
        print(f"{'ok  ' if ok else 'FAIL'} ops/runs {p}=a\\x00b -> {st} {code}")
        if not ok:
            bad.append((p, st, code))
    s.request("DELETE", "/api/v1/ops/session")
    print(f"\n{len(bad)} ops/runs filter(s) return non-400 on a NUL byte (expected 400)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
