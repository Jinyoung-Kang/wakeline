from __future__ import annotations

from dataclasses import dataclass

from skywx_collector.budget import Budget
from skywx_collector.db import Db
from skywx_collector.publisher import Publisher
from skywx_collector.raw_store import RawStore
from skywx_collector.runtime_settings import RuntimeSettings
from skywx_collector.status import ProviderStatus


@dataclass
class JobContext:
    budget: Budget
    db: Db
    publisher: Publisher
    raw: RawStore
    status: ProviderStatus
    rt: RuntimeSettings
    fixture: bool
