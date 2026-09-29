"""운영 스크립트·Makefile 정책 시험 — 컨테이너를 띄우지 않는다(동작 시험은 infra/tests/*.sh 가 버리는 컨테이너로 한다).

- R-13: 백업·복원 명령이 있고, 백업 파일은 git 에 들어가지 않으며, 버리는 컨테이너 시험(db_backup_test.sh)이 infra-docker-test 에 묶여 있다

실행: python3 -m unittest discover -s infra/tests -v
"""
from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MAKEFILE = (ROOT / "Makefile").read_text()


def recipe(target: str) -> str:
    """Makefile 의 target 레시피(탭으로 시작하는 줄들)."""
    m = re.search(rf"(?m)^{re.escape(target)}:[^\n]*\n((?:\t[^\n]*\n?)*)", MAKEFILE)
    assert m, f"Makefile 에 {target} 없음"
    return m.group(1)


class BackupRestoreTest(unittest.TestCase):
    """R-13: PostgreSQL 백업·복원 절차."""

    def test_make_backup_and_restore_use_the_tools(self):
        self.assertIn("tools/db-backup.sh", recipe("backup"))
        r = recipe("restore")
        self.assertIn("tools/db-restore.sh", r)
        self.assertIn("--confirm", r, "복원은 명시적 확인 문구가 있어야 한다")
        self.assertIn("--file", r)

    def test_backups_never_reach_git(self):
        r = subprocess.run(["git", "check-ignore", "-q", "backups/wakeline-20260101T000000Z.dump"], cwd=ROOT)
        self.assertEqual(r.returncode, 0, "backups/ 는 .gitignore 대상")

    def test_backup_tool_writes_owner_only_and_uses_local_socket(self):
        t = (ROOT / "tools" / "db-backup.sh").read_text()
        self.assertIn("umask 077", t)
        self.assertIn('chmod 700 "$OUT"', t)
        self.assertIn('chmod 600 "$file"', t)
        self.assertIn("--format=custom", t)
        self.assertNotRegex(t, r"pg_dump[^\n]*\s-h\s", "로컬 소켓(슈퍼유저 TCP 는 막혀 있다)")
        self.assertNotRegex(t, r"PGPASSWORD|POSTGRES_PASSWORD|DB_ROOT_PASSWORD", "비밀번호를 쓰지 않는다")

    def test_restore_tool_refuses_unless_empty_and_confirmed(self):
        t = (ROOT / "tools" / "db-restore.sh").read_text()
        self.assertIn('[ "$CONFIRM" = "$NAME" ]', t)
        self.assertIn('[ "$existing" = 0 ]', t)
        self.assertIn("--single-transaction", t)
        self.assertIn("--exit-on-error", t)
        for s in ("api", "collector", "ais", "migrate"):
            self.assertRegex(t, rf"for s in [^\n]*\b{s}\b", "쓰는 컨테이너가 멈춰 있어야 한다")

    def test_container_test_is_wired(self):
        self.assertIn("bash infra/tests/db_backup_test.sh", recipe("infra-docker-test"))


class PasswordRotationTest(unittest.TestCase):
    """R-80: DB 서비스 계정 비밀번호를 DB 와 .env 에 함께 바꾸는 절차(값만 바꾸면 인증이 조용히 실패한다)."""

    def test_make_target_and_container_test(self):
        r = recipe("rotate-db-passwords")
        self.assertIn("tools/db_rotate_passwords.py", r)
        self.assertIn("--sync", r, "어긋난 값 복구(sync=1)")
        self.assertIn("bash infra/tests/db_rotate_test.sh", recipe("infra-docker-test"))

    def test_tool_sends_only_scram_verifiers_and_never_plaintext_on_argv(self):
        t = (ROOT / "tools" / "db_rotate_passwords.py").read_text()
        self.assertIn("SCRAM-SHA-256$", t)
        self.assertIn("input=sql", t, "SQL 은 stdin 으로")
        self.assertRegex(t, r'"-e", "PGPASSWORD", cid', "로그인 확인은 -e 이름만(값은 환경)")
        self.assertNotRegex(t, r'"-e", f?"PGPASSWORD=', "값을 argv 에 두지 않는다")
        self.assertIn("init_env.write_private", t, ".env 는 0600 원자적 교체")

    def test_readme_and_env_example_explain_rotation(self):
        readme = (ROOT / "README.md").read_text()
        self.assertIn("make rotate-db-passwords", readme)
        self.assertIn("make rotate-db-passwords", (ROOT / ".env.example").read_text())


SCANNER_SCRIPTS = [ROOT / "perf" / "review_measure.sh", ROOT / "tools" / "scan_lib.sh", ROOT / "tools" / "security_gate.sh"]


