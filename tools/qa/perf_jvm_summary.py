"""QA-400 재측정 요약: tools/qa/perf_jvm_run.sh 가 남긴 단계 경계(phases-qa400-<설정>-r<n>.txt) · 자원 표본(stats-…csv) · k6 요약(k6-…-{rest,ws,burst}.json)을
설정마다 모아 표로 낸다(가운데 [최소–최대]).

    python3 tools/qa/perf_jvm_summary.py <설정 이름> …        # 예: p40 p40pgc p35 p30 p30pgc
    python3 tools/qa/perf_jvm_summary.py --runs <설정 이름> …   # 실행마다 한 줄도

단계: W 기동 뒤 데움(마지막 60 s = 기동 뒤 쉼) · R REST 100 rps 3분 · S WS 200 연결 · B 몰림(300 → 400 rps) · I 몰림 뒤 쉼(마지막 60 s = 평탄).
메모리는 MiB: 컨테이너 = docker stats(cgroup − inactive_file), RSS = java 프로세스 VmRSS. 한도 512 는 MiB 로 읽는다(perf_check_mem.py 와 같다).
힙 여유 = 힙 상한 − GC 뒤 old 영역의 최대(jvm_gc_live_data_size — 마지막 GC 뒤 old 영역 크기, 살아 있는 데이터의 상한) · 힙 상한 − 몰림 중 힙 사용 최대.
결과 폴더: PERF_EV(기본 docs/qa/2026-10/evidence/performance/after-fix).
"""

from __future__ import annotations

import csv
import glob
import json
import os
import statistics
import sys

EV = os.environ.get("PERF_EV") or os.path.join(os.path.dirname(__file__), "..", "..", "docs", "qa", "2026-10", "evidence", "performance", "after-fix")
LIMIT = 512.0


def phases(path: str) -> tuple[dict[str, tuple[str, str]], dict[str, str]]:
    ph, meta = {}, {}
    for line in open(path):
        parts = line.split()
        if len(parts) == 3 and parts[0] in ("W", "R", "S", "B", "I"):
            ph[parts[0]] = (parts[1], parts[2])
        elif line.startswith(("inspect ", "oom_lines ", "jvm_line ", "JAVA_TOOL_OPTIONS=", "setting=")):
            k = line.split("=", 1)[0].split(" ", 1)[0]
            meta[k] = line.strip()
    return ph, meta


def col(rows: list[dict], c: str) -> list[float]:
    out = []
    for r in rows:
        try:
            v = float(r[c])
        except (KeyError, ValueError, TypeError):
            continue
        if v >= 0:
            out.append(v)
    return out


def window(rows: list[dict], a: str, b: str) -> list[dict]:
    return [r for r in rows if a <= r["ts"] <= b]


