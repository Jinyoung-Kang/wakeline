from __future__ import annotations

from dataclasses import dataclass

from wakeline_collector.budget import Budget
from wakeline_collector.db import Db
from wakeline_collector.publisher import Publisher
from wakeline_collector.raw_store import RawStore
from wakeline_collector.runtime_settings import RuntimeSettings
from wakeline_collector.status import ProviderStatus


@dataclass
class JobContext:
    budget: Budget
    db: Db
    publisher: Publisher
    raw: RawStore
    status: ProviderStatus
    rt: RuntimeSettings
    fixture: bool
