# QA 2026-10 — 보안 영역 결과

- 대상 커밋: `main` `359a3eac`(격리 스택 A 이미지 `:qa-prod` = 운영 `:local`과 같은 다이제스트)
- 스택: A `wakeline-e2e` http://localhost:8701 (fixture 모드 · 외부 키 빈 값)
- 시험 계정: `qa-a` · `qa-b`(공용), `qa-sec`(이 영역 전용 — 비밀번호 교체 · 잠금 시험용, 스택과 함께 사라짐)
- 도구: 표준 라이브러리 HTTP(`tools/qa/qa_session.py`), Playwright(Chromium), redis-cli(컨테이너 환경 변수의 비밀번호, 출력 안 함)
- 범위 밖/못 함: gitleaks · trivy 는 이 기계에 설치돼 있지 않아 직접 돌리지 못했다(아래 §비밀값). 가짜 키 egress 추적(선택)은 공유 스택 A 의 collector · ais 재생성이 필요해 하지 않았다 — fixture 키가 이미 빈 값이고 로그 · 번들 · 응답에서 키 흔적이 없음을 따로 확인했다.

요약: **치명 · 높음 0건**. 보통 1 · 낮음 1 · 미확인 1 · 개선 제안 1. 인증 · 인가 · CSRF · Origin · XSS · 헤더 · 비밀값은 모두 설계대로 막혔다.

---

## 결함

### QA-001 · 보통 · 입력 처리(인젝션/견고성) · (커밋 359a3eac · 스택 A 8701 · HTTP)
범위를 벗어난(그러나 ISO 형식은 맞는) 시각 · 날짜 쿼리 값이 검증 없이 Postgres 로 가, 400 이 아니라 **500 INTERNAL** 이 난다.
Java 의 `Instant`·`LocalDate` 는 연도 ±999,999,999 까지 받아들이지만 Postgres `timestamptz`(상한 294276 AD)·`date`(상한 5874897 AD)의 유한 범위를 넘으면
`DataIntegrityViolationException` 이 나고, `ProblemAdvice` 가 이를 '결함일 수 있는 DB 오류'로 보아 500 + ERROR 로그로 남긴다. 익명(인증 없이)으로 공개 경로에서 낼 수 있다.

- 재현(복사해 실행):
  ```bash
  cd <worktree>
  python3 tools/qa/qa_001_outofrange_time.py http://localhost:8701
  # 또는 공개 경로 하나만:
  curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8701/api/v1/ais/gaps?to=%2B300000-01-01T00%3A00%3A00Z"   # 500
  curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8701/api/v1/stats/traffic?day=%2B6000000-01-01"          # 500
  ```
- 기대: 400(범위 밖 입력은 DB 전에 거른다 — RFC 9457 문제 응답)
- 실제: 500 `{"code":"INTERNAL","detail":"unexpected error"}` + 서버 ERROR 로그(실패한 SQL 포함, 응답 본문에는 스택·SQL 없음)
- 영향 받는 경로(확인):
  - 공개(익명): `GET /api/v1/ais/gaps?to=` · `/alerts/history?to=` · `/stats/alerts?to=` · `/stats/sigmet?to=` · `/stats/traffic?day=`
  - 운영(세션): `GET /api/v1/ops/runs?since=`
  - 막힌 것(참고): `/api/v1/replay?at=`(400 BAD_AT), `/stats/*?from=`(400 BAD_RANGE — from>to 로 걸린다), `LocalDate.MAX(+999999999)`는 pgjdbc 가 `date 'infinity'`로 보내 통과(200)
- 증거: `docs/qa/2026-10/evidence/security/qa_001_outofrange_time.txt`, `server_500_logs.txt`, `boundary_candidates.jsonl`
- 의심 원인:
  - `apps/api/.../ships/web/ShipController.java:398-403`(`aisGaps` — from<to · 31일 범위만 보고 상한 미검), `weather/web/WeatherController.java:106`(`alertHistory`), `history/HistoryController.java:77·93·106`(stats — 날짜 상한 미검), `ops/OpsController.java:152-155`(`runs` since)
  - `platform/web/ProblemAdvice.java:53·106-110`(`isUnavailable` 밖의 DB 예외는 500 + ERROR — 범위 밖 입력이 여기로 떨어진다)
