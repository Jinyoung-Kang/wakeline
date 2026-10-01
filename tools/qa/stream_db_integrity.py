#!/usr/bin/env python3
"""QA 점검(신뢰성 · 데이터 무결성): Redis 스트림에 발행된 엔트리 ↔ PostgreSQL 에 저장된 행을 한 시간 창에서 대조한다 — 격리 스택 B(wakeline-qa) 전용.

불변식(설계: ingest.StreamConsumer · aircraft.data.TrackWriter · ships.data.ShipWriter · platform.data.OrderedWriter):
- 항적: 창 안 wakeline:aircraft 엔트리(DLQ 로 간 것 제외)의 모든 상태 (hex, seen_at) 가 track_point 에 있다(PK (hex, ts) — 중복은 구조상 없다).
  focus 엔트리는 requested 에 든 hex 만(api 가 나머지를 버린다).
- 선박: 창 안 wakeline:ships(kind=ships) 보고의 (mmsi, 60 s 창) 가운데 MMSI 별로 처음 나타난(단조 증가) 창마다 ship_position 에 정확히 한 행.
  늦게 온(이미 더 뒤 창을 고른 뒤) 보고의 창은 설계상 건너뛸 수 있다 — '설계상 건너뜀' 으로 따로 센다. 한 창에 두 행 이상 = 중복.
- SIGMET: 창 안 wakeline:sigmet 세트의 모든 id 가 sigmet 표에 있다.
- 공백: 창 안 ais_gap 의 (scope, started_at) 이 ingest_gap 에 있다.
- 소비 그룹 api: 창 끝 이전 엔트리가 PEL 에 남지 않는다(회복 뒤 다 ACK — 기다림 상한 --settle-s).
결함(손실 · 중복 · 남은 pending)이 하나라도 있으면 종료 코드 1. 지표(api 관리 포트 — 컨테이너 안에서 curl)로 버림(dropped · failed · forced)도 함께 적는다.

    python3 tools/qa/stream_db_integrity.py --since-ms 1790875000000 --until-ms 1790875600000 [--warmup-s 180] [--json out.json]

비밀값: redis-cli · psql 은 각 컨테이너 안에서 그 컨테이너의 환경 · 로컬 소켓으로 돈다(chaos.sh 와 같다) — 비밀번호가 이 호스트의 명령행에 나오지 않는다.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import subprocess
import sys
import time
from collections import Counter, defaultdict
from datetime import UTC, datetime

PROJECT = "wakeline-qa"
ALLOWED_PROJECTS = {"wakeline-qa"}
WINDOW_S = 60
KEEP_PAST_S = 24 * 3600
KEEP_FUTURE_S = 5 * 60
STREAMS = ["wakeline:aircraft", "wakeline:sigmet", "wakeline:radar", "wakeline:ships"]
METRICS = (
    "wakeline_track_rows_total",
    "wakeline_ship_rows_total",
    "wakeline_persist_tasks_total",
    "wakeline_stream_messages_total",
    "wakeline_track_receipts_forced_total",
    "wakeline_ship_receipts_forced_total",
    "wakeline_stream_trim_loss_events_total",
    "wakeline_stream_unacked",
    "wakeline_track_queue",
    "wakeline_ship_queue",
    "wakeline_persist_queue",
)


def c(svc: str) -> str:
    return f"{PROJECT}-{svc}-1"


def redis_json(*args: str):
    out = subprocess.run(
        ["docker", "exec", c("redis"), "sh", "-c", 'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli --no-auth-warning --json "$@"', "sh", *args],
        check=True, capture_output=True, text=True,
    ).stdout
    return json.loads(out) if out.strip() else None


def psql_rows(sql: str) -> list[list[str]]:
    out = subprocess.run(
        ["docker", "exec", c("db"), "psql", "-X", "-U", "postgres", "-d", "wakeline", "-At", "-F", "\t", "-c", "SET TIME ZONE 'UTC'", "-c", sql],
        check=True, capture_output=True, text=True,
    ).stdout
    return [line.split("\t") for line in out.splitlines() if line and line != "SET"]


def metrics() -> dict[str, float]:
    """api 관리 포트(9000)의 지표 가운데 무결성에 닿는 것만(컨테이너 안에서 — 호스트에 게시되지 않는다)."""
    try:
        out = subprocess.run(["docker", "exec", c("api"), "curl", "-s", "-m", "5", "http://localhost:9000/actuator/prometheus"],
                             check=True, capture_output=True, text=True).stdout
    except subprocess.CalledProcessError:
        return {}
    m: dict[str, float] = {}
    for line in out.splitlines():
        if line.startswith("#"):
            continue
        name = line.split("{", 1)[0].split(" ", 1)[0]
        if name in METRICS:
            k, _, v = line.rpartition(" ")
            try:
                m[k] = float(v)
            except ValueError:
                pass
    return m


def entries(stream: str, start: str, end: str) -> list[tuple[str, dict[str, str]]]:
    out: list[tuple[str, dict[str, str]]] = []
    cursor = start
    while True:
        page = redis_json("XRANGE", stream, cursor, end, "COUNT", "200") or []
        for eid, flat in page:
            out.append((eid, dict(zip(flat[::2], flat[1::2], strict=False))))
        if len(page) < 200:
            return out
        ms, seq = page[-1][0].split("-")
        cursor = f"{ms}-{int(seq) + 1}"


def payload(f: dict[str, str]) -> dict:
    return json.loads(gzip.decompress(base64.b64decode(f["payload"])))


def iso_us(s: str) -> str:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")


def epoch_s(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def group_state(until_ms: int) -> dict[str, dict]:
    """소비 그룹 api 의 상태 + 창 끝(until) 이전 엔트리 가운데 아직 PEL 에 남은 것(old_pending — 회복 뒤에도 남으면 결함)."""
    st = {}
    for s in STREAMS:
        groups = redis_json("XINFO", "GROUPS", s) or []
        for g in groups:
            d = dict(zip(g[::2], g[1::2], strict=False)) if isinstance(g, list) else g
            if d.get("name") == "api":
                old = redis_json("XPENDING", s, "api", "-", f"{until_ms}-99999999", "100") or []
                st[s] = {"pending": d.get("pending"), "lag": d.get("lag"), "last_delivered": d.get("last-delivered-id"),
                         "old_pending": len(old), "old_pending_sample": [o[0] for o in old[:5]],
                         "delivered_past_until": int(str(d.get("last-delivered-id", "0-0")).split("-")[0]) >= until_ms}
    return st


def wait_drained(until_ms: int, settle_s: int) -> dict[str, dict]:
    """창 끝 이전 엔트리가 모두 ACK 될 때까지(최대 settle_s 초) 기다린다."""
    deadline = time.time() + settle_s
    while True:
        st = group_state(until_ms)
        if all(g["old_pending"] == 0 for g in st.values()) or time.time() > deadline:
            return st
        time.sleep(2)


def check(since_ms: int, until_ms: int, warmup_s: int, settle_s: int = 60) -> dict:
    groups = wait_drained(until_ms, settle_s)  # 먼저 — ACK 된 엔트리의 행은 이미 커밋됐다(영수증 규칙)
    dlq = {f.get("source_id") for _, f in entries("wakeline:dlq", "-", "+")}
    res: dict = {"window": [since_ms, until_ms], "dlq_in_window": 0}

    # ---- 항적
    expected: set[tuple[str, str]] = set()
    n_entries = 0
    for eid, f in entries("wakeline:aircraft", f"{since_ms}-0", f"{until_ms}-99999999"):
        if eid in dlq:
            res["dlq_in_window"] += 1
            continue
        n_entries += 1
        p = payload(f)
        req = set(p.get("requested") or []) if f.get("scope") == "focus" and isinstance(p.get("requested"), list) else None
        for s in p.get("states", []):
            if req is not None and s["hex"] not in req:
                continue
            expected.add((s["hex"], iso_us(s["seen_at"])))
    missing: list[tuple[str, str]] = []
    if expected:
        lo = min(t for _, t in expected)
        hi = max(t for _, t in expected)
        rows = psql_rows(
            "SELECT hex, to_char(ts, 'YYYY-MM-DD\"T\"HH24:MI:SS.US') FROM track_point "
            f"WHERE ts >= '{lo}+00' AND ts <= '{hi}+00'"
        )
        have = {(h.strip(), t) for h, t in rows}
        missing = sorted(expected - have, key=lambda x: x[1])
    res["aircraft"] = {"entries": n_entries, "expected_rows": len(expected), "missing_rows": len(missing),
                       "missing_sample": missing[:10],
                       "missing_by_second": dict(Counter(t[:19] for _, t in missing).most_common(20))}

    # ---- 선박(60 s 창 — MMSI 별 단조 필터를 흉내 낸다. warmup 동안은 기억만 채우고 평가하지 않는다)
    kept: dict[str, int] = {}
    monotonic: dict[tuple[str, int], str] = {}
    late: set[tuple[str, int]] = set()
    gaps_expected: set[tuple[str, str]] = set()
    sig_expected: set[str] = set()
    n_ship_entries = 0
    for eid, f in entries("wakeline:ships", f"{since_ms - warmup_s * 1000}-0", f"{until_ms}-99999999"):
        in_window = int(eid.split("-")[0]) >= since_ms
        if eid in dlq:
            res["dlq_in_window"] += int(in_window)
            continue
        p = payload(f)
        now_s = int(eid.split("-")[0]) / 1000
        if f.get("kind") == "ais_gap":
            if in_window:
                gaps_expected.add((p.get("scope") or "", iso_us(p["started_at"])))
            continue
        if f.get("kind") != "ships":
            continue
        n_ship_entries += int(in_window)
        for s in p.get("ships", []):
            t = epoch_s(s["seen_at"])
            if t < now_s - KEEP_PAST_S or t > now_s + KEEP_FUTURE_S:
                continue
            w = int(t // WINDOW_S)
            prev = kept.get(s["mmsi"])
            if prev is not None and w <= prev:
                if in_window and (s["mmsi"], w) not in monotonic:
                    late.add((s["mmsi"], w))
                continue
            kept[s["mmsi"]] = w
            if in_window:
                monotonic[(s["mmsi"], w)] = eid
    ship_missing: list = []
    ship_dups: list = []
    late_missing = 0
    if monotonic or late:
        wins = [w for _, w in monotonic] + [w for _, w in late]
        lo, hi = min(wins) * WINDOW_S, (max(wins) + 1) * WINDOW_S
        rows = psql_rows(
            "SELECT mmsi, floor(extract(epoch FROM ts) / 60)::bigint, count(*) FROM ship_position "
            f"WHERE ts >= to_timestamp({lo}) AND ts < to_timestamp({hi}) GROUP BY 1, 2"
        )
        have = {(m.strip(), int(w)): int(n) for m, w, n in rows}
        for k, eid in sorted(monotonic.items(), key=lambda kv: kv[1]):
            if have.get(k, 0) == 0:
                ship_missing.append((k[0], datetime.fromtimestamp(k[1] * WINDOW_S, UTC).isoformat(), eid))
        late_missing = sum(1 for k in late if have.get(k, 0) == 0)
        ship_dups = [(m, w, n) for (m, w), n in have.items() if n > 1]
    res["ships"] = {"entries": n_ship_entries, "expected_windows": len(monotonic), "missing_windows": len(ship_missing),
                    "missing_sample": ship_missing[:10], "late_windows": len(late), "late_windows_without_row": late_missing,
                    "duplicate_windows": len(ship_dups), "duplicate_sample": ship_dups[:10]}

    # ---- SIGMET
    n_sig = 0
    for eid, f in entries("wakeline:sigmet", f"{since_ms}-0", f"{until_ms}-99999999"):
        if eid in dlq:
            continue
        n_sig += 1
        for s in payload(f).get("sigmets", []):
            sig_expected.add(s["id"])
    sig_missing: list[str] = []
    if sig_expected:
        have_ids = {r[0] for r in psql_rows("SELECT id FROM sigmet")}
        sig_missing = sorted(sig_expected - have_ids)
    res["sigmet"] = {"entries": n_sig, "expected_ids": len(sig_expected), "missing_ids": len(sig_missing), "missing_sample": sig_missing[:10]}

    # ---- 공백
    gap_missing: list = []
    if gaps_expected:
        have_g = {(r[0], r[1]) for r in psql_rows(
            "SELECT coalesce(scope, ''), to_char(started_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.US') FROM ingest_gap WHERE source = 'ais'")}
        gap_missing = sorted(gaps_expected - have_g)
    res["ais_gap"] = {"expected": len(gaps_expected), "missing": len(gap_missing), "missing_sample": gap_missing[:10]}

    res["groups"] = groups
    res["metrics"] = metrics()
    pend = {s: g for s, g in groups.items() if g["old_pending"] > 0}
    res["defects"] = {
        "aircraft_rows_lost": len(missing),
        "ship_windows_lost": len(ship_missing),
        "ship_windows_duplicated": len(ship_dups),
        "sigmet_ids_lost": len(sig_missing),
        "ais_gaps_lost": len(gap_missing),
        "groups_not_drained": pend,
    }
    return res


def main() -> int:
    global PROJECT
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=PROJECT)
    ap.add_argument("--since-ms", type=int, required=True)
    ap.add_argument("--until-ms", type=int, required=True)
    ap.add_argument("--warmup-s", type=int, default=180, help="선박 단조 필터의 기억을 채우는 앞 구간(평가하지 않음)")
    ap.add_argument("--settle-s", type=int, default=60, help="창 끝 이전 엔트리가 모두 ACK 되기를 기다리는 상한")
    ap.add_argument("--json", help="결과를 이 파일에도 쓴다")
    a = ap.parse_args()
    if a.project not in ALLOWED_PROJECTS:
        raise SystemExit(f"QA 신뢰성 점검은 격리 스택 B 만: {a.project}")
    PROJECT = a.project
    res = check(a.since_ms, a.until_ms, a.warmup_s, a.settle_s)
    text = json.dumps(res, ensure_ascii=False, indent=1, default=str)
    print(text)
    if a.json:
        with open(a.json, "w") as fh:
            fh.write(text + "\n")
    d = res["defects"]
    bad = any(v for k, v in d.items() if k != "groups_not_drained") or bool(d["groups_not_drained"])
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
