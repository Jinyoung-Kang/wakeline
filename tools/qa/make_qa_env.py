#!/usr/bin/env python3
"""QA 2026-10 AWS: 격리 QA 스택 전용 env 파일을 새로 만든다 — 사용자의 `.env` 를 읽거나 쓰지 않는다.

`.env.example` 을 바탕으로 내부 비밀값(DB · Redis)만 새로 만들어 채우고, 외부 키는 빈 값으로 둔다. 파일은 0600 으로 원자적으로 쓴다.
비밀값은 화면에 출력하지 않는다. 이미 있으면 덮지 않는다(--force 로만).

    python3 tools/qa/make_qa_env.py <경로> [--force]
"""
from __future__ import annotations

import os
import re
import secrets
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from init_env import INTERNAL, OPTIONAL_EXTERNAL  # noqa: E402  같은 이름 목록을 쓴다


def build(example: str) -> str:
    out = []
    for line in example.splitlines():
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if m and m.group(1) in INTERNAL:
            line = f"{m.group(1)}={secrets.token_urlsafe(32)}"
        elif m and m.group(1) in OPTIONAL_EXTERNAL:
            line = f"{m.group(1)}="
        out.append(line)
    seen = {re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=", l).group(1) for l in out if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", l)}
    for name in INTERNAL:
        if name not in seen:
            out.append(f"{name}={secrets.token_urlsafe(32)}")
    return "\n".join(out) + "\n"


def main(argv: list[str]) -> int:
    if not argv or argv[0].startswith("-"):
        print(__doc__, file=sys.stderr)
        return 2
    path = Path(argv[0]).resolve()
    if path == (ROOT / ".env").resolve():
        print("사용자의 .env 에는 쓰지 않는다", file=sys.stderr)
        return 2
    if path.exists() and "--force" not in argv:
        print(f"이미 있다(덮지 않음): {path}")
        return 0
    text = build((ROOT / ".env.example").read_text(encoding="utf-8"))
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".qa-env-")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    print(f"만들었다: {path} (0600, 내부 비밀값 {len(INTERNAL)}개 생성, 외부 키 빈 값)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