- 재현 시험: `tools/qa/qa_001_outofrange_time.py`(500 이 하나라도 있으면 종료 코드 1 — 지금 6건 FAIL). 실패 메시지: `6 endpoint(s) return non-400 on out-of-range time/date (expected 400)`

### QA-002 · 낮음 · 입력 처리(인젝션/견고성) · (커밋 359a3eac · 스택 A 8701 · HTTP)
운영 조회 `GET /api/v1/ops/runs` 의 자유 글자 필터 `job` · `provider` · `status` 에 NUL 바이트(U+0000)를 넣으면 400 이 아니라 **500 INTERNAL** 이 난다.
값이 검증 없이 SQL 파라미터로 가, Postgres 가 `invalid byte sequence for encoding "UTF8": 0x00` 로 거부한다. 공개 검색(`/ships/search`·`/aircraft/search`)은 같은 입력을 400 BAD_QUERY 로 막아, 이 경로만 검증이 빠졌다. 운영 세션이 필요하다(인증된 운영자만).

- 재현:
  ```bash
  python3 tools/qa/qa_002_nul_ops_runs.py http://localhost:8701   # job·provider·status 모두 500
  ```
- 기대: 400 BAD_REQUEST
- 실제: 500 `{"code":"INTERNAL"}` + 서버 ERROR 로그(`invalid byte sequence for encoding "UTF8": 0x00`)
- 증거: `docs/qa/2026-10/evidence/security/qa_002_nul_ops_runs.txt`, `server_500_logs.txt`
- 의심 원인: `apps/api/.../ops/OpsController.java:152-155` · `ops/IngestRunRepository.java:runs`(job·provider·status 를 검증 없이 SQL 파라미터로) — QA-001 과 같은 처리 경로(DB 예외 → 500)
- 재현 시험: `tools/qa/qa_002_nul_ops_runs.py`(500 이 있으면 종료 코드 1). 실패 메시지: `3 ops/runs filter(s) return non-400 on a NUL byte (expected 400)`

---

## 미확인(의심했지만 '결함'으로 못 박지 못함 — 소유자 확인 필요)

- **운영자끼리의 쓰기 격리 여부**: `qa-b` 가 `qa-a` 가 만든 해결 표시(`POST /ops/resolutions`)를 id 로 되돌릴 수 있었다(`DELETE /ops/resolutions/{id}` → 204).
  설계상 운영 역할은 하나(`ROLE_OPS`)이고 해결·되돌림은 공용 운영 기능이며 감사(`RESOLVE`·`UNRESOLVE`, `resolved_by`·`revoked_by`)가 누가 했는지 남긴다 — ADR-024.
  즉 **공유가 설계 의도로 보인다**(단일 역할 + 감사 추적). ADR-017·024 에 '운영자끼리 서로의 기록을 못 바꾼다'는 규칙은 없다. 결함으로 보지 않았으나,
  소유자에게 "운영자 여럿이 서로의 해결 표시 · 설정을 바꿀 수 있는 것이 의도인가"를 확인받길 권한다. 증거: `evidence/security/session_checks.json`(A 절).

---

## 개선 제안(구조 — 결함 수에 넣지 않음)

- 범위 · 문자 검증을 한 곳에 모으기: 시각(`Instant`)·날짜(`LocalDate`) 파라미터에 저장소(Postgres)의 유한 범위 상·하한을 두는 공용 바인더/검증기, 자유 글자 필터(logs q·rid·fp 처럼)에
  제어 문자(NUL 포함) 거르기를 공용으로 두면 QA-001·QA-002 같은 '500 대신 400' 누락을 경로마다 반복하지 않는다. `platform/web/Params`·`BboxParam` 옆에 두는 것이 자연스럽다.

---

## 확인했고 문제없음(커버리지)

