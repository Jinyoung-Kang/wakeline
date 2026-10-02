"""QA 성능(계획 §3.5): 격리 스택 A(wakeline-e2e) 컨테이너 자원 · api JVM 을 일정 간격으로 표본을 떠 CSV 로 남긴다(읽기 전용).

    python3 tools/qa/perf_sample.py <출력.csv> [간격 s=5] [길이 s=600]

열: 시각(UTC) · VM CPU %(4코어 합 = 400 %, /proc/stat — 컨테이너 안에서도 VM 전체 값) · 컨테이너마다 CPU % · 메모리 MiB(docker stats — cgroup 사용량 −
inactive_file) · api cgroup memory.current MiB · api java VmRSS · RssAnon MiB · 힙 사용 · 커밋 MiB · GC 일시정지 횟수 · 합 s(누적) · Hikari 활성 · 대기 ·
(뒤에 더한 열 — QA-400 재측정) 힙 상한(G1 Old Gen max) · GC 뒤 old 영역(jvm_gc_live_data_size — 살아 있는 데이터의 상한) · 힙 밖 커밋(메타스페이스 · 코드 캐시 …) MiB · 살아 있는 스레드.
docker stats 는 wakeline-e2e-* 이름만 묻는다(다른 스택은 읽지 않는다).
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

P = "wakeline-e2e"
SVCS = ["api", "collector", "db", "redis", "edge", "web", "ais"]


def sh(*cmd: str) -> str:
    r = subprocess.run(list(cmd), capture_output=True, text=True)
    return r.stdout


def vm_cpu() -> tuple[int, int]:
    line = sh("docker", "exec", f"{P}-redis-1", "head", "-1", "/proc/stat").split()
    vals = list(map(int, line[1:]))
    idle = vals[3] + vals[4]
    return sum(vals), idle


def stats() -> dict[str, tuple[float, float]]:
    out = sh("docker", "stats", "--no-stream", "--format", "{{json .}}", *[f"{P}-{s}-1" for s in SVCS])
    res = {}
    for line in out.splitlines():
        d = json.loads(line)
        name = d["Name"].removeprefix(f"{P}-").removesuffix("-1")
        try:
            cpu = float(d["CPUPerc"].rstrip("%"))
        except ValueError:
            cpu = -1.0
        m = re.match(r"([\d.]+)\s*([KMG]?i?B)", d["MemUsage"])
        mult = {"B": 1 / 1048576, "KiB": 1 / 1024, "MiB": 1, "GiB": 1024, "kB": 1 / 1024, "MB": 1, "GB": 1024}.get(m.group(2), -1) if m else -1
        res[name] = (cpu, float(m.group(1)) * mult if m and mult > 0 else -1.0)
    return res


def api_mem() -> dict[str, float]:
    out = sh("docker", "exec", f"{P}-api-1", "sh", "-c",
             'cat /sys/fs/cgroup/memory.current; for p in /proc/[0-9]*; do if tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q "^java"; then '
             'grep -E "VmRSS|RssAnon" $p/status; fi; done')
    lines = out.split()
    r = {"cg_current": int(lines[0]) / 1048576 if lines and lines[0].isdigit() else -1}
    for k in ("VmRSS:", "RssAnon:"):
        if k in lines:
            r[k[:-1]] = int(lines[lines.index(k) + 1]) / 1024
    return r


def prom() -> dict[str, float]:
    out = sh("docker", "exec", f"{P}-api-1", "curl", "-s", "localhost:9000/actuator/prometheus")
    r = {"heap_used": 0.0, "heap_committed": 0.0, "gc_count": 0.0, "gc_sum": 0.0, "gc_max": 0.0, "hk_active": 0.0, "hk_pending": 0.0,
         "heap_max": -1.0, "gc_live": -1.0, "nonheap_committed": 0.0, "threads": -1.0}
    for line in out.splitlines():
        if line.startswith("#"):
            continue
        try:
            name, val = line.rsplit(" ", 1)
            v = float(val)
        except ValueError:
            continue
        if name.startswith("jvm_memory_used_bytes{") and 'area="heap"' in name:
            r["heap_used"] += v / 1048576
        elif name.startswith("jvm_memory_committed_bytes{") and 'area="heap"' in name:
            r["heap_committed"] += v / 1048576
        elif name.startswith("jvm_gc_pause_seconds_count{"):
            r["gc_count"] += v
        elif name.startswith("jvm_gc_pause_seconds_sum{"):
            r["gc_sum"] += v
        elif name.startswith("jvm_gc_pause_seconds_max{"):
            r["gc_max"] = max(r["gc_max"], v)
        elif name.startswith("hikaricp_connections_active{") and "HikariPool-1" in name:
            r["hk_active"] = v
        elif name.startswith("hikaricp_connections_pending{") and "HikariPool-1" in name:
            r["hk_pending"] = v
        elif name.startswith("jvm_memory_max_bytes{") and 'area="heap"' in name and v > 0:
            r["heap_max"] = max(r["heap_max"], v / 1048576)
        elif name.startswith("jvm_gc_live_data_size_bytes"):
            r["gc_live"] = v / 1048576
        elif name.startswith("jvm_memory_committed_bytes{") and 'area="nonheap"' in name:
            r["nonheap_committed"] += v / 1048576
        elif name.startswith("jvm_threads_live_threads"):
            r["threads"] = v
    return r


def main() -> int:
    out = sys.argv[1]
    every = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
    dur = float(sys.argv[3]) if len(sys.argv) > 3 else 600.0
    cols = ["ts", "vm_cpu_pct"] + [f"{s}_{k}" for s in SVCS for k in ("cpu", "mem")] + \
           ["api_cg_mib", "api_rss_mib", "api_rss_anon_mib", "heap_used_mib", "heap_committed_mib", "gc_count", "gc_sum_s", "gc_max_s", "hikari_active", "hikari_pending",
            "heap_max_mib", "gc_live_mib", "nonheap_committed_mib", "threads"]
    end = time.monotonic() + dur
    prev = vm_cpu()
    with open(out, "w") as f:
        f.write(",".join(cols) + "\n")
        while time.monotonic() < end:
            t0 = time.monotonic()
            try:
                s = stats()
                a = api_mem()
                p = prom()
            except Exception as e:  # 컨테이너를 다시 만드는 중 — 이 표본만 건너뛴다
                print("sample skipped:", e, file=sys.stderr)
                time.sleep(every)
                continue
            cur = vm_cpu()
            dt, di = cur[0] - prev[0], cur[1] - prev[1]
            prev = cur
            vm = 400.0 * (dt - di) / dt if dt > 0 else 0.0
            row = [datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), f"{vm:.1f}"]
            for sv in SVCS:
                c, m = s.get(sv, (-1, -1))
                row += [f"{c:.1f}", f"{m:.1f}"]
            row += [f"{a.get('cg_current', -1):.1f}", f"{a.get('VmRSS', -1):.1f}", f"{a.get('RssAnon', -1):.1f}", f"{p['heap_used']:.1f}",
                    f"{p['heap_committed']:.1f}", f"{p['gc_count']:.0f}", f"{p['gc_sum']:.3f}", f"{p['gc_max']:.3f}", f"{p['hk_active']:.0f}", f"{p['hk_pending']:.0f}",
                    f"{p['heap_max']:.1f}", f"{p['gc_live']:.1f}", f"{p['nonheap_committed']:.1f}", f"{p['threads']:.0f}"]
            f.write(",".join(row) + "\n")
            f.flush()
            time.sleep(max(0.0, every - (time.monotonic() - t0)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
