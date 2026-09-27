"""원천 불변 보관: raw/{provider}/{yyyymmdd}/{hhmmss}.json.gz, 72 시간 뒤 삭제."""

from __future__ import annotations

import gzip
import os
import time
from datetime import UTC, datetime
from pathlib import Path

from skywx_collector.config import settings


class RawStore:
    def __init__(self, root: str | None = None):
        self.root = Path(root or settings.raw_dir)

    def save(self, provider: str, body: bytes, at: datetime | None = None) -> str:
        at = at or datetime.now(UTC)
        d = self.root / provider / at.strftime("%Y%m%d")
        try:
            d.mkdir(parents=True, exist_ok=True)
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