### 1. 인증 · 인가 (`tools/qa/authz_matrix.py` — 230행, 실패 0 · `evidence/security/authz_matrix.jsonl`)
- 운영 경로 19개를 **세션 없음 · CSRF 쌍만 있는 익명 · 위조 세션 쿠키(없는 id · 깨진 base64 · 4,000자 · `../` base64) · 로그아웃 뒤 재생**으로 호출 → 모두 404(데이터 없음). CSRF 를 통과해도 인가가 404.
- 경로 속임수(디코딩 경로로 판단 — `ApiPaths`): `%6Fps`·`%6fps`·`o%70s`(→ 404), `//`·`/./`·`/../`·`%2e`·`;jsessionid`·`\`·`%2f`·`%00`(→ 400 방화벽 거절, 모두 RFC 9457), 끝 `/`·`.json`·대문자 `OPS`·`API`·`V1`(→ 404). 어느 것도 데이터를 돌려주지 않았다.
- 메서드: 익명 GET→404, HEAD/OPTIONS→404, TRACE→405, PUT/POST/DELETE/PATCH→403(Origin). CORS 사전 요청(`Access-Control-Request-Method`)에 `Access-Control-Allow-*` 헤더가 붙지 않는다.
- 두 계정으로 한쪽이 다른 쪽 데이터 접근 — 위 '미확인' 참고(설계상 공유).

### 2. 세션 · 계정 (`tools/qa/session_checks.py` — 29개 점검, 실패 0 · `evidence/security/session_checks.json`)
- 세션 고정: 공격자 세션 쿠키 · 없는 id 를 심은 채 로그인 → 새 세션 id, 심은 세션 무효(S14). CSRF 토큰도 로그인 때 회전, 로그인 전 토큰은 뒤에 거부.
- 쿠키 속성: 세션 `Path=/api`·HttpOnly·SameSite=Strict, CSRF `Path=/`·SameSite=Strict(화면 JS 가 읽어 헤더로 보냄, HttpOnly 아님 — 설계).
- 비밀번호 교체(CLI) → 그 사용자의 기존 세션 모두 404(R-95), 옛 비밀번호 401, 새 비밀번호 200.
- 잠금: 5회 실패 뒤 맞는 비밀번호도 401, 감사 `ACCOUNT_LOCKED`. 절대 수명(R-54): Redis 의 `ops_auth_at` 을 9 h 전으로 바꾸니 다음 운영 요청이 404 + 세션 키 삭제.
- 로그아웃은 그 세션만 끝내고 같은 사용자의 다른 세션은 유지.

### 3. CSRF · Origin (`apps/web/e2e/qa/qa-sec-csrf.spec.ts` — 통과)
- 다른 포트(127.0.0.1:임의)의 공격 페이지가 운영자 브라우저에서 폼 POST · no-cors fetch · `_csrf`(쿼리·폼) · text/plain JSON · 사용자 헤더(cors preflight 차단)로 운영 변경을 시도 → **모두 403 `ORIGIN_NOT_ALLOWED`**(컨트롤러에 닿지 않음). 감사 행 증가 없음, 세션 그대로. 로그인 강요도 403.
- 같은 탐침을 같은 출처로 보내면 컨트롤러에 닿는다(400 BAD_DAY) — 403 이 탐침 탓이 아님을 증명.
- WS 핸드셰이크 Origin: `evil.example`·다른 포트·`null` → 403, 허용 출처·Origin 없음(비브라우저) → 101.

### 4. XSS (`apps/web/e2e/qa/qa-sec-xss.spec.ts` — 4/4 통과 · `window.__qa_xss` 표식 · 주입 요소 · CSP 위반 모두 없음)
- 저장형: 브라우저 오류(`POST /client-errors` message·stack·component·path) → `/logs` 목록·상세·묶음·검색, 해결 메모 → `/ops` 감사, 조작한 스트림(선박 이름·호출부호·목적지, 항공기 호출부호·등록·기종 — `tools/qa/inject_stream.py` 생산자 ACL 로 XADD) → 검색·카드. 모두 글자로 렌더(DOM 텍스트 노드 — `lib/tooltip.renderTip`, React 이스케이프).
- 반사형: `/airports/<조작>`·`/logs#id=·#rid=·#fp=·&stream=`·쿼리·지도 해시·로그 검색어 — 실행·주입 없음.
- 코드에 `dangerouslySetInnerHTML`·`innerHTML` 싱크 없음, MapLibre 툴팁은 `setDOMContent`(텍스트 노드)만.

