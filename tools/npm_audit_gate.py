#!/usr/bin/env python3
"""npm 의존성 감사 판정(NFR-10 — High 이상 0 건, ci.yml web job · tools/dependency_audit.sh 가 같은 명령으로 부른다).

`npm audit --audit-level=high` 를 대신한다. 규칙은 같고, 하나만 더한다: 고친 판이 없는 공지 하나를 정해진 기한 동안 예외로 둘 수 있다
(apps/web/npm-audit-allow.json — 사용자 결정 2026-10-03, VERIFICATION #114). 예외는 좁다:
  - 실행 의존성(`npm audit --omit=dev` — 웹 이미지에 들어가는 것)의 High 이상은 예외 없이 실패한다. 예외는 개발 도구(ESLint 등)에만.
  - 예외 목록에 없는 High 이상 공지는 실패한다(전처럼). 공지마다 GHSA 번호 · 패키지 이름이 둘 다 맞아야 한다.
  - 기한(expires)이 지나면 실패한다. 기한은 더한 날(added)에서 31일 안 — 늘리려면 다시 판단해 새로 적는다.
  - 예외 공지가 감사에 더 이상 보이지 않으면(고친 판으로 갱신) 실패하지 않고 목록에서 빼라고 알린다(NOTE).
  - 감사를 돌리지 못하면(npm 없음 · 네트워크 · JSON 아님 · npm 의 error) 실패한다(fail closed).
apps/web 에서 돌린다: `python3 ../../tools/npm_audit_gate.py`. 시험은 --full · --prod(감사 JSON 파일) · --today 로 npm 없이 판정만 본다.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

BLOCKING = {"high", "critical"}
MAX_WINDOW_DAYS = 31
GHSA = re.compile(r"GHSA(-[23456789cfghjmpqrvwx]{4}){3}")


class AuditError(Exception):
    """감사를 돌리지 못했거나 예외 목록이 틀렸다 — 실패로 본다."""


def run_npm_audit(*extra: str) -> dict[str, Any]:
    try:
        r = subprocess.run(["npm", "audit", "--json", *extra], capture_output=True, text=True)
    except FileNotFoundError as e:
        raise AuditError("npm 이 없다") from e
    return parse_report(r.stdout, r.returncode, "npm audit --json " + " ".join(extra))


def parse_report(text: str, rc: int, what: str) -> dict[str, Any]:
    try:
        report = json.loads(text)
    except ValueError as e:
        raise AuditError(f"{what}: JSON 이 아니다(exit {rc})") from e
    if not isinstance(report, dict) or "error" in report or not isinstance(report.get("vulnerabilities"), dict):
        raise AuditError(f"{what}: 감사 결과가 아니다(exit {rc}) — {str(report.get('error') if isinstance(report, dict) else report)[:200]}")
    if rc != 0 and not report["vulnerabilities"]:
        raise AuditError(f"{what}: 취약점 없이 exit {rc} — 돌리지 못한 것으로 본다")
    return report


def advisories(report: dict[str, Any]) -> dict[str, dict[str, str]]:
    """High 이상 공지 {GHSA: {package, severity, title}}. 다른 패키지를 거쳐 걸린 노드(via 가 이름뿐)는 그 공지로 센다."""
    out: dict[str, dict[str, str]] = {}
    for node in report["vulnerabilities"].values():
        for via in node.get("via", []):
            if not isinstance(via, dict) or via.get("severity") not in BLOCKING:
                continue
            m = GHSA.search(str(via.get("url", "")))
            key = m.group(0) if m else f"npm-{via.get('source')}"
            out[key] = {"package": str(via.get("name", "")), "severity": str(via["severity"]), "title": str(via.get("title", ""))}
    return out


def load_allow(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as e:
        raise AuditError(f"{path.name}: JSON 이 아니다") from e
    allow: dict[str, dict[str, Any]] = {}
    for i, e in enumerate(data.get("advisories", [])):
        where = f"{path.name} advisories[{i}]"
        if not isinstance(e, dict) or not GHSA.fullmatch(str(e.get("id", ""))):
            raise AuditError(f"{where}: id 는 GHSA 번호")
        if not str(e.get("package", "")).strip() or not str(e.get("reason", "")).strip():
            raise AuditError(f"{where}: package · reason 이 있어야 한다")
        try:
            added = dt.date.fromisoformat(str(e.get("added")))
            expires = dt.date.fromisoformat(str(e.get("expires")))
        except ValueError as err:
            raise AuditError(f"{where}: added · expires 는 yyyy-MM-dd") from err
        if not added <= expires <= added + dt.timedelta(days=MAX_WINDOW_DAYS):
            raise AuditError(f"{where}: expires 는 added 부터 {MAX_WINDOW_DAYS}일 안")
        allow[e["id"]] = {**e, "added": added, "expires": expires}
    return allow


def judge(full: dict[str, Any], prod: dict[str, Any], allow: dict[str, dict[str, Any]], today: dt.date) -> tuple[list[str], list[str], int]:
    """(실패 줄, 알림 줄, 쓰인 예외 수)."""
    fails: list[str] = []
    notes: list[str] = []
    used = 0
    for gid, a in sorted(advisories(prod).items()):
        fails.append(f"실행 의존성의 {a['severity']} — {gid} {a['package']}: {a['title']} (실행 의존성은 예외를 두지 않는다)")
    seen = advisories(full)
    for gid, a in sorted(seen.items()):
        e = allow.get(gid)
        if e is None:
            fails.append(f"{a['severity']} — {gid} {a['package']}: {a['title']}")
        elif e["package"] != a["package"]:
            fails.append(f"{gid}: 예외 목록의 패키지 {e['package']} 와 감사의 {a['package']} 가 다르다")
        elif today > e["expires"]:
            fails.append(f"{gid} {a['package']}: 예외 기한 {e['expires']} 이 지났다 — 고친 판으로 갱신하거나 다시 판단해 새로 적는다")
        else:
            used += 1
            notes.append(f"예외 {gid} {a['package']} ({a['severity']}, 개발 의존성만) — 기한 {e['expires']}: {e['reason']}")
    for gid, e in sorted(allow.items()):
        if gid not in seen:
            notes.append(f"예외 {gid} {e['package']} 가 감사에 더 이상 보이지 않는다 — npm-audit-allow.json 에서 뺀다")
    return fails, notes, used


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--allow", type=Path, default=Path("npm-audit-allow.json"))
    ap.add_argument("--full", type=Path, help="npm audit --json 결과 파일(시험용 — 없으면 npm 을 부른다)")
    ap.add_argument("--prod", type=Path, help="npm audit --json --omit=dev 결과 파일(시험용)")
    ap.add_argument("--today", type=dt.date.fromisoformat, default=dt.datetime.now(dt.timezone.utc).date())
    args = ap.parse_args(argv)
    try:
        allow = load_allow(args.allow)
        full = parse_report(args.full.read_text(encoding="utf-8"), 0, str(args.full)) if args.full else run_npm_audit()
        prod = parse_report(args.prod.read_text(encoding="utf-8"), 0, str(args.prod)) if args.prod else run_npm_audit("--omit=dev")
    except AuditError as e:
        print(f"FAIL  npm audit — 돌리지 못했다: {e}")
        return 1
    fails, notes, used = judge(full, prod, allow, args.today)
    for n in notes:
        print(f"NOTE  {n}")
    for f in fails:
        print(f"FAIL  {f}")
    if fails:
        print(f"npm audit: High 이상 {len(fails)}건 — 실패")
        return 1
    print(f"npm audit: High 이상 0 건(기한부 예외 {used}건 — 개발 의존성만)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
