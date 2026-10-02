"""화면 성능 과제(QA-402 · QA-403, PERF §15): tools/qa/perf_cwv.sh 가 남긴 Lighthouse 보고서(.json.gz)를 화면 · 프리셋마다 가운데 [최소–최대]로 요약한다.

    python3 tools/qa/perf_cwv_summary.py <폴더> [<폴더> …]            # 표(점수 · LCP · TBT · CLS · FCP · JS 전송) + 'good' 판정
    python3 tools/qa/perf_cwv_summary.py --runs <폴더>                 # 실행마다: LCP 요소 · LCP 단계 · 긴 작업 · 스크립트 평가 상위 · 주 스레드 분해
    python3 tools/qa/perf_cwv_summary.py --md <폴더> …                 # 같은 표를 markdown 으로(PERF §15 에 붙인다)

기준(web.dev — 실험실에서는 INP 대신 TBT): LCP ≤ 2,500 ms · CLS ≤ 0.1 · TBT ≤ 200 ms. 판정은 가운데 값으로(perf_cwv_check.py 와 같다).
"""

from __future__ import annotations

import glob
import gzip
import json
import os
import statistics
import sys
from collections import defaultdict

LIMITS = {"LCP": 2500.0, "TBT": 200.0, "CLS": 0.1}
ORDER = {"root": 0, "replay": 1, "about": 2, "stats": 3}


def load(path: str) -> dict:
    with (gzip.open(path, "rt") if path.endswith(".gz") else open(path)) as f:
        return json.load(f)


def short(url: str) -> str:
    if not url:
        return "?"
    u = url.split("?")[0]
    return u.rsplit("/", 1)[-1] or u


def lcp_element(a: dict) -> str:
    d = a.get("largest-contentful-paint-element", {}).get("details", {})
    for it in d.get("items", []):
        for sub in it.get("items", []) if isinstance(it, dict) else []:
            node = sub.get("node") if isinstance(sub, dict) else None
            if node:
                return f"{node.get('selector', '?')} «{(node.get('nodeLabel') or '')[:40]}»"
    return "—"


def lcp_phases(a: dict) -> str:
    d = a.get("largest-contentful-paint-element", {}).get("details", {})
    for it in d.get("items", []):
        if not isinstance(it, dict):
            continue
        rows = it.get("items", [])
        if rows and isinstance(rows[0], dict) and "phase" in rows[0]:
            return " · ".join(f"{r['phase']} {r.get('timing', 0):.0f}" for r in rows)
    return "—"


def metrics(r: dict) -> dict:
    a = r["audits"]
    nv = lambda k: a.get(k, {}).get("numericValue") or 0.0  # noqa: E731
    reqs = a.get("network-requests", {}).get("details", {}).get("items", [])
    js = sum(i.get("transferSize", 0) for i in reqs if i.get("resourceType") == "Script")
    lts = a.get("long-tasks", {}).get("details", {}).get("items", [])
    return {
        "score": round((r["categories"]["performance"]["score"] or 0) * 100),
        "LCP": nv("largest-contentful-paint"), "TBT": nv("total-blocking-time"), "CLS": nv("cumulative-layout-shift"),
        "FCP": nv("first-contentful-paint"), "SI": nv("speed-index"),
        "jsKiB": js / 1024, "reqs": len(reqs),
        "ofm": sum(1 for i in reqs if "openfreemap" in i.get("url", "")),
        "ext": sum(1 for i in reqs if not i.get("url", "").startswith(("http://localhost", "ws://localhost", "data:", "blob:"))),
        "bootup": a.get("bootup-time", {}).get("numericValue") or 0.0,
        "mainthread": a.get("mainthread-work-breakdown", {}).get("numericValue") or 0.0,
        "longN": len(lts), "longMax": max((t.get("duration", 0) for t in lts), default=0),
        "bench": r.get("environment", {}).get("benchmarkIndex"),
        "lcpEl": lcp_element(a), "lcpPh": lcp_phases(a),
        "boot": [(short(i.get("url", "")), i.get("total", 0), i.get("scripting", 0)) for i in a.get("bootup-time", {}).get("details", {}).get("items", [])[:5]],
        "groups": [(i.get("groupLabel") or i.get("group"), i.get("duration", 0)) for i in a.get("mainthread-work-breakdown", {}).get("details", {}).get("items", [])[:6]],
        "long": [(short(t.get("url", "")), round(t.get("startTime", 0)), round(t.get("duration", 0))) for t in lts[:8]],
    }