### 5. 보안 헤더 · CSP · Host (`evidence/security/headers_check.txt`)
- 화면 CSP: `script-src 'self' 'nonce-…' 'strict-dynamic'`(요청마다 nonce, `unsafe-inline` 은 style 만 — script 에 없음), `object-src 'none'`·`frame-ancestors 'none'`·`base-uri 'self'`·`form-action 'self'`. api JSON CSP: `default-src 'none'`.
- edge 가 모든 응답에 nosniff·X-Frame-Options DENY·Referrer-Policy·Permissions-Policy·COOP. 정적 파일 1년 immutable, 인증 운영 응답은 `no-store/no-cache`(공개 캐시 없음).
- Host 허용 목록: `evil.example`·`wakeline.dev`·`localhost.evil.com` → 421(DNS rebinding 방어), `localhost`·`127.0.0.1` → 200.
- 위조 방지: 클라이언트가 보낸 `X-Request-Id`·`X-Forwarded-For` 를 edge 가 덮어쓴다(응답·로그에 위조 값이 아닌 edge 값).

### 6. 비밀값
- 컨테이너 로그(api·collector·ais·web·edge): 비밀값 형태 없음(collector 는 `KMA_APIHUB_KEY not set — disabled` — 값 없음). `/api/v1/status`·오류 응답(500 본문)·브라우저 번들(7개 화면의 정적 JS 21개)에서 키·토큰·비밀번호 형태 없음("apihub" 은 기상청 출처 링크 `apihub.kma.go.kr` 뿐).
- 추적 파일(`git ls-files`)에 `.env` 없음(.gitignore 2줄), 소스에 하드코딩된 비밀값 할당 없음. `.gitleaksignore` 는 시험용 가짜 키 지문만.
- 직접 실행 못 함: gitleaks · trivy 미설치. 프로젝트 마지막 게이트(VERIFICATION 자동 검사 현황)는 gitleaks 1,136 커밋 누출 0 · 자체 이미지 trivy HIGH/CRITICAL 0 · npm audit · pip-audit 0.

### 7. 버전 · EOL (WebFetch 로 확인)
- Next.js **16.3.8**(package.json·node_modules 모두) = 최신 16.x(2026-09-30) — 이전 리뷰 L-9 '두 패치 뒤짐'은 **해소됨**(endoflife.date/nextjs).
- Node 24.21.0: active LTS 종료 2026-10-20(약 18일 뒤) · 보안 2028-04-30 — 곧 유지보수 단계(정보, 결함 아님, endoflife.date/nodejs).
- Spring Boot 4.1.1 · Spring Security 7.1.1 · Tomcat 11.0.26(CVE 대응 제약) · Jackson 3.1.7/2.22.3(CVE 대응) · PostgreSQL 18 · PostGIS 3.6 · Redis 8 · nginx 1.30 · Python 3.13(버그픽스 2026-10-01 종료, 보안 2029-10-31) — 모두 지원 중(이전 보안 리뷰 §5 와 일치, 새 결함 없음).

### 8. 인젝션(SQL) — 코드 확인 + 입력 시험
- 모든 `JdbcClient` 는 이름 붙은 파라미터, 동적 SQL(`ShipRepository.search`·`IngestRunRepository.runs`·`AlertRepository.history`·`ProviderSwitchService`·`JdbcCoverageSource`)은 상수 조각만 이어 붙이고 값은 파라미터. SQL 메타문자(`'`·`--`·`;DROP`·`pg_sleep`)를 공개·운영 값에 넣어도 데이터 유출·추가 지연 없음(파라미터로 바인딩). 위 QA-001·QA-002 는 인젝션이 아니라 바인딩된 값이 DB 타입 범위·인코딩을 벗어나 나는 500 이다.
