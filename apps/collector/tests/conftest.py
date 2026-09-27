import os
from pathlib import Path

os.environ.setdefault("FIXTURES_DIR", str(Path(__file__).resolve().parents[3] / "fixtures"))
os.environ.setdefault("SCHEMAS_DIR", str(Path(__file__).resolve().parents[3] / "schemas"))

import pytest  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="session")
def fixtures_dir() -> Path:
    return ROOT / "fixtures"


@pytest.fixture(scope="session")
def schemas_dir() -> Path:
    return ROOT / "schemas"
