"""QA-001 재현(격리 스택 8701 · 8702만): 시간대가 있는 ISO 시각 · 날짜를 받는 공개 · 운영 조회 파라미터에 Postgres 범위를 벗어나는 값을
넣으면 400 이 아니라 500(INTERNAL)이 난다. Java 는 연도 ±999,999,999 까지 Instant · LocalDate 로 받아들이지만 Postgres timestamptz · date
의 상한(294276 AD)을 넘어, 값이 그대로 DB 에 가 DataIntegrityViolationException → ProblemAdvice 가 500 으로 남긴다(설계상 '결함일 수 있는' DB 오류).

기대: 400(BAD_REQUEST / 문제 응답) — 범위 밖 입력은 DB 에 닿기 전에 걸러야 한다.
실제: 500 INTERNAL + 서버 ERROR 로그(스택에 실패한 SQL). 응답 본문에 비밀값 · 스택은 없다(ProblemJson 일반 오류).

이 스크립트는 그 500 이 하나라도 나면 종료 코드 1 로 끝난다(결함이 남아 있음). 고치면 모두 400 이 되어 0.

    python3 tools/qa/qa_001_outofrange_time.py [http://localhost:8701]
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from qa_session import OpsSession  # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8701"

# (설명, 경로템플릿, 값) — 값은 하나만 범위 밖으로(나머지는 유효). 공개는 세션 없이, ops 는 qa-a 세션으로.
# 종류: ts = timestamptz(상한 294276 AD) · day = date(상한 5874897 AD). 둘 다 Java Instant · LocalDate 로는 유효하다.
# 넘는 값을 쓴다: ts 는 +300000년, day 는 +6000000년.
PUBLIC = [
    ("ais/gaps to", "/api/v1/ais/gaps?to={v}", "ts"),
    ("alerts/history to", "/api/v1/alerts/history?to={v}", "ts"),
    ("replay at", "/api/v1/replay?at={v}&bbox=126,33,130,38", "ts"),
    ("stats/alerts from", "/api/v1/stats/alerts?from={v}", "day"),
    ("stats/alerts to", "/api/v1/stats/alerts?to={v}", "day"),
    ("stats/traffic day", "/api/v1/stats/traffic?day={v}", "day_fin"),
    ("stats/sigmet from", "/api/v1/stats/sigmet?from={v}", "day"),
    ("stats/sigmet to", "/api/v1/stats/sigmet?to={v}", "day"),
]
OPS = [("ops/runs since", "/api/v1/ops/runs?since={v}", "ts")]
TS = "+300000-01-01T00:00:00Z"       # year 300000 > timestamptz 상한(294276 AD)
DAY = "+6000000-01-01"                # year 6000000 > date 상한(5874897 AD) — 부호(+)가 있어야 LocalDate 로 읽힌다
# LocalDate.MAX(+999999999)은 pgjdbc 가 date 'infinity' 로 보내 통과한다 — 유한한 범위 밖 값(+6000000)이라야 재현된다


def req(path: str, sess: OpsSession | None):
    time.sleep(0.6)
    if sess is not None:
        return sess.request("GET", path)[0:3:2]
    r = urllib.request.Request(BASE + path, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=30) as x:
            return x.status, x.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main() -> int:
    bad = []
    s = OpsSession(BASE, "qa-a")
    for label, tmpl, kind in PUBLIC + OPS:
        v = DAY if kind.startswith("day") else TS
        sess = s if label.startswith("ops") else None
        st, body = req(tmpl.format(v=urllib.parse.quote(v, safe="")), sess)
        code = None
        try:
            code = json.loads(body).get("code")
        except Exception:
            pass
        ok = st == 400
        print(f"{'ok  ' if ok else 'FAIL'} {label:22} {v:28} -> {st} {code}")
        if not ok:
            bad.append((label, v, st, code))
    s.request("DELETE", "/api/v1/ops/session")
    print(f"\n{len(bad)} endpoint(s) return non-400 on out-of-range time/date (expected 400)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
