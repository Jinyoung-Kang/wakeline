#!/usr/bin/env python3
"""`.env` 를 만들고 내부 비밀값(DB·Redis)을 자동 생성한다.

- `.env` 가 없으면 `.env.example` 을 복사한다. 있으면 비어 있거나 빠진 내부 비밀값만 채운다(이미 있는 값·외부 키는 절대 바꾸지 않는다).
- `.env` 는 항상 소유자 전용(0600)이다 — 새로 만들 때도, 이미 있던 파일도(SEC-13). 쓰기는 같은 디렉터리의 0600 임시 파일 → 원자적 교체.
- 비밀값은 화면에 출력하지 않는다.
"""
from __future__ import annotations

import os
import re
import secrets
import stat
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE, ENV = ROOT / ".env.example", ROOT / ".env"
# 외부 키(OPENSKY_*, KMA_APIHUB_KEY, DATA_GO_KR_SERVICE_KEY, aisstream_key)는 사람이 넣는다 — 여기서 만들지 않는다.
INTERNAL = [
    "DB_ROOT_PASSWORD",
    "DB_MIGRATOR_PASSWORD",
    "DB_API_PASSWORD",
    "DB_COLLECTOR_PASSWORD",
    "REDIS_PASSWORD",            # Redis default(관리) 사용자 — 헬스체크·운영 전용
    "REDIS_API_PASSWORD",        # Redis ACL 사용자 wakeline_api (계약 §6)
    "REDIS_COLLECTOR_PASSWORD",  # Redis ACL 사용자 wakeline_collector (계약 §6)
    "REDIS_AIS_PASSWORD",        # Redis ACL 사용자 wakeline_ais (계약 v2 §C — 선박 수신 컨테이너)
]
# 선택 외부 키 → 없을 때 꺼지는 기능. 값은 읽지도 출력하지도 않고 '비어 있는지'만 본다.
# aisstream_key 는 사용자가 .env 에 저장한 이름 그대로(소문자)다 — compose 가 ais 컨테이너의 AISSTREAM_API_KEY 로 넘긴다.
OPTIONAL_EXTERNAL = {
    "OPENSKY_CLIENT_ID": "global view",
    "OPENSKY_CLIENT_SECRET": "global view",
    "KMA_APIHUB_KEY": "KMA radar",
    # 공공데이터포털 — 해양수산부 선박운항정보(ADR-022) · 해양교통안전공단 교통정보 · 해양수산부 격자(ADR-023)
    "DATA_GO_KR_SERVICE_KEY": "Korean port calls, coastal traffic layer",
    "aisstream_key": "ships layer",
}
OWNER_ONLY = 0o600


def fill_secrets(text: str, keys: list[str] = INTERNAL) -> tuple[str, list[str]]:
    """비어 있거나 없는 key 에만 새 비밀값을 넣는다. (새 텍스트, 생성한 key 목록)."""
    generated: list[str] = []
    for key in keys:
        m = re.search(rf"^{re.escape(key)}=(.*)$", text, re.M)
        if m is None:
            if text and not text.endswith("\n"):
                text += "\n"
            text += f"{key}={secrets.token_urlsafe(24)}\n"
            generated.append(key)
        elif not m.group(1).strip():
            text = text[: m.start()] + f"{key}={secrets.token_urlsafe(24)}" + text[m.end():]
            generated.append(key)
    return text, generated


def write_private(path: Path, text: str) -> None:
    """0600 임시 파일에 쓰고 원자적으로 교체한다 — 쓰는 도중에도 다른 사용자가 읽을 수 있는 순간이 없다."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        os.fchmod(fd, OWNER_ONLY)
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    os.chmod(path, OWNER_ONLY)


def ensure_env(env: Path = ENV, example: Path = EXAMPLE, out=sys.stdout) -> list[str]:
    """`.env` 를 준비한다. 생성한 비밀값 key 목록을 돌려준다(값은 돌려주지 않는다)."""
    created = not env.exists()
    was_open = not created and bool(stat.S_IMODE(env.stat().st_mode) & 0o077)
    text = example.read_text() if created else env.read_text()
    text, generated = fill_secrets(text)
    if created or generated:
        write_private(env, text)
    os.chmod(env, OWNER_ONLY)  # 이미 있던 파일도 매번 0600 으로 좁힌다
    if created:
        print(f"created {env.name} from {example.name} (mode 600)", file=out)
    if generated:
        print(f"generated internal secrets: {', '.join(generated)}", file=out)
    if was_open and not created:
        print(f"{env.name}: permissions tightened to 600 (was readable by group/others)", file=out)
    missing = [k for k in OPTIONAL_EXTERNAL if not re.search(rf"^{re.escape(k)}=\S", text, re.M)]
    if missing:
        off = sorted({OPTIONAL_EXTERNAL[k] for k in missing})
        print(f"optional external keys not set ({', '.join(off)} stays off):", ", ".join(missing), file=out)
    print(f"{env.name} ready", file=out)
    return generated


def main() -> None:
    ensure_env()


if __name__ == "__main__":
    main()
