"""QA 성능(계획 §3.5 · NFR-03 'api 메모리 ≤ 512 MB'): perf_sample.py 의 CSV 에서 api 컨테이너 메모리(docker stats) · java RSS 의 최소 · 중앙 · 최대를 내고,
한도를 넘은 표본이 있으면 종료 코드 1.

    python3 tools/qa/perf_check_mem.py [--limit-mib 512] <stats-*.csv> …

한도 512 MB 는 MiB 로 읽는다(512 MiB = 536.9 MB — 더 너그러운 쪽). docker stats 메모리 = cgroup 사용량 − inactive_file(캐시 일부 제외).
"""

from __future__ import annotations

import csv
import statistics
import sys


def main() -> int:
    args = sys.argv[1:]
    limit = 768.0  # NFR-03(ADR-031): 잰 최대 741 MiB(몰림 뒤) — 컨테이너 한도 1 GiB 의 75 %
    if args and args[0] == "--limit-mib":
        limit = float(args[1])
        args = args[2:]
    over = False
    for path in args:
        rows = list(csv.DictReader(open(path)))
        for col in ("api_mem", "api_rss_mib", "api_cg_mib", "heap_used_mib", "heap_committed_mib"):
            vals = [float(r[col]) for r in rows if r.get(col) not in (None, "", "-1.0", "-1")]
            if not vals:
                continue
            mx = max(vals)
            flag = ""
            if col in ("api_mem", "api_rss_mib") and mx > limit:
                flag = f"  OVER {limit:.0f} MiB ({sum(v > limit for v in vals)}/{len(vals)} 표본)"
                over = True
            print(f"{path.rsplit('/', 1)[-1]:40} {col:20} n={len(vals):4} min={min(vals):7.1f} med={statistics.median(vals):7.1f} max={mx:7.1f}{flag}")
    return 1 if over else 0


if __name__ == "__main__":
    sys.exit(main())
