"""QA 2026-10 AWS 성능 요약: tools/qa/perf_aws_run.sh 가 남긴 단계 경계(phases-<태그>.txt) · 자원 표본(stats-<태그>.csv) · k6 요약(k6-<태그>-<단계>.json)을
이름표마다 모아 markdown 표로 낸다 — 값은 실행(보통 3번)의 가운데 [최소–최대].

    PERF_EV=<증거 폴더> python3 tools/qa/perf_aws_summary.py <이름표> …            # 단계 요약 · 자원 · WS · 몰림 단계
    PERF_EV=<증거 폴더> python3 tools/qa/perf_aws_summary.py --routes <이름표> …   # + 경로별 표(REST · 몰림 단계마다)
    PERF_EV=<증거 폴더> python3 tools/qa/perf_aws_summary.py --runs <이름표> …     # + 실행마다 한 줄

목표(PERF §14 · QA-PLAN §3.5): 경로마다 REST p95 ≤ 300 ms · 오류 < 1 % · 503 ≤ 1 %(몰림은 기록만) · WS 항공기 지연 p95 ≤ 500 ms · api 컨테이너 ≤ 768 MiB(ADR-031).
메모리는 MiB: 컨테이너 = docker stats(cgroup − inactive_file), RSS = java VmRSS. 503 비율 = k6 status_503(경로가 받은 응답 중 503), 격벽 거절 = api 지표 증가분.
"""

from __future__ import annotations

import csv
import glob
import json
import os
import re
import statistics
import sys

EV = os.environ.get("PERF_EV") or "."
P95_LIMIT = 300.0
FAIL_LIMIT = 1.0
WS_LIMIT = 500.0
MEM_LIMIT = 768.0


def spread(vals: list[float], fmt: str = "{:.1f}") -> str:
    vals = [v for v in vals if v is not None]
    if not vals:
        return "—"
    if len(vals) == 1:
        return fmt.format(vals[0])
    return f"{fmt.format(statistics.median(vals))} [{fmt.format(min(vals))}–{fmt.format(max(vals))}]"


def phases(path: str) -> tuple[list[tuple[str, str, str]], dict[str, list[str]]]:
    ph, meta = [], {}
    for line in open(path):
        parts = line.split()
        if len(parts) == 3 and re.fullmatch(r"W|R\d+|S|B|I", parts[0]):
            ph.append((parts[0], parts[1], parts[2]))
        elif parts:
            meta.setdefault(parts[0].split("=", 1)[0], []).append(line.rstrip("\n"))
    return ph, meta


def rows_of(tag: str) -> list[dict]:
    try:
        return list(csv.DictReader(open(os.path.join(EV, f"stats-{tag}.csv"))))
    except OSError:
        return []


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


def k6(tag: str, ph: str) -> dict:
    try:
        return json.load(open(os.path.join(EV, f"k6-{tag}-{ph}.json")))["metrics"]
    except (OSError, ValueError, KeyError):
        return {}


def val(m: dict, key: str, stat: str, default=None):
    return m.get(key, {}).get("values", {}).get(stat, default)


def tags(label: str) -> list[str]:
    fs = sorted(glob.glob(os.path.join(EV, f"phases-{label}-r[0-9]*.txt")))
    return [os.path.basename(f)[len("phases-"):-4] for f in fs]


def other_cpu(w: list[dict]) -> float | None:
    out = []
    for r in w:
        try:
            out.append(float(r["vm_cpu_pct"]) - sum(float(r[k]) for k in r if k.endswith("_cpu") and float(r[k]) >= 0))
        except (KeyError, ValueError, TypeError):
            pass
    return statistics.median(out) if out else None


