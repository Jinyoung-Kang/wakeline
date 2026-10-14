#!/usr/bin/env python3
"""QA 2026-10 AWS 리허설(R) 준비: 시험 전용 비밀값 · 시험 CA · 덧붙임 compose 를 세션 임시 폴더(WLQA_R_DIR)에 만든다.

    python3 -B tools/qa/rehearsal/setup.py            # 이미 있으면 덮지 않는다(--force 로만)

만드는 것(모두 WLQA_R_DIR 아래, 비밀값 파일은 0600 — 화면에 출력하지 않는다):
  rds.env              RDS 흉내(wlqa-rds)용 — 슈퍼유저 · 비 superuser 마스터 · 다른 두 프로젝트(macro · buildrisk) 계정 비밀번호
  apps/<프로젝트>/.env   aws-deploy rds/bootstrap.sh 가 읽는 자리(APPS_DIR) — macro · buildrisk 비밀번호, wakeline 은 wakeline.env 사본
  wakeline.env         tools/qa/make_qa_env.py(.env.example 바탕 · 내부 비밀값 새로 · 외부 키 빈 값) + RDS_HOST · RDS_PORT · PUBLIC_ORIGIN
  front.env · gate-code 앞단(wlqa-front)용 — ORIGIN_SECRET · GATE_SECRET · MACRO_DEMO_TOKEN · GATE_CODES(gate.py hash) / 접근 코드 원문
  ops-creds.json       리허설 운영자 계정(복원 뒤 로그인 확인용)
  certs/               시험 CA A(서버 인증서 서명, SAN = rds.wlqa.test) · 시험 CA B(서명하지 않은 다른 CA)
  compose.rds.yml      aws-deploy rehearsal/compose.rds-emu.yml 덧붙임 — wakeline-db:qa · 시험 CA 서버 인증서 · max_connections 78 · tools/holder 서비스
  compose.aws-r.yml    infra/compose.aws.yml 덧붙임 — RDS 이름(rds.wlqa.test → host-gateway) · CA 묶음(WLQA_RDS_CA) 을 migrate · api · collector 에
  compose.front.yml    aws-deploy rehearsal/compose.edge.yml 덧붙임 — portfolio-gate:wlqa · 운영과 같은 메모리 상한 · MACRO_DEMO_TOKEN · PUBLIC_SCHEME=https

aws-deploy 저장소는 읽기만 한다(gate.py hash 는 -B -I 로 실행해 __pycache__ 를 쓰지 않는다). 사용자의 .env 는 읽지도 쓰지도 않는다.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
AWS_DEPLOY = Path(os.environ.get("AWS_DEPLOY_DIR", "/Users/jinyoung/Projects/aws-deploy"))
R = Path(os.environ.get(
    "WLQA_R_DIR",
    "/private/tmp/claude-501/-Users-jinyoung-Projects-wakeline/3b40667d-7c26-4f92-9be9-6efb0a86ebea/scratchpad/qa/rehearsal"))
RDS_NAME = "rds.wlqa.test"


def pw() -> str:
    return secrets.token_urlsafe(32)  # bootstrap.sh check_pw: ^[A-Za-z0-9._~+/=-]{16,}$


def write_secret(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def write_plain(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def openssl(*args: str, cwd: Path) -> None:
    subprocess.run(["openssl", *args], cwd=cwd, check=True, capture_output=True)


def make_certs(d: Path) -> None:
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    for ca in ("a", "b"):
        openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "7", "-keyout", f"ca-{ca}.key", "-out", f"ca-{ca}.pem",
                "-subj", f"/CN=wlqa rehearsal test RDS CA {ca.upper()}",
                "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
                "-addext", "subjectKeyIdentifier=hash", cwd=d)
    openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", f"/CN={RDS_NAME}", cwd=d)
    (d / "server.ext").write_text(
        f"subjectAltName=DNS:{RDS_NAME}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n")
    openssl("x509", "-req", "-in", "server.csr", "-CA", "ca-a.pem", "-CAkey", "ca-a.key", "-CAcreateserial", "-days", "7",
            "-extfile", "server.ext", "-out", "server.crt", cwd=d)
    for f in d.iterdir():
        f.chmod(0o600 if f.suffix == ".key" else 0o644)


def gate_hash(code: str) -> str:
    out = subprocess.run([sys.executable, "-B", "-I", str(AWS_DEPLOY / "gate" / "gate.py"), "hash"], input=code + "\n",
                         capture_output=True, text=True, check=True)
    return out.stdout.strip()


RDS_COMPOSE = """\
# QA 2026-10 AWS 리허설(R) — aws-deploy rehearsal/compose.rds-emu.yml 덧붙임(setup.py 가 만든다). 프로젝트 이름 wlqa-rds 로만.
services:
  rds:
    image: wakeline-db:${{WLQA_TAG:-qa}}
    pull_policy: never
    # 개인 키는 postgres 가 소유한 0600 이어야 한다 — 마운트한 파일을 /tmp 로 복사한 뒤 원래 진입점으로
    entrypoint: ["bash", "-c", "install -m 0600 /wlqa-certs/server.key /tmp/server.key && exec docker-entrypoint.sh \\"$$@\\"", "--"]
    command: [postgres, -c, ssl=on, -c, ssl_cert_file=/wlqa-certs/server.crt, -c, ssl_key_file=/tmp/server.key,
              -c, max_connections=78, -c, shared_buffers=256MB]
    volumes:
      - {certs}:/wlqa-certs:ro
  tools:   # psql · pg_dump · pg_restore 18.6(같은 이미지) — bootstrap.sh · backup.sh 를 그대로 돌린다
    profiles: ["tools"]
    image: wakeline-db:${{WLQA_TAG:-qa}}
    pull_policy: never
    entrypoint: ["bash"]
    working_dir: /tmp
    environment:
      HOME: /tmp
      PGPASSWORD: ${{RDS_MASTER_PASSWORD:?}}
      RDS_HOST: rds
      RDS_PORT: "5432"
      RDS_MASTER_USER: ${{RDS_MASTER_USER:?}}
      APPS_DIR: /apps
    volumes:
      - {aws_deploy}/rds:/aws-deploy-rds:ro
      - {apps}:/apps:ro
      - {backups}:/backups
      - {qa}:/qa:ro
  holder:  # 다른 두 프로젝트 몫 연결을 붙잡는 더미(macro · buildrisk 계정, TLS) — HOLD_FILL=1 이면 남은 자리를 모두 채운다
    profiles: ["holder"]
    image: wakeline-collector:${{WLQA_TAG:-qa}}
    pull_policy: never
    entrypoint: ["python", "-u", "/qa/hold_conns.py"]
    read_only: true
    environment:
      MACRO_PW: ${{MACRO_DB_PASSWORD:?}}
      BUILDRISK_PW: ${{BUILDRISK_DB_PASSWORD:?}}
      HOLD_MACRO: ${{HOLD_MACRO:-7}}
      HOLD_BUILDRISK: ${{HOLD_BUILDRISK:-7}}
      HOLD_FILL: ${{HOLD_FILL:-0}}
      HOLD_GREEDY: ${{HOLD_GREEDY:-0}}
      HOLD_HOST: rds
      HOLD_PORT: "5432"
    volumes:
      - {qa}:/qa:ro
