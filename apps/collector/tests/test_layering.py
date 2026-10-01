"""수집기 import 방향 가드(collector-review §2.1 · PLAN Phase 0) — 표준 라이브러리 ast 만 쓴다(새 도구 없음).

층(아래로만 import 한다):
  entry     실행 진입 — main · ais.main · health · __main__ · tools
  jobs      조율 — 예약 → 어댑터 호출 → 규칙으로 판정 → 어댑터로 쓰기
  adapters  입출력 — Redis · HTTP(providers 포함) · Postgres · 파일 · 환경 변수(config)
  rules     순수 규칙 — 입출력 없음(모델 · 파서 · 판정)

규칙:
1. 어느 모듈도 자기 층보다 위 층을 import 하지 않는다.
2. jobs 사이에는 jobs.context(주입 묶음)만 — 그리고 설계상 jobs.demand → jobs.route.
3. entry 모듈을 import 하는 것은 같은 패키지의 __main__ 뿐이다(X.__main__ → X.main).
4. 규칙 모듈은 공통 규칙(KERNEL)이나 같은 기능의 규칙만 import 한다(기능 사이 의존 금지).
5. 다른 모듈의 비공개 이름(_x)을 import 하지 않는다.
6. ais 패키지는 격벽이다(ais/__init__.py): ais 밖에서는 AIS_SHARED 만 import 한다.

오늘의 위반(collector-review §1.4)은 ALLOWED 에 적었다. 새 위반은 실패하고, 고친 위반이 ALLOWED 에 남아도 실패한다 — 목록은 줄어들기만 한다.
새 모듈은 층(과 규칙 모듈이면 기능)을 정해야 한다 — 정하지 않으면 실패한다. 함수 안의(늦은) import 도 센다.
"""

from __future__ import annotations

import ast
from pathlib import Path

PKG = "wakeline_collector"
ROOT = Path(__file__).resolve().parents[1] / PKG

ENTRY, JOBS, ADAPTERS, RULES = "entry", "jobs", "adapters", "rules"
RANK = {RULES: 0, ADAPTERS: 1, JOBS: 2, ENTRY: 3}

# 규칙 모듈 → 기능. KERNEL 은 어느 규칙이든 import 할 수 있는 공통 규칙이다(KERNEL 은 KERNEL 만 import 한다).
KERNEL = "kernel"
RULE_FEATURES: dict[str, str] = {
    "": KERNEL,  # 패키지 __init__ (버전 글자뿐)
    "models": KERNEL,
    "geo": KERNEL,
    "masking": KERNEL,
    "gz": KERNEL,
    "errors": KERNEL,
    "http_errors": KERNEL,
    "send_outcome": KERNEL,
    "budget_rules": KERNEL,
    "textutil": KERNEL,
    "retry": KERNEL,
    "fallback": KERNEL,
    "ratelimit": KERNEL,
    "scheduler": KERNEL,
    "normalize": "aircraft",
    "quality": "aircraft",
    "sigmet_parse": "weather",
    "flight_category": "weather",
    "kma_grid": "kma",
    "marine_grid": "marine",
    "grid_tiles": "marine",
    "traffic_grid": "marine",
    "portcalls": "portcalls",
    "route": "route",
    "ais": "ais",
    "ais.parse": "ais",
    "ais.book": "ais",
    "ais.bbox": "ais",
    "ais.backoff": "ais",
    "ais.queue": "ais",
    "ais.feed": "ais",
    "ais.shards": "ais",
    "ais.reconnect": "ais",
    "ais.diag": "ais",
}
LAYERS: dict[str, str] = {m: RULES for m in RULE_FEATURES} | {
    # entry
    "__main__": ENTRY,
    "main": ENTRY,
    "health": ENTRY,
    "ais.__main__": ENTRY,
    "ais.main": ENTRY,
    "ais.health": ENTRY,
    "tools": ENTRY,
    "tools.snapshot": ENTRY,
    # adapters
    "config": ADAPTERS,
    "http": ADAPTERS,
    "budget": ADAPTERS,
    "status": ADAPTERS,
    "chain_store": ADAPTERS,
    "publisher": ADAPTERS,
    "runtime_settings": ADAPTERS,
    "demand": ADAPTERS,
    "raw_store": ADAPTERS,
    "db": ADAPTERS,
    "logsink": ADAPTERS,
    "redis_retry": ADAPTERS,
    "ais.client": ADAPTERS,
    "ais.pool": ADAPTERS,
    "ais.sink": ADAPTERS,
    "ais.runtime": ADAPTERS,
    "ais.replay": ADAPTERS,
    "ais.worker": ADAPTERS,
    "ais.config": ADAPTERS,
}
LAYER_BY_PREFIX = {"jobs": JOBS, "providers": ADAPTERS}
JOBS_SHARED = {"jobs", "jobs.context"}
JOBS_DESIGNED = {("jobs.demand", "jobs.route")}  # 선택 항공기 노선 조회를 demand 가 이어 부른다(collector-review §2.1)
AIS_SHARED = {"geo", "masking", "logsink", "publisher", "redis_retry"}

