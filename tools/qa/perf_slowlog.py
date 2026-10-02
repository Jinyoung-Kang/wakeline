"""QA 성능(계획 §3.5 '느린 쿼리'): 격리 스택 A db 로그(log_min_duration_statement)에서 느린 문장을 모아 문장 앞부분으로 묶는다(읽기 전용).

    python3 tools/qa/perf_slowlog.py <since UTC, 예 2026-10-01T21:55:30Z> [until] [--raw 출력.log]

출력: 묶음마다 건수 · 가운데 · 최대 ms · 첫 시각 · 마지막 시각 · 문장 앞 160자. 'execute <unnamed>' · 'execute S_n' 과 'statement:' 를 같은 문장으로 본다.
문장이 여러 줄이면 첫 줄만 로그 줄에 있다 — DETAIL(파라미터) 줄은 건너뛴다.
"""

from __future__ import annotations

import re
import statistics
import subprocess
import sys

LINE = re.compile(r"^(\S+ \S+) UTC \[(\d+)\] LOG:  duration: ([\d.]+) ms  (?:statement|execute [^:]*): (.*)$")


def main() -> int:
    since = sys.argv[1]
    until = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else None
    raw = sys.argv[sys.argv.index("--raw") + 1] if "--raw" in sys.argv else None
    cmd = ["docker", "logs", "--since", since] + (["--until", until] if until else []) + ["wakeline-e2e-db-1"]
    out = subprocess.run(cmd, capture_output=True, text=True)
    text = out.stdout + out.stderr
    lines = text.splitlines()
    groups: dict[str, list[tuple[float, str]]] = {}
    kept = []
    for i, ln in enumerate(lines):
        m = LINE.match(ln)
        if not m:
            continue
        ts, _pid, ms, stmt = m.group(1), m.group(2), float(m.group(3)), m.group(4).strip()
        # 여러 줄 문장: 다음 줄들이 이어진다(LOG/DETAIL 로 시작하지 않는 줄)
        j = i + 1
        while j < len(lines) and not re.match(r"^\d{4}-\d\d-\d\d \d", lines[j]):
            stmt += " " + lines[j].strip()
            j += 1
        key = re.sub(r"\s+", " ", stmt)[:160]
        groups.setdefault(key, []).append((ms, ts))
        kept.append(f"{ts} {ms:10.1f} ms  {re.sub(r'\s+', ' ', stmt)[:400]}")
    if raw:
        with open(raw, "w") as f:
            f.write("\n".join(kept) + "\n")
    print(f"since {since}{' until ' + until if until else ''}: {len(kept)} statements ≥ log_min_duration_statement, {len(groups)} groups")
    print("| 건수 | 가운데 ms | 최대 ms | 처음 | 마지막 | 문장(앞 160자) |\n|---|---|---|---|---|---|")
    for key, v in sorted(groups.items(), key=lambda kv: -sum(x[0] for x in kv[1])):
        ms = [x[0] for x in v]
        print(f"| {len(v)} | {statistics.median(ms):.0f} | {max(ms):.0f} | {v[0][1][11:19]} | {v[-1][1][11:19]} | `{key.replace('|', '¦')}` |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
