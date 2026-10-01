# Wakeline — 로컬 운영 명령 (macOS · Apple Silicon · Docker Desktop)
SHELL := /bin/bash
COMPOSE := docker compose -f infra/compose.yml --env-file .env
# 격리 스택(E2E·데모): 프로젝트·포트·서브넷·볼륨이 개발 스택과 분리된다. fixture 모드라 외부 호출이 없다.
# 외부 키는 빈 값으로 덮어쓴다(셸 환경이 --env-file 보다 우선) — 격리 스택 컨테이너에는 실제 키가 들어가지 않는다(fixture 모드와 이중 안전장치).
# 개발 전용 EXTRA_ALLOWED_ORIGINS(`next dev` opt-in)도 비운다 — 격리 스택의 허용 Origin 은 게시 포트(8701)뿐이다.
ISO_ENV := WAKELINE_FIXTURE_MODE=1 WAKELINE_PORT=8701 WAKELINE_NET_PREFIX=10.78.0 aisstream_key= OPENSKY_CLIENT_ID= OPENSKY_CLIENT_SECRET= KMA_APIHUB_KEY= DATA_GO_KR_SERVICE_KEY= EXTRA_ALLOWED_ORIGINS=
ISO := $(ISO_ENV) docker compose -p wakeline-e2e -f infra/compose.yml --env-file .env
# 부하 시험 도구 — 버전+다이제스트 고정(latest 가 바뀌어 내부망에 붙는 도구가 조용히 달라지지 않게). Dependabot 대상 아님: 올릴 때 여기서 함께 바꾼다.
K6_IMAGE := grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34
# 개발 스택의 api 주소·네트워크(compose 의 고정 IP) 와 WS Origin(api 의 허용 목록 WAKELINE_ALLOWED_ORIGINS 에 있는 값)
NET_PREFIX := $(or $(WAKELINE_NET_PREFIX),10.77.0)
BENCH_API := http://$(NET_PREFIX).30:8000
BENCH_ORIGIN ?= http://localhost:$(or $(WAKELINE_PORT),8700)

.PHONY: help init up down ps logs build ops-user test test-api test-collector test-collector-db test-web test-infra infra-docker-test security contract contract-rest ws-samples readme-images e2e demo demo-down bench bench-edge measure-ais db-superuser-local-only backup restore rotate-db-passwords fixtures clean

help: ## 명령 목록
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

init: ## .env 생성(소유자 전용 600) + 빠진 내부 비밀값만 생성 (외부 키는 직접 입력)
	@python3 tools/init_env.py

up: init ## 전체 스택 기동 (상시 7 컨테이너 + 일회성 migrate) → http://localhost:8700
	$(COMPOSE) up -d --build
	@echo "Wakeline → http://localhost:8700   (ops: http://localhost:8700/ops)"

down: init ## 중지 (데이터 보존)
	$(COMPOSE) down

clean: init ## 중지 + 볼륨 삭제 (데이터 초기화!)
	$(COMPOSE) down -v

ps: init ## 컨테이너 상태
	$(COMPOSE) ps

logs: init ## 로그 (예: make logs s=api · make logs s=ais · 여러 개: s="api ais")
	$(COMPOSE) logs -f --tail=200 $(s)

build: init ## 이미지만 빌드
	$(COMPOSE) build