# 오늘의 위반(collector-review §1.4 의 1 · 2 · 3 · 4 · 6 — PLAN §2.4 의 '6곳', retry 는 import 둘) — (import 하는 모듈, import 되는 것, 규칙).
# 고치면 지운다(PLAN Phase 3B).
ALLOWED: set[tuple[str, str, str]] = {
    ("fallback", "status", "layer"),  # 3B-7 chain_state — 판정 상태기계가 Redis 어댑터를 품는다
    ("fallback", "chain_store", "layer"),  # 3B-7
}


def _modules(root: Path) -> dict[str, Path]:
    """모듈 이름('wakeline_collector.' 을 뗀 것 — 패키지 자신은 빈 글자) → 파일."""
    out: dict[str, Path] = {}
    for p in sorted(root.rglob("*.py")):
        parts = list(p.relative_to(root).with_suffix("").parts)
        if parts[-1] == "__init__":
            parts.pop()
        out[".".join(parts)] = p
    return out


def _layer(m: str) -> str | None:
    if m in LAYERS:
        return LAYERS[m]
    return LAYER_BY_PREFIX.get(m.split(".", 1)[0])


def _imports(m: str, path: Path, modules: dict[str, Path]) -> list[tuple[str, str]]:
    """m 이 import 하는 패키지 안 모듈 — (모듈, 비공개 이름이면 그 이름 · 아니면 빈 글자). 함수 안의 import 도 센다."""
    here = m.split(".") if m else []
    if path.name != "__init__.py":
        here = here[:-1]
    out: list[tuple[str, str]] = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"), str(path))):
        if isinstance(node, ast.Import):
            out += [(a.name.removeprefix(PKG).lstrip("."), "") for a in node.names if a.name.split(".")[0] == PKG]
        elif isinstance(node, ast.ImportFrom):
            if node.level:  # 상대 import(지금은 없다)
                parts = here[: len(here) - (node.level - 1)] + ([node.module] if node.module else [])
                base = ".".join(parts)
            elif (node.module or "").split(".")[0] == PKG:
                base = (node.module or "").removeprefix(PKG).lstrip(".")
            else:
                continue
            for a in node.names:
                sub = f"{base}.{a.name}" if base else a.name
                if sub in modules:
                    out.append((sub, ""))
                else:
                    out.append((base, a.name if a.name.startswith("_") and not a.name.startswith("__") else ""))
    return out


def _own_main(m: str, target: str) -> bool:
    """X.__main__ → X.main(실행 진입이 같은 패키지의 main 을 부른다)."""
    pkg = m.rsplit(".", 1)[0] if "." in m else ""
    return m.endswith("__main__") and target == (f"{pkg}.main" if pkg else "main")