def collect(d: str) -> dict[tuple[str, str], list[dict]]:
    runs: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for f in sorted(glob.glob(os.path.join(d, "*-*-*.json.gz")) + glob.glob(os.path.join(d, "*-*-*.json"))):
        base = os.path.basename(f).removesuffix(".gz").removesuffix(".json")
        page, preset, n = base.rsplit("-", 2)
        m = metrics(load(f))
        m["n"] = n
        runs[(page, preset)].append(m)
    return runs


def mmm(v: list[float], fmt: str) -> str:
    return f"{fmt.format(statistics.median(v))} [{fmt.format(min(v))}–{fmt.format(max(v))}]"


def table(d: str, md: bool) -> int:
    runs = collect(d)
    bad = 0
    head = ["화면", "프리셋", "n", "점수", "LCP ms", "TBT ms", "CLS", "FCP ms", "JS KiB", "판정"]
    if md:
        print(f"\n`{os.path.relpath(d)}`\n")
        print("| " + " | ".join(head) + " |")
        print("|" + "---|" * len(head))
    else:
        print(f"\n== {d}")
        print(f"{'화면':8} {'프리셋':8} {'n':>2} {'점수':>13} {'LCP ms':>22} {'TBT ms':>22} {'CLS':>20} {'FCP ms':>20} {'JS KiB':>8}  판정")
    for (page, preset), rs in sorted(runs.items(), key=lambda kv: (ORDER.get(kv[0][0], 9), kv[0][1])):
        miss = [f"{k}>{lim:g}" for k, lim in LIMITS.items() if statistics.median([r[k] for r in rs]) > lim]
        bad += bool(miss)
        cells = [mmm([r["score"] for r in rs], "{:.0f}"), mmm([r["LCP"] for r in rs], "{:,.0f}"), mmm([r["TBT"] for r in rs], "{:,.0f}"),
                 mmm([r["CLS"] for r in rs], "{:.3f}"), mmm([r["FCP"] for r in rs], "{:,.0f}"), f"{statistics.median([r['jsKiB'] for r in rs]):.1f}"]
        verdict = "MISS " + " ".join(miss) if miss else "good"
        name = "/" + ("" if page == "root" else page)
        if md:
            print("| " + " | ".join([f"`{name}`", preset, str(len(rs)), *cells, verdict]) + " |")
        else:
            print(f"{name:8} {preset:8} {len(rs):>2} {cells[0]:>13} {cells[1]:>22} {cells[2]:>22} {cells[3]:>20} {cells[4]:>20} {cells[5]:>8}  {verdict}")
    return bad


def per_run(d: str) -> None:
    for (page, preset), rs in sorted(collect(d).items(), key=lambda kv: (ORDER.get(kv[0][0], 9), kv[0][1])):
        for r in sorted(rs, key=lambda x: x["n"]):
            print(f"\n## /{'' if page == 'root' else page} {preset} #{r['n']}  score {r['score']} · LCP {r['LCP']:,.0f} · TBT {r['TBT']:,.0f} · CLS {r['CLS']:.3f} · FCP {r['FCP']:,.0f}"
                  f" · JS {r['jsKiB']:.1f} KiB · reqs {r['reqs']} (ext {r['ext']} · ofm {r['ofm']}) · bench {r['bench']}")
            print(f"  LCP 요소: {r['lcpEl']}  | 단계: {r['lcpPh']}")
            print(f"  주 스레드 {r['mainthread']:,.0f} ms: " + " · ".join(f"{g} {v:,.0f}" for g, v in r["groups"]))
            print(f"  스크립트 평가 {r['bootup']:,.0f} ms: " + " · ".join(f"{u} {t:,.0f}({s:,.0f})" for u, t, s in r["boot"]))
            print(f"  긴 작업 {r['longN']}개 · 최대 {r['longMax']:,.0f} ms: " + " · ".join(f"{u}@{st}+{du}" for u, st, du in r["long"]))


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    if argv[0] == "--runs":
        for d in argv[1:]:
            per_run(d)
        return 0
    md = argv[0] == "--md"
    dirs = argv[1:] if md else argv
    bad = sum(table(d, md) for d in dirs)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
