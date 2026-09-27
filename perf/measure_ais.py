#!/usr/bin/env python3
"""AIS 수신 측정(ADR-014 §7 — 동아시아로 시작해 처리량·자원을 잰 뒤 넓힌다). `make measure-ais d=60 i=10 [P=wakeline-e2e]`.

실행 중인 스택을 읽기만 한다: Redis 에서 wakeline:ais:status · wakeline:ships 스트림(길이·메모리·소비자 그룹 lag) · 전체 메모리,
docker stats 에서 ais · api · redis 컨테이너의 CPU·메모리를 i 초마다 d 초 동안 모아 요약한다. 외부 호출·쓰기 없음.
- Redis 명령은 redis 컨테이너 안에서 그 컨테이너의 REDIS_PASSWORD(관리 사용자, 운영 전용)로 실행한다 — 비밀번호가 이 호스트의
  명령행·출력에 나오지 않는다. 컨테이너는 compose 라벨로 찾으므로 compose 파일을 해석하지 않는다.
- 값은 측정한 그대로 적는다. 없는 값은 "—". msgs_per_s 는 ais 프로세스가 스스로 보고한 값, CPU 는 docker stats 순간값이다.
결과는 perf/results/ais-<UTC 시각>.log 에도 남는다.
"""

from __future__ import annotations

import argparse
import statistics
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

RESULTS = Path(__file__).resolve().parent / "results"
STATUS_KEY = "wakeline:ais:status"
STREAM = "wakeline:ships"
DASH = "—"


def sh(args: list[str], timeout: float = 15) -> str:
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)  # noqa: S603 — 고정 argv(셸 없음), 프로젝트 이름은 검증됨
    if r.returncode != 0:
        raise RuntimeError(f"{args[0]} {args[1] if len(args) > 1 else ''} failed: {r.stderr.strip()[:200]}")
    return r.stdout


def container(project: str, service: str) -> str | None:
    out = sh(
        ["docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={project}",
         "--filter", f"label=com.docker.compose.service={service}"]
    ).split()
    return out[0] if len(out) == 1 else None


class RedisCli:
    """redis 컨테이너 안에서 관리 사용자로 읽기 명령만 실행한다(비밀번호는 컨테이너 환경변수에서 — 호스트 argv 에 없음)."""

    READ_ONLY = {"HGETALL", "XLEN", "XINFO", "MEMORY", "INFO"}

    def __init__(self, cid: str) -> None:
        self.cid = cid

    def __call__(self, *cmd: str) -> list[str]:
        if cmd[0].upper() not in self.READ_ONLY:
            raise ValueError(f"read-only commands only: {cmd[0]}")
        script = 'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli --no-auth-warning "$@"'
        out = sh(["docker", "exec", self.cid, "sh", "-c", script, "sh", *cmd])
        return out.splitlines()


def pairs(lines: list[str]) -> dict[str, str]:
    return {lines[i]: lines[i + 1] for i in range(0, len(lines) - 1, 2)}


def parse_iso(v: str | None) -> datetime | None:
    if not v:
        return None
    try:
        t = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else None


def to_float(v: str | None) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def mib(text: str) -> float | None:
    """docker stats 의 '123.4MiB / 256MiB' 앞부분 → MiB."""
    v = text.split("/")[0].strip()
    for unit, f in (("GiB", 1024.0), ("MiB", 1.0), ("KiB", 1 / 1024), ("kB", 1 / 1024), ("MB", 1.0), ("GB", 1024.0), ("B", 1 / 1024 / 1024)):
        if v.endswith(unit):
            try:
                return float(v[: -len(unit)]) * f
            except ValueError:
                return None
    return None


def fmt(v: float | int | str | None, spec: str = "") -> str:
    if v is None or v == "":
        return DASH
    return format(v, spec) if spec and not isinstance(v, str) else str(v)


def sample(redis: RedisCli, cids: dict[str, str]) -> dict:
    now = datetime.now(UTC)
    st = pairs(redis("HGETALL", STATUS_KEY))
    groups: dict[str, str] = {}
    try:
        g = redis("XINFO", "GROUPS", STREAM)
        # 소비자 그룹 하나(api)당 12줄: name api consumers N pending N last-delivered-id X entries-read N lag N
        groups = pairs(g[:12]) if g and not g[0].startswith("ERR") else {}
    except RuntimeError:
        groups = {}
    xlen = redis("XLEN", STREAM)
    mem = redis("MEMORY", "USAGE", STREAM)
    info = dict(line.split(":", 1) for line in redis("INFO", "memory") if ":" in line)
    stats: dict[str, tuple[float | None, float | None]] = {}
    names = {v: k for k, v in cids.items()}
    fmt_s = "{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}"
    for line in sh(["docker", "stats", "--no-stream", "--format", fmt_s, *cids.values()], timeout=30).splitlines():
        cid, cpu, memu = line.split("\t")
        svc = next((names[k] for k in names if k.startswith(cid) or cid.startswith(k)), cid)
        stats[svc] = (to_float(cpu.rstrip("%")), mib(memu))
    last = parse_iso(st.get("last_msg_at"))
    return {
        "at": now,
        "status": st,
        "connected": st.get("connected"),
        "msgs_per_s": to_float(st.get("msgs_per_s")),
        "last_msg_age_s": (now - last).total_seconds() if last else None,
        "dropped_total": to_float(st.get("dropped_total")),
        "quarantined_total": to_float(st.get("quarantined_total")),
        "gap_open_since": st.get("gap_open_since") or None,
        "xlen": int(xlen[0]) if xlen and xlen[0].isdigit() else None,
        "stream_kib": int(mem[0]) / 1024 if mem and mem[0].isdigit() else None,
        "lag": groups.get("lag"),
        "pending": groups.get("pending"),
        "redis_used_mib": (um / 1024 / 1024) if (um := to_float(info.get("used_memory", "").strip())) is not None else None,
        "stats": stats,
    }


