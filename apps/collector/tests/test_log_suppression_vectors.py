"""계약 v5 §G9 — 언어 간 억제 벡터(schemas/vectors/log-suppression.v1.json)의 모양 검사(tools/contract_check.py)가
틀린 벡터를 실제로 잡는지. 벡터가 나중에 고쳐져도 단계 누계 · 발생 번호 · 마지막 close · 불변식(항목 수 + suppressed 합 = 발생 수)이
어긋나면 계약 검사가 실패해야 한다. 싱크가 벡터를 따르는지는 test_logsink.py(Python) · LogSinkTest(Java)가 본다."""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
VECTORS = ROOT / "schemas" / "vectors" / "log-suppression.v1.json"
_spec = importlib.util.spec_from_file_location("contract_check", ROOT / "tools" / "contract_check.py")
assert _spec and _spec.loader
cc = importlib.util.module_from_spec(_spec)
sys.modules["contract_check"] = cc
_spec.loader.exec_module(cc)


def committed() -> dict:
    return json.loads(VECTORS.read_text(encoding="utf-8"))


def test_the_committed_vectors_are_well_formed():
    doc = committed()
    assert cc.log_suppression_vector_problems(doc) == []
    assert doc["version"] == 1 and doc["window_ms"] == 10_000
    assert len(doc["cases"]) >= 8
    # 모든 동작(occur · tick · close)과 지문 둘인 사례가 있다
    assert {s["do"] for c in doc["cases"] for s in c["steps"]} == {"occur", "tick", "close"}
    assert any(s.get("fp") == "b" for c in doc["cases"] for s in c["steps"])
    assert cc.check_log_suppression_vectors() == 0


def _broken(edit) -> list[str]:
    doc = copy.deepcopy(committed())
    edit(doc)
    return cc.log_suppression_vector_problems(doc)


def _twice(doc: dict) -> dict:
    return next(c for c in doc["cases"] if c["name"].startswith("twice inside one window"))


def _claim_one_more_suppressed(case: dict) -> None:
    """누계는 서로 맞지만(단계마다 emit 합 = 누계) 발생 2번에 항목 2 · suppressed 1 — 불변식만 어긋난다."""
    steps = case["steps"]
    steps[3].update(emit=[[1, 1]], suppressed=1)  # 창이 닫힐 때 실은 두 번째 발생
    steps[4].update(suppressed=1)


@pytest.mark.parametrize(
    "what,edit,needle",
    [
        ("wrong version", lambda d: d.update(version=2), "version"),
        ("no window", lambda d: d.pop("window_ms"), "window_ms"),
        ("no cases", lambda d: d.update(cases=[]), "cases"),
        ("unknown action", lambda d: _twice(d)["steps"][1].update(do="flush"), "do"),
        ("time goes back", lambda d: _twice(d)["steps"][2].update(at_ms=3000), "at_ms"),
        ("running total off", lambda d: _twice(d)["steps"][3].update(entries=3), "entries"),
        ("suppressed total off", lambda d: _twice(d)["steps"][3].update(suppressed=1), "suppressed"),
        ("emit names a future occurrence", lambda d: _twice(d)["steps"][0].update(emit=[[1, 0]]), "occurrence"),
        ("an occurrence emitted twice", lambda d: _twice(d)["steps"][4].update(emit=[[1, 0]], entries=3), "twice"),
        ("negative suppressed", lambda d: _twice(d)["steps"][3].update(emit=[[1, -1]], suppressed=-1), "suppressed"),
        ("does not end with close", lambda d: _twice(d)["steps"].pop(), "close"),
        ("close in the middle", lambda d: _twice(d)["steps"][2].update(do="close"), "close"),
        ("fp on a tick", lambda d: _twice(d)["steps"][2].update(fp="a"), "fp"),
        ("unknown key", lambda d: _twice(d)["steps"][2].update(note="x"), "key"),
        ("invariant broken", lambda d: _claim_one_more_suppressed(_twice(d)), "invariant"),
    ],
)
def test_malformed_vectors_are_caught(what, edit, needle):
    problems = _broken(edit)
    assert problems, what
    assert any(needle in p for p in problems), (what, problems)