def run(tag: str) -> dict:
    ph, meta = phases(os.path.join(EV, f"phases-{tag}.txt"))
    rows = rows_of(tag)
    out: dict = {"tag": tag, "phases": {}, "meta": meta}
    rej = {}
    for line in meta.get("rejected_before", []) + meta.get("rejected_after", []):
        k, p, v = line.split()[:3]
        try:
            rej[(k, p)] = float(v)
        except ValueError:
            pass
    for name, a, b in ph:
        w = window(rows, a, b)
        d: dict = {"a": a, "b": b}
        if name in ("W", "I"):
            tail = w[-12:]  # 마지막 60 s
            d["mem_tail"] = statistics.median(col(tail, "api_mem") or [-1])
            d["rss_tail"] = statistics.median(col(tail, "api_rss_mib") or [-1])
            d["heap_comm_tail"] = statistics.median(col(tail, "heap_committed_mib") or [-1])
        d["mem_max"] = max(col(w, "api_mem") or [-1])
        d["rss_max"] = max(col(w, "api_rss_mib") or [-1])
        d["heap_comm_max"] = max(col(w, "heap_committed_mib") or [-1])
        d["heap_used_max"] = max(col(w, "heap_used_mib") or [-1])
        gs, gn = col(w, "gc_sum_s"), col(w, "gc_count")
        d["gc_s"] = gs[-1] - gs[0] if len(gs) > 1 else None
        d["gc_n"] = gn[-1] - gn[0] if len(gn) > 1 else None
        d["gc_max"] = max(col(w, "gc_max_s") or [-1])
        d["api_cpu"] = statistics.median(col(w, "api_cpu") or [-1])
        d["db_cpu"] = statistics.median(col(w, "db_cpu") or [-1])
        d["db_cpu_max"] = max(col(w, "db_cpu") or [-1])
        d["db_mem_max"] = max(col(w, "db_mem") or [-1])
        d["hk_pending_max"] = max(col(w, "hikari_pending") or [-1])
        d["other_cpu"] = other_cpu(w)
        if ("rejected_before", name) in rej and ("rejected_after", name) in rej:
            d["rejected"] = rej[("rejected_after", name)] - rej[("rejected_before", name)]
        m = k6(tag, name)
        if m and name != "S" and "http_reqs" in m:
            d["rate"] = val(m, "http_reqs", "rate")
            d["reqs"] = val(m, "http_reqs", "count")
            d["fail"] = val(m, "http_req_failed", "rate", 0) * 100
            d["s503"] = val(m, "status_503", "rate", 0) * 100
            d["p50"] = val(m, "http_req_duration", "med")
            d["p95"] = val(m, "http_req_duration", "p(95)")
            d["p99"] = val(m, "http_req_duration", "p(99)")
            d["dropped"] = val(m, "dropped_iterations", "count", 0)
            routes = {}
            for k, v in m.items():
                mm = re.fullmatch(r"http_req_duration\{(name|stage):(.+)\}", k)
                if mm:
                    key = f"{mm.group(1)}:{mm.group(2)}"
                    routes[key] = {"p50": v["values"]["med"], "p95": v["values"]["p(95)"], "p99": v["values"]["p(99)"], "max": v["values"]["max"],
                                   "n": val(m, f"http_reqs{{{key}}}", "count", 0), "fail": val(m, f"http_req_failed{{{key}}}", "rate", 0) * 100,
                                   "s503": val(m, f"status_503{{{key}}}", "rate", 0) * 100}
            d["routes"] = routes
            named = {k[5:]: v for k, v in routes.items() if k.startswith("name:")}
            if named:
                worst = max(named.items(), key=lambda kv: kv[1]["p95"])
                d["worst"] = f"{worst[0]} {worst[1]['p95']:.0f}"
                d["over"] = sorted(n for n, v in named.items() if v["p95"] > P95_LIMIT or v["fail"] >= FAIL_LIMIT)
                d["over503"] = sorted(n for n, v in named.items() if v["s503"] > FAIL_LIMIT)
            d["secs"] = (d["reqs"] or 0) / d["rate"] if d.get("rate") else None
        elif m and name == "S":
            d["lag50"] = val(m, "ws_diff_lag_ms", "med")
            d["lag95"] = val(m, "ws_diff_lag_ms", "p(95)")
            d["lag99"] = val(m, "ws_diff_lag_ms", "p(99)")
            d["lagmax"] = val(m, "ws_diff_lag_ms", "max")
            d["slag95"] = val(m, "ws_ships_lag_ms", "p(95)")
            d["msgs"] = val(m, "ws_messages", "count", 0)
            d["diffs"] = val(m, "ws_diffs", "count", 0)
            d["snaps"] = val(m, "ws_snapshots", "count", 0)
            d["ship_msgs"] = val(m, "ws_ship_messages", "count", 0)
            d["errors"] = val(m, "ws_errors", "count", 0)
            d["vus"] = val(m, "vus_max", "max", 0)
        out["phases"][name] = d
    out["mem_all_max"] = max(col(rows, "api_mem") or [-1])
    out["rss_all_max"] = max(col(rows, "api_rss_mib") or [-1])
    out["heap_max"] = max(col(rows, "heap_max_mib") or [-1])
    return out


