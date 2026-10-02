"""앱 Dockerfile 정책 시험 — 이미지를 빌드하지 않는다(빌드한 이미지 검사는 infra/tests/image_test.sh).

- R-25: api 힙 상한 = 컨테이너 메모리 한도의 40 %(ADR-017 §4) — compose 한도 1g 에서 약 410 MiB, NFR-03 예산 512 MB 안
- S11 · L-8: 수집기 이미지는 uv.lock 그대로 설치(uv sync --locked), 저장소 루트를 빌드 컨텍스트로 쓰는 이미지는 루트 .dockerignore 로 비밀값 · 큰 산출물을 뺀다

실행: python3 -m unittest discover -s infra/tests -v
"""
from __future__ import annotations

import re
import subprocess
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


class ApiNativeMemoryTest(unittest.TestCase):
    """R-25 후속: 힙 비율만으로는 NFR-03(≤ 512 MB)에 닿지 않았다 — 실측 RSS 610–628 MiB 중 JVM NMT 가 센 것은 427 MiB,
    나머지 약 160 MiB 는 glibc malloc 아레나가 쥐고 있던 메모리였다. MALLOC_ARENA_MAX=2 로 경합 기록이 없는 k6 실행에서 497–501 MiB(실측)."""

    def test_malloc_arena_cap_in_runtime_stage(self):
        runtime = stages(DOCKERFILES["api"].read_text())[-1]
        self.assertRegex(runtime, r"(?m)^ENV\b.*\bMALLOC_ARENA_MAX=2\b", "실행 단계 ENV 에 MALLOC_ARENA_MAX=2")


class CollectorNativeMemoryTest(unittest.TestCase):
    """리뷰 4단계: collector 도 작업 스레드(asyncio.to_thread 기본 풀, 최대 8)마다 glibc 아레나를 따로 쥐어 RSS 가 계단식으로 늘었다
    (기본 설정 재기동 뒤 40분에 RssAnon 99 → 289–298 MiB). api(R-25 후속)와 같이 아레나를 2개로 묶는다 — ais 도 같은 이미지다."""

    def test_malloc_arena_cap_in_runtime_stage(self):
        runtime = stages(DOCKERFILES["collector"].read_text())[-1]
        self.assertRegex(runtime, r"(?m)^ENV\b.*\bMALLOC_ARENA_MAX=2\b")




class EdgeImageTest(unittest.TestCase):
    """edge(nginx) — 상류 nginxinc/nginx-unprivileged 를 다이제스트로 고정하고, 빌드 때 Alpine 보안 갱신(apk upgrade)만 얹는다. 상류가 고친 패키지로
    다시 빌드하기 전에도 고칠 수 있는 HIGH 가 남지 않게(2026-10-02 CI trivy: pcre2 CVE-2026-103111). 실행은 그대로 비root uid 101."""

    def test_edge_dockerfile_pins_upstream_and_takes_security_updates(self):
        path = ROOT / "infra" / "edge" / "Dockerfile"
        self.assertTrue(path.exists(), "infra/edge/Dockerfile 없음 — edge 가 상류 이미지를 그대로 쓴다")
        text = path.read_text()
        froms = re.findall(r"(?mi)^FROM\s+(\S+)", text)
        self.assertEqual(len(froms), 1)
        self.assertRegex(froms[0], r"^nginxinc/nginx-unprivileged:[\w.-]+@sha256:[0-9a-f]{64}$")
        runs = " ".join(re.findall(r"(?m)^RUN\s+(.*)$", re.sub(r"\\\n", " ", text)))
        self.assertRegex(runs, r"apk upgrade --no-cache")
        users = re.findall(r"(?m)^USER\s+(\S+)", text)
        self.assertEqual(users[-1], "101", "마지막 USER 는 비root 101(nginx)")