def docker_runs(text: str) -> list[str]:
    """`docker run …` 명령(줄 이음 \\ 포함)을 하나의 문자열로. 배열 SCAN_RUN=(docker run …) 정의도 포함한다."""
    joined = re.sub(r"\\\n\s*", " ", text)
    return [ln.strip() for ln in joined.splitlines() if re.search(r"\bdocker run\b", ln) and not ln.lstrip().startswith("#")]


class ScannerIsolationTest(unittest.TestCase):
    """R-38: 스캐너 도구 이미지는 다이제스트 고정, docker.sock·작업 트리(.env 포함)를 넘기지 않고, 코드·이미지를 읽을 때는 네트워크가 없다."""

    def test_no_docker_socket_and_no_latest(self):
        for p in SCANNER_SCRIPTS:
            t = "\n".join(ln for ln in p.read_text().splitlines() if not ln.lstrip().startswith("#"))  # 설명 주석은 빼고
            with self.subTest(script=p.name):
                self.assertNotIn("docker.sock", t)
                self.assertNotRegex(t, r"[\w./-]+:latest\b", "떠다니는 :latest 금지")

    def test_tool_images_are_pinned_by_digest(self):
        lib = (ROOT / "tools" / "scan_lib.sh").read_text()
        for var in ("TRIVY_IMAGE", "GITLEAKS_IMAGE", "SEMGREP_IMAGE"):
            with self.subTest(var=var):
                self.assertRegex(lib, rf'(?m)^{var}="[^"@\s]+:[^"@\s]+@sha256:[0-9a-f]{{64}}"$')
        for p in SCANNER_SCRIPTS:
            for cmd in docker_runs(p.read_text()):
                with self.subTest(script=p.name, cmd=cmd[:90]):
                    literal = re.findall(r"\b(?:aquasec/trivy|semgrep/semgrep|zricethezav/gitleaks|ghcr\.io/gitleaks/gitleaks)[^\s\"']*", cmd)
                    self.assertFalse(literal, "도구 이미지는 scan_lib 의 고정 변수로만")

    def test_repo_is_never_mounted_whole(self):
        for p in SCANNER_SCRIPTS:
            t = p.read_text()
            with self.subTest(script=p.name):
                self.assertNotRegex(t, r'-v\s+"?\$(PWD|\(pwd\)|ROOT)"?:', "작업 트리(.env 포함)를 통째로 마운트하지 않는다")

    def test_scanners_that_read_code_or_images_have_no_network(self):
        lib = (ROOT / "tools" / "scan_lib.sh").read_text()
        self.assertRegex(lib, r"SCAN_RUN=\(docker run --rm --network none ")
        for p in SCANNER_SCRIPTS:
            for cmd in docker_runs(p.read_text()):
                if "SCAN_RUN=(" in cmd:
                    continue
                with self.subTest(script=p.name, cmd=cmd[:100]):
                    if re.search(r"\$(TRIVY|GITLEAKS|SEMGREP)_IMAGE", cmd):
                        # 네트워크가 있는 유일한 경우: trivy DB 받기 — 캐시 디렉터리만 마운트한다
                        self.assertRegex(cmd, r"--download-(java-)?db-only", "코드·이미지를 읽는 스캐너는 SCAN_RUN(--network none)으로")
                        self.assertEqual(re.findall(r"-v\s+\"?([^:\"]+):", cmd), ["$TRIVY_CACHE"])

    def test_review_measure_uses_the_hardened_helpers(self):
        t = (ROOT / "perf" / "review_measure.sh").read_text()
        self.assertIn(". tools/scan_lib.sh", t)
        for fn in ("trivy_image", "repo_copy", "repo_clone", "trivy_db_update"):
            self.assertRegex(t, rf"\b{fn}\b")
        self.assertIn("--metrics=off", t)
        self.assertIn("https://semgrep.dev/c/", t, "규칙은 미리 파일로 받고 semgrep 은 네트워크 없이 돈다")


OPS_SCRIPTS = sorted([*(ROOT / "tools").glob("*.sh"), *(ROOT / "perf").glob("*.sh")])
# docker run 옵션 중 값을 따로 받는 것(이미지 이름을 찾을 때 건너뛴다)
_VALUE_OPTS = {"-v", "--volume", "-e", "--env", "-w", "--workdir", "--network", "--name", "--entrypoint", "-p", "--publish", "--label",
               "-u", "--user", "--tmpfs", "--security-opt", "--cap-drop", "--cap-add", "--mount", "--memory", "--shm-size", "--network-alias"}


def run_image(cmd: str) -> str | None:
    """`docker run …` 한 줄에서 이미지 자리(옵션 다음 첫 인자)."""
    toks = cmd.split()
    i = toks.index("run") + 1
    while i < len(toks):
        t = toks[i]
        if t.startswith("-"):
            i += 2 if (t in _VALUE_OPTS and "=" not in t) else 1
            continue
        return t.strip('"')
    return None