"""

AWS_R_COMPOSE = """\
# QA 2026-10 AWS 리허설(R) — infra/compose.aws.yml 뒤에 붙인다(setup.py 가 만든다). 프로젝트 이름 wlqa-aws 로만.
# RDS 흉내는 호스트 127.0.0.1:55432 — 컨테이너는 EC2 → RDS 처럼 NAT 를 거쳐 밖의 DB 로 나간다(host-gateway). 이름 rds.wlqa.test = 시험 서버 인증서의 SAN.
# CA 묶음은 compose.aws.yml 의 rds/global-bundle.pem 자리(/etc/wakeline/rds-ca.pem)를 WLQA_RDS_CA 로 바꾼다(대상 경로가 같아 덮인다).
services:
  migrate:
    extra_hosts: ["{rds}:host-gateway"]
    volumes: ["${{WLQA_RDS_CA:?}}:/etc/wakeline/rds-ca.pem:ro"]
  api:
    extra_hosts: ["{rds}:host-gateway"]
    volumes: ["${{WLQA_RDS_CA:?}}:/etc/wakeline/rds-ca.pem:ro"]
  collector:
    extra_hosts: ["{rds}:host-gateway"]
    volumes: ["${{WLQA_RDS_CA:?}}:/etc/wakeline/rds-ca.pem:ro"]
