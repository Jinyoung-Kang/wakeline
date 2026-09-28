"""원천 불변 보관: raw/{provider}/{yyyymmdd}/{hhmmss}.json.gz, 72 시간 뒤 삭제.

- 본문이 이미 gzip 이면(\x1f\x8b 로 시작 — KMA 레이더 바이너리) 다시 압축하지 않고 그대로 .bin.gz 로 쓴다(R-21).
- 압축·파일 쓰기는 동기 작업이다. 작업 코드는 archive() 로 스레드에서 부른다(이벤트 루프를 수십 ms 막지 않게, R-21).
"""

from __future__ import annotations

import asyncio
import gzip
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from wakeline_collector.config import settings

GZIP_MAGIC = b"\x1f\x8b"


class _Saver(Protocol):
    def save(self, provider: str, body: bytes, at: datetime | None = None) -> str: ...


async def archive(store: _Saver, provider: str, body: bytes, at: datetime | None = None) -> str:
    """원천 보관을 이벤트 루프 밖(스레드)에서 한다. 반환: raw_ref."""
    return await asyncio.to_thread(store.save, provider, body, at)


class RawStore:
    def __init__(self, root: str | None = None):
        self.root = Path(root or settings.raw_dir)

    def save(self, provider: str, body: bytes, at: datetime | None = None) -> str:
        at = at or datetime.now(UTC)
        d = self.root / provider / at.strftime("%Y%m%d")
        try:
            d.mkdir(parents=True, exist_ok=True)
            if body[:2] == GZIP_MAGIC:  # 이미 gzip — 받은 바이트 그대로(두 번 압축하지 않는다)
                p = d / f"{at.strftime('%H%M%S_%f')}.bin.gz"
                p.write_bytes(body)
            else:
                p = d / f"{at.strftime('%H%M%S_%f')}.json.gz"
                with gzip.open(p, "wb", compresslevel=6) as f:
                    f.write(body)
            return str(p.relative_to(self.root))
        except OSError as e:  # 보관 실패는 수집을 막지 않는다 — ingest_run 에 raw_ref 없이 기록
            return f"unsaved:{type(e).__name__}"

    def purge(self, retention_h: int | None = None) -> int:
        cutoff = time.time() - (retention_h or settings.raw_retention_h) * 3600
        removed = 0
        if not self.root.exists():
            return 0
        for dirpath, _dirs, files in os.walk(self.root):
            for fn in files:
                p = Path(dirpath) / fn
                try:
                    if p.stat().st_mtime < cutoff:
                        p.unlink()
                        removed += 1
                except OSError:
                    pass
        return removed
