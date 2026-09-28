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


if __name__ == "__main__":
    unittest.main()