"""

FRONT_COMPOSE = """\
# QA 2026-10 AWS 리허설(R) — aws-deploy rehearsal/compose.edge.yml 덧붙임(setup.py 가 만든다). 프로젝트 이름 wlqa-front 로만.
# gate 는 새 태그 portfolio-gate:wlqa(먼저 docker build) — portfolio-gate:local 을 덮지 않는다. 메모리 상한은 운영 compose.yml 과 같게.
services:
  gate:
    image: portfolio-gate:wlqa
    build: !reset null
    pull_policy: never
    mem_limit: 96m
  caddy:
    mem_limit: 128m
    environment:
      MACRO_DEMO_TOKEN: ${{MACRO_DEMO_TOKEN:?}}
      PUBLIC_SCHEME: https          # 운영 값(CloudFront 뒤) — 리허설 기본은 http
      WAKELINE_EDGE: host.docker.internal:18710
"""


def main(argv: list[str]) -> int:
    force = "--force" in argv
    if (R / "rds.env").exists() and not force:
        print(f"이미 있다(덮지 않음): {R}")
        return 0
    R.mkdir(parents=True, exist_ok=True, mode=0o700)
    R.chmod(0o700)

    master_pw, macro_pw, buildrisk_pw = pw(), pw(), pw()
    write_secret(R / "rds.env", "\n".join([
        f"RDS_EMU_SUPERUSER_PASSWORD={pw()}",
        "RDS_MASTER_USER=rdsmaster",
        f"RDS_MASTER_PASSWORD={master_pw}",
        f"MACRO_DB_PASSWORD={macro_pw}",
        f"BUILDRISK_DB_PASSWORD={buildrisk_pw}",
        "WLQA_TAG=qa", ""]))

    # wakeline 시험 env — make_qa_env.py 로 만들고 배포 값을 더한다
    wl = R / "wakeline.env"
    subprocess.run([sys.executable, "-B", str(ROOT / "tools/qa/make_qa_env.py"), str(wl), "--force"], check=True, capture_output=True)
    with wl.open("a", encoding="utf-8") as f:
        f.write(f"\n# 리허설(R) — RDS 흉내 · 앞단\nRDS_HOST={RDS_NAME}\nRDS_PORT=55432\nPUBLIC_ORIGIN=http://localhost:8103\n")
    wl.chmod(0o600)

    apps = R / "apps"
    write_secret(apps / "Local_macro_dashboard_v3" / ".env", f"DATABASE_PASSWORD={macro_pw}\n")
    write_secret(apps / "buildrisk-radar" / ".env", f"POSTGRES_PASSWORD={buildrisk_pw}\n")
    (apps / "wakeline").mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copyfile(wl, apps / "wakeline" / ".env")
    (apps / "wakeline" / ".env").chmod(0o600)
    # Docker Desktop 의 파일 공유는 소유자를 컨테이너 쪽 uid 로 보이게 한다 — 0600 · 0700 그대로 컨테이너(postgres 999)가 읽는다(실측)

    code = secrets.token_urlsafe(18)
    write_secret(R / "gate-code", code + "\n")
    write_secret(R / "front.env", "\n".join([
        f"ORIGIN_SECRET={secrets.token_urlsafe(36)}",
        f"GATE_SECRET={secrets.token_urlsafe(36)}",
        f"MACRO_DEMO_TOKEN={secrets.token_urlsafe(36)}",
        f"GATE_CODES=recruit:{gate_hash(code)}",
        "WAKELINE_EDGE_PORT=18710", ""]))
    write_secret(R / "ops-creds.json", json.dumps({"username": "qa-rehearsal", "password": pw()}))

    make_certs(R / "certs")
    (R / "backups").mkdir(exist_ok=True, mode=0o700)
    write_plain(R / "compose.rds.yml", RDS_COMPOSE.format(certs=R / "certs", aws_deploy=AWS_DEPLOY, apps=apps,
                                                          backups=R / "backups", qa=ROOT / "tools/qa/rehearsal"))
    write_plain(R / "compose.aws-r.yml", AWS_R_COMPOSE.format(rds=RDS_NAME))
    write_plain(R / "compose.front.yml", FRONT_COMPOSE.format())
    print(f"만들었다: {R} (비밀값 파일 0600 · 값은 출력하지 않음)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