class CollectorPythonVersionTest(unittest.TestCase):
    """CI(setup-uv · `uv run`)는 프로젝트의 .python-version 을 따른다 — 없으면 requires-python(>=3.13)을 만족하는 가장 새 판을 받는다(2026-10-02 CI:
    CPython 3.14.8, 운영 이미지는 3.13). 시험이 운영과 같은 파이썬에서 돌게 이미지의 판과 묶는다."""

    def test_python_version_file_matches_the_image(self):
        pin = ROOT / "apps" / "collector" / ".python-version"
        self.assertTrue(pin.exists(), "apps/collector/.python-version 없음 — CI 가 운영과 다른 파이썬으로 시험한다")
        image = re.search(r"(?m)^FROM python:(\d+\.\d+)-slim@", DOCKERFILES["collector"].read_text())
        self.assertIsNotNone(image)
        self.assertEqual(pin.read_text().strip(), image.group(1))

class RuntimeToolsTest(unittest.TestCase):
    """R-29: 실행 이미지에 쓰지 않는 패키지 관리자를 남기지 않는다(web·collector 의 HIGH 취약점 전부의 출처). 빌드한 이미지는 image_test.sh 가 본다."""

    def test_web_runtime_drops_npm_corepack_yarn(self):
        runtime = stages(DOCKERFILES["web"].read_text())[-1]
        rm = " ".join(re.findall(r"(?m)^RUN\s+(.*)$", re.sub(r"\\\n", " ", runtime)))  # 줄 이음(\)을 합친 RUN 명령들
        for path in ("/usr/local/lib/node_modules/npm", "/usr/local/lib/node_modules/corepack", "/usr/local/bin/npm",
                     "/usr/local/bin/npx", "/usr/local/bin/corepack", "/usr/local/bin/yarn", "/usr/local/bin/yarnpkg", "/opt/yarn-"):
            with self.subTest(path=path):
                self.assertIn(path, rm)
        self.assertNotRegex(runtime, r"(?m)^(RUN|CMD|ENTRYPOINT)[^\n]*\b(npm|npx|yarn|corepack)\s+(run|start|exec)\b", "실행 단계는 node 만 쓴다")

    def test_collector_runtime_drops_pip(self):
        runtime = stages(DOCKERFILES["collector"].read_text())[-1]
        self.assertRegex(runtime, r"(?m)^RUN\s[^\n]*python -m pip uninstall -y pip")
        self.assertLess(runtime.index("pip uninstall"), runtime.index("USER app"), "root 로 지운 뒤 비root 로 내려간다")


    def test_debian_and_ubuntu_runtimes_take_security_updates_at_build(self):
        """2026-10-01 최종 검증: 다이제스트로 고정한 기반 이미지(R-85)가 나온 뒤 고쳐진 OS 보안 갱신(openssl · pcre2 — 고칠 수 있는 HIGH, 같은 기반의 새
        다이제스트는 아직 없었다)이 api · collector 이미지에 남아 Trivy 게이트가 실패했다. db 와 같이 실행 단계에서 apt-get upgrade 하고 목록은 지운다."""
        for name, path in (("api", DOCKERFILES["api"]), ("collector", DOCKERFILES["collector"]), ("db", ROOT / "infra" / "db" / "Dockerfile")):
            runtime = stages(path.read_text())[-1]
            joined = " ".join(re.findall(r"(?m)^RUN\s+(.*)$", re.sub(r"\\\n", " ", runtime)))
            with self.subTest(image=name):
                self.assertRegex(joined, r"apt-get update[^\n]*apt-get upgrade -y")
                self.assertIn("rm -rf /var/lib/apt/lists/*", joined)


PINNED = re.compile(r"^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$")


