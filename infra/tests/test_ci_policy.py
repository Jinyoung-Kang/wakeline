"""CI 워크플로(.github/workflows/ci.yml)·Dependabot 정책 시험 (GAP-7 · GAP-24 · NFR-10 · SEC-8).

YAML 파서 없이(표준 라이브러리만 — CI 러너의 python3 그대로) 줄 단위로 읽는다. 워크플로 구조를 바꾸면 이 시험도 함께 고친다.
확인하는 것:
- collector: 커버리지 바닥 80 % 이상, mypy 가 차단(continue-on-error 없음)
- api: gradle 테스트 뒤에 REST 계약 검사(tools/rest_contract_check.py --dir ../api/build/rest-samples)
- compose 의 모든 이미지가 스캔된다: wakeline-*:local 은 security job 의 Trivy, 제3자 이미지는 third-party-images 행렬
- 모든 서드파티 액션은 커밋 SHA(40자)로 고정, 기본 권한은 contents: read
- Dependabot 이 compose·Dockerfile·액션·세 앱 의존성을 모두 본다

실행: python3 -m unittest discover -s infra/tests -v
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CI = ROOT / ".github" / "workflows" / "ci.yml"
DEPENDABOT = ROOT / ".github" / "dependabot.yml"
COMPOSE = ROOT / "infra" / "compose.yml"


def jobs(text: str) -> dict[str, str]:
    """jobs: 아래 2칸 들여쓴 job 이름 → 그 job 의 본문 텍스트."""
    body = text.split("\njobs:\n", 1)[1]
    parts = re.split(r"^  ([A-Za-z0-9_-]+):\s*$", body, flags=re.M)
    return {parts[i]: parts[i + 1] for i in range(1, len(parts) - 1, 2)}


def steps(job: str) -> list[str]:
    """job 본문의 steps 를 '- ' 로 시작하는 항목 단위로 자른다(6칸 들여쓰기)."""
    body = job.split("    steps:\n", 1)[1]
    return [s for s in re.split(r"^      - ", body, flags=re.M) if s.strip()]


def compose_images() -> dict[str, str]:
    """compose.yml 의 서비스 → image (services: 아래 2칸 들여쓴 이름과 그 아래 4칸 image:)."""
    out: dict[str, str] = {}
    svc = None
    in_services = False
    for line in COMPOSE.read_text().splitlines():
        if re.match(r"^services:\s*$", line):
            in_services = True
            continue
        if in_services and re.match(r"^\S", line):
            in_services = False
        if not in_services:
            continue
        m = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if m:
            svc = m.group(1)
            continue
        m = re.match(r"^    image:\s*(\S+)", line)
        if m and svc:
            out[svc] = m.group(1)
    return out


class CiPolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = CI.read_text()
        cls.jobs = jobs(cls.text)

    def test_least_privilege_default_permissions(self):
        self.assertRegex(self.text, r"(?m)^permissions:\s*\{\s*contents:\s*read\s*\}\s*$")

    def test_actions_pinned_by_commit_sha(self):
        uses = re.findall(r"uses:\s*([^\s#]+)", self.text)
        self.assertTrue(uses)
        for u in uses:
            with self.subTest(uses=u):
                self.assertRegex(u, r"^[\w.-]+/[\w./-]+@[0-9a-f]{40}$", "태그가 아니라 커밋 SHA 로 고정")

    # --- GAP-7 ---
    def test_collector_coverage_floor_is_at_least_80(self):
        m = re.search(r'COLLECTOR_COV_MIN:\s*"?(\d+)"?', self.jobs["collector"])
        self.assertIsNotNone(m)
        self.assertGreaterEqual(int(m.group(1)), 80)
        self.assertIn('--cov-fail-under="$COLLECTOR_COV_MIN"', self.jobs["collector"])

    def test_collector_mypy_is_blocking(self):
        mypy = [s for s in steps(self.jobs["collector"]) if "mypy" in s]
        self.assertEqual(len(mypy), 1)
        self.assertNotIn("continue-on-error", mypy[0])

    # --- GAP-24 ---
    def test_api_job_runs_rest_contract_after_tests(self):
        st = steps(self.jobs["api"])
        gradle = next(i for i, s in enumerate(st) if "./gradlew" in s and " test" in s)
        rest = next(i for i, s in enumerate(st) if "rest_contract_check.py --dir ../api/build/rest-samples" in s)
        self.assertGreater(rest, gradle, "api 테스트(RestSamplesIT)가 응답을 기록한 뒤에 검사")
        self.assertIn("working-directory: apps/collector", st[rest])
        self.assertIn("uv sync --locked", st[rest])
        self.assertTrue(any("setup-uv@" in s for s in st[:rest]), "uv 설치가 먼저")
        self.assertNotIn("continue-on-error", st[rest])

    # --- NFR-10 · SEC-8: 모든 이미지 스캔 ---
    def test_every_compose_image_is_scanned(self):
        images = compose_images()
        self.assertIn("ais", images, "ais 서비스가 compose 에 있다")
        own = {img for img in images.values() if img.startswith("wakeline-")}
        security = self.jobs["security"]
        for img in own:
            with self.subTest(image=img):
                self.assertRegex(security, rf'image-ref:\s*"{re.escape(img)}".*exit-code:\s*"1"', "자체 이미지는 차단 스캔")
                name = img.split(":")[0].removeprefix("wakeline-")
                self.assertRegex(security, rf"build [^\n]*\b{name}\b", f"{img} 를 빌드한 뒤 스캔")
        targets = set(re.findall(r"\{\s*target:\s*([\w-]+)\s*,", self.jobs["third-party-images"]))
        third = {svc for svc, img in images.items() if not img.startswith("wakeline-")}
        self.assertTrue(third)
        self.assertLessEqual(third, targets, f"제3자 이미지 서비스가 스캔 행렬에 없음: {third - targets}")
        self.assertIn("k6", targets, "make bench 의 k6 도 스캔")

    def test_e2e_runs_the_isolated_stack(self):
        self.assertIn("make e2e", self.jobs["e2e"])
        self.assertRegex(self.jobs["e2e"], r"needs:\s*\[[^\]]*infra[^\]]*\]")

    def test_infra_job_runs_policy_and_container_tests(self):
        self.assertIn("make -s test-infra", self.jobs["infra"])
        self.assertIn("make -s infra-docker-test", self.jobs["infra"])


class DependabotPolicyTest(unittest.TestCase):
    def test_every_ecosystem_is_watched(self):
        t = DEPENDABOT.read_text()
        for eco, where in (("npm", "/apps/web"), ("uv", "/apps/collector"), ("gradle", "/apps/api"),
                           ("docker-compose", "/infra"), ("github-actions", "/")):
            with self.subTest(ecosystem=eco):
                self.assertRegex(t, rf"package-ecosystem:\s*{re.escape(eco)}\s*\n\s*director(y|ies):[^\n]*{re.escape(where)}")
        m = re.search(r"package-ecosystem:\s*docker\s*\n\s*directories:\s*\[([^\]]*)\]", t)
        self.assertIsNotNone(m)
        for d in ("/apps/api", "/apps/web", "/apps/collector"):
            self.assertIn(d, m.group(1))


if __name__ == "__main__":
    unittest.main()
