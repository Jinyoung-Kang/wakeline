"""infra/compose.yml 정책 시험 (SEC-4 · SEC-5 · SEC-7 · SEC-8 · SEC-13 · REL-20 · SEC-R2 · SEC-R3 · 계약 v2 §B1·§C).

`docker compose config` 로 해석한 결과(개발 스택과 격리 E2E 스택 둘 다)를 검사한다 — 컨테이너를 띄우지 않는다.
임시 디렉터리에 init_env 로 만든 .env 를 쓰므로 실제 .env 는 읽지도 바꾸지도 않는다. docker CLI 가 없으면 건너뛴다.
격리 스택의 환경변수는 Makefile 의 ISO_ENV(`make -s print-ISO_ENV`)를 그대로 쓴다 — make e2e·demo 와 같은 값.

실행: python3 -m unittest discover -s infra/tests -v
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "infra" / "compose.yml"
_spec = importlib.util.spec_from_file_location("init_env", ROOT / "tools" / "init_env.py")
init_env = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(init_env)

LONG_RUNNING = ["edge", "web", "api", "collector", "ais", "redis", "db"]
# 시험용 .env 에 넣는 가짜 외부 키(사용자 .env 의 이름 그대로 — 소문자 aisstream_key). 실제 키가 아니다.
FAKE_EXTERNAL = {
    "aisstream_key": "test-ais-key-not-real-0123456789",
    "OPENSKY_CLIENT_ID": "test-opensky-id",
    "OPENSKY_CLIENT_SECRET": "test-opensky-secret-not-real",
    "KMA_APIHUB_KEY": "test-kma-key-not-real",
    "DATA_GO_KR_SERVICE_KEY": "test-data-go-kr-key-not-real",
}
# migrate(--migrate)가 실제로 읽는 환경변수(WakelineApplication.migrate) — 이 밖의 값은 주지 않는다(SEC-R2)
MIGRATE_ENV_ALLOWED = {"TZ", "DB_HOST", "DB_NAME", "DB_PORT", "DB_MIGRATOR_USER", "DB_MIGRATOR_PASSWORD"}
# ais 컨테이너(계약 v2 §B1)가 받는 값 — DB 비밀번호·다른 외부 키는 없다
# R-64 · R-77 · ADR-017 §4: 서비스 → 붙는 망. public(게시 포트) · wakeline(= internal 망, internal: true) · egress(인터넷, collector·ais 만)
INTERNAL_NET = "wakeline"
SERVICE_NETWORKS = {
    "edge": {"public", INTERNAL_NET},
    "web": {INTERNAL_NET}, "api": {INTERNAL_NET}, "migrate": {INTERNAL_NET}, "db": {INTERNAL_NET}, "redis": {INTERNAL_NET},
    "collector": {INTERNAL_NET, "egress"}, "ais": {INTERNAL_NET, "egress"},
}
# R-24 · ADR-017 §4: db 서버 설정(체크포인트 간격·WAL 상한·WAL 압축·공유 버퍼) — infra/tests/db_hardening_test.sh 가 실제 SHOW 값도 본다
DB_SETTINGS = {"checkpoint_timeout": "15min", "max_wal_size": "2GB", "wal_compression": "on", "shared_buffers": "256MB"}
AIS_ENV_ALLOWED = {
    "TZ", "REDIS_HOST", "REDIS_USERNAME", "REDIS_PASSWORD", "AISSTREAM_API_KEY", "AIS_BBOXES",
    "HTTP_USER_AGENT", "FIXTURES_DIR", "SCHEMAS_DIR", "WAKELINE_FIXTURE_MODE",
}


def _docker_compose_available() -> bool:
    if not shutil.which("docker"):
        return False
    return subprocess.run(["docker", "compose", "version"], capture_output=True).returncode == 0


def iso_env() -> dict[str, str]:
    """Makefile 의 ISO_ENV("K=V K2= …")를 사전으로 — 격리 스택이 실제로 받는 셸 환경."""
    r = subprocess.run(["make", "-s", "--no-print-directory", "print-ISO_ENV"], cwd=ROOT, capture_output=True, text=True, check=True)
    out: dict[str, str] = {}
    for tok in r.stdout.split():
        k, sep, v = tok.partition("=")
        assert sep and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k), tok
        out[k] = v
    return out


@unittest.skipUnless(_docker_compose_available(), "docker compose 없음")
class ComposePolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        d = Path(cls._tmp.name)
        cls.env_file = d / ".env"
        init_env.ensure_env(cls.env_file, ROOT / ".env.example", out=io.StringIO())
        # 사용자 .env 처럼 외부 키가 채워진 상태를 흉내 낸다(값은 가짜) — 개발 스택에서는 필요한 컨테이너에만, 격리 스택에서는 어디에도 없어야 한다
        text = cls.env_file.read_text()
        for k, v in FAKE_EXTERNAL.items():
            text = re.sub(rf"^{re.escape(k)}=.*$", f"{k}={v}", text, flags=re.M) if re.search(rf"^{re.escape(k)}=", text, re.M) else text + f"{k}={v}\n"
        cls.env_file.write_text(text)
        cls.secrets = dict(re.findall(r"^([A-Za-z0-9_]+)=(.*)$", cls.env_file.read_text(), re.M))
        cls.iso_env = iso_env()
        cls.dev = cls._config({})
        cls.iso = cls._config(cls.iso_env, project="wakeline-e2e")

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    @classmethod
    def _config(cls, extra: dict[str, str], project: str | None = None) -> dict:
        # 호스트 셸의 값이 해석 결과에 섞이지 않게(시험은 임시 .env + 명시한 값만 본다)
        drop = ("WAKELINE_", "REDIS_", "DB_", "COMPOSE_", "OPENSKY_", "KMA_", "AIS_", "aisstream", "EXTRA_ALLOWED_ORIGINS")
        env = {k: v for k, v in os.environ.items() if not k.startswith(drop)}
        env.update(extra)
        cmd = ["docker", "compose"] + (["-p", project] if project else []) + ["-f", str(COMPOSE), "--env-file", str(cls.env_file), "config", "--format", "json"]
        r = subprocess.run(cmd, capture_output=True, text=True, env=env)
        if r.returncode != 0:
            raise AssertionError(f"docker compose config failed: {r.stderr}")
        return json.loads(r.stdout)

    def svc(self, name: str, cfg: dict | None = None) -> dict:
        return (cfg or self.dev)["services"][name]

    # --- SEC-4: 컨테이너 권한 ---
    def test_every_container_is_hardened(self):
        for cfg in (self.dev, self.iso):
            for name, s in cfg["services"].items():
                with self.subTest(service=name):
                    self.assertIn("no-new-privileges:true", s.get("security_opt", []))
                    self.assertEqual(s.get("cap_drop"), ["ALL"])
                    self.assertTrue(s.get("read_only"), "루트 FS 는 read-only")
                    self.assertNotIn("privileged", s)
                    self.assertNotIn("env_file", s, "필요한 값만 environment 로 넘긴다")

    def test_no_service_adds_capabilities(self):
        """R-63 · ADR-004 재결정 뒤: db 도 처음부터 postgres(999)로 돌아(이미지 USER — 엔트리포인트의 root → gosu 경로 없음) 추가 권한이 없다."""
        for name, s in self.dev["services"].items():
            with self.subTest(service=name):
                self.assertFalse(s.get("cap_add"), "어느 서비스도 추가 권한이 없다")

    def test_db_image_is_built_here_and_runs_as_postgres_without_gosu(self):
        """R-63: db 는 infra/db/Dockerfile 로 직접 빌드 — 공식 postgres 기반 다이제스트 고정 · PostGIS 3.6 고정 · gosu 삭제 · USER postgres."""
        db = self.svc("db")
        self.assertEqual(db.get("image"), "wakeline-db:local")
        self.assertTrue(str(db.get("build", {}).get("context", "")).endswith("db"))
        df = (ROOT / "infra" / "db" / "Dockerfile").read_text()
        self.assertRegex(df, r"(?m)^FROM postgres:18-trixie@sha256:[0-9a-f]{64}\s*$", "공식 이미지 · 다이제스트 고정")
        self.assertIn("'postgresql-18-postgis-3=3.6.*'", df, "PostGIS 부 버전 고정")
        self.assertIn("rm -f /usr/local/bin/gosu", df)
        self.assertRegex(df, r"(?m)^USER postgres\s*$")

    def test_edge_and_redis_run_as_non_root(self):
        self.assertEqual(self.svc("edge").get("user"), "101:101")
        self.assertIn("nginx-unprivileged", self.svc("edge")["image"])
        self.assertEqual(self.svc("redis").get("user"), "999:1000")

    def test_resource_limits(self):
        for name in LONG_RUNNING:
            with self.subTest(service=name):
                lim = self.svc(name).get("deploy", {}).get("resources", {}).get("limits", {})
                self.assertTrue(lim.get("memory"), "memory 상한")
                self.assertTrue(lim.get("pids"), "pids 상한")

    def test_only_edge_publishes_and_only_on_loopback(self):
        for cfg, port in ((self.dev, "8700"), (self.iso, "8701")):
            for name, s in cfg["services"].items():
                with self.subTest(service=name, port=port):
                    ports = s.get("ports", [])
                    if name == "edge":
                        self.assertEqual(len(ports), 1)
                        self.assertEqual(ports[0]["host_ip"], "127.0.0.1")
                        self.assertEqual(str(ports[0]["published"]), port)
                    else:
                        self.assertEqual(ports, [])

    # --- SEC-8: 제3자 이미지 고정 ---
    def test_third_party_images_pinned_by_digest(self):
        for name, s in self.dev["services"].items():
            with self.subTest(service=name):
                if s["image"].startswith("wakeline-"):
                    self.assertTrue(s["image"].endswith(":local"))
                else:
                    self.assertRegex(s["image"], r"^[^@]+:[^@]+@sha256:[0-9a-f]{64}$")

    # --- SEC-5 · 계약 v2 §C: Redis ACL 사용자 ---
    def test_services_use_their_own_redis_user(self):
        admin = self.secrets["REDIS_PASSWORD"]
        expect = {"api": ("wakeline_api", "REDIS_API_PASSWORD"),
                  "collector": ("wakeline_collector", "REDIS_COLLECTOR_PASSWORD"),
                  "ais": ("wakeline_ais", "REDIS_AIS_PASSWORD")}
        for cfg in (self.dev, self.iso):
            for name, (user, pw_key) in expect.items():
                with self.subTest(service=name, project=cfg["name"]):
                    env = self.svc(name, cfg)["environment"]
                    self.assertEqual(env["REDIS_USERNAME"], user)
                    self.assertEqual(env["REDIS_PASSWORD"], self.secrets[pw_key])
                    self.assertNotIn(admin, env.values(), "관리용 default 비밀번호를 받지 않는다")
        pws = [self.secrets[k] for k in ("REDIS_PASSWORD", "REDIS_API_PASSWORD", "REDIS_COLLECTOR_PASSWORD", "REDIS_AIS_PASSWORD")]
        self.assertEqual(len(set(pws)), len(pws), "서비스마다 다른 비밀번호")

    def test_only_redis_sees_redis_secrets_it_does_not_use(self):
        """Redis 비밀번호는 그 사용자를 쓰는 서비스와 redis 자신에게만 있다."""
        owner = {"REDIS_PASSWORD": {"redis"}, "REDIS_API_PASSWORD": {"redis", "api"},
                 "REDIS_COLLECTOR_PASSWORD": {"redis", "collector"}, "REDIS_AIS_PASSWORD": {"redis", "ais"}}
        for key, allowed in owner.items():
            for name, s in self.dev["services"].items():
                with self.subTest(secret=key, service=name):
                    if name not in allowed:
                        self.assertNotIn(self.secrets[key], (s.get("environment") or {}).values())

    def test_collector_gets_no_other_service_secrets(self):
        env = self.svc("collector")["environment"]
        for k in ("DB_ROOT_PASSWORD", "DB_MIGRATOR_PASSWORD", "DB_API_PASSWORD", "REDIS_API_PASSWORD", "REDIS_AIS_PASSWORD", "aisstream_key"):
            with self.subTest(secret=k):
                self.assertNotIn(self.secrets[k], env.values())

    # --- SEC-R2: migrate 는 DDL 계정 비밀번호만 ---
    def test_migrate_gets_only_what_migrate_reads(self):
        for cfg in (self.dev, self.iso):
            with self.subTest(project=cfg["name"]):
                m = self.svc("migrate", cfg)
                env = m["environment"]
                self.assertLessEqual(set(env), MIGRATE_ENV_ALLOWED, "WakelineApplication.migrate 가 읽지 않는 값은 주지 않는다")
                self.assertEqual(env["DB_MIGRATOR_PASSWORD"], self.secrets["DB_MIGRATOR_PASSWORD"])
                for k in ("DB_ROOT_PASSWORD", "DB_API_PASSWORD", "DB_COLLECTOR_PASSWORD",
                          "REDIS_PASSWORD", "REDIS_API_PASSWORD", "REDIS_COLLECTOR_PASSWORD", "REDIS_AIS_PASSWORD"):
                    self.assertNotIn(self.secrets[k], env.values(), k)
                self.assertEqual(set(m.get("depends_on", {})), {"db"}, "Redis 를 기다리지 않는다(쓰지 않는다)")
                self.assertEqual(m.get("restart"), "no")
                self.assertEqual(m.get("command"), ["--migrate"])

    # --- R-78: 수집 계층은 api 건강에 묶이지 않는다(api 크래시 루프여도 수집·원천 보관·DB 기록이 기동된다) ---
    def test_collectors_do_not_wait_for_api_health(self):
        for cfg in (self.dev, self.iso):
            with self.subTest(project=cfg["name"]):
                for name in ("collector", "ais"):
                    self.assertNotIn("api", self.svc(name, cfg).get("depends_on", {}), name)
                dep = self.svc("collector", cfg)["depends_on"]
                self.assertEqual(dep["migrate"]["condition"], "service_completed_successfully", "ingest 테이블은 migrate 가 만든다")
                self.assertEqual(dep["redis"]["condition"], "service_healthy")
                self.assertEqual(dep["db"]["condition"], "service_healthy")

    # --- 외부 키: 쓰는 컨테이너에만(개발), 격리 스택에는 없음 ---
    def test_external_keys_only_where_used(self):
        where = {"aisstream_key": ("ais", "AISSTREAM_API_KEY"), "OPENSKY_CLIENT_ID": ("collector", "OPENSKY_CLIENT_ID"),
                 "OPENSKY_CLIENT_SECRET": ("collector", "OPENSKY_CLIENT_SECRET"), "KMA_APIHUB_KEY": ("collector", "KMA_APIHUB_KEY"),
                 "DATA_GO_KR_SERVICE_KEY": ("collector", "DATA_GO_KR_SERVICE_KEY")}
        for key, (owner, var) in where.items():
            fake = FAKE_EXTERNAL[key]
            with self.subTest(key=key):
                self.assertEqual(self.svc(owner)["environment"][var], fake, f"{owner} 가 {var} 로 받는다")
                for name, s in self.dev["services"].items():
                    if name != owner:
                        self.assertNotIn(fake, (s.get("environment") or {}).values(), f"{name} 에는 없어야 한다")
                for name, s in self.iso["services"].items():
                    self.assertNotIn(fake, (s.get("environment") or {}).values(), f"격리 스택 {name} 에는 없어야 한다")

    def test_redis_passwords_not_on_command_line(self):
        r = self.svc("redis")
        argv = " ".join((r.get("entrypoint") or []) + (r.get("command") or []) + r["healthcheck"]["test"])
        for k in ("REDIS_PASSWORD", "REDIS_API_PASSWORD", "REDIS_COLLECTOR_PASSWORD", "REDIS_AIS_PASSWORD"):
            with self.subTest(secret=k):
                self.assertNotIn(self.secrets[k], argv)
                self.assertEqual(r["environment"][k], self.secrets[k])
        self.assertEqual(r["entrypoint"], ["sh", "/etc/redis/start.sh"])
        mounts = {v["target"]: v for v in r["volumes"]}
        self.assertTrue(mounts["/etc/redis/start.sh"]["read_only"])
        self.assertTrue(mounts["/etc/redis/redis.conf"]["read_only"])
        self.assertEqual(mounts["/data"]["type"], "volume")

    def test_redis_acl_file_lives_on_tmpfs(self):
        """S7: start.sh 는 ACL 파일(해시만, 0600)을 /tmp 에 쓴다 — 루트 FS 는 read-only 라 tmpfs 가 있어야 기동하고,
        데이터 볼륨(/data — AOF, 백업 대상이 될 수 있다)에는 두지 않는다. 컨테이너가 멈추면 사라진다."""
        for cfg in (self.dev, self.iso):
            r = self.svc("redis", cfg)
            self.assertTrue(r.get("read_only"))
            self.assertTrue([t for t in r.get("tmpfs", []) if t.split(":", 1)[0] == "/tmp"], "redis 에 tmpfs /tmp")

    # --- R-90 · R-06: api 설정값이 .env 에서 실제로 전달된다(application.yml 기본값만 있고 compose 가 넘기지 않으면 바꿀 방법이 없다) ---
    def test_api_cookie_secure_and_alert_retention_pass_through(self):
        env = self.svc("api")["environment"]
        self.assertEqual(env["WAKELINE_COOKIE_SECURE"], "false", "로컬 http 기본")
        self.assertEqual(env["WAKELINE_ALERT_RETENTION_DAYS"], "30")
        custom = self._config({"COOKIE_SECURE": "true", "ALERT_RETENTION_DAYS": "45"})
        self.assertEqual(custom["services"]["api"]["environment"]["WAKELINE_COOKIE_SECURE"], "true")
        self.assertEqual(custom["services"]["api"]["environment"]["WAKELINE_ALERT_RETENTION_DAYS"], "45")

    # --- 계약 v5 §G24 · 리뷰 2026-09-30: .env 에 적는 수집기 설정은 collector 컨테이너에 닿는다 ---
    # collector 는 .env 전체(env_file)를 받지 않고 compose 가 명시한 값만 받는다(Settings env_file=None) — 여기 빠진 설정은 .env 에 적어도 조용히
    # 기본값이 된다(KMA_APIHUB_RPS 가 그랬다: 문서는 운영 설정이라 했지만 compose 가 넘기지 않아 늘 0.5).
    def test_every_collector_setting_in_env_example_reaches_the_collector(self):
        body = (ROOT / "apps/collector/wakeline_collector/config.py").read_text(encoding="utf-8").split("class Settings(BaseSettings):", 1)[1]
        fields = set(re.findall(r"^    ([a-z_][a-z0-9_]*)\s*:", body, re.M))
        keys = re.findall(r"^([A-Za-z_][A-Za-z0-9_]*)=", (ROOT / ".env.example").read_text(encoding="utf-8"), re.M)
        documented = [k for k in keys if k.lower() in fields]
        self.assertIn("KMA_APIHUB_RPS", documented)
        for cfg in (self.dev, self.iso):
            env = self.svc("collector", cfg)["environment"]
            for k in documented:
                with self.subTest(project=cfg["name"], key=k):
                    # 이름만 비교한다(실패 글에 비밀값이 찍히지 않게)
                    self.assertIn(k, sorted(env), f".env.example 의 {k} 는 수집기 설정({k.lower()})인데 collector 에 넘기지 않는다")

    def test_kma_apihub_rps_passes_through_with_the_chosen_default(self):
        self.assertEqual(self.svc("collector")["environment"]["KMA_APIHUB_RPS"], "0.5", ".env.example 의 고른 값")
        custom = self._config({"KMA_APIHUB_RPS": "1.0"})
        self.assertEqual(custom["services"]["collector"]["environment"]["KMA_APIHUB_RPS"], "1.0")
        for name, svc in self.dev["services"].items():
            if name != "collector":
                self.assertNotIn("KMA_APIHUB_RPS", sorted(svc.get("environment") or {}), name)

    def test_region_chain_default_is_adsb_fi_first_everywhere(self):
        """계약 v5 §G25(ADR-011 개정 2026-09-30 저녁): 관심 지역 기본 순서 adsb_fi → adsb_lol → (opensky 는 전세계 전용). .env.example · compose 기본값 ·
        수집기 설정 기본값 · 운영 설정을 옮기는 마이그레이션(V17)이 같은 순서다 — 하나만 바뀌면 .env 유무 · 운영 설정 미러 유무에 따라 순서가 달라진다."""
        want = "adsb_fi,adsb_lol,opensky"
        self.assertEqual(self.svc("collector")["environment"]["AIRCRAFT_PROVIDERS"], want, ".env.example 의 값")
        m = re.search(r"AIRCRAFT_PROVIDERS: \$\{AIRCRAFT_PROVIDERS:-([^}]*)\}", COMPOSE.read_text(encoding="utf-8"))
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), want, "compose 기본값(.env 에 없을 때)")
        config = (ROOT / "apps/collector/wakeline_collector/config.py").read_text(encoding="utf-8")
        self.assertIn(f'aircraft_providers: str = "{want}"', config)
        v17 = next((ROOT / "apps/api/src/main/resources/db/migration").glob("V17__*.sql"), None)
        self.assertIsNotNone(v17, "운영 설정(app_setting)을 옮기는 마이그레이션")
        self.assertIn(f"SET value = '\"{want}\"'", v17.read_text(encoding="utf-8"))

    # --- SEC-7: WS Origin 허용 목록 ---
    def test_api_allowed_origins_follow_published_port(self):
        self.assertEqual(self.svc("api")["environment"]["WAKELINE_ALLOWED_ORIGINS"], "http://localhost:8700,http://127.0.0.1:8700")
        self.assertEqual(self.svc("api", self.iso)["environment"]["WAKELINE_ALLOWED_ORIGINS"], "http://localhost:8701,http://127.0.0.1:8701")

    def test_extra_allowed_origins_are_an_empty_opt_in_that_reaches_only_the_api(self):
        """`next dev`(http://localhost:3000)로 화면을 띄울 때의 개발 전용 opt-in(리뷰 cto-2026-10 S1 후속): 기본은 비어 있어 허용 목록은 게시 포트뿐이고,
        .env 의 EXTRA_ALLOWED_ORIGINS 는 api 의 WAKELINE_EXTRA_ALLOWED_ORIGINS 로만 간다(AppProperties.originPatterns 가 목록 뒤에 붙인다)."""
        for cfg in (self.dev, self.iso):
            with self.subTest(project=cfg["name"]):
                self.assertEqual(self.svc("api", cfg)["environment"]["WAKELINE_EXTRA_ALLOWED_ORIGINS"], "")
        custom = self._config({"EXTRA_ALLOWED_ORIGINS": "http://localhost:3000"})
        api = custom["services"]["api"]["environment"]
        self.assertEqual(api["WAKELINE_EXTRA_ALLOWED_ORIGINS"], "http://localhost:3000")
        self.assertEqual(api["WAKELINE_ALLOWED_ORIGINS"], "http://localhost:8700,http://127.0.0.1:8700", "the stack's own list is unchanged")
        for name, svc in custom["services"].items():
            if name != "api":
                self.assertNotIn("WAKELINE_EXTRA_ALLOWED_ORIGINS", sorted(svc.get("environment") or {}), name)

    # --- REL-20 · 계약 §8: collector 헬스체크 ---
    def test_collector_healthcheck(self):
        hc = self.svc("collector")["healthcheck"]
        self.assertEqual(hc["test"], ["CMD", "python", "-m", "wakeline_collector.health"])
        self.assertIn("start_period", hc)

    def test_every_long_running_service_has_healthcheck(self):
        for name in LONG_RUNNING:
            with self.subTest(service=name):
                self.assertTrue(self.svc(name).get("healthcheck", {}).get("test"))

    def test_isolated_stack_is_separate(self):
        self.assertEqual(self.iso["name"], "wakeline-e2e")
        for name in ("api", "collector", "ais"):
            with self.subTest(service=name):
                self.assertEqual(self.svc(name, self.iso)["environment"]["WAKELINE_FIXTURE_MODE"], "1")
        self.assertEqual(self.svc("ais", self.iso)["environment"]["AISSTREAM_API_KEY"], "", "fixture 재생 — 키 없음")
        self.assertEqual(self.svc("api", self.iso)["environment"]["WAKELINE_TRUSTED_PROXY"], "10.78.0.10")
        self.assertEqual(self.iso["networks"]["wakeline"]["ipam"]["config"][0]["subnet"], "10.78.0.0/24")

    def test_iso_env_blanks_every_external_key(self):
        for k in FAKE_EXTERNAL:
            with self.subTest(key=k):
                self.assertEqual(self.iso_env.get(k), "", "Makefile ISO_ENV 가 빈 값으로 덮어써야 한다")

    def test_api_has_shutdown_grace(self):
        self.assertIn("stop_grace_period", self.svc("api"))

    # --- 계약 v2 §B1 · §C: ais 서비스 ---
    def test_ais_service(self):
        for cfg in (self.dev, self.iso):
            with self.subTest(project=cfg["name"]):
                a = self.svc("ais", cfg)
                self.assertEqual(a["image"], "wakeline-collector:local", "collector 와 같은 이미지")
                self.assertEqual(a["build"]["dockerfile"], self.svc("collector", cfg)["build"]["dockerfile"])
                # 이미지 ENTRYPOINT 가 python -m wakeline_collector 라서 command 로는 바꿀 수 없다 — entrypoint 를 바꾼다
                self.assertEqual(a["entrypoint"], ["python", "-m", "wakeline_collector.ais"])
                self.assertFalse(a.get("command"))
                self.assertEqual(a["healthcheck"]["test"], ["CMD", "python", "-m", "wakeline_collector.ais.health"])
                self.assertIn("start_period", a["healthcheck"])
                self.assertEqual(int(a["deploy"]["resources"]["limits"]["memory"]), 256 * 1024 * 1024)
                self.assertTrue(a["deploy"]["resources"]["limits"].get("pids"))
                self.assertEqual(a["depends_on"]["redis"]["condition"], "service_healthy")
                self.assertNotIn("db", a["depends_on"], "DB 를 쓰지 않는다")
                self.assertNotIn(str(a.get("user", "")), ("0", "root", "0:0"), "이미지의 비root 사용자(app)")
                self.assertFalse(a.get("volumes"), "쓰기 볼륨 없음(read-only + tmpfs)")
                self.assertTrue(any(t.startswith("/tmp") for t in a.get("tmpfs", [])))
                self.assertLessEqual(set(a["environment"]), AIS_ENV_ALLOWED)
                self.assertEqual(a["environment"]["AIS_BBOXES"], "18,105,46,150", "동아시아로 시작(ADR-014 §7)")
                self.assertEqual(a.get("ports", []), [])
                for k in ("DB_ROOT_PASSWORD", "DB_MIGRATOR_PASSWORD", "DB_API_PASSWORD", "DB_COLLECTOR_PASSWORD"):
                    self.assertNotIn(self.secrets[k], a["environment"].values(), k)

    def test_ais_image_user_is_not_root(self):
        """이미지가 로컬에 있으면 USER 가 root 가 아닌지 본다(compose 는 user 를 지정하지 않고 이미지의 app 사용자를 쓴다)."""
        r = subprocess.run(["docker", "image", "inspect", "-f", "{{.Config.User}}", "wakeline-collector:local"], capture_output=True, text=True)
        if r.returncode != 0:
            self.skipTest("wakeline-collector:local 이미지 없음")
        self.assertNotIn(r.stdout.strip(), ("", "0", "root", "0:0"))

    # --- SEC-R3: 슈퍼유저 로컬 소켓 전용 ---
    def test_db_superuser_local_socket_only(self):
        for cfg in (self.dev, self.iso):
            with self.subTest(project=cfg["name"]):
                db = self.svc("db", cfg)
                self.assertEqual(db["environment"]["WAKELINE_PG_SUPERUSER_TCP"], "reject")
                mounts = {v["target"]: v for v in db["volumes"]}
                self.assertTrue(mounts["/docker-entrypoint-initdb.d"]["read_only"])
                self.assertEqual(db["healthcheck"]["test"][0], "CMD-SHELL")
                self.assertNotRegex(db["healthcheck"]["test"][1], r"\s-h\s", "헬스체크는 로컬 소켓(-h 없음)")
        self.assertTrue((ROOT / "infra/db/init/02-superuser-local-only.sh").stat().st_mode & 0o111, "실행 가능해야 initdb 가 실행한다")

    # --- R-64 · R-77 · ADR-017 §4: 네트워크 분리 — 외부 호출은 collector·ais 만(망이 강제) ---
    # wakeline = ADR 의 internal 망(internal: true, 게이트웨이 없음). 이름을 유지해 기존 스택이 `make up` 한 번으로 제자리 전환되고 되돌리기도 같다.
    def test_every_service_is_on_exactly_its_networks(self):
        for cfg in (self.dev, self.iso):
            for name, s in cfg["services"].items():
                with self.subTest(project=cfg["name"], service=name):
                    self.assertIn(name, SERVICE_NETWORKS, "새 서비스는 어느 망에 둘지 여기서 정한다")
                    self.assertEqual(set(s.get("networks") or {}), SERVICE_NETWORKS[name])
            self.assertEqual(set(cfg["services"]), set(SERVICE_NETWORKS), "목록에만 있고 compose 에 없는 서비스")

    def test_internal_network_has_no_internet(self):
        for cfg in (self.dev, self.iso):
            nets = cfg["networks"]
            with self.subTest(project=cfg["name"]):
                self.assertEqual(set(nets), {"public", INTERNAL_NET, "egress"})
                self.assertIs(nets[INTERNAL_NET].get("internal"), True, "internal: true — 게이트웨이·NAT 없음")
                self.assertFalse(nets["egress"].get("internal"), "collector·ais 의 외부 호출 경로")
                self.assertFalse(nets["public"].get("internal"), "edge 의 게시 포트 경로")

    def test_only_collector_ais_and_edge_sit_on_networks_that_reach_the_internet(self):
        # R-77 후속: 'public' 도 일반 bridge(NAT)라 edge 는 망 차원에서는 인터넷에 나갈 수 있다 — 게시 포트는 internal 망에 둘 수 없고,
        # Docker Desktop 은 bridge 의 enable_ip_masquerade=false 로도 막지 않았다(실측). edge 의 외부 호출 금지는 설정(nginx upstream 이
        # api·web 뿐 · resolver 없음 — test_edge_policy.NoOutboundCalls)으로 지킨다. 망이 막는 것은 web·api·migrate·db·redis 다.
        for cfg in (self.dev, self.iso):
            outside = {n for n, v in cfg["networks"].items() if not v.get("internal")}
            by_service = {name: set(s.get("networks") or {}) & outside for name, s in cfg["services"].items()}
            with self.subTest(project=cfg["name"]):
                self.assertEqual({n for n, v in by_service.items() if v}, {"collector", "ais", "edge"})
                self.assertEqual({n for n, v in by_service.items() if "egress" in v}, {"collector", "ais"})
                self.assertEqual({n for n, v in by_service.items() if "public" in v}, {"edge"})
                for name in ("web", "api", "migrate", "db", "redis"):
                    self.assertEqual(by_service[name], set(), f"{name} 는 인터넷에 닿는 망에 없다")

    def test_fixed_ips_and_trusted_proxy_stay_on_the_internal_network(self):
        for cfg, prefix in ((self.dev, "10.77.0"), (self.iso, "10.78.0")):
            with self.subTest(project=cfg["name"]):
                self.assertEqual(cfg["networks"][INTERNAL_NET]["ipam"]["config"][0]["subnet"], f"{prefix}.0/24")
                edge_ip = self.svc("edge", cfg)["networks"][INTERNAL_NET]["ipv4_address"]
                self.assertEqual(edge_ip, f"{prefix}.10")
                self.assertEqual(self.svc("api", cfg)["environment"]["WAKELINE_TRUSTED_PROXY"], edge_ip,
                                 "api 가 보는 edge 주소는 internal 망의 주소")
                self.assertEqual(self.svc("api", cfg)["networks"][INTERNAL_NET]["ipv4_address"], f"{prefix}.30", "make bench 의 BENCH_API")

    # --- R-24 · ADR-017 §4: WAL 전체 페이지 이미지 줄이기 ---
    def test_db_wal_and_memory_settings(self):
        for cfg in (self.dev, self.iso):
            with self.subTest(project=cfg["name"]):
                cmd = self.svc("db", cfg).get("command") or []
                self.assertEqual(cmd[:1], ["postgres"], "공식 엔트리포인트가 postgres 로 인식해 초기화·권한 강하를 그대로 한다")
                settings = dict(a.split("=", 1) for a in cmd[2::2]) if cmd[1:2] == ["-c"] else {}
                self.assertEqual([a for a in cmd[1::2]], ["-c"] * len(settings), "postgres -c k=v -c k=v …")
                self.assertEqual(settings, DB_SETTINGS)

    # --- R-80: 비밀값이 빠지면 조용히 빈 값으로 뜨지 않고 기동을 거부한다 ---
    def test_missing_secret_is_refused_by_name(self):
        text = self.env_file.read_text()
        for key in init_env.INTERNAL:
            with self.subTest(secret=key):
                broken = Path(self._tmp.name) / f"missing-{key}.env"
                broken.write_text(re.sub(rf"^{re.escape(key)}=.*\n", "", text, flags=re.M))
                drop = ("WAKELINE_", "REDIS_", "DB_", "COMPOSE_", "OPENSKY_", "KMA_", "AIS_", "aisstream", "EXTRA_ALLOWED_ORIGINS")
                env = {k: v for k, v in os.environ.items() if not k.startswith(drop)}
                r = subprocess.run(["docker", "compose", "-f", str(COMPOSE), "--env-file", str(broken), "config", "--quiet"],
                                   capture_output=True, text=True, env=env)
                self.assertNotEqual(r.returncode, 0, f"{key} 가 없는데 compose 가 빈 값으로 해석했다")
                self.assertIn(key, r.stderr, "오류가 빠진 변수 이름을 알려 준다")

    def test_every_secret_interpolation_is_guarded(self):
        text = COMPOSE.read_text()
        for key in init_env.INTERNAL:
            with self.subTest(secret=key):
                uses = re.findall(rf"\$\{{{re.escape(key)}(\}}|[^}}]*\}})", text)
                self.assertTrue(uses, f"{key} 를 쓰는 곳이 없다")
                for u in uses:
                    self.assertTrue(u.startswith(":?"), f"${{{key}{u} — ':?' 가드가 없다")

    # --- 로그 회전(디스크 고갈 방지) ---
    def test_every_service_rotates_logs(self):
        for name, s in self.dev["services"].items():
            with self.subTest(service=name):
                log = s.get("logging") or {}
                self.assertEqual(log.get("driver"), "json-file")
                self.assertTrue(log.get("options", {}).get("max-size"))
                self.assertTrue(log.get("options", {}).get("max-file"))


if __name__ == "__main__":
    unittest.main()
