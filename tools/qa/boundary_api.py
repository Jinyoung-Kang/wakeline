"""QA 보안 점검(계획 §3.1 입력 처리): 공개 · 운영 API 의 쿼리 · 경로 값에 경계 · 형식 오류 값을 넣어 처리되지 않은 오류를 찾는다.
값: 범위 밖 시각 · 날짜, 숫자 경계(NaN · Infinity · 아주 큰 수), 잘못된 bbox, 긴 글자, 비 ASCII, 빈 값.
후보: 500 · 내부 정보(예외 이름 · SQL 오류 글자 · 스택)가 응답 본문에 · 3 s 넘는 지연. 격리 스택(8701 · 8702)만.

공유 스택 A 의 api 요청 제한(IP 분당 120 — 다른 QA 에이전트와 같은 IP)을 다 쓰지 않게, 응답의 X-RateLimit-Remaining 이 60 아래면
다음 분까지 기다린다. 운영은 읽기만 보낸다.

    python3 tools/qa/boundary_api.py [http://localhost:8701]   # 후보가 있으면 종료 코드 1, 표는 evidence/security/boundary_api.jsonl
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from qa_session import OpsSession  # noqa: E402

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8701"
OUT = os.environ.get("QA_EVIDENCE", os.path.join(os.path.dirname(__file__), "../../docs/qa/2026-10/evidence/security"))
SLOW_S = 3.0
INTERNAL = re.compile(r"(Exception|org\.postgresql|org\.springframework|java\.lang|\.java:\d+|ERROR: |out of range)")

TIME = ["300000-01-01T00:00:00Z", "+300000-01-01T00:00:00Z", "-999999999-01-01T00:00:00Z", "+1000000000-12-31T23:59:59Z",
        "0000-01-01T00:00:00Z", "-0001-01-01T00:00:00Z", "1970-01-01T00:00:00Z", "2026-13-40T00:00:00Z", "2026-10-01", ""]
DATE = ["300000-01-01", "+300000-01-01", "-999999999-01-01", "+999999999-12-31", "0000-01-01", "-0001-01-01", "2026-02-30", ""]
NUM = ["-1", "0", "NaN", "Infinity", "1e309", "99999999999999999999", "2147483648", "1.5", ""]
BBOX = ["-180,-90,180,90", "NaN,NaN,NaN,NaN", "1e308,1e308,-1e308,-1e308", "1,2,3", "1,2,3,4,5", "0,0,0,0", "170,0,-170,10",
        "Infinity,0,1,1", "a,b,c,d", ""]
TEXT = ["A" * 300, "A" * 5000, "한글", "‮", "%", "'", ""]

rows: list[dict] = []
cands: list[dict] = []
_remaining = [120]


def pace() -> None:
    time.sleep(0.6)
    if _remaining[0] < 60:
        time.sleep(61 - time.time() % 60)
        _remaining[0] = 120


def q(v: str) -> str:
    return urllib.parse.quote(v, safe="")


def get(path: str, sess: OpsSession | None = None):
    pace()
    t0 = time.monotonic()
    if sess is not None:
        st, hd, body = sess.request("GET", path)
    else:
        req = urllib.request.Request(BASE + path, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                st, hd, body = r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            st, hd, body = e.code, dict(e.headers), e.read()
    dt = time.monotonic() - t0
    try:
        _remaining[0] = int(hd.get("X-RateLimit-Remaining", _remaining[0]))
    except ValueError:
        pass
    return st, body, dt


def probe(label: str, path: str, sess: OpsSession | None = None) -> None:
    st, body, dt = get(path, sess)
    if st == 429:  # 제한에 걸리면 한 번 더(다음 분)
        time.sleep(61 - time.time() % 60)
        st, body, dt = get(path, sess)
    text = body[:4000].decode("utf-8", "replace")
    code = None
    try:
        code = json.loads(body).get("code")
    except Exception:
        pass
    leak = INTERNAL.search(text) if st >= 400 else None
    row = {"label": label, "path": path[:300], "status": st, "code": code, "s": round(dt, 3), "leak": leak.group(0) if leak else None}
    rows.append(row)
    if st >= 500 or leak or dt > SLOW_S:
        row["body"] = text[:400]
        cands.append(row)
        print("CAND", json.dumps(row, ensure_ascii=False), flush=True)


def first(path: str):
    st, body, _ = get(path)
    try:
        j = json.loads(body)
    except ValueError:
        return None
    return j


def main() -> int:
    fc = first("/api/v1/aircraft?bbox=120,30,135,43") or {}
    hex_ = next((f["properties"]["hex"] for f in fc.get("features", [])), "780b7a")
    mmsi = "440999001"
    sig = first("/api/v1/sigmets?active=false") or {}
    sid = next((f.get("id") or f["properties"].get("id") for f in sig.get("features", [])), None) or "x"

    for v in TIME:
        probe("aircraft track from", f"/api/v1/aircraft/{hex_}/track?from={q(v)}")
        probe("aircraft track to", f"/api/v1/aircraft/{hex_}/track?to={q(v)}")
        probe("ship track from", f"/api/v1/ships/{mmsi}/track?from={q(v)}")
        probe("ship track to", f"/api/v1/ships/{mmsi}/track?to={q(v)}")
        probe("ais gaps from", f"/api/v1/ais/gaps?from={q(v)}")
        probe("ais gaps to", f"/api/v1/ais/gaps?to={q(v)}")
        probe("alerts history from", f"/api/v1/alerts/history?from={q(v)}")
        probe("alerts history to", f"/api/v1/alerts/history?to={q(v)}")
        probe("replay at", f"/api/v1/replay?at={q(v)}&bbox=126,33,130,38")
    for v in DATE:
        probe("stats sigmet from", f"/api/v1/stats/sigmet?from={q(v)}")
        probe("stats sigmet to", f"/api/v1/stats/sigmet?to={q(v)}")
        probe("stats traffic day", f"/api/v1/stats/traffic?day={q(v)}")
        probe("stats alerts from", f"/api/v1/stats/alerts?from={q(v)}")
        probe("stats alerts to", f"/api/v1/stats/alerts?to={q(v)}")
    for v in NUM:
        probe("aircraft track stepS", f"/api/v1/aircraft/{hex_}/track?stepS={q(v)}")
        probe("ships search limit", f"/api/v1/ships/search?q=44&limit={q(v)}")
        probe("alerts history limit", f"/api/v1/alerts/history?limit={q(v)}")
        probe("alerts history cursor", f"/api/v1/alerts/history?cursor={q(v)}")
    for v in BBOX:
        probe("aircraft bbox", f"/api/v1/aircraft?bbox={q(v)}")
        probe("ships bbox", f"/api/v1/ships?bbox={q(v)}")
        probe("sigmets bbox", f"/api/v1/sigmets?bbox={q(v)}")
        probe("airports bbox", f"/api/v1/airports?bbox={q(v)}")
        probe("replay bbox", f"/api/v1/replay?at=2026-10-01T12:00:00Z&bbox={q(v)}")
    for v in TEXT:
        probe("aircraft search q", f"/api/v1/aircraft/search?q={q(v)}")
        probe("ships search q", f"/api/v1/ships/search?q={q(v)}")
        probe("aircraft hex", f"/api/v1/aircraft/{q(v) or '-'}")
        probe("ships mmsi", f"/api/v1/ships/{q(v) or '-'}")
        probe("sigmet id", f"/api/v1/sigmets/{q(v) or '-'}")
        probe("airport wx", f"/api/v1/airports/{q(v) or '-'}/wx")
        probe("radar kr tm", f"/api/v1/radar/kr/{q(v) or '-'}.png")
        probe("alerts kind", f"/api/v1/alerts?kind={q(v)}")
        probe("alerts history hex", f"/api/v1/alerts/history?hex={q(v)}")
        probe("sigmets hazard", f"/api/v1/sigmets?hazard={q(v)}")
        probe("stats sigmet group", f"/api/v1/stats/sigmet?group={q(v)}")
        probe("aircraft detail param", f"/api/v1/aircraft?bbox=126,33,130,38&detail={q(v)}")
    probe("sigmet id (real)", f"/api/v1/sigmets/{q(str(sid))}")

    # 운영(읽기만) — 세션 qa-a
    s = OpsSession(BASE, "qa-a")
    for v in TIME:
        probe("ops runs since", f"/api/v1/ops/runs?since={q(v)}", s)
        probe("ops logs since", f"/api/v1/ops/logs?since={q(v)}", s)
        probe("ops logs until", f"/api/v1/ops/logs?until={q(v)}", s)
        probe("ops logs groups since", f"/api/v1/ops/logs/groups?since={q(v)}", s)
    for v in NUM:
        probe("ops runs limit", f"/api/v1/ops/runs?limit={q(v)}", s)
        probe("ops runs cursor", f"/api/v1/ops/runs?cursor={q(v)}", s)
        probe("ops quality days", f"/api/v1/ops/quality?days={q(v)}", s)
        probe("ops audit cursor", f"/api/v1/ops/audit?cursor={q(v)}", s)
        probe("ops audit limit", f"/api/v1/ops/audit?limit={q(v)}", s)
        probe("ops logs limit", f"/api/v1/ops/logs?limit={q(v)}", s)
    for v in TEXT:
        probe("ops runs job", f"/api/v1/ops/runs?job={q(v)}", s)
        probe("ops runs provider", f"/api/v1/ops/runs?provider={q(v)}", s)
        probe("ops runs status", f"/api/v1/ops/runs?status={q(v)}", s)
        probe("ops runs resolved", f"/api/v1/ops/runs?resolved={q(v)}", s)
        probe("ops logs q", f"/api/v1/ops/logs?q={q(v)}", s)
        probe("ops logs rid", f"/api/v1/ops/logs?rid={q(v)}", s)
        probe("ops logs fp", f"/api/v1/ops/logs?fp={q(v)}", s)
        probe("ops logs level", f"/api/v1/ops/logs?level={q(v)}", s)
        probe("ops logs service", f"/api/v1/ops/logs?service={q(v)}", s)
        probe("ops logs cursor", f"/api/v1/ops/logs?cursor={q(v)}", s)
        probe("ops logs id stream", f"/api/v1/ops/logs/1-0?stream={q(v)}", s)
    for v in ["99999999999999999999-0", "1-99999999999999999999", "18446744073709551615-18446744073709551615", "0-0"]:
        probe("ops logs id", f"/api/v1/ops/logs/{v}", s)
    s.request("DELETE", "/api/v1/ops/session")

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "boundary_api.jsonl"), "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"rows={len(rows)} candidates={len(cands)}")
    return 1 if cands else 0


if __name__ == "__main__":
    sys.exit(main())
