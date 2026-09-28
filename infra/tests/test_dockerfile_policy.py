"""앱 Dockerfile 정책 시험 — 이미지를 빌드하지 않는다(빌드한 이미지 검사는 infra/tests/image_test.sh).

- R-25: api 힙 상한 = 컨테이너 메모리 한도의 40 %(ADR-017 §4) — compose 한도 1g 에서 약 410 MiB, NFR-03 예산 512 MB 안

실행: python3 -m unittest discover -s infra/tests -v
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCKERFILES = {app: ROOT / "apps" / app / "Dockerfile" for app in ("api", "web", "collector")}


def stages(text: str) -> list[str]:
    """FROM 으로 나눈 단계 본문(마지막이 실행 이미지)."""
    parts = re.split(r"(?m)^(?=FROM\s)", text)
    return [p for p in parts if p.startswith("FROM")]


def compose_memory_limit_mib(service: str) -> int:
    text = (ROOT / "infra" / "compose.yml").read_text()
    body = re.search(rf"(?ms)^  {service}:\n(.*?)(?=^  \S)", text).group(1)
    m = re.search(r"limits:\s*\{\s*memory:\s*(\d+)([mg])", body)
    assert m, f"{service} memory limit"
    return int(m.group(1)) * (1024 if m.group(2) == "g" else 1)


class ApiHeapTest(unittest.TestCase):
    """R-25: api 힙 비율 60 % → 40 %."""

    def test_heap_percentage_and_budget(self):
        runtime = stages(DOCKERFILES["api"].read_text())[-1]
        m = re.search(r'JAVA_TOOL_OPTIONS="[^"]*-XX:MaxRAMPercentage=(\d+(?:\.\d+)?)', runtime)
        self.assertIsNotNone(m, "실행 단계의 JAVA_TOOL_OPTIONS 에 MaxRAMPercentage")
        pct = float(m.group(1))
        self.assertEqual(pct, 40, "ADR-017 §4: 40 %")
        self.assertNotRegex(runtime, r"-Xmx", "상한은 비율 하나로만(컨테이너 한도를 따라간다)")
        heap = compose_memory_limit_mib("api") * pct / 100
        self.assertLessEqual(heap, 512, f"힙 상한 {heap:.0f} MiB 는 NFR-03 예산(512 MB) 안")


if __name__ == "__main__":
    unittest.main()