def _violations(modules: dict[str, Path]) -> set[tuple[str, str, str]]:
    found: set[tuple[str, str, str]] = set()
    for m, path in modules.items():
        src = _layer(m)
        assert src is not None, f"unclassified module {m}"
        for target, private in _imports(m, path, modules):
            if target == m:
                continue
            if private:
                found.add((m, f"{target}.{private}", "private"))
            dst = _layer(target)
            assert dst is not None, f"{m} imports unclassified {target}"
            if RANK[dst] > RANK[src]:
                found.add((m, target, "layer"))
            elif src == dst == JOBS and target not in JOBS_SHARED and (m, target) not in JOBS_DESIGNED:
                found.add((m, target, "jobs"))
            elif dst == ENTRY and not _own_main(m, target):
                found.add((m, target, "entry"))
            elif src == dst == RULES and RULE_FEATURES[target] not in (KERNEL, RULE_FEATURES[m]):
                found.add((m, target, "feature"))
            if m.split(".")[0] == "ais" and target.split(".")[0] != "ais" and target not in AIS_SHARED:
                found.add((m, target, "ais"))
    return found


MODULES = _modules(ROOT)


def test_every_module_has_a_layer_and_every_rule_module_a_feature():
    unclassified = sorted(m for m in MODULES if _layer(m) is None)
    assert unclassified == [], f"새 모듈의 층을 test_layering.LAYERS 에 정한다: {unclassified}"
    stale = sorted(m for m in LAYERS if m not in MODULES)
    assert stale == [], f"없어진 모듈을 LAYERS · RULE_FEATURES 에서 지운다: {stale}"


def test_no_new_import_violations():
    new = sorted(_violations(MODULES) - ALLOWED)
    assert new == [], f"import 방향 위반(층 · 기능 · 비공개 이름 · ais 격벽 — 이 파일 설명): {new}"


def test_fixed_violations_leave_the_allow_list():
    fixed = sorted(ALLOWED - _violations(MODULES))
    assert fixed == [], f"고친 위반을 ALLOWED 에서 지운다(목록은 줄어들기만 한다): {fixed}"


def test_the_guard_sees_each_kind_of_violation(tmp_path):
    """가드 자체의 시험: 층 · jobs 사이 · entry · 기능 · 비공개 이름 · ais 격벽 위반을 하나씩 심은 가짜 패키지에서 모두(그리고 그것만) 찾는다."""
    files = {
        "__init__.py": "",
        "__main__.py": "from wakeline_collector.main import run\n",  # 허용: 같은 패키지의 main
        "models.py": "",
        "geo.py": "from wakeline_collector.models import M\n",  # 허용: 규칙 → 공통 규칙
        "masking.py": "from wakeline_collector.http import x\n",  # rules → adapters
        "route.py": "",
        "portcalls.py": "def f():\n    from wakeline_collector import route\n",  # 기능 사이(함수 안 import)
        "http.py": "from wakeline_collector.jobs.aircraft import y\n",  # adapters → jobs
        "publisher.py": "from wakeline_collector import geo\n",  # 허용: 어댑터 → 규칙
        "main.py": "import wakeline_collector.jobs.aircraft\n",  # 허용: entry → jobs
        "health.py": "from wakeline_collector.main import z\n",  # entry → entry
        "jobs/__init__.py": "",
        "jobs/context.py": "",
        "jobs/demand.py": "from wakeline_collector.jobs.route import R\n",  # 허용: 설계
        "jobs/route.py": "",
        "jobs/aircraft.py": "from wakeline_collector.jobs.context import C\nfrom wakeline_collector.jobs.weather import W\n",
        "jobs/weather.py": "",
        "ais/__init__.py": "",
        "ais/sink.py": "from wakeline_collector.publisher import _size\nfrom wakeline_collector.http import q\n",
    }
    for name, body in files.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text(body)
    assert _violations(_modules(tmp_path)) == {
        ("masking", "http", "layer"),
        ("portcalls", "route", "feature"),
        ("http", "jobs.aircraft", "layer"),
        ("health", "main", "entry"),
        ("jobs.aircraft", "jobs.weather", "jobs"),
        ("ais.sink", "publisher._size", "private"),
        ("ais.sink", "http", "ais"),
    }
