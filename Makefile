# SkyWx — 로컬 운영 명령 (macOS · Apple Silicon · Docker Desktop)
SHELL := /bin/bash
COMPOSE := docker compose -f infra/compose.yml --env-file .env
# 격리 스택(E2E·데모): 프로젝트·포트·서브넷·볼륨이 개발 스택과 분리된다. fixture 모드라 외부 호출이 없다.
ISO_ENV := SKYWX_FIXTURE_MODE=1 SKYWX_PORT=8701 SKYWX_NET_PREFIX=10.78.0
ISO := $(ISO_ENV) docker compose -p skywx-e2e -f infra/compose.yml --env-file .env

.PHONY: help init up down ps logs build ops-user test test-api test-collector test-web contract e2e demo demo-down bench bench-edge fixtures clean

help: ## 명령 목록
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

init: ## .env 생성 + 내부 비밀값 자동 생성 (외부 키는 직접 입력)
	@python3 tools/init_env.py

up: init ## 전체 스택 기동 (6 컨테이너) → http://localhost:8700
	$(COMPOSE) up -d --build
	@echo "SkyWx → http://localhost:8700   (ops: http://localhost:8700/ops)"

down: ## 중지 (데이터 보존)
	$(COMPOSE) down

clean: ## 중지 + 볼륨 삭제 (데이터 초기화!)
	$(COMPOSE) down -v

ps: ## 컨테이너 상태
	$(COMPOSE) ps

logs: ## 로그 (예: make logs s=api)
	$(COMPOSE) logs -f --tail=200 $(s)

build: ## 이미지만 빌드
	$(COMPOSE) build

ops-user: ## 운영자 계정 생성/갱신 (make ops-user u=admin) — 비밀번호는 프롬프트(12자 이상, 화면에 표시 안 됨)
	@read -s -p "password for $(or $(u),admin) (12자 이상): " pw; echo; \
	if [ $${#pw} -lt 12 ]; then echo "비밀번호는 12자 이상이어야 합니다 (입력: $${#pw}자)"; exit 2; fi; \
	read -s -p "confirm: " pw2; echo; \
	if [ "$$pw" != "$$pw2" ]; then echo "두 입력이 다릅니다"; exit 2; fi; \
	$(COMPOSE) exec -T -e SKYWX_OPS_USER=$(or $(u),admin) -e SKYWX_OPS_PASSWORD="$$pw" api java -jar /app/app.jar --create-ops-user 2>&1 | grep -E "ops user|must be" || true

test: test-collector test-api test-web ## 전체 테스트

test-api: ## Java 단위·통합 테스트 (로컬 JDK 25 + Docker 필요)
	cd apps/api && ./gradlew test

test-collector: ## Python 단위 테스트
	cd apps/collector && uv run pytest -q

test-web: ## 프론트 단위 테스트
	cd apps/web && npm test

contract: ## Python↔Java 스키마 계약 검사
	cd apps/collector && uv run python ../../tools/contract_check.py

e2e: init ## 격리된 fixture 스택(8701)에서 Playwright E2E → 끝나면 스택·볼륨 삭제. 개발 스택(8700)은 건드리지 않는다
	$(ISO) up -d --build --wait
	cd apps/web && E2E_BASE_URL=http://localhost:8701 npx playwright test; rc=$$?; cd ../.. && $(ISO) down -v --remove-orphans >/dev/null 2>&1; exit $$rc

demo: init ## 외부 호출 없는 fixture 데모 스택 → http://localhost:8701 (make demo-down 으로 삭제)
	$(ISO) up -d --build --wait
	@echo "demo (fixture) → http://localhost:8701"

demo-down: ## 데모 스택·볼륨 삭제
	$(ISO) down -v --remove-orphans

bench: ## k6 부하 시험 — api 층 직접 측정(IP당 제한 잠시 상향, grafana/k6 컨테이너). 결과: perf/results/
	PUBLIC_RATE_LIMIT_PER_MIN=1000000 WS_MAX_CONN_PER_IP=500 $(COMPOSE) up -d api
	@echo "waiting for api…"; sleep 30
	docker run --rm --network skywx_skywx -v "$(PWD)/perf:/perf" -w /perf -e BASE_URL=http://10.77.0.30:8000 grafana/k6:latest run rest.js
	docker run --rm --network skywx_skywx -v "$(PWD)/perf:/perf" -w /perf -e BASE_URL=http://10.77.0.30:8000 grafana/k6:latest run ws.js
	$(COMPOSE) up -d api   # 제한 원복
	@echo "restored rate limits (.env values)"

bench-edge: ## 로컬 k6 로 edge(8700) 경유 측정 — 요청 제한(IP당 10 r/s·분당 120)이 그대로 걸려 429 가 정상이다(제한 동작 확인용)
	RPS=8 DURATION=1m k6 run perf/rest.js || true

fixtures: ## 실응답 스냅샷 갱신 (외부 한도 소모 주의)
	cd apps/collector && uv run python -m skywx_collector.tools.snapshot