def g(runs: list[dict], ph: str, key: str) -> list[float]:
    return [r["phases"][ph][key] for r in runs if ph in r["phases"] and r["phases"][ph].get(key) is not None]


def summary(label: str, show_routes: bool, show_runs: bool) -> None:
    ts = tags(label)
    runs = [run(t) for t in ts]
    if not runs:
        print(f"\n## {label}: 결과 없음")
        return
    print(f"\n## {label} — {len(runs)}회 ({', '.join(ts)})")
    names = [p for p in runs[0]["phases"]]
    rest = [p for p in names if p.startswith("R") or p == "B"]
    if rest:
        print("\n| 단계 | 처리량 /s | 요청 | 실패 % | 503 % | 격벽 거절 | 전체 p50 · p95 · p99 ms | 가장 느린 경로 p95 | 목표 넘은 경로(p95 > 300 · 실패 ≥ 1 %) | 503 > 1 % 경로 |")
        print("|---|---|---|---|---|---|---|---|---|---|")
        for p in rest:
            over = [", ".join(r["phases"][p].get("over", [])) or "0" for r in runs if p in r["phases"]]
            o503 = [", ".join(r["phases"][p].get("over503", [])) or "0" for r in runs if p in r["phases"]]
            worst = [r["phases"][p].get("worst", "—") for r in runs if p in r["phases"]]
            print(f"| {p} | {spread(g(runs, p, 'rate'))} | {spread(g(runs, p, 'reqs'), '{:.0f}')} | {spread(g(runs, p, 'fail'), '{:.2f}')} | "
                  f"{spread(g(runs, p, 's503'), '{:.2f}')} | {spread(g(runs, p, 'rejected'), '{:.0f}')} | "
                  f"{spread(g(runs, p, 'p50'))} · {spread(g(runs, p, 'p95'))} · {spread(g(runs, p, 'p99'))} | {' / '.join(worst)} | {' / '.join(over)} | {' / '.join(o503)} |")
    if "S" in names:
        print("\n| WS(S) | 값 |\n|---|---|")
        for lab, k, f in [("최대 VU", "vus", "{:.0f}"), ("메시지", "msgs", "{:.0f}"), ("스냅샷 · diff", "snaps", "{:.0f}"), ("diff", "diffs", "{:.0f}"),
                          ("선박 메시지", "ship_msgs", "{:.0f}"), ("오류", "errors", "{:.0f}"), ("항공기 지연 p50 ms", "lag50", "{:.0f}"),
                          ("항공기 지연 p95 ms(목표 ≤ 500)", "lag95", "{:.0f}"), ("항공기 지연 p99 ms", "lag99", "{:.0f}"), ("항공기 지연 최대 ms", "lagmax", "{:.0f}"),
                          ("선박 지연 p95 ms", "slag95", "{:.0f}")]:
            print(f"| {lab} | {spread(g(runs, 'S', k), f)} |")
    print("\n| 단계 | 컨테이너 최대 MiB | RSS 최대 | 힙 커밋 최대 · 사용 최대 | GC 일시정지 합 s · 횟수 · 최대 s | api CPU % 가운데 | db CPU % 가운데 / 최대 | db 메모리 최대 | 히카리 대기 최대 | VM 다른 CPU % |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for p in names:
        print(f"| {p} | {spread(g(runs, p, 'mem_max'), '{:.0f}')} | {spread(g(runs, p, 'rss_max'), '{:.0f}')} | "
              f"{spread(g(runs, p, 'heap_comm_max'), '{:.0f}')} · {spread(g(runs, p, 'heap_used_max'), '{:.0f}')} | "
              f"{spread(g(runs, p, 'gc_s'), '{:.2f}')} · {spread(g(runs, p, 'gc_n'), '{:.0f}')} · {spread(g(runs, p, 'gc_max'), '{:.3f}')} | "
              f"{spread(g(runs, p, 'api_cpu'), '{:.0f}')} | {spread(g(runs, p, 'db_cpu'), '{:.0f}')} / {spread(g(runs, p, 'db_cpu_max'), '{:.0f}')} | "
              f"{spread(g(runs, p, 'db_mem_max'), '{:.0f}')} | {spread(g(runs, p, 'hk_pending_max'), '{:.0f}')} | {spread(g(runs, p, 'other_cpu'), '{:.0f}')} |")
    for p, lab in (("W", "기동 뒤 쉼(W 마지막 60 s)"), ("I", "몰림 · 부하 뒤 쉼(I 마지막 60 s)")):
        if p in names:
            print(f"\n{lab}: 컨테이너 {spread(g(runs, p, 'mem_tail'), '{:.0f}')} · RSS {spread(g(runs, p, 'rss_tail'), '{:.0f}')} · 힙 커밋 {spread(g(runs, p, 'heap_comm_tail'), '{:.0f}')} MiB")
    print(f"\n실행 전체 api 컨테이너 최대 {spread([r['mem_all_max'] for r in runs], '{:.0f}')} MiB(목표 ≤ {MEM_LIMIT:.0f}) · RSS 최대 {spread([r['rss_all_max'] for r in runs], '{:.0f}')} · 힙 상한 {spread([r['heap_max'] for r in runs], '{:.0f}')} MiB")
    for r in runs:
        insp = r["meta"].get("inspect", ["?"])[0]
        oom = r["meta"].get("oom_lines", ["?"])[0]
        print(f"- {r['tag']}: {insp} · {oom}")
    if "B" in names:
        print("\n| 몰림 단계 | 처리량 /s | p50 · p95 · p99 ms | 실패 % | 503 % |\n|---|---|---|---|---|")
        stages = sorted({k for r in runs for k in r["phases"].get("B", {}).get("routes", {}) if k.startswith("stage:")}, key=lambda s: int(s.split(":s")[1]))
        for s in stages:
            vs = [r["phases"]["B"]["routes"][s] for r in runs if s in r["phases"].get("B", {}).get("routes", {})]
            print(f"| {s[6:]} | {spread([v['n'] / 60 for v in vs])} | {spread([v['p50'] for v in vs])} · {spread([v['p95'] for v in vs])} · {spread([v['p99'] for v in vs])} | "
                  f"{spread([v['fail'] for v in vs], '{:.2f}')} | {spread([v['s503'] for v in vs], '{:.2f}')} |")
    if show_routes:
        for p in rest:
            keys = sorted({k for r in runs for k in r["phases"].get(p, {}).get("routes", {}) if k.startswith("name:")})
            print(f"\n### {label} {p} — 경로별(3회 가운데 [최소–최대])\n")
            print("| 경로 | 요청 | 처리량 /s | p50 ms | p95 ms | p99 ms | 최대 ms | 실패 % | 503 % |\n|---|---|---|---|---|---|---|---|---|")
            for k in keys:
                vs = [(r["phases"][p]["routes"][k], r["phases"][p].get("secs")) for r in runs if k in r["phases"].get(p, {}).get("routes", {})]
                print(f"| {k[5:]} | {spread([v['n'] for v, _ in vs], '{:.0f}')} | {spread([v['n'] / s for v, s in vs if s])} | {spread([v['p50'] for v, _ in vs])} | "
                      f"{spread([v['p95'] for v, _ in vs])} | {spread([v['p99'] for v, _ in vs])} | {spread([v['max'] for v, _ in vs], '{:.0f}')} | "
                      f"{spread([v['fail'] for v, _ in vs], '{:.2f}')} | {spread([v['s503'] for v, _ in vs], '{:.2f}')} |")
    if show_runs:
        print(f"\n### {label} — 실행마다")
        for r in runs:
            for p, d in r["phases"].items():
                if p.startswith("R") or p == "B":
                    print(f"- {r['tag']} {p}: rate {d.get('rate', 0):.1f}/s fail {d.get('fail', 0):.2f}% 503 {d.get('s503', 0):.2f}% p95 {d.get('p95') or 0:.1f} "
                          f"worst {d.get('worst')} over {d.get('over')} rejected {d.get('rejected')} mem_max {d['mem_max']:.0f} gc {d.get('gc_s')}")
                elif p == "S":
                    print(f"- {r['tag']} S: lag p95 {d.get('lag95') or 0:.0f} ms errors {d.get('errors')} mem_max {d['mem_max']:.0f}")


def main() -> int:
    args = sys.argv[1:]
    show_routes = "--routes" in args
    show_runs = "--runs" in args
    for a in [a for a in args if not a.startswith("--")]:
        summary(a, show_routes, show_runs)
    return 0


if __name__ == "__main__":
    sys.exit(main())