class BaseImagePinningTest(unittest.TestCase):
    """R-85: 기반 이미지·빌드 도구 이미지(FROM · COPY --from=<이미지> · # syntax=)를 태그+다이제스트로 고정 — 같은 커밋이면 같은 기반."""

    def test_every_external_image_reference_is_pinned(self):
        for app, path in DOCKERFILES.items():
            text = path.read_text()
            names = set(re.findall(r"(?mi)^FROM\s+\S+\s+AS\s+(\S+)", text))
            refs = re.findall(r"(?mi)^FROM\s+(\S+)", text) + re.findall(r"(?mi)^COPY\s+--from=(\S+)", text)
            refs += re.findall(r"(?m)^#\s*syntax=(\S+)", text)
            external = [r for r in refs if r not in names]
            self.assertTrue(external)
            for ref in external:
                with self.subTest(app=app, ref=ref):
                    self.assertRegex(ref, PINNED, "tag@sha256:<64 hex>")

    def test_same_base_is_pinned_to_the_same_digest(self):
        """한 파일 안에서 같은 태그는 같은 다이제스트(빌드·실행 단계가 어긋나지 않게)."""
        for app, path in DOCKERFILES.items():
            seen: dict[str, str] = {}
            for ref in re.findall(r"(?mi)^FROM\s+(\S+@sha256:[0-9a-f]{64})", path.read_text()):
                tag, digest = ref.split("@")
                with self.subTest(app=app, tag=tag):
                    self.assertEqual(seen.setdefault(tag, digest), digest)


class CollectorLockedInstallTest(unittest.TestCase):
    """S11 · L-8: 이미지 빌드도 CI(uv sync --locked)처럼 uv.lock 을 그대로 설치한다. uv.lock* 글롭은 파일이 없어도 COPY 가 통과하고,
    --locked 가 없으면 빠졌거나 pyproject 와 어긋난 lock 을 빌드 안에서 조용히 다시 풀어(resolve) 시험하지 않은 버전이 들어간다."""

    def test_uv_lock_is_copied_as_a_required_file(self):
        text = DOCKERFILES["collector"].read_text()
        copies = [ln for ln in text.splitlines() if re.match(r"COPY\s", ln) and "uv.lock" in ln]
        self.assertEqual(len(copies), 1)
        self.assertRegex(copies[0], r"\sapps/collector/uv\.lock\s", "글롭(uv.lock*) 없이 — 없으면 빌드가 실패한다")

    def test_every_uv_sync_is_locked(self):
        syncs = re.findall(r"(?m)^RUN\b[^\n]*\buv sync\b[^\n]*$", DOCKERFILES["collector"].read_text())
        self.assertEqual(len(syncs), 2, "의존성 층 + 프로젝트 층")
        for s in syncs:
            with self.subTest(run=s):
                self.assertRegex(s, r"\s--locked\b", "lock 이 pyproject 와 어긋나면 실패(다시 풀지 않는다)")
                self.assertRegex(s, r"\s--no-dev\b")


def dockerignore_excludes(path: str, patterns: list[str]) -> bool:
    """루트 .dockerignore 규칙으로 path(컨텍스트 기준)가 빠지는지 — Docker 규칙의 필요한 부분만(* · ? · ** · ! · 디렉터리면 그 아래 전부)."""
    def rx(pat: str) -> re.Pattern[str]:
        out, i = "", 0
        while i < len(pat):
            if pat.startswith("**/", i):
                out, i = out + "(?:.*/)?", i + 3
            elif pat.startswith("**", i):
                out, i = out + ".*", i + 2
            elif pat[i] == "*":
                out, i = out + "[^/]*", i + 1
            elif pat[i] == "?":
                out, i = out + "[^/]", i + 1
            else:
                out, i = out + re.escape(pat[i]), i + 1
        return re.compile(out)

    parts = path.split("/")
    excluded = False
    for p in patterns:
        neg = p.startswith("!")
        r = rx(p.lstrip("!").strip("/"))
        if any(r.fullmatch("/".join(parts[:i])) for i in range(1, len(parts) + 1)):
            excluded = not neg
    return excluded


