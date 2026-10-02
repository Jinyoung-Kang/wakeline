"""QA 성능(계획 §3.5 '화면'): perf_lighthouse.sh 가 남긴 Lighthouse 보고서(.json 또는 gzip 한 .json.gz)에서 화면 · 프리셋마다 가운데 값을 Core Web Vitals 'good' 기준과 견준다.
하나라도 넘으면 종료 코드 1(QA-402 · QA-403 재현 검사).

    python3 tools/qa/perf_cwv_check.py [보고서 폴더=docs/qa/2026-10/evidence/performance/lighthouse]

기준(web.dev — 실험실에서는 INP 대신 TBT): LCP ≤ 2,500 ms · CLS ≤ 0.1 · TBT ≤ 200 ms. 가운데 값은 같은 화면 · 프리셋의 실행(보통 3번)에서.
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


def main() -> int:
    d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", "docs", "qa", "2026-10", "evidence", "performance", "lighthouse")
    runs: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for f in sorted(glob.glob(os.path.join(d, "*-*-*.json")) + glob.glob(os.path.join(d, "*-*-*.json.gz"))):
        base = os.path.basename(f).removesuffix(".gz").removesuffix(".json")
        page, preset, _n = base.rsplit("-", 2)
        a = json.load(gzip.open(f) if f.endswith(".gz") else open(f))["audits"]
        runs[(page, preset)].append({"LCP": a["largest-contentful-paint"]["numericValue"], "TBT": a["total-blocking-time"]["numericValue"],
                                     "CLS": a["cumulative-layout-shift"]["numericValue"]})
    bad = 0
    print(f"{'화면':8} {'프리셋':8} {'n':>2} {'LCP ms':>16} {'TBT ms':>16} {'CLS':>14}  판정")
    for (page, preset), rs in sorted(runs.items()):
        cells, miss = [], []
        for k, lim in LIMITS.items():
            v = [r[k] for r in rs]
            med = statistics.median(v)
            fmt = "{:.3f}" if k == "CLS" else "{:.0f}"
            cells.append(f"{fmt.format(med)} [{fmt.format(min(v))}–{fmt.format(max(v))}]")
            if med > lim:
                miss.append(f"{k}>{lim:g}")
        bad += bool(miss)
        print(f"{'/' + ('' if page == 'root' else page):8} {preset:8} {len(rs):>2} {cells[0]:>16} {cells[1]:>16} {cells[2]:>14}  {'MISS ' + ' '.join(miss) if miss else 'good'}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
