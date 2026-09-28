#!/usr/bin/env python3
"""DB 서비스 계정 비밀번호 교체(R-80) — wakeline_migrator · wakeline_api · wakeline_collector.

    python3 tools/db_rotate_passwords.py                      # 새 난수로 교체: DB 역할 → 로그인 확인 → .env 갱신 (make rotate-db-passwords)
    python3 tools/db_rotate_passwords.py --sync               # .env 의 지금 값을 DB 역할에 다시 맞춘다(값이 어긋나 인증이 실패할 때)
    WAKELINE_PROJECT=wakeline-e2e python3 tools/db_rotate_passwords.py --sync   # 격리 스택은 --sync 만(아래 "공유 .env")
    python3 tools/db_rotate_passwords.py --container NAME --env-file PATH   # infra/tests/db_rotate_test.sh

왜: 역할 비밀번호는 새 볼륨의 initdb(infra/db/init/01-roles.sh)에서 한 번만 정해진다. .env 값만 바꾸거나 잃으면(make init 이 새로 채운다)
    api·collector·migrate 의 DB 인증이 조용히 실패한다. 이 도구가 DB 와 .env 를 함께 바꾼다.
비밀값 규칙: 평문 비밀번호는 명령행(argv)·로그·화면에 두지 않는다. DB 에는 이 프로세스에서 계산한 SCRAM-SHA-256 검증값만 psql 의 stdin 으로 보낸다
    (서버는 평문을 보지 않는다). 로그인 확인은 PGPASSWORD 를 docker exec 의 -e 이름으로만 넘긴다(값은 이 프로세스의 환경).
순서: 옛 검증값 저장 → 한 트랜잭션으로 ALTER ROLE → 새 값으로 TCP 로그인 확인 → .env 원자적 교체(0600).
    확인이 실패하면 옛 검증값으로 되돌리고 .env 는 그대로 둔다. 슈퍼유저(postgres)는 로컬 소켓 전용이라(SEC-R3) 대상이 아니다.
다음: make up — api·collector·migrate(와 환경이 바뀐 db 컨테이너)가 새 값으로 다시 만들어진다.
공유 .env: 개발 스택(wakeline)과 격리 스택(wakeline-e2e)은 같은 .env 의 DB 비밀번호를 읽는다. 그래서 새 값은 개발 스택에서만 만들고,
    격리 스택은 --sync(= make rotate-db-passwords P=wakeline-e2e sync=1)로 그 값에 맞춘다. 격리 스택에서 새 값을 만들면 .env 가 바뀌어
    개발 DB 가 옛 값으로 남는다(R-80 후속). 교체 뒤 같은 .env 를 읽는 다른 프로젝트의 DB 볼륨이 있으면 맞추는 명령을 알려 준다.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import importlib.util
import os
import re
import secrets
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("init_env", ROOT / "tools" / "init_env.py")
init_env = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(init_env)

ROLES = {"wakeline_migrator": "DB_MIGRATOR_PASSWORD", "wakeline_api": "DB_API_PASSWORD", "wakeline_collector": "DB_COLLECTOR_PASSWORD"}
SCRAM_ITERATIONS = 4096  # PostgreSQL 기본값(scram_iterations)


def scram_verifier(password: str, salt: bytes | None = None, iterations: int = SCRAM_ITERATIONS) -> str:
    """PostgreSQL 이 pg_authid 에 저장하는 형식: SCRAM-SHA-256$<반복>:<솔트>$<StoredKey>:<ServerKey> (RFC 5802/7677)."""
    salt = salt or secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    return f"SCRAM-SHA-256${iterations}:{_b64(salt)}${_b64(stored_key)}:{_b64(server_key)}"


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def env_value(text: str, key: str) -> str:
    m = re.search(rf"^{re.escape(key)}=(.*)$", text, re.M)
    if not m or not m.group(1).strip():
        raise SystemExit(f"rotate: {key} 가 .env 에 없습니다 — make init 뒤에 다시 실행하세요")
    return m.group(1).strip()


def set_env_value(text: str, key: str, value: str) -> str:
    return re.sub(rf"^{re.escape(key)}=.*$", lambda _: f"{key}={value}", text, count=1, flags=re.M)


DEV_PROJECT = "wakeline"


def other_projects_with_db(project: str) -> list[str]:
    """같은 .env 를 읽는(= 이 저장소의 compose) 다른 프로젝트 중 DB 볼륨이 남아 있는 것 — 그 DB 에는 옛 비밀번호가 있다."""
    r = subprocess.run(["docker", "volume", "ls", "--filter", "label=com.docker.compose.volume=db_data", "--format", '{{.Label "com.docker.compose.project"}}'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return []
    return sorted({p.strip() for p in r.stdout.split() if p.strip() and p.strip() != project})


def container_id(project: str) -> str:
    out = subprocess.run(
        ["docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={project}", "--filter", "label=com.docker.compose.service=db"],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    if len(out) != 1:
        raise SystemExit(f"rotate: compose 프로젝트 '{project}' 의 db 컨테이너가 {'없습니다' if not out else '여러 개입니다'}")
    return out[0]


def psql_su(cid: str, sql: str) -> str:
    """로컬 소켓 슈퍼유저로 SQL 을 stdin 으로 실행한다(명령행에 값이 없다)."""
    r = subprocess.run(["docker", "exec", "-i", "-u", "postgres", cid, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", "postgres", "-At"],
                       input=sql, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"psql 실패: {r.stderr.strip()[:300]}")
    return r.stdout


def container_ip(cid: str) -> str:
    """db 컨테이너의 네트워크 주소. 127.0.0.1 은 이미지 기본 pg_hba 가 trust 라 비밀번호를 확인하지 못한다 — 서비스가 붙는 주소로 확인한다."""
    out = subprocess.run(["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", cid],
                         capture_output=True, text=True).stdout.split()
    if not out:
        raise SystemExit("rotate: db 컨테이너에 네트워크 주소가 없어 새 비밀번호를 확인할 수 없습니다 — 바꾸지 않았습니다")
    return out[0]


def can_login(cid: str, ip: str, role: str, password: str) -> bool:
    env = {**os.environ, "PGPASSWORD": password}
    r = subprocess.run(["docker", "exec", "-e", "PGPASSWORD", cid, "psql", "-X", "-w", "-h", ip, "-U", role, "-d", "wakeline", "-Atc", "SELECT 1"],
                       capture_output=True, text=True, env=env)
    return r.returncode == 0 and r.stdout.strip() == "1"


def alter_sql(verifiers: dict[str, str]) -> str:
    lines = ["BEGIN;"] + [f"ALTER ROLE {role} PASSWORD '{v}';" for role, v in verifiers.items()] + ["COMMIT;"]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--container", help="db 컨테이너 이름(기본: compose 프로젝트 WAKELINE_PROJECT 또는 wakeline 의 db)")
    ap.add_argument("--env-file", default=str(ROOT / ".env"))
    ap.add_argument("--sync", action="store_true", help=".env 의 지금 값을 DB 에 다시 맞춘다(.env 는 바꾸지 않는다)")
    a = ap.parse_args(argv)
    env_path = Path(a.env_file)
    text = env_path.read_text()
    project = os.environ.get("WAKELINE_PROJECT", DEV_PROJECT)
    if not a.container and not a.sync and project != DEV_PROJECT:
        # 공유 .env: 여기서 새 값을 쓰면 개발 DB 가 옛 값으로 남아 api·collector 인증이 조용히 실패한다
        raise SystemExit(f"rotate: '{project}' 는 개발 스택과 같은 .env 를 읽습니다 — 새 값은 개발 스택에서 만들고(make rotate-db-passwords), "
                         f"이 스택은 make rotate-db-passwords P={project} sync=1 로 맞추세요. 아무것도 바꾸지 않았습니다")
    cid = a.container or container_id(project)
    ip = container_ip(cid)

    current = {role: env_value(text, key) for role, key in ROLES.items()}
    target = current if a.sync else {role: secrets.token_urlsafe(24) for role in ROLES}
    verifiers = {role: scram_verifier(pw) for role, pw in target.items()}

    names = ",".join(f"'{r}'" for r in ROLES)
    old_rows = psql_su(cid, f"SELECT rolname || ' ' || coalesce(rolpassword, '') FROM pg_authid WHERE rolname IN ({names});\n")
    old = dict(line.split(" ", 1) for line in old_rows.splitlines() if line.strip())
    missing = set(ROLES) - set(old)
    if missing:
        raise SystemExit(f"rotate: DB 에 역할이 없습니다: {', '.join(sorted(missing))}")

    psql_su(cid, alter_sql(verifiers))
    failed = [role for role, pw in target.items() if not can_login(cid, ip, role, pw)]
    if failed:
        restore = {role: v for role, v in old.items() if v}
        psql_su(cid, alter_sql(restore))
        print(f"rotate: 새 비밀번호로 로그인하지 못해 되돌렸습니다({', '.join(failed)}) — .env 는 그대로입니다", file=sys.stderr)
        return 1
    if not a.sync:
        new_text = text
        for role, key in ROLES.items():
            new_text = set_env_value(new_text, key, target[role])
        init_env.write_private(env_path, new_text)
    what = "DB 역할을 .env 의 지금 값에 맞췄습니다" if a.sync else f"{env_path.name} 와 DB 역할의 비밀번호를 새 값으로 바꿨습니다"
    print(f"rotate: {what} ({', '.join(ROLES)} — 로그인 확인됨, 값은 출력하지 않음)")
    print("next: make up   (api·collector·migrate 가 새 값으로 다시 만들어진다)")
    if not a.sync and not a.container:
        for other in other_projects_with_db(project):
            print(f"note: '{other}' 의 DB 볼륨은 옛 비밀번호입니다 — 그 스택을 쓰려면: make rotate-db-passwords P={other} sync=1 (또는 make demo-down 으로 삭제)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