class RootDockerignoreTest(unittest.TestCase):
    """S11 · L-8: collector · ais 는 저장소 루트를 빌드 컨텍스트로 쓴다(compose context: ..). 루트 .dockerignore 가 비밀값(.env · 백업)과
    큰 산출물을 빼서, 나중에 넓은 COPY 를 써도 이미지에 들어가지 않게 한다 — 그러면서 Dockerfile 이 COPY 하는 경로는 빼지 않는다."""

    @classmethod
    def setUpClass(cls) -> None:
        f = ROOT / ".dockerignore"
        cls.patterns = [ln.strip() for ln in f.read_text().splitlines() if ln.strip() and not ln.lstrip().startswith("#")] if f.exists() else []

    def test_secrets_vcs_and_bulk_are_excluded(self):
        for path in (".env", ".env.local", "apps/web/.env.local", "infra/.env", "backups/wakeline-20260101T000000Z.dump", ".git/config",
                     "apps/web/node_modules/next/package.json", "apps/collector/.venv/bin/python", "apps/api/build/libs/app.jar",
                     "apps/api/.gradle/x", "apps/web/.next/BUILD_ID", "apps/web/test-results/x.png", "apps/web/playwright-report/index.html",
                     "apps/collector/wakeline_collector/__pycache__/x.pyc", "apps/collector/.pytest_cache/x", "apps/collector/htmlcov/index.html",
                     "perf/results/k6.log", "data/raw/x.json", "raw/x.json", ".claude/settings.local.json"):
            with self.subTest(path=path):
                self.assertTrue(dockerignore_excludes(path, self.patterns), "빌드 컨텍스트에서 빠져야 한다")

    def test_repo_root_build_inputs_are_kept(self):
        compose = (ROOT / "infra" / "compose.yml").read_text()
        root_dockerfiles = re.findall(r"(?m)^\s+context:\s*\.\.\s*\n\s+dockerfile:\s*(\S+)", compose)
        self.assertEqual(root_dockerfiles, ["apps/collector/Dockerfile"], "저장소 루트 컨텍스트를 쓰는 Dockerfile")
        tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.splitlines()
        for df in root_dockerfiles:
            sources = [s for ln in (ROOT / df).read_text().splitlines()
                       if re.match(r"COPY\s", ln) and "--from=" not in ln
                       for s in [w for w in ln.split()[1:-1] if not w.startswith("--")]]
            self.assertTrue(sources)
            for src in sources:
                files = [f for f in tracked if f == src or f.startswith(src + "/")]
                with self.subTest(dockerfile=df, source=src):
                    self.assertTrue(files, "COPY 원본이 저장소에 있다")
                    self.assertFalse([f for f in files if dockerignore_excludes(f, self.patterns)], "COPY 하는 파일을 빼면 빌드가 깨진다")


class WebDockerignoreTest(unittest.TestCase):
    """최종 리뷰: web 은 apps/web 을 빌드 컨텍스트로 쓰고(compose build: ../apps/web) 빌드 단계가 COPY . . 를 한다. 개발자가 apps/web 에 둔
    .env* (next dev 의 .env.local 등)가 빌드 단계 · 캐시에 들어가지 않게 그 .dockerignore 가 뺀다 — 그러면서 빌드가 쓰는 파일은 빼지 않는다."""

    @classmethod
    def setUpClass(cls) -> None:
        f = ROOT / "apps" / "web" / ".dockerignore"
        cls.patterns = [ln.strip() for ln in f.read_text().splitlines() if ln.strip() and not ln.lstrip().startswith("#")]

    def test_env_files_are_excluded(self):
        for path in (".env", ".env.local", ".env.development.local", ".env.production", ".env.production.local", "node_modules/next/package.json", ".next/BUILD_ID"):
            with self.subTest(path=path):
                self.assertTrue(dockerignore_excludes(path, self.patterns), "빌드 컨텍스트에서 빠져야 한다")

    def test_build_inputs_are_kept(self):
        tracked = subprocess.run(["git", "ls-files", "apps/web"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.splitlines()
        inputs = [f.removeprefix("apps/web/") for f in tracked if f.startswith(("apps/web/app/", "apps/web/components/", "apps/web/lib/", "apps/web/public/"))]
        inputs += ["package.json", "package-lock.json", "next.config.ts", "tsconfig.json"]
        self.assertGreater(len(inputs), 100)
        self.assertEqual([f for f in inputs if dockerignore_excludes(f, self.patterns)], [], "빌드가 쓰는 파일을 빼면 빌드가 깨진다")


if __name__ == "__main__":
    unittest.main()
