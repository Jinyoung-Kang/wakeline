# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Wakeline — 실시간 항공기 · 선박 · 위험기상 상황판(개인 포트폴리오, 비상업 · 로컬 운영). 사용자와의 대화 · 문서 · 화면 글자 · 코드 주석은 한국어,
커밋 메시지는 영어(끝에 `Co-Authored-By` 줄). 자세한 설명은 [README.md](README.md), 결정은 [docs/adr](docs/adr), 검증 기록은 [docs/VERIFICATION.md](docs/VERIFICATION.md).

## 스택
- `apps/api` Spring Boot 4.1 · Java 25 · Gradle(`./gradlew --offline`) · Flyway(`src/main/resources/db/migration`, V1–V17) · Testcontainers
- `apps/collector` Python 3.13 asyncio · uv — 패키지 `wakeline_collector`(폴링 수집기)와 `ais`(aisstream.io WebSocket 수신, 같은 이미지 · 다른 컨테이너)
- `apps/web` Next.js 16.3 · React 19.3 · MapLibre · zustand · Vitest · Playwright — **학습한 Next.js 와 다르다**: 코드를 쓰기 전에 `apps/web/AGENTS.md` 대로
  `apps/web/node_modules/next/dist/docs/` 를 읽는다
- `infra/` compose(PostgreSQL 18 + PostGIS 3.6 직접 빌드 · Redis 8 · nginx edge) · `tools/` 계약 검사 · `.env` 생성 · 보안 게이트 · `schemas/` 언어 사이 계약

## 명령
스택(포트 **8700** = 운영 스택, **8701** = 격리 E2E · 데모 스택):
```bash
make up                       # .env 생성(빠진 내부 비밀값만, 0600) + 빌드 · 기동 — 바뀐 컨테이너만 다시 만든다
make e2e                      # 격리 fixture 스택(8701)에서 Playwright → 스택 · 볼륨 삭제
make demo / make demo-down    # 외부 호출 없는 fixture 스택(8701)
make ops-user u=admin         # 운영자 계정 — 비밀번호는 프롬프트(stdin)로만
```
시험 · 검사 전체(CI `.github/workflows/ci.yml` 와 같은 명령):
```bash
make test                     # test-collector · test-api · test-web · test-infra
make test-api                 # wakeline-db:local 빌드 + gradlew test jacocoTestReport jacocoTestCoverageVerification(LINE 95 · BRANCH 80) + REST 계약
make test-collector-db        # 수집기 SQL 을 실제 PostgreSQL 에(버리는 컨테이너)
make infra-docker-test        # edge · Redis ACL · db 권한 · 백업·복원 · 비밀번호 교체 · 이미지 교체 · 수집기 PG — 버리는 컨테이너
make contract                 # schemas ↔ Python ↔ Java 사본 대조(+ REST 응답 계약)
make security                 # gitleaks + trivy(자체 이미지 :local) + npm audit · pip-audit — 이미지는 먼저 빌드. SCAN_OFFLINE=1 은 감사 건너뜀
```
하나만 돌리기:
```bash
cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.ops.OpsOriginFilterTest'          # 클래스 · 메서드(…Test.method)
cd apps/api && ./gradlew --offline perfTest --tests 'dev.wakeline.logs.LogReaderScanPerfTest'    # @Tag("perf") 측정 시험은 test 에서 빠진다
cd apps/collector && uv run --offline pytest tests/test_http.py::test_name -q
cd apps/collector && uv run --offline ruff check . && uv run --offline ruff format --check . && uv run --offline mypy wakeline_collector
cd apps/collector && uv run --offline python ../../tools/contract_check.py                       # contract_check 는 수집기 venv 로
cd apps/web && npx vitest run tests/log-feed.test.ts                                              # 측정 시험은 WAKELINE_PERF=1
cd apps/web && npx eslint . && npx tsc --noEmit && npm run build && npm run check:first-js -- --in-image
python3 -m unittest discover -s infra/tests                                                       # 인프라 정책(README 수치 · compose · Dockerfile)
```

## 아키텍처(여러 파일을 읽어야 보이는 것)
- **흐름**: collector · ais 만 외부를 부른다 → Redis Streams(`XADD`, 봉투 `schemas/stream_envelope`) → api `ingest.StreamConsumer`(`XREADGROUP`,
  JSON Schema 검증은 건너뛰지 않는다) → 메모리 상태(불변 스냅샷 교체) · WS 허브 방송 · 기록기(TrackWriter · ShipWriter · OrderedWriter → PostGIS, 일 파티션).
  웹은 nginx edge(127.0.0.1:8700) 뒤에서 REST + WS. api 는 요청 처리 중 외부 API 를 부르지 않는다(ADR-001 · 006).
