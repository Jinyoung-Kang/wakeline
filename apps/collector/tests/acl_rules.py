"""infra/redis/start.sh 가 서비스 사용자에게 주는 Redis ACL 규칙을 그대로 읽는다 — 시험이 규칙을 복사하지 않게(R-41).

start.sh 를 가짜 redis-server(받은 인자를 한 줄에 하나씩 출력)로 실행해 `--user <이름> on ><비밀번호> 규칙…` 을 모은다.
infra/tests/test_redis_acl_rules.py 와 같은 방식이다. 돌려주는 규칙에는 on·비밀번호가 없다(시험이 자기 비밀번호로 붙인다).
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
START = ROOT / "infra" / "redis" / "start.sh"
# 시험용 가짜 비밀번호(규칙을 읽는 데만 쓰고 버린다)
_FAKE = {
    k: f"{k.lower()}-rules-only"
    for k in ("REDIS_PASSWORD", "REDIS_API_PASSWORD", "REDIS_COLLECTOR_PASSWORD", "REDIS_AIS_PASSWORD")
}


def service_acl_rules(user: str) -> list[str]:
    """start.sh 가 `user`(wakeline_api · wakeline_collector · wakeline_ais)에게 주는 규칙 목록(ACL SETUSER 인자 그대로)."""
    with tempfile.TemporaryDirectory() as tmp:
        stub = Path(tmp) / "redis-server"
        stub.write_text('#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n')
        stub.chmod(0o755)
        env = {"PATH": f"{tmp}{os.pathsep}{os.environ.get('PATH', '/usr/bin:/bin')}", **_FAKE}
        args = subprocess.run(["sh", str(START)], env=env, capture_output=True, text=True, check=True).stdout.splitlines()
    starts = [i for i, a in enumerate(args[:-1]) if a == "--user" and args[i + 1] == user]
    if not starts:
        raise LookupError(f"start.sh 에 {user} 사용자가 없다")
    i = starts[0]
    rules: list[str] = []
    for a in args[i + 2 :]:
        if a.startswith("--"):
            break
        if a == "on" or a.startswith(">"):
            continue
        rules.append(a)
    return rules
