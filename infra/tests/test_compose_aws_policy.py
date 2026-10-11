"""AWS 데모 덧붙임(infra/compose.aws.yml — ADR-039) 정책: RDS 서버 인증서를 검증한다(AWS 리뷰 2026-10 C-1).

require(api · collector) · prefer(migrate)는 암호화만 하고 상대가 RDS 인지 확인하지 않았다. 이제 셋 모두 verify-full + AWS RDS CA 묶음
(infra/rds/global-bundle.pem — AWS 공식 truststore). 되돌리기는 .env 의 RDS_SSLMODE=require 하나(이 파일은 기본값만 정한다).
로컬 compose.yml 은 그대로다(db 컨테이너 — 이 정책과 상관없다).
"""

from __future__ import annotations

import base64
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AWS = ROOT / "infra" / "compose.aws.yml"
BUNDLE = ROOT / "infra" / "rds" / "global-bundle.pem"
CA_IN_CONTAINER = "/etc/wakeline/rds-ca.pem"
DEFAULT_MODE = "${RDS_SSLMODE:-verify-full}"


def service_block(text: str, name: str) -> str:
    """services: 아래 두 칸 들여쓴 서비스 하나의 글자(다음 서비스 · 최상위 키 앞까지)."""
    m = re.search(rf"^  {name}:\n(.*?)(?=^  [a-z][a-z0-9_-]*:\n|^[a-z]|\Z)", text, re.S | re.M)
    assert m, f"service {name} not in {AWS.name}"
    return m.group(1)


class RdsTlsVerification(unittest.TestCase):
    def setUp(self) -> None:
        self.text = AWS.read_text(encoding="utf-8")

    def test_the_bundle_is_only_certificates_and_has_the_seoul_rds_root(self) -> None:
        pem = BUNDLE.read_text(encoding="ascii")
        blocks = re.findall(r"-----BEGIN CERTIFICATE-----\n(.*?)\n-----END CERTIFICATE-----", pem, re.S)
        self.assertGreater(len(blocks), 10)
        rest = re.sub(r"-----BEGIN CERTIFICATE-----\n.*?\n-----END CERTIFICATE-----", "", pem, flags=re.S)
        self.assertEqual(rest.strip(), "", "the bundle holds nothing but certificates")
        ders = [base64.b64decode("".join(b.split())) for b in blocks]
        # 이 RDS 의 CA(rds-ca-rsa2048-g1)의 서울 루트 — DER 안의 CN 글자
        self.assertTrue(any(b"Amazon RDS ap-northeast-2 Root CA RSA2048 G1" in d for d in ders))

    def test_api_migrate_and_collector_verify_the_rds_certificate_by_default(self) -> None:
        anchor = re.search(r"^x-rds-ca: &rds-ca (\S+)$", self.text, re.M)
        assert anchor
        self.assertEqual(anchor.group(1), f"./rds/global-bundle.pem:{CA_IN_CONTAINER}:ro")
        api = service_block(self.text, "api")
        self.assertIn(f"?sslmode={DEFAULT_MODE}&sslrootcert={CA_IN_CONTAINER}", api)
        migrate = service_block(self.text, "migrate")
        self.assertIn(f"DB_SSLMODE: {DEFAULT_MODE}", migrate)
        self.assertIn(f"DB_SSLROOTCERT: {CA_IN_CONTAINER}", migrate)
        collector = service_block(self.text, "collector")
        self.assertIn(f"PGSSLMODE: {DEFAULT_MODE}", collector)
        self.assertIn(f"PGSSLROOTCERT: {CA_IN_CONTAINER}", collector)
        for name, block in (("api", api), ("migrate", migrate), ("collector", collector)):
            self.assertRegex(block, r"volumes:\n\s+- \*rds-ca\n", name)
        self.assertNotRegex(self.text, r"sslmode=require|PGSSLMODE: require", "no hard-coded require left")


if __name__ == "__main__":
    unittest.main()