- **수요 기반 추적**(ADR-013): 브라우저가 WS 로 보는 영역만 알리고, api 가 Redis 에 60 s 임대를 쓰면 collector 가 그것만 부른다(토큰 버킷 · 일일 예산 — Redis Lua).
- **언어 경계 = `schemas/*.json`**: 루트가 원본이고 Java 는 `apps/api/src/main/resources/schemas` 의 바이트 같은 사본을 쓴다(바꾸면 함께 복사 — `contract_check` 가 본다).
  WS 메시지는 `schemas/ws/*.json` · 표본은 api 시험이 만들어 웹 fixture 로(`make ws-samples`). OpenAPI 스냅샷은 `apps/api/openapi/openapi-v1.json`(`-PupdateOpenApi`).
- **api 패키지**(ADR-028): `aircraft` · `ships` · `weather` 는 `core`(규칙 · 메모리 상태 — JDBC · Redis · 서블릿 금지) / `data` / `web`, 작은 기능은 평평하게,
  기반은 `platform.{config,web,data,support}` · `geo`. 의존은 바깥 → 규칙 한 방향, 순환 0, 컨트롤러는 데이터에 직접 닿지 않음, `ws` 는 아무도 import 하지 않음.
  가드 `ArchitectureTest`(허용 목록 KNOWN 비었음 · 순환 import 0 — 늘리지 않는다). 리스너 순서는 `@Order`(EngineService 가 WsHub 보다 먼저).
- **수집기 층**(ADR-030): entry → jobs → adapters(Redis · HTTP · DB · 파일 · 환경 변수) → rules(어댑터를 import 하지 않는 규칙, 기능 사이 의존 금지).
  가드 `apps/collector/tests/test_layering.py`(ALLOWED 비었음 — 새 모듈은 층 · 기능을 정해야 통과).
- **웹 데이터 접근**(ADR-029): 전송은 `lib/api.ts` 하나, 경로는 `lib/endpoints/*`(서버 값은 `pathSegment` 로 인코딩 · `""` `.` `..` 거절), 상태 · 부수 효과는 Hook
  (`useApiResource` · `useVisibleInterval` · `components/{ops,logs,map}/use*`), 규칙 · 변환은 React 없는 `lib/*`. 숨은 탭에서는 주기 요청을 쉬고, 늦은 답은 열쇠 · 순번으로 버린다.
  첫 화면 JS 예산 550,000 B(ADR-026 — `check:first-js`, 카드 · 목록 전용 코드는 조각 전용 모듈로).
- **운영 · 로그**: `/ops`(공급자 · 실행 · 품질 · 설정 · 감사 · DLQ · 파이프라인)는 세션 + CSRF(`X-CSRF-Token` 헤더만) + 정확한 Origin 검사. 시스템 로그는 Redis
  스트림 → `/logs`, 지문(`LogEvents.fingerprint`)에 로거 이름(클래스 완전한 이름)이 들어가 **클래스를 옮기면 운영자의 '해결' 표시가 풀린다**(ADR-028 §5-4).
- Redis 세션에 Java 직렬화되는 `ops.OpsAuthentication` · `ops.OpsUserService$User` 는 옮기지 않는다(옮기면 모두 로그아웃 · 역직렬화 실패 — `SessionSerializationConfig`).

## 문서 · 계약 규칙
- 결정은 ADR(`docs/adr/ADR-0NN-*.md`). ADR 을 더하면 README 의 'ADR N건'도 고친다 — `ReadmeFactsTest` 가 파일 수 · Flyway 범위 · 계약 범위를 대조한다.
- 공개 API · 메시지 변경은 `docs/audit/change-contract-v5.md` 의 개정(§Gnn)으로 적는다. 쓴 · 안 쓴 §G 번호를 `apps/web/tests/docs-contract-g11.test.ts` 가 고정한다.
- 실제로 겪은 문제와 확인은 `docs/VERIFICATION.md` 의 `## #NNN`, 성능 전후 수치는 `docs/PERF.md` 의 절(§)과 재현 명령. 성능 변경은 잰 전후 수치로만 판단한다.
- 버그는 실패하는 시험을 먼저 쓰고(실패 글을 커밋 메시지에), 근본 원인을 고친다. 리팩터링과 수정은 다른 커밋, 리팩터링 커밋은 동작을 바꾸지 않는다.
  git 이력은 다시 쓰지 않는다(amend · rebase · force push 금지) — 틀린 것은 앞으로 고치고 VERIFICATION 에 적는다.

