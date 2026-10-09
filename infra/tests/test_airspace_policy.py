"""공역 자료 정책 시험(ADR-034 · SPEC F1) — 국토교통부 공역정보 지도자료(AIP 차수 기준 KMZ)는 저작물이라 공개 저장소에 넣지 않는다.

확인하는 것:
- 저장소가 추적하는 .kml · .kmz 는 합성 시험 자료(apps/collector/tests/fixtures/airspace/synthetic*.kml)뿐이고, 그 파일은 가짜 자료라고 밝힌다
- .gitignore 가 .kmz 를 무시한다(실수로 add 해도 잡히게 — git add -f 는 위 시험이 잡는다)
- make airspace-import 는 파일을 표준 입력으로만 넘긴다(컨테이너에 볼륨을 열지 않는다) · 격리 스택(make e2e · demo)은 합성 자료만 가져온다

실행: python3 -m unittest discover -s infra/tests -v
"""

from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ALLOWED = re.compile(r"^apps/collector/tests/fixtures/airspace/synthetic[\w-]*\.kml$")


def tracked(*patterns: str) -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z", "--", *patterns], cwd=ROOT, capture_output=True, check=True).stdout
    return [p for p in out.decode().split("\0") if p]


class AirspaceDataPolicy(unittest.TestCase):
    def test_only_the_synthetic_fixture_is_tracked(self) -> None:
        files = tracked("*.kml", "*.kmz", "*.KML", "*.KMZ")
        self.assertEqual([f for f in files if not ALLOWED.match(f)], [], "AIP 공역 자료(원본 · 파생)는 저장소에 넣지 않는다")
        for f in files:
            head = (ROOT / f).read_text(encoding="utf-8")[:2_000]
            self.assertIn("가짜 자료", head, f"{f}: 합성 자료임을 밝힌다")

    def test_gitignore_ignores_kmz(self) -> None:
        r = subprocess.run(["git", "check-ignore", "-q", "--no-index", "some/dir/AIP 25년 5차 기준.kmz"], cwd=ROOT)
        self.assertEqual(r.returncode, 0, ".gitignore 에 *.kmz")

    def test_make_targets_pass_the_file_on_stdin_and_isolated_stacks_use_the_synthetic_fixture(self) -> None:
        mk = (ROOT / "Makefile").read_text(encoding="utf-8")
        target = re.search(r"^airspace-import:.*?\n((?:\t.*\n)+)", mk, re.M)
        self.assertIsNotNone(target, "make airspace-import")
        body = target.group(1) if target else ""
        self.assertIn("exec -T collector python -m wakeline_collector.tools.airspace_import", body)
        self.assertRegex(body, r'< "\$\(f\)"')
        self.assertNotIn(" -v ", body)
        for name in ("e2e", "demo"):
            t = re.search(rf"^{name}:.*?\n((?:\t.*\n)+)", mk, re.M)
            self.assertIsNotNone(t, name)
            self.assertIn("$(AIRSPACE_FIXTURE_IMPORT)", t.group(1) if t else "", f"make {name} 은 합성 공역을 가져온다")
        self.assertRegex(mk, r"AIRSPACE_FIXTURE_IMPORT.*synthetic\.kml")


if __name__ == "__main__":
    unittest.main()
