"""tools/npm_audit_gate.py — npm 의존성 감사 판정(NFR-10 · VERIFICATION #114). npm 없이 감사 JSON 으로 판정만 본다.

규칙: High 이상 0 건(npm audit --audit-level=high 와 같다) + 예외는 npm-audit-allow.json 의 기한부(31일 안) 개발 의존성 공지만. 실행 의존성
(--omit=dev)은 예외 없이 실패, 목록에 없거나 기한이 지났거나 패키지가 다르면 실패, 감사를 돌리지 못하면 실패. 예외 공지가 사라지면 알림만.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("npm_audit_gate", ROOT / "tools" / "npm_audit_gate.py")
gate = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(gate)

BRACES = "GHSA-vfj7-8cjw-p6xm"
OTHER = "GHSA-xxxx-xxxx-xxxx".replace("x", "c")


def advisory(name: str, ghsa: str, severity: str = "high") -> dict:
    return {"source": 1, "name": name, "dependency": name, "title": f"{name} issue", "url": f"https://github.com/advisories/{ghsa}",
            "severity": severity, "range": "<=3.0.3"}


def report(*nodes: tuple[str, list]) -> dict:
    """nodes: (패키지, via) — via 는 공지(dict) 또는 다른 패키지 이름."""
    return {"auditReportVersion": 2, "vulnerabilities": {n: {"name": n, "severity": "high", "via": via} for n, via in nodes}, "metadata": {}}


# 2026-10-03 의 실제 모양(eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces)
REAL_FULL = report(("@next/eslint-plugin-next", ["fast-glob"]), ("braces", [advisory("braces", BRACES)]), ("eslint-config-next", ["@next/eslint-plugin-next"]),
                   ("fast-glob", ["micromatch"]), ("micromatch", ["braces"]))
CLEAN = report()
ALLOW = {"advisories": [{"id": BRACES, "package": "braces", "added": "2026-10-03", "expires": "2026-11-02", "reason": "개발 도구만 · 고친 판 없음"}]}


class NpmAuditGateTest(unittest.TestCase):
    def run_gate(self, full: dict, prod: dict, allow: dict | None = ALLOW, today: str = "2026-10-03") -> tuple[int, str]:
        with tempfile.TemporaryDirectory() as tmp:
            t = Path(tmp)
            (t / "full.json").write_text(json.dumps(full))
            (t / "prod.json").write_text(json.dumps(prod))
            args = ["--full", str(t / "full.json"), "--prod", str(t / "prod.json"), "--today", today, "--allow", str(t / "allow.json")]
            if allow is not None:
                (t / "allow.json").write_text(json.dumps(allow, ensure_ascii=False))
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = gate.main(args)
            return rc, buf.getvalue()

    def test_the_real_report_passes_with_the_dev_only_exception(self):
        rc, out = self.run_gate(REAL_FULL, CLEAN)
        self.assertEqual(rc, 0, out)
        self.assertRegex(out, rf"(?m)^NOTE  예외 {BRACES} braces \(high, 개발 의존성만\) — 기한 2026-11-02")
        self.assertIn("High 이상 0 건(기한부 예외 1건", out)

    def test_without_the_exception_it_fails_like_npm_audit(self):
        rc, out = self.run_gate(REAL_FULL, CLEAN, allow=None)
        self.assertEqual(rc, 1, out)
        self.assertRegex(out, rf"(?m)^FAIL  high — {BRACES} braces")
        self.assertEqual(out.count("FAIL  "), 1, "다른 패키지를 거쳐 걸린 노드 넷은 같은 공지 하나로 센다")

    def test_a_runtime_dependency_has_no_exception(self):
        rc, out = self.run_gate(REAL_FULL, report(("braces", [advisory("braces", BRACES)])))
        self.assertEqual(rc, 1, out)
        self.assertIn("실행 의존성은 예외를 두지 않는다", out)

    def test_any_other_high_or_critical_fails(self):
        for sev in ("high", "critical"):
            with self.subTest(severity=sev):
                full = report(*[(n, v["via"]) for n, v in REAL_FULL["vulnerabilities"].items()], ("lodash", [advisory("lodash", OTHER, sev)]))
                rc, out = self.run_gate(full, CLEAN)
                self.assertEqual(rc, 1, out)
                self.assertRegex(out, rf"(?m)^FAIL  {sev} — {OTHER} lodash")

    def test_moderate_and_low_do_not_fail(self):
        rc, out = self.run_gate(report(("x", [advisory("x", OTHER, "moderate")]), ("y", [advisory("y", OTHER, "low")])), CLEAN)
        self.assertEqual(rc, 0, out)

    def test_an_expired_exception_fails(self):
        self.assertEqual(self.run_gate(REAL_FULL, CLEAN, today="2026-11-02")[0], 0, "기한 날까지는 예외")
        rc, out = self.run_gate(REAL_FULL, CLEAN, today="2026-11-03")
        self.assertEqual(rc, 1, out)
        self.assertIn("예외 기한 2026-11-02 이 지났다", out)

    def test_the_package_must_match(self):
        allow = {"advisories": [{**ALLOW["advisories"][0], "package": "micromatch"}]}
        rc, out = self.run_gate(REAL_FULL, CLEAN, allow=allow)
        self.assertEqual(rc, 1, out)
        self.assertIn("예외 목록의 패키지 micromatch 와 감사의 braces 가 다르다", out)

    def test_a_fixed_advisory_only_asks_to_drop_the_entry(self):
        rc, out = self.run_gate(CLEAN, CLEAN)
        self.assertEqual(rc, 0, out)
        self.assertRegex(out, rf"(?m)^NOTE  예외 {BRACES} braces 가 감사에 더 이상 보이지 않는다 — npm-audit-allow.json 에서 뺀다")

    def test_the_exception_list_is_strict(self):
        base = ALLOW["advisories"][0]
        bad = {
            "id 가 GHSA 가 아님": {**base, "id": "CVE-2026-0001"},
            "이유 없음": {**base, "reason": " "},
            "패키지 없음": {**base, "package": ""},
            "31일 넘는 기한": {**base, "expires": "2026-11-04"},
            "더한 날보다 이른 기한": {**base, "expires": "2026-10-02"},
            "날짜 형식": {**base, "added": "10/03/2026"},
        }
        for name, entry in bad.items():
            with self.subTest(name):
                rc, out = self.run_gate(REAL_FULL, CLEAN, allow={"advisories": [entry]})
                self.assertEqual(rc, 1, out)
                self.assertRegex(out, r"(?m)^FAIL  npm audit — 돌리지 못했다: ")

    def test_an_audit_that_did_not_run_fails_closed(self):
        cases = {
            "JSON 아님": ("npm ERR! network", 1),
            "npm 의 error": (json.dumps({"error": {"code": "ENOTFOUND", "summary": "getaddrinfo ENOTFOUND registry.npmjs.org"}}), 1),
            "취약점 없이 exit 1": (json.dumps({"vulnerabilities": {}}), 1),
            "모양이 다름": (json.dumps({"advisories": {}}), 0),
        }
        for name, (text, rc) in cases.items():
            with self.subTest(name), self.assertRaises(gate.AuditError):
                gate.parse_report(text, rc, "npm audit --json")
        self.assertEqual(gate.parse_report(json.dumps(REAL_FULL), 1, "npm audit --json")["vulnerabilities"].keys(), REAL_FULL["vulnerabilities"].keys(),
                         "취약점이 있으면 npm 은 exit 1 — 결과로 읽는다")

    def test_the_committed_exception_list_is_valid_and_short_lived(self):
        path = ROOT / "apps" / "web" / "npm-audit-allow.json"
        allow = gate.load_allow(path)
        for gid, e in allow.items():
            with self.subTest(gid):
                self.assertLessEqual((e["expires"] - e["added"]).days, gate.MAX_WINDOW_DAYS)
                self.assertTrue(e["reason"].strip())
        self.assertLessEqual(len(allow), 3, "예외가 쌓이면 정책(NFR-10)을 다시 본다")


if __name__ == "__main__":
    unittest.main()