## 제품 규칙(사용자가 정한 것)
- 화면 시각은 **KST 만**(공유 포맷터 `lib/time`). 저장 · API · WS · 로그는 UTC 그대로, 원문(METAR · SIGMET 의 `…Z`)은 손대지 않는다.
- UI 는 Palantir 풍(어두운 바탕 · 촘촘한 표 · 고정폭 값 · 단위 · 출처 · 불확실성을 적는다). 참고 사이트의 화면을 따라 하지 않는다.
- 실데이터로 받쳐지지 않는 값을 짐작해 보이지 않는다(번호 범위로 기종 · 항공사 추정 등 금지). 모르면 `—`.
- 한국 연안 선박 공백을 메우려고 유료 AIS · 자체 수신기를 들이지 않는다(사용자 결정 2026-10-01). 관측 수신 범위 · 연안 교통량 격자로 설명한다.

## 운영 스택과 안전
- `.env`(0600)는 읽거나 출력하지 않는다. 비밀번호는 stdin 으로만(명령행 · 환경 변수 금지). 외부 키는 사용자가 직접 넣는다.
- 로그는 `docker logs wakeline-<api|collector|ais|web|redis|db|edge>-1`(허용됨). `docker compose -f infra/compose.yml logs` 는 `--env-file .env` 없이는 실패한다.
  계정 표(`ops_user` 등)는 조회하지 않는다.
- 호스트 포트 8080 은 다른 프로젝트(SmartCollab) 것 — 쓰지 않는다. 게시 포트는 127.0.0.1 에만. 다른 프로젝트(aptlake 등)는 건드리지 않는다.
- **`make e2e` · `make build` · `make infra-docker-test`(db) 는 운영 스택이 쓰는 `wakeline-*:local` 태그를 덮는다.** 돌던 컨테이너는 그대로지만 다음
  `make up` 이 그 이미지를 쓴다 — 브랜치 작업 중에는 main 이미지를 `:mainsafe` 로 태그해 두고 끝나면 `:local` 로 되돌린다. 다른 태그를 검사할 때는
  `SECURITY_OWN_IMAGES="wakeline-api:<tag> …" bash tools/security_gate.sh`.
- 배포는 `make up`. Redis(AOF)를 다시 만들면 한동안 `LOADING` 이고 api 는 503 + Retry-After 로 답한다. 실행 이미지는 빌드 때 `apt-get upgrade` 로 OS 보안
  갱신을 받는다(기반 이미지는 다이제스트 고정) — 새 CVE 로 trivy 가 실패하면 캐시 없이 다시 빌드해 본다(`docker build --no-cache`).
- main 병합 · 배포 · GitHub push · 데이터를 지우거나 바꾸는 일은 사용자에게 먼저 묻는다.

## 함정
- macOS 에는 `timeout` 명령이 없다(쓰면 종료 코드 127 로 아무것도 돌지 않는다).
- `npx next build` 는 `prebuild`(MapLibre 워커를 `public/maplibre/<버전>` 에 복사)를 건너뛴다 → `check:first-js` 가 '버전 폴더 0개'로 실패한다. `npm run build` 를 쓴다.
- `apps/web/node_modules` 가 `package.json` 의 버전보다 오래됐을 수 있다(Next 16.3.6 이 남아 수치가 틀렸던 적이 있다) — 측정 전에 설치된 `next` 버전을 확인한다.
- api DB 시험(Testcontainers)은 `wakeline-db:local` 이미지를 쓴다(`make test-api` 가 `infra/db` 로 빌드). 측정 시험 5종(`@Tag("perf")`)은 `test` · 커버리지에서 빠진다.
- 루트 `.gitignore` 의 `data/` 규칙이 이름이 `data` 인 Java 패키지를 숨긴 적이 있다 — 새 소스가 `git status` 에 안 보이면 `git check-ignore -v` 로 확인(`GitIgnoreScopeTest`).
- 수집기 작업 모듈(`jobs/kma_radar.py` 등)의 docstring 은 운영에서 겪은 사고와 규칙의 근거다. 줄이지 말고, 동작을 바꾸면 함께 고친다.
- 공급자 429 · DNS · 연결 시간 초과는 설계대로 처리된다(호스트 쉼 · 폴백 체인 · 다음 주기에 채움). `/ops` RUNS 의 '해결된 오류 포함'이 켜져 있으면 이미 해결한 오류도 보인다.
