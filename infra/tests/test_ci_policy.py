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

    # --- R-07: gitleaks 가 실패해도 이미지 스캔은 돈다 · 게이트는 보고만이 아니다 ---
    def test_image_build_runs_even_if_gitleaks_fails(self):
        st = steps(self.jobs["security"])
        gl = next(i for i, s in enumerate(st) if "gitleaks/gitleaks-action@" in s)
        build = next(i for i, s in enumerate(st) if s.startswith("id: build"))
        self.assertGreater(build, gl)
        self.assertRegex(st[build], r"(?m)^\s+if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}\s*$",
                         "build 에 if 가 없으면 gitleaks 실패 시 skipped 가 되고 trivy 3단계도 모두 건너뛴다")
        trivy = [s for s in st if "aquasecurity/trivy-action@" in s]
        self.assertEqual(len(trivy), 3)
        for s in trivy:
            with self.subTest(step=s.splitlines()[0]):
                self.assertIn("steps.build.outcome == 'success'", s)
                self.assertRegex(s, r'exit-code:\s*"1"', "자체 이미지는 차단(보고만 아님)")
                self.assertRegex(s, r"ignore-unfixed:\s*true")
                self.assertRegex(s, r'severity:\s*"HIGH,CRITICAL"')

    def test_gitleaks_allowlist_is_exact_fingerprints_only(self):
        """허용 목록은 시험용 가짜 값 2건의 정확한 지문뿐 — 정규식·경로 허용(.gitleaks.toml allowlist)은 없다."""
        ignore = ROOT / ".gitleaksignore"
        self.assertTrue(ignore.exists(), ".gitleaksignore 없음 — gitleaks 가 시험용 가짜 값 2건에서 실패한다")
        entries = [ln.strip() for ln in ignore.read_text().splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
        for e in entries:
            with self.subTest(entry=e):
                self.assertRegex(e, r"^[0-9a-f]{40}:[^:*?\[\]]+:[a-z0-9-]+:\d+$", "커밋:파일:규칙:줄 지문만(와일드카드 금지)")
        self.assertEqual(set(entries), {
            "5251859bac52838e622a55edd431727500aebb18:apps/collector/tests/test_ais_server.py:generic-api-key:35",
            "94ae84e2f28cfdc00835410d58b0780bccd791bd:apps/collector/tests/test_masking.py:jwt:12",
        })
        self.assertFalse((ROOT / ".gitleaks.toml").exists(), "넓은 허용 규칙 파일을 두지 않는다")

    def test_local_security_gate_uses_ci_matrix(self):
        """원격이 없어 CI 가 돈 적이 없다 — make security 가 같은 기준(차단 여부는 ci.yml 행렬)을 로컬에서 돌린다."""
        mk = (ROOT / "Makefile").read_text()
        self.assertRegex(mk, r"(?m)^security:.*\n\tbash tools/security_gate\.sh")
        gate = (ROOT / "tools" / "security_gate.sh").read_text()
        self.assertIn(".github/workflows/ci.yml", gate)
        self.assertIn("--ignore-unfixed --exit-code 1", gate)
        pattern = re.search(r"sed -nE '([^']+)' \.github/workflows/ci\.yml", gate)
        self.assertIsNotNone(pattern, "게이트가 ci.yml 행렬을 읽는다")
        sed_re = pattern.group(1).split("/")[1]  # s/<ERE>/\1 \2/p — 이 ERE 는 파이썬 re 로도 같게 읽힌다
        rows = [m.groups() for ln in self.jobs["third-party-images"].splitlines() if (m := re.search(sed_re, ln))]
        self.assertEqual({t for t, _ in rows}, set(re.findall(r"\{\s*target:\s*([\w-]+)\s*,", self.jobs["third-party-images"])))
        self.assertIn(("edge", "1"), rows)
        self.assertIn(("redis", "1"), rows)

    # --- R-41: 수집기의 실제 Redis 대조 시험(예산 Lua·ACL)이 CI 에서 건너뛰어지지 않는다 ---
    def test_collector_job_runs_real_redis_checks(self):
        st = steps(self.jobs["collector"])
        unit = next(i for i, s in enumerate(st) if "pytest" in s and "--cov-fail-under" in s)
        real = [i for i, s in enumerate(st) if "bash infra/tests/collector_redis_test.sh" in s]
        self.assertEqual(len(real), 1, "collector job 이 실제 Redis 대조 시험을 돌린다")
        self.assertGreater(real[0], unit)
        self.assertIn("working-directory: .", st[real[0]])
        self.assertNotIn("continue-on-error", st[real[0]])
        script = (ROOT / "infra" / "tests" / "collector_redis_test.sh").read_text()
        self.assertIn("infra/compose.yml", script, "compose 에 고정된 redis 이미지로")
        self.assertIn("tests/test_redis_integration.py tests/test_ais_redis_integration.py", script)
        self.assertRegex(script, r"grep -q[^\n]*skipped", "건너뛴 시험이 있으면 실패")

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