def last(rows: list[dict], secs: int = 60) -> list[dict]:
    return rows[-max(1, secs // 5):]


def k6(path: str) -> dict:
    try:
        return json.load(open(path))["metrics"]
    except (OSError, ValueError, KeyError):
        return {}


def run_metrics(tag: str) -> dict:
    ph, meta = phases(os.path.join(EV, f"phases-{tag}.txt"))
    rows = list(csv.DictReader(open(os.path.join(EV, f"stats-{tag}.csv"))))
    m: dict[str, float | str] = {"tag": tag}
    heap_max = max(col(rows, "heap_max_mib") or [-1])
    m["heap_max"] = heap_max
    for p in ("R", "S", "B"):
        if p not in ph:
            continue
        w = window(rows, *ph[p])
        m[f"{p}_mem"] = max(col(w, "api_mem") or [-1])
        m[f"{p}_rss"] = max(col(w, "api_rss_mib") or [-1])
        m[f"{p}_heap_used"] = max(col(w, "heap_used_mib") or [-1])
        m[f"{p}_heap_comm"] = max(col(w, "heap_committed_mib") or [-1])
        gs = col(w, "gc_sum_s")
        gc_ = col(w, "gc_count")
        m[f"{p}_gc_s"] = (gs[-1] - gs[0]) if len(gs) > 1 else -1
        m[f"{p}_gc_n"] = (gc_[-1] - gc_[0]) if len(gc_) > 1 else -1
        m[f"{p}_gc_max"] = max(col(w, "gc_max_s") or [-1])
        m[f"{p}_nonheap"] = max(col(w, "nonheap_committed_mib") or [-1])
        # 힙 밖 RSS = java RSS − 힙 커밋(같은 표본) — 메타스페이스 · 코드 캐시 · GC 구조 · 스레드 · malloc · 매핑한 파일
        gaps = [float(r["api_rss_mib"]) - float(r["heap_committed_mib"]) for r in w
                if r.get("api_rss_mib") not in (None, "", "-1.0") and r.get("heap_committed_mib") not in (None, "", "-1.0")]
        m[f"{p}_gap"] = max(gaps) if gaps else -1
        # VM 의 다른 CPU(VM 전체 − 스택 A 컨테이너 합, 400 % 만점) — 같은 VM 의 k6 · 다른 스택 몫. 지연을 읽을 때 함께 본다
        other = []
        for r in w:
            try:
                other.append(float(r["vm_cpu_pct"]) - sum(float(r[k]) for k in r if k.endswith("_cpu") and float(r[k]) >= 0))
            except (KeyError, ValueError, TypeError):
                pass
        m[f"{p}_other_cpu"] = statistics.median(other) if other else -1
        m[f"{p}_api_cpu"] = statistics.median(col(w, "api_cpu") or [-1])
    if "W" in ph:
        w = last(window(rows, *ph["W"]))
        m["W_mem"] = statistics.median(col(w, "api_mem") or [-1])
        m["W_rss"] = statistics.median(col(w, "api_rss_mib") or [-1])
        m["W_heap_comm"] = statistics.median(col(w, "heap_committed_mib") or [-1])
    if "I" in ph:
        wi = window(rows, *ph["I"])
        w = last(wi)
        m["I_mem"] = statistics.median(col(w, "api_mem") or [-1])
        m["I_rss"] = statistics.median(col(w, "api_rss_mib") or [-1])
        m["I_heap_comm"] = statistics.median(col(w, "heap_committed_mib") or [-1])
        m["I_heap_used"] = statistics.median(col(w, "heap_used_mib") or [-1])
        gs = col(wi, "gc_sum_s")
        m["I_gc_s"] = (gs[-1] - gs[0]) if len(gs) > 1 else -1
    m["live_max"] = max(col(rows, "gc_live_mib") or [-1])
    m["headroom_live"] = heap_max - m["live_max"] if heap_max > 0 else -1
    m["headroom_burst"] = heap_max - m.get("B_heap_used", heap_max) if heap_max > 0 else -1
    # k6
    rest = k6(os.path.join(EV, f"k6-{tag}-rest.json"))
    if rest:
        m["R_p95"] = rest["http_req_duration"]["values"]["p(95)"]
        m["R_fail"] = rest["http_req_failed"]["values"]["rate"] * 100
        worst = max(((k[len("http_req_duration{name:"):-1], v["values"]["p(95)"]) for k, v in rest.items() if k.startswith("http_req_duration{name:")),
                    key=lambda x: x[1], default=("-", -1))
        m["R_worst"] = worst[1]
        m["R_worst_name"] = worst[0]
    ws = k6(os.path.join(EV, f"k6-{tag}-ws.json"))
    if ws:
        m["S_lag95"] = ws.get("ws_diff_lag_ms", {}).get("values", {}).get("p(95)", -1)
        m["S_ship95"] = ws.get("ws_ships_lag_ms", {}).get("values", {}).get("p(95)", -1)
        m["S_err"] = ws.get("ws_errors", {}).get("values", {}).get("count", 0)
    burst = k6(os.path.join(EV, f"k6-{tag}-burst.json"))
    if burst:
        for i, rps in enumerate((300, 400)):
            d = burst.get(f"http_req_duration{{stage:s{i}}}", {}).get("values", {})
            f = burst.get(f"http_req_failed{{stage:s{i}}}", {}).get("values", {})
            m[f"B{rps}_p95"] = d.get("p(95)", -1)
            m[f"B{rps}_fail"] = f.get("rate", 0) * 100
    insp = meta.get("inspect", "")
    m["restarts"] = insp.split("restarts=")[1].split()[0] if "restarts=" in insp else "?"
    m["oom_killed"] = insp.split("oom_killed=")[1].split()[0] if "oom_killed=" in insp else "?"
    m["oom_lines"] = meta.get("oom_lines", "oom_lines ?").split()[-1]
    m["jvm"] = meta.get("JAVA_TOOL_OPTIONS", "").removeprefix("JAVA_TOOL_OPTIONS=")
    return m


def spread(vals: list[float], fmt: str = "{:.0f}") -> str:
    vals = [v for v in vals if isinstance(v, (int, float)) and v >= 0]
    if not vals:
        return "—"
    if len(vals) == 1:
        return fmt.format(vals[0])
    return f"{fmt.format(statistics.median(vals))} [{fmt.format(min(vals))}–{fmt.format(max(vals))}]"


ROWS = [  # (머리, 열, 형식)
    ("힙 상한 MiB", "heap_max", "{:.0f}"),
    ("기동 뒤 쉼: 컨테이너 · RSS · 힙 커밋", ("W_mem", "W_rss", "W_heap_comm"), "{:.0f}"),
    ("REST 100 rps: 컨테이너 최대", "R_mem", "{:.0f}"),
    ("REST 100 rps: RSS 최대", "R_rss", "{:.0f}"),
    ("REST 100 rps: 힙 사용 · 커밋 최대", ("R_heap_used", "R_heap_comm"), "{:.0f}"),
    ("REST 100 rps: 힙 밖 커밋(JVM 풀) 최대 · 힙 밖 RSS(RSS − 힙 커밋) 최대", ("R_nonheap", "R_gap"), "{:.0f}"),
    ("REST 100 rps: GC 일시정지 합 s · 횟수 · 최대 s", ("R_gc_s", "R_gc_n", "R_gc_max"), "{:.2f}"),
    ("REST 100 rps: 전체 p95 ms · 가장 느린 경로 p95 ms · 실패 %", ("R_p95", "R_worst", "R_fail"), "{:.1f}"),
    ("REST 100 rps: api CPU % 가운데 · VM 다른 CPU % 가운데", ("R_api_cpu", "R_other_cpu"), "{:.0f}"),
    ("WS 200: 컨테이너 · RSS 최대", ("S_mem", "S_rss"), "{:.0f}"),
    ("WS 200: 힙 커밋 최대", "S_heap_comm", "{:.0f}"),
    ("WS 200: GC 합 s · 최대 s", ("S_gc_s", "S_gc_max"), "{:.2f}"),
    ("WS 200: 항공기 diff 지연 p95 ms · 선박 p95 ms · 오류", ("S_lag95", "S_ship95", "S_err"), "{:.0f}"),
    ("WS 200: api CPU % 가운데 · VM 다른 CPU % 가운데", ("S_api_cpu", "S_other_cpu"), "{:.0f}"),
    ("몰림: 컨테이너 · RSS 최대", ("B_mem", "B_rss"), "{:.0f}"),
    ("몰림: 힙 사용 · 커밋 최대", ("B_heap_used", "B_heap_comm"), "{:.0f}"),
    ("몰림: GC 합 s · 최대 s", ("B_gc_s", "B_gc_max"), "{:.2f}"),
    ("몰림: 300 · 400 rps p95 ms", ("B300_p95", "B400_p95"), "{:.0f}"),
    ("몰림: 300 · 400 rps 실패 %", ("B300_fail", "B400_fail"), "{:.2f}"),
    ("몰림 뒤 쉼(마지막 60 s): 컨테이너 · RSS", ("I_mem", "I_rss"), "{:.0f}"),
    ("몰림 뒤 쉼: 힙 커밋 · 힙 사용 · GC 합 s", ("I_heap_comm", "I_heap_used", "I_gc_s"), "{:.1f}"),
    ("GC 뒤 old 영역 최대 MiB · 힙 여유(상한 − 그것) · 몰림 중 여유(상한 − 사용 최대)", ("live_max", "headroom_live", "headroom_burst"), "{:.0f}"),
]


def main() -> int:
    args = sys.argv[1:]
    show_runs = False
    if args and args[0] == "--runs":
        show_runs, args = True, args[1:]
    data = {}
    for s in args:
        tags = sorted(os.path.basename(p)[len("phases-"):-len(".txt")] for p in glob.glob(os.path.join(EV, f"phases-qa400-{s}-r*.txt")))
        data[s] = [run_metrics(t) for t in tags]
    print("| 항목 | " + " | ".join(f"{s}({len(data[s])}회)" for s in args) + " |")
    print("|---|" + "---|" * len(args))
    for head, keys, fmt in ROWS:
        keys = keys if isinstance(keys, tuple) else (keys,)
        cells = []
        for s in args:
            cells.append(" · ".join(spread([r.get(k, -1) for r in data[s]], fmt) for k in keys))
        print(f"| {head} | " + " | ".join(cells) + " |")
    over = []
    for s in args:
        for r in data[s]:
            for k in ("R_mem", "R_rss", "S_mem", "S_rss"):
                if isinstance(r.get(k), float) and r[k] > LIMIT:
                    over.append(f"{r['tag']}:{k}={r[k]:.0f}")
    print("\n512 MiB 넘음(REST · WS 단계 최대): " + (", ".join(over) if over else "없음"))
    print("다시 시작 · OOM: " + ", ".join(f"{r['tag']} restarts={r['restarts']} oom_killed={r['oom_killed']} oom_lines={r['oom_lines']}" for s in args for r in data[s]))
    if show_runs:
        print("\n| 실행 | JVM 옵션 | R 컨테이너 · RSS 최대 | R 힙 커밋 | R GC 합 s | R p95 · 최악 경로 | WS p95 | 몰림 힙 사용 · 커밋 | 평탄 컨테이너 · RSS · 커밋 |")
        print("|---|---|---|---|---|---|---|---|---|")
        f = lambda v, fmt="{:.0f}": fmt.format(v) if isinstance(v, (int, float)) and v >= 0 else "—"
        for s in args:
            for r in data[s]:
                print(f"| {r['tag']} | `{r['jvm']}` | {f(r.get('R_mem', -1))} · {f(r.get('R_rss', -1))} | {f(r.get('R_heap_comm', -1))} | {f(r.get('R_gc_s', -1), '{:.2f}')} | "
                      f"{f(r.get('R_p95', -1), '{:.1f}')} · {f(r.get('R_worst', -1), '{:.1f}')} ({r.get('R_worst_name', '-')}) | {f(r.get('S_lag95', -1))} | "
                      f"{f(r.get('B_heap_used', -1))} · {f(r.get('B_heap_comm', -1))} | {f(r.get('I_mem', -1))} · {f(r.get('I_rss', -1))} · {f(r.get('I_heap_comm', -1))} |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
