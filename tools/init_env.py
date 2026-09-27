#!/usr/bin/env python3
"""`.env` 를 만들고 내부 비밀값(DB·Redis)을 자동 생성한다. 이미 있으면 빈 내부 값만 채운다."""
from __future__ import annotations
import re, secrets, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE, ENV = ROOT / ".env.example", ROOT / ".env"
INTERNAL = ["DB_ROOT_PASSWORD", "DB_MIGRATOR_PASSWORD", "DB_API_PASSWORD", "DB_COLLECTOR_PASSWORD", "REDIS_PASSWORD"]

def main() -> None:
    if not ENV.exists():
        shutil.copy(EXAMPLE, ENV)
        print(f"created {ENV.relative_to(ROOT)} from .env.example")
    text = ENV.read_text()
    for key in INTERNAL:
        m = re.search(rf"^{key}=(.*)$", text, re.M)
        if m is None:
            text += f"\n{key}={secrets.token_urlsafe(24)}\n"
        elif not m.group(1).strip():
            text = text.replace(m.group(0), f"{key}={secrets.token_urlsafe(24)}", 1)
    ENV.write_text(text)
    missing = [k for k in ("OPENSKY_CLIENT_ID", "OPENSKY_CLIENT_SECRET") if not re.search(rf"^{k}=.+$", text, re.M)]
    if missing:
        print("optional external keys not set (global view stays off):", ", ".join(missing))
    print(".env ready — internal secrets generated")

if __name__ == "__main__":
    main()