# 비밀번호는 명령행(argv — ps 로 누구나 볼 수 있다)이나 환경변수로 넘기지 않고 stdin 한 줄로 넘긴다(계약 §7, SEC-13).
# printf 는 bash 내장이라 별도 프로세스의 argv 에도 남지 않는다.
ops-user: init ## 운영자 계정 생성/갱신 (make ops-user u=admin) — 비밀번호는 프롬프트(12자 이상, 화면에 표시 안 됨)
	@u='$(or $(u),admin)'; \
	if ! [[ "$$u" =~ ^[A-Za-z0-9_.-]{1,64}$$ ]]; then echo "사용자 이름은 영문·숫자·_ . - 1~64자여야 합니다"; exit 2; fi; \
	IFS= read -rs -p "password for $$u (12자 이상): " pw; echo; \
	if [ $${#pw} -lt 12 ]; then echo "비밀번호는 12자 이상이어야 합니다 (입력: $${#pw}자)"; exit 2; fi; \
	IFS= read -rs -p "confirm: " pw2; echo; \
	if [ "$$pw" != "$$pw2" ]; then echo "두 입력이 다릅니다"; exit 2; fi; \
	out=$$(printf '%s\n' "$$pw" | $(COMPOSE) exec -T -e WAKELINE_OPS_USER="$$u" api java -jar /app/app.jar --create-ops-user --password-stdin 2>&1); rc=$$?; \
	unset pw pw2; \
	grep -E "ops user|must be|password" <<<"$$out" || true; \
	if [ $$rc -ne 0 ]; then echo "실패(exit $$rc) — 마지막 로그:"; tail -n 15 <<<"$$out"; fi; \
	exit $$rc

test: test-collector test-api test-web test-infra ## 전체 테스트

test-api: ## Java 단위·통합 테스트 + JaCoCo 커버리지 보고서·검증 + REST 계약 검사 (로컬 JDK 25 + Docker 필요)
	docker build -q -t wakeline-db:local infra/db >/dev/null   # DB 통합 테스트가 운영과 같은 db 이미지를 쓴다(R-63 — 레지스트리에 없다)
	cd apps/api && ./gradlew test jacocoTestReport jacocoTestCoverageVerification
	$(MAKE) -s contract-rest

test-collector: ## Python 단위 테스트
	cd apps/collector && uv run pytest -q

test-collector-db: ## 수집기 SQL 을 실제 PostgreSQL(api 의 Flyway 마이그레이션 · 수집기 계정)에 대조 — 버리는 컨테이너(db 이미지 wakeline-db:local 은 make build · infra-docker-test 가 만든다)
	bash infra/tests/collector_pg_test.sh

test-web: ## 프론트 단위 테스트
	cd apps/web && npm test

test-infra: ## 인프라 정책 시험(.env 생성 · compose 해석(개발·격리): 권한 축소·ACL 사용자·비밀값 분리·다이제스트 고정 · CI 스캔 범위) — 컨테이너를 띄우지 않는다
	python3 -m unittest discover -s infra/tests -v

infra-docker-test: init ## 버리는 컨테이너로 edge(Host 허용 목록·비root) · redis(ACL: api·collector·ais) · db(권한 축소·슈퍼유저 로컬 소켓 전용 · 백업·복원 · 비밀번호 교체 · 이전 이미지 → 새 이미지 교체) · 수집기 SQL(실제 PostgreSQL) 동작 시험 — 개발 스택은 건드리지 않는다
	$(COMPOSE) build db   # R-63: db 이미지는 infra/db 에서 직접 빌드한다(레지스트리에 없다) — db 시험이 이 태그를 쓴다
	bash infra/tests/edge_test.sh
	bash infra/tests/redis_acl_test.sh
	bash infra/tests/db_hardening_test.sh
	bash infra/tests/db_backup_test.sh
	bash infra/tests/db_rotate_test.sh
	bash infra/tests/db_image_swap_test.sh
	bash infra/tests/collector_pg_test.sh

# 원격 CI 가 없어도 ci.yml 의 security·third-party-images 와 같은 기준으로 막는다(R-07). 스캐너는 다이제스트 고정·네트워크 없음·docker.sock 없음(tools/scan_lib.sh).
# 의존성 감사는 ci.yml 의 web·collector job 과 같은 명령(tools/dependency_audit.sh, S2) — 레지스트리·취약점 DB 에 닿아야 하고, 돌리지 못하면 실패다.
security: ## 보안 게이트: gitleaks(git 이력) + trivy(자체 이미지 차단 · 제3자는 ci.yml 행렬대로) + npm audit · pip-audit(CI 와 같은 명령) — 이미지는 먼저 make build · SCAN_OFFLINE=1 이면 trivy DB 캐시만 쓰고 의존성 감사는 건너뜀(SKIP 표시)
	bash tools/security_gate.sh

contract: ## Python↔Java 스키마 계약 검사 (+ api 테스트가 남긴 REST 응답 기록이 있으면 REST 계약도)
	cd apps/collector && uv run python ../../tools/contract_check.py
	@if [ -d apps/api/build/rest-samples ]; then $(MAKE) -s contract-rest; else echo "REST 계약: apps/api/build/rest-samples 없음 — make test-api 가 만든다(건너뜀)"; fi

contract-rest: ## Java→Python REST 계약 검사 — api 통합 테스트(RestSamplesIT)가 기록한 응답을 JSON Schema 로 검사 (GAP-24)
	cd apps/collector && uv run python ../../tools/rest_contract_check.py --dir ../api/build/rest-samples

ws-samples: ## WS 메시지 표본 다시 만들기(계약 v5 §E1) — api 시험이 실제 빌더로 만들어 schemas/ws 로 검증한 뒤 apps/web/tests/fixtures/ws-samples.v1.json 에 쓴다(커밋)
	cd apps/api && ./gradlew test --tests 'dev.wakeline.ws.WsSchemaContractTest' -PupdateWsSamples

readme-images: ## README 그림 내보내기 — 설명서 캡처(apps/web/public/guide · lib/guide-manifest.json)를 docs/images/<이름>.webp 로 복사, 설정(apps/web/lib/readme-images.json)에 없는 그림 파일은 지움. 먼저 guide-screenshots 로 찍는다(dry=1 이면 계획만)
	cd apps/web && node scripts/readme-images.mjs $(if $(dry),--dry-run,)

# 실패하면 스택을 지우기 전에 상태·로그를 남긴다(CI 에서 원인을 볼 수 있게). E2E_KEEP=1 이면 스택을 남긴다.
e2e: init ## 격리된 fixture 스택(8701)에서 Playwright E2E → 끝나면 스택·볼륨 삭제. 개발 스택(8700)은 건드리지 않는다
	@rc=0; \
	if ! $(ISO) up -d --build --wait; then \
	  echo "격리 스택 기동 실패 — 상태·로그:"; $(ISO) ps -a; $(ISO) logs --no-color --tail=150; rc=1; \
	else \
	  (cd apps/web && E2E_BASE_URL=http://localhost:8701 npx playwright test) || rc=$$?; \
	  if [ $$rc -ne 0 ]; then $(ISO) ps -a; $(ISO) logs --no-color --tail=150; fi; \
	fi; \
	if [ -z "$$E2E_KEEP" ]; then $(ISO) down -v --remove-orphans >/dev/null 2>&1; fi; \
	exit $$rc

demo: init ## 외부 호출 없는 fixture 데모 스택 → http://localhost:8701 (make demo-down 으로 삭제)
	$(ISO) up -d --build --wait
	@echo "demo (fixture) → http://localhost:8701"

demo-down: init ## 데모 스택·볼륨 삭제
	$(ISO) down -v --remove-orphans

# 측정 동안만 api 의 IP 제한·연결 상한을 올린다. 복원은 trap 으로 — k6 실패·Ctrl-C·kill·docker 오류 어느 경우든 .env 값으로 되돌린다(SEC-14).
# WS 는 api 가 명시한 Origin 목록만 받는다 → 개발 스택의 허용 Origin(BENCH_ORIGIN)을 보낸다.
bench: init ## k6 부하 시험 — api 층 직접 측정(측정 동안만 IP 제한·연결 상한 상향, 끝나면·중단돼도 원복). SHIPS=1 이면 선박 레이어도. 결과: perf/results/
	@ts=$$(date -u +%Y%m%dT%H%M%SZ); rc=1; rc2=1; \
	restore() { echo "restoring rate limits (.env values)…"; $(COMPOSE) up -d --wait api >/dev/null 2>&1 || echo "경고: api 원복 실패 — 'make up' 으로 다시 만드세요" >&2; }; \
	trap restore EXIT; trap 'exit 130' INT; trap 'exit 143' TERM HUP; \
	PUBLIC_RATE_LIMIT_PER_MIN=1000000 WS_MAX_CONN_PER_IP=1000 WS_MAX_CONN=1000 $(COMPOSE) up -d --wait api || exit 1; \
	docker run --rm --network wakeline_wakeline -v "$(CURDIR)/perf:/perf" -w /perf -e BASE_URL=$(BENCH_API) $(K6_IMAGE) run rest.js 2>&1 | tee perf/results/k6-rest-$$ts.log; rc=$${PIPESTATUS[0]}; \
	docker run --rm --network wakeline_wakeline -v "$(CURDIR)/perf:/perf" -w /perf -e BASE_URL=$(BENCH_API) -e ORIGIN=$(BENCH_ORIGIN) -e SHIPS=$(if $(filter 1,$(SHIPS)),1,0) $(K6_IMAGE) run ws.js 2>&1 | grep --line-buffered -v "VU iteration was interrupted" | tee perf/results/k6-ws-$$ts.log; rc2=$${PIPESTATUS[0]}; \
	echo "k6 exit: rest=$$rc ws=$$rc2 (99 = threshold crossed)"; [ $$rc -eq 0 ] && [ $$rc2 -eq 0 ]

bench-edge: ## 로컬 k6 로 edge(8700) 경유 측정 — 요청 제한(IP당 10 r/s·분당 120)이 그대로 걸려 429 가 정상이다(제한 동작 확인용)
	RPS=8 DURATION=1m k6 run perf/rest.js || true

# ADR-014 §7: 동아시아 구독으로 처리량·자원을 잰 뒤 전세계로 넓힌다. 측정값만 기록한다(외부 호출은 ais 컨테이너가 이미 하는 수신뿐).
measure-ais: ## AIS 수신 상태(wakeline:ais:status)·처리량·자원 측정, 읽기 전용 (make measure-ais d=60 i=10 · 격리 스택: P=wakeline-e2e) → perf/results/ais-*.log
	@python3 perf/measure_ais.py '$(or $(d),60)' '$(or $(i),10)' '$(or $(P),wakeline)'

fixtures: ## 실응답 스냅샷 갱신 (외부 한도 소모 주의)
	cd apps/collector && uv run python -m wakeline_collector.tools.snapshot

# SEC-R3: initdb 스크립트(infra/db/init/02-…)는 새 볼륨에서만 돈다 — 이미 있는 개발 볼륨에는 이것으로 한 번 적용한다(멱등, 재시작 없음).
db-postgis-update: ## db 이미지의 PostGIS 부 버전이 오른 뒤 한 번: ALTER EXTENSION postgis UPDATE (3.6.x 안에서만 · 멱등 · 격리 스택: P=wakeline-e2e)
	@WAKELINE_PROJECT='$(or $(P),wakeline)' bash tools/db-postgis-update.sh

db-superuser-local-only: ## 기존 db 볼륨에 '슈퍼유저 postgres 는 로컬 소켓만' 적용 (pg_hba reject + reload, 멱등 · 격리 스택: P=wakeline-e2e)
	@WAKELINE_PROJECT='$(or $(P),wakeline)' bash tools/db-superuser-local-only.sh

# R-13: 영구 보존 자료(SIGMET·알림·통계·감사·운영자·설정)의 사본. db 컨테이너 안에서 로컬 소켓 슈퍼유저로 pg_dump(비밀번호 없음) — 스택을 멈추지 않아도 한 스냅샷.
backup: ## DB 백업 → backups/<프로젝트>-<UTC>.dump (pg_dump 사용자 지정 형식, 파일 0600·디렉터리 0700, git 제외). 72 h 원해상도 행은 빼고(full=1 이면 포함) · 최신 keep 개(기본 10, 0 = 모두)만 보관 · 격리 스택: P=wakeline-e2e
	@WAKELINE_PROJECT='$(or $(P),wakeline)' FULL='$(full)' KEEP='$(or $(keep),10)' bash tools/db-backup.sh

# 빈 새 볼륨에만 복원한다(확인 문구 · 쓰는 컨테이너 정지 · 빈 DB 확인 · 한 트랜잭션). 절차: README '백업·복원'.
restore: ## 백업 복원: make restore f=backups/<파일>.dump confirm=wakeline — api·collector·ais 정지 + db 만 새 볼륨으로 띄운 상태에서
	@WAKELINE_PROJECT='$(or $(P),wakeline)' bash tools/db-restore.sh --file '$(f)' --confirm '$(confirm)'

# R-80: 역할 비밀번호는 새 볼륨의 initdb 에서 한 번만 정해진다 — .env 값만 바꾸거나 잃으면 api·collector·migrate 의 DB 인증이 조용히 실패한다.
# DB 에는 SCRAM 검증값만 stdin 으로 보내고, 새 값으로 로그인을 확인한 뒤에만 .env(0600)를 바꾼다. 적용: 이어서 make up.
rotate-db-passwords: init ## DB 서비스 계정(migrator·api·collector) 비밀번호 교체(DB·.env 함께) → 이어서 make up · sync=1 이면 .env 의 지금 값을 DB 에 맞춤(어긋남 복구) · 격리 스택은 같은 .env 를 읽으므로 P=wakeline-e2e sync=1 만
	@WAKELINE_PROJECT='$(or $(P),wakeline)' python3 tools/db_rotate_passwords.py $(if $(filter 1,$(sync)),--sync,)

# 변수 값 출력(CI · 보안 게이트 · 정책 시험용, 예: make -s print-K6_IMAGE). 허용 목록의 고정 설정만 — make 는 환경변수도 변수로 읽으므로
# 아무 이름이나 받으면 셸 · CI 에 export 된 비밀값까지 찍는다(I-8). 늘릴 때는 비밀값이 아닌지 확인하고 이름을 더한다(test_scripts_policy.py).
PRINTABLE_VARS := K6_IMAGE ISO_ENV
.PHONY: $(addprefix print-,$(PRINTABLE_VARS))
$(addprefix print-,$(PRINTABLE_VARS)): print-%:
	@echo '$($*)'
