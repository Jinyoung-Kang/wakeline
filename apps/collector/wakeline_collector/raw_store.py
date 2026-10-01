"""원천 불변 보관: raw/{provider}/{yyyymmdd}/{hhmmss}.json.gz, 72 시간 뒤 삭제.

- 본문이 이미 gzip 이면(\x1f\x8b 로 시작 — KMA 레이더 바이너리) 다시 압축하지 않고 그대로 .bin.gz 로 쓴다(R-21).
- 압축·파일 쓰기는 동기 작업이다. 작업 코드는 archive() 로 스레드에서 부른다(이벤트 루프를 수십 ms 막지 않게, R-21).
- 보관 · 정리 실패는 수집을 막지 않지만 조용하지도 않다(F6): 실패마다 센다(heartbeat raw_unsaved · raw_purge_failed — 기동 뒤 누계) · WARN 은 종류마다
  분에 한 번(WARN_EVERY_S — 그때까지의 누계를 싣는다). 가득 차거나 읽기 전용인 볼륨이 보관을 멈추면 로그 화면과 heartbeat 에 드러난다.
"""

from __future__ import annotations

import asyncio
import gzip
import logging
import os
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

from wakeline_collector.config import settings

GZIP_MAGIC = b"\x1f\x8b"
WARN_EVERY_S = 60.0  # 같은 종류(보관 · 정리) 실패 WARN 의 최소 간격 — 다른 Redis · DB 도우미와 같은 분당 한 번

log = logging.getLogger("raw_store")


class _Saver(Protocol):
    def save(self, provider: str, body: bytes, at: datetime | None = None) -> str: ...


async def archive(store: _Saver, provider: str, body: bytes, at: datetime | None = None) -> str:
    """원천 보관을 이벤트 루프 밖(스레드)에서 한다. 반환: raw_ref."""
    return await asyncio.to_thread(store.save, provider, body, at)


class RawStore:
    def __init__(self, root: str | None = None):
        self.root = Path(root or settings.raw_dir)
        self.unsaved = 0  # 보관하지 못한 본문 수(기동 뒤 누계 — heartbeat raw_unsaved)
        self.purge_failed = 0  # 지우거나 읽지 못한 파일 · 디렉터리 수(기동 뒤 누계 — heartbeat raw_purge_failed)
        self._lock = threading.Lock()  # save 는 여러 스레드에서 돈다(archive)
        self._warned_at: dict[str, float] = {}

    def _failed(self, kind: str, what: str, e: OSError) -> None:
        """보관('save') · 정리('purge') 실패 하나: 세고, 그 종류의 마지막 WARN 에서 WARN_EVERY_S 가 지났으면 WARN 한 줄(누계 포함)."""
        with self._lock:
            if kind == "save":
                self.unsaved += 1
                total = f"{self.unsaved} unsaved since start"
            else:
                self.purge_failed += 1
                total = f"{self.purge_failed} not purged since start"
            now = time.monotonic()
            last = self._warned_at.get(kind)
            if last is not None and now - last < WARN_EVERY_S:
                return
            self._warned_at[kind] = now
        log.warning(
            "raw archive: could not %s %s (%s: %s) — %s; collection goes on", kind, what, type(e).__name__, e.strerror or e, total
        )

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
        except OSError as e:  # 보관 실패는 수집을 막지 않는다 — ingest_run 에 raw_ref 없이 기록(세고 WARN — _failed)
            self._failed("save", provider, e)
            return f"unsaved:{type(e).__name__}"

    def purge(self, retention_h: int | None = None) -> int:
        cutoff = time.time() - (retention_h or settings.raw_retention_h) * 3600
        removed = 0
        if not self.root.exists():
            return 0
        for dirpath, _dirs, files in os.walk(self.root, onerror=lambda e: self._failed("purge", str(e.filename or self.root), e)):
            for fn in files:
                p = Path(dirpath) / fn
                try:
                    if p.stat().st_mtime < cutoff:
                        p.unlink()
                        removed += 1
                except FileNotFoundError:
                    pass  # 그 사이 사라졌다(다른 정리) — 실패가 아니다
                except OSError as e:
                    self._failed("purge", str(p.relative_to(self.root)), e)
        return removed
