"""QA 성능(계획 §3.5): perf_k6.sh 가 남긴 k6 요약(JSON)과 자원 표본(CSV)을 실행 묶음마다 모아 표로 낸다(가운데 값과 범위).

    python3 tools/qa/perf_summarize.py rest <이름표 접두> …      # 예: rest rest50 rest100 → 경로마다 p50 · p95 · p99 · 최대 · 오류 % · 처리량(3회의 가운데 [최소–최대])
    python3 tools/qa/perf_summarize.py step <이름표 접두>         # 단계마다
    python3 tools/qa/perf_summarize.py ws <이름표 접두>
    python3 tools/qa/perf_summarize.py res <이름표 접두> …        # 자원(api · db · collector · redis CPU % · 메모리, api RSS · 힙, GC, VM 의 다른 CPU)
증거 폴더: docs/qa/2026-10/evidence/performance/(환경 변수 PERF_EV 로 바꾼다)
"""

from __future__ import annotations

import csv
import glob
import json
import os
import statistics
import sys

# PERF_EV: 다른 증거 폴더(고친 뒤 재측정 — …/performance/after-fix)
EV = os.environ.get("PERF_EV") or os.path.join(os.path.dirname(__file__), "..", "..", "docs", "qa", "2026-10", "evidence", "performance")


def runs(prefix: str, ext: str) -> list[str]:
    return sorted(glob.glob(os.path.join(EV, f"k6-{prefix}-r[0-9]*.{ext}" if ext == "json" else f"stats-{prefix}-r[0-9]*.csv")))


def spread(vals: list[float], fmt: str = "{:.1f}") -> str:
    if not vals:
        return "—"
    if len(vals) == 1:
        return fmt.format(vals[0])
    return f"{fmt.format(statistics.median(vals))} [{fmt.format(min(vals))}–{fmt.format(max(vals))}]"


def rest(prefixes: list[str], key_kind: str = "name") -> None:
    for prefix in prefixes:
        files = runs(prefix, "json")
        data = [json.load(open(f)) for f in files]
        if not data:
            continue
        print(f"\n### {prefix} — {len(data)}회 ({', '.join(os.path.basename(f) for f in files)})")
        tot = [d["metrics"]["http_reqs"]["values"]["rate"] for d in data]
        fail = [d["metrics"]["http_req_failed"]["values"]["rate"] * 100 for d in data]
        dur = [d["state"]["testRunDurationMs"] / 1000 for d in data]
        print(f"전체 처리량 {spread(tot)} /s · 실패 {spread(fail, '{:.2f}')} % · 실행 {spread(dur, '{:.0f}')} s")
        names = []
        for k in data[0]["metrics"]:
            if k.startswith(f"http_req_duration{{{key_kind}:"):
                names.append(k[len(f"http_req_duration{{{key_kind}:"):-1])
        if key_kind == "stage":
            names.sort(key=lambda s: int(s[1:]))
        print("| 경로 | 요청 수 | 처리량 /s | p50 ms | p95 ms | p99 ms | 최대 ms | 오류 % |")
        print("|---|---|---|---|---|---|---|---|")
        for n in names:
            dv = [d["metrics"][f"http_req_duration{{{key_kind}:{n}}}"]["values"] for d in data if f"http_req_duration{{{key_kind}:{n}}}" in d["metrics"]]
            cv = [d["metrics"].get(f"http_reqs{{{key_kind}:{n}}}", {}).get("values", {}).get("count", 0) for d in data]
            fv = [d["metrics"].get(f"http_req_failed{{{key_kind}:{n}}}", {}).get("values", {}).get("rate", 0) * 100 for d in data]
            secs = [60.0] * len(data) if key_kind == "stage" else dur
            rv = [c / s for c, s in zip(cv, secs)]
            print(f"| {n} | {spread(cv, '{:.0f}')} | {spread(rv)} | {spread([v['med'] for v in dv])} | {spread([v['p(95)'] for v in dv])} | "
                  f"{spread([v['p(99)'] for v in dv])} | {spread([v['max'] for v in dv], '{:.0f}')} | {spread(fv, '{:.2f}')} |")


def ws(prefix: str) -> None:
    files = runs(prefix, "json")
    data = [json.load(open(f)) for f in files]
    print(f"\n### {prefix} — {len(data)}회")
    m = lambda d, k, s: d["metrics"].get(k, {}).get("values", {}).get(s, 0)
    print("| 항목 | 값(가운데 [최소–최대]) |\n|---|---|")
    for label, k, s in [("최대 VU", "vus_max", "max"), ("메시지", "ws_messages", "count"), ("스냅샷", "ws_snapshots", "count"), ("diff", "ws_diffs", "count"),
                        ("오류", "ws_errors", "count"), ("선박 메시지", "ws_ship_messages", "count")]:
        print(f"| {label} | {spread([m(d, k, s) for d in data], '{:.0f}')} |")
    for label, k in [("항공기 지연", "ws_diff_lag_ms"), ("선박 지연", "ws_ships_lag_ms")]:
        for s in ("med", "p(95)", "p(99)", "max"):
            print(f"| {label} {s} ms | {spread([m(d, k, s) for d in data], '{:.0f}')} |")


def res(prefixes: list[str]) -> None:
    print("| 묶음 | 표본 | api CPU % 가운데/최대 | api 메모리 MiB(docker stats) 최대 | api RSS MiB 최대 | 힙 사용 최대 · 커밋 최대 MiB | GC 일시정지 합 s(실행 중) · 최대 s |"
          " db CPU % 가운데/최대 | db 메모리 최대 | collector CPU · 메모리 최대 | redis 메모리 최대 | VM 다른 CPU % 가운데/최대 |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for prefix in prefixes:
        for f in sorted(glob.glob(os.path.join(EV, f"stats-{prefix}*.csv"))):
            rows = [r for r in csv.DictReader(open(f)) if float(r["api_mem"]) >= 0]
            if not rows:
                continue
            col = lambda c: [float(r[c]) for r in rows if float(r[c]) >= 0]
            stack = [sum(float(r[k]) for k in r if k.endswith("_cpu") and float(r[k]) >= 0) for r in rows]
            other = [float(r["vm_cpu_pct"]) - s for r, s in zip(rows, stack)]
            gc = float(rows[-1]["gc_sum_s"]) - float(rows[0]["gc_sum_s"])
            print(f"| {os.path.basename(f)[6:-4]} | {len(rows)} | {statistics.median(col('api_cpu')):.0f} / {max(col('api_cpu')):.0f} | {max(col('api_mem')):.0f} | "
                  f"{max(col('api_rss_mib')):.0f} | {max(col('heap_used_mib')):.0f} · {max(col('heap_committed_mib')):.0f} | {gc:.2f} · {max(col('gc_max_s')):.3f} | "
                  f"{statistics.median(col('db_cpu')):.0f} / {max(col('db_cpu')):.0f} | {max(col('db_mem')):.0f} | {max(col('collector_cpu')):.0f} · {max(col('collector_mem')):.0f} | "
                  f"{max(col('redis_mem')):.0f} | {statistics.median(other):.0f} / {max(other):.0f} |")


def main() -> int:
    kind, *args = sys.argv[1:]
    if kind == "rest":
        rest(args)
    elif kind == "step":
        rest(args, "stage")
    elif kind == "ws":
        for a in args:
            ws(a)
    elif kind == "res":
        res(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