class SecretsNotOnArgvTest(unittest.TestCase):
    """R-87: 운영 스크립트는 비밀값을 docker CLI argv(-e NAME=값)로 넘기지 않고, 쓰는 도구 이미지는 다이제스트로 고정한다."""

    def test_no_secret_values_in_docker_argv(self):
        for p in OPS_SCRIPTS + [ROOT / "Makefile"]:
            for n, line in enumerate(p.read_text().splitlines(), 1):
                if line.lstrip().startswith("#"):
                    continue
                with self.subTest(file=p.name, line=n):
                    self.assertNotRegex(line, r"-e\s+[A-Za-z_]*(PASSWORD|SECRET|TOKEN|AUTH)[A-Za-z_]*=",
                                        "값은 환경으로(-e NAME) 또는 컨테이너 안 변수로 넘긴다 — argv 는 ps 로 보인다")

    def test_tool_images_in_scripts_are_pinned(self):
        for p in OPS_SCRIPTS:
            for cmd in docker_runs(p.read_text()):
                img = run_image(cmd)
                if img is None or img.startswith("$") or img.startswith("\"$") or img.endswith(":local"):
                    continue  # 변수(정의에서 고정) · 자체 이미지
                with self.subTest(file=p.name, image=img):
                    self.assertRegex(img, r"^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()


class PortableShellTest(unittest.TestCase):
    """시험·도구 셸 스크립트는 macOS(BSD)와 Linux(GNU, CI) 모두에서 같은 값을 내야 한다."""

    def test_no_bsd_only_stat_format(self):
        # GNU stat 의 -f 는 "파일 시스템 상태"라 `stat -f %Lp f` 는 %Lp 를 파일 이름으로 읽고 파일 시스템 정보를 먼저 출력한다 —
        # `|| stat -c %a` 로 넘어가도 앞 출력이 섞여 값이 틀린다. 권한은 python3 os.stat 로 읽는다(file_mode).
        offenders = []
        for p in sorted([*(ROOT / "infra" / "tests").glob("*.sh"), *(ROOT / "tools").glob("*.sh"), ROOT / "tools" / "dc"]):
            for n, line in enumerate(p.read_text().splitlines(), 1):
                if re.search(r"\bstat\s+-f\b", line.split("#", 1)[0]):
                    offenders.append(f"{p.relative_to(ROOT)}:{n}")
        self.assertEqual(offenders, [])


class ReadmeFactsTest(unittest.TestCase):
    """R-50: README 의 수치가 저장소와 어긋나지 않게 — 마이그레이션 최대 버전 · ADR 수 · 변경 계약 범위(싼 문서 검사)."""

    def setUp(self):
        self.readme = (ROOT / "README.md").read_text()

    def test_flyway_range_matches_the_latest_migration(self):
        versions = [int(re.match(r"V(\d+)__", p.name).group(1)) for p in (ROOT / "apps/api/src/main/resources/db/migration").glob("V*__*.sql")]
        stated = {int(v) for v in re.findall(r"Flyway V1–V(\d+)", self.readme)}
        self.assertTrue(stated, "README 에 'Flyway V1–Vn' 표기")
        self.assertEqual(stated, {max(versions)})

    def test_adr_count_matches_the_files(self):
        n = len(list((ROOT / "docs/adr").glob("ADR-*.md")))
        self.assertIn(f"ADR {n}건", self.readme)

    def test_data_sources_section_names_every_credit_the_screens_show(self):
        """§9 데이터 출처는 화면 하단 · /about 이 쓰는 목록(apps/web/lib/attribution.ts CREDITS)을 모두 적는다 — 레인을 합칠 때 한쪽 출처가
        빠진 적이 있다(PORT-MIS · 검토 지적). 이름은 목록의 label 그대로."""
        credits = re.findall(r'label: "([^"]+)"', (ROOT / "apps/web/lib/attribution.ts").read_text())
        self.assertGreaterEqual(len(credits), 10)
        m = re.search(r"^## 9\. 데이터 출처·약관\n(.*?)(?=^## |\Z)", self.readme, re.M | re.S)
        self.assertIsNotNone(m, "README §9 '데이터 출처·약관'")
        missing = [c for c in credits if c not in m.group(1)]
        self.assertEqual(missing, [], "README §9 에 없는 출처")

    def test_contract_range_matches_the_files(self):
        audit = ROOT / "docs/audit"
        latest = max([1] + [int(m.group(1)) for p in audit.glob("change-contract-v*.md") if (m := re.match(r"change-contract-v(\d+)\.md", p.name))])
        self.assertIn(f"변경 계약 v1–v{latest}", self.readme)
