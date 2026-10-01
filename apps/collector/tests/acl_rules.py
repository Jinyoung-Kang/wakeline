"""infra/redis/start.sh 가 서비스 사용자에게 주는 Redis ACL 규칙을 그대로 읽는다 — 시험이 규칙을 복사하지 않게(R-41).

start.sh 를 가짜 redis-server(받은 인자를 파일에 한 줄에 하나씩 적는다)와 임시 TMPDIR 로 실행하고, start.sh 가 쓴 ACL 파일(--aclfile)의
`user <이름> on #<해시> 규칙…` 줄을 읽는다(비밀번호는 redis-server 의 argv 가 아니라 이 파일에 해시로만 있다 — S7).
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


def _merge_selectors(tokens: list[str]) -> list[str]:
    """공백으로 나뉜 셀렉터 '(~a ~b +set)' 를 ACL SETUSER 인자 하나로 다시 합친다(Redis 가 ACL 파일을 읽을 때와 같다)."""
    out: list[str] = []
    buf: list[str] = []
    for tok in tokens:
        if buf or tok.startswith("("):
            buf.append(tok)
            if tok.endswith(")"):
                out.append(" ".join(buf))
                buf = []
        else:
            out.append(tok)
    if buf:
        raise ValueError(f"닫히지 않은 셀렉터: {buf}")
    return out


def service_acl_rules(user: str) -> list[str]:
    """start.sh 가 `user`(wakeline_api · wakeline_collector · wakeline_ais)에게 주는 규칙 목록(ACL SETUSER 인자 그대로)."""
    with tempfile.TemporaryDirectory() as tmp:
        bin_dir = Path(tmp) / "bin"
        tmpdir = Path(tmp) / "tmp"
        bin_dir.mkdir()
        tmpdir.mkdir()
        argv_file = Path(tmp) / "argv"
        stub = bin_dir / "redis-server"
        stub.write_text(f'#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done > "{argv_file}"\n')
        stub.chmod(0o755)
        env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '/usr/bin:/bin')}", "TMPDIR": str(tmpdir), **_FAKE}
        subprocess.run(["sh", str(START)], env=env, capture_output=True, text=True, check=True)
        argv = argv_file.read_text().splitlines()
        lines = Path(argv[argv.index("--aclfile") + 1]).read_text().splitlines()
    for line in lines:
        tokens = line.split()
        if tokens[:2] != ["user", user]:
            continue
        return [r for r in _merge_selectors(tokens[2:]) if r != "on" and not r.startswith(("#", ">"))]
    raise LookupError(f"start.sh 에 {user} 사용자가 없다")