def summarize(xs: list[float | None]) -> str:
    v = [x for x in xs if x is not None]
    if not v:
        return DASH
    return f"min {min(v):.1f} · avg {statistics.fmean(v):.1f} · max {max(v):.1f} (n={len(v)})"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="AIS ingest measurement (read-only)")
    ap.add_argument("duration", type=int, nargs="?", default=60, help="seconds (10–3600)")
    ap.add_argument("interval", type=int, nargs="?", default=10, help="seconds between samples (2–600)")
    ap.add_argument("project", nargs="?", default="wakeline", help="compose project (wakeline | wakeline-e2e)")
    a = ap.parse_args(argv)
    if not (10 <= a.duration <= 3600 and 2 <= a.interval <= 600) or not a.project.replace("-", "").replace("_", "").isalnum():
        ap.error("duration 10–3600 s, interval 2–600 s, project [A-Za-z0-9_-]")

    cids = {s: c for s in ("ais", "api", "redis") if (c := container(a.project, s))}
    if "redis" not in cids:
        print(f"redis container of compose project '{a.project}' is not running", file=sys.stderr)
        return 2
    if "ais" not in cids:
        print(f"note: ais container of '{a.project}' is not running — status below is whatever is left in Redis", file=sys.stderr)
    redis = RedisCli(cids["redis"])

    RESULTS.mkdir(exist_ok=True)
    ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    log_path = RESULTS / f"ais-{ts}.log"
    lines: list[str] = []

    def out(s: str = "") -> None:
        print(s, flush=True)
        lines.append(s)

    out(f"AIS measurement · project {a.project} · {a.duration}s every {a.interval}s · started {ts}")
    first = sample(redis, cids)
    out(f"{STATUS_KEY}:")
    if first["status"]:
        for k, v in sorted(first["status"].items()):
            out(f"  {k:20} {v if v != '' else DASH}")
    else:
        out("  (없음 — ais 가 아직 상태를 쓰지 않았다)")
    out("")
    hdr = f"{'UTC':8} {'conn':>4} {'msg/s':>6} {'last_msg':>8} {'dropped':>8} {'quar':>6} {'gap':>5} {'xlen':>5} {'strKiB':>7} {'lag':>5} {'redisMiB':>8} {'aisCPU%':>7} {'aisMiB':>7} {'apiCPU%':>7} {'apiMiB':>7}"
    out(hdr)
    samples = [first]
    deadline = time.monotonic() + a.duration

    def row(s: dict) -> str:
        ais = s["stats"].get("ais", (None, None))
        api = s["stats"].get("api", (None, None))
        age = DASH if s["last_msg_age_s"] is None else f"{s['last_msg_age_s']:.0f}s"
        return (
            f"{s['at']:%H:%M:%S} {fmt(s['connected']):>4} {fmt(s['msgs_per_s'], '.1f'):>6} {age:>8} "
            f"{fmt(s['dropped_total'], '.0f'):>8} {fmt(s['quarantined_total'], '.0f'):>6} {'open' if s['gap_open_since'] else '-':>5} "
            f"{fmt(s['xlen']):>5} {fmt(s['stream_kib'], '.0f'):>7} {fmt(s['lag']):>5} {fmt(s['redis_used_mib'], '.1f'):>8} "
            f"{fmt(ais[0], '.1f'):>7} {fmt(ais[1], '.0f'):>7} {fmt(api[0], '.1f'):>7} {fmt(api[1], '.0f'):>7}"
        )

    out(row(first))
    try:
        while time.monotonic() + a.interval <= deadline:
            time.sleep(a.interval)
            s = sample(redis, cids)
            samples.append(s)
            out(row(s))
    except KeyboardInterrupt:
        out("(interrupted)")

    def delta(key: str) -> str:
        v = [s[key] for s in samples if s[key] is not None]
        return f"{v[-1] - v[0]:.0f}" if len(v) >= 2 else DASH

    span = (samples[-1]["at"] - samples[0]["at"]).total_seconds()
    out("")
    out(f"summary over {span:.0f} s ({len(samples)} samples):")
    out(f"  msgs_per_s (ais 보고값)   {summarize([s['msgs_per_s'] for s in samples])}")
    out(f"  dropped (대기열 가득)     +{delta('dropped_total')}   quarantined(위치 점프) +{delta('quarantined_total')}")
    out(f"  gap open in samples      {sum(1 for s in samples if s['gap_open_since'])}/{len(samples)}")
    out(f"  ships stream             xlen {summarize([s['xlen'] for s in samples])} · KiB {summarize([s['stream_kib'] for s in samples])}")
    out(f"  api group lag            {summarize([to_float(s['lag']) for s in samples])}")
    out(f"  redis used_memory MiB    {summarize([s['redis_used_mib'] for s in samples])}  (maxmemory 256 MiB, noeviction)")
    for svc in ("ais", "api", "redis"):
        out(f"  {svc:5} CPU %              {summarize([s['stats'].get(svc, (None, None))[0] for s in samples])}")
        out(f"  {svc:5} memory MiB         {summarize([s['stats'].get(svc, (None, None))[1] for s in samples])}")
    log_path.write_text("\n".join(lines) + "\n")
    print(f"\nsaved {log_path.relative_to(RESULTS.parent.parent)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
