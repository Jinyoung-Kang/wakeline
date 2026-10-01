# Wakeline QA 계획 — 실무 출시 기준 검증 (2026-10-02)

- 대상: `main` `359a3eac`(2026-10-02 01:29 KST 운영 배포본 + CLAUDE.md) — QA 브랜치 `qa/2026-10`
- 상태: **계획 — 승인 대기**. 승인 뒤에는 멈추지 않고 끝까지 진행한다(아래 '멈춤 조건'만 예외).
- 목적: 결함을 **찾아 재현하고 증명**한다. 고치지 않는다.

## 0. 원칙과 제약
| 항목 | 정한 것 |
|---|---|
| 바꿀 수 있는 것 | 시험 코드 · 시험 데이터 · 점검 스크립트 · QA 문서(`docs/qa/2026-10/`)만. **제품 코드(`apps/*/src` · `apps/web/{app,components,lib}` · `apps/collector/wakeline_collector` · `infra` 설정 · `schemas`)는 바꾸지 않는다** |
| 시험 환경 | **격리 스택만**: compose 프로젝트 `wakeline-e2e`, `http://localhost:8701`, fixture 모드(외부 호출 0 — 외부 키는 빈 값으로 덮인다), 버리는 볼륨. 단위 · 통합 시험은 Testcontainers · 버리는 컨테이너 |
| 쓰지 않는 것 | 운영 스택(8700)의 데이터 · 계정 · 설정(읽기 포함), 실제 공급자 호출(adsb · OpenSky · 기상청 · 해수부 · aisstream — 저장된 fixture 와 목만), 사용자의 `.env` 값 |
| 시험 계정 | 격리 스택에만 시험 운영자 계정을 만든다(이름 `qa-*`, 비밀번호는 생성해 세션 임시 폴더의 0600 파일에만 — 대화 · 저장소에 적지 않는다). 스택과 함께 지운다 |
| 이미지 태그 | 격리 스택 빌드가 운영 스택의 `wakeline-*:local` 태그를 덮으므로 시작 전에 지금 `:local` 을 `:qa-prod` 로 표시해 두고 끝나면 되돌린다 |
| 결함 번호 | `QA-001` 부터. 실패 시험 이름에 번호를 붙인다(`Qa001…Test` · `test_qa_001_…` · `qa-001-….spec.ts`) |
| 기록 | 결함 목록 `docs/qa/2026-10/DEFECTS.md`, 증거 `docs/qa/2026-10/evidence/`(명령 출력 · 로그 · 스크린샷), 최종 보고 `docs/qa/2026-10/REPORT.md` |
| 구분 | **결함**(재현됨) · **미확인**(의심했지만 재현 못 함 — 따로 표시) · **개선 제안**(계층 위반 · 순환 의존 같은 구조 문제 — 결함 수에 넣지 않음) |

### 심각도
| 등급 | 뜻 |
|---|---|
| 치명 | 인증 우회 · 원격 실행 · 비밀값 노출 · 데이터 영구 손실이나 오염 · 전체 중단. **발견 즉시 알린다** |
| 높음 | 핵심 기능이 틀린 값을 보이거나 동작하지 않음 · 운영 기능 일부의 인가 우회 · 조건부 데이터 손실 · 저절로 회복되지 않는 장애 |
| 보통 | 일부 기능 오류(우회 가능) · 성능 목표 초과 · 핵심 작업을 막는 WCAG AA 위반 |
| 낮음 | 표시 · 문구 · 드문 조건 · 경미한 접근성 위반 |

## 1. 파악한 대상
### 기능
항공기(관심 지역 · 전세계 · 수요 기반 집중 · 핫 리전, 검색 · 상세 · 항적 · 노선), 선박(AIS 위치 · 정적 정보 · 항적 · 검색 · 관측 수신 범위 · 공백 · 연안 교통량 격자 · 한국 항만 입출항),
기상(SIGMET · 경보 · 예측 알림 · RainViewer · 기상청 레이더 · 공항 METAR/TAF), 재생 · 통계, 운영(공급자 켜고 끔 · 실행 기록 · 품질 · 설정 · 감사 · DLQ · 파이프라인 · 해결 표시), 시스템 로그, 설명서.

### API (공개 27 + 운영 19 + WS 1)
| 묶음 | 경로 |
|---|---|
| 항공기 | `GET /api/v1/aircraft?bbox,detail` · `/aircraft/search?q` · `/aircraft/{hex}` · `/aircraft/{hex}/track?from,to,stepS` |
| 선박 | `GET /api/v1/ships?bbox` · `/ships/search?q,limit` · `/ships/{mmsi}` · `/ships/{mmsi}/track?from,to` · `/ships/coverage` · `/ais/gaps?from,to` · `/traffic/grid` |
| 기상 · 공항 | `GET /api/v1/sigmets?active,bbox,hazard` · `/sigmets/{id}` · `/alerts?kind` · `/alerts/history?from,to,hex,cursor,limit` · `/radar/frames` · `/radar/kr` · `/radar/kr/{tm}.png` · `/airports?bbox,watched` · `/airports/{icao}/wx` |
| 이력 · 상태 | `GET /api/v1/replay?at,bbox` · `/stats/sigmet?from,to,group` · `/stats/traffic?day` · `/stats/alerts?from,to` · `/status` · `/healthz` · `POST /api/v1/client-errors` |
| 운영(세션 · CSRF) | `POST · GET · DELETE /api/v1/ops/session` · `GET /ops/providers` · `POST /ops/providers/{name}/{action}` · `GET /ops/runs` · `/ops/quality` · `/ops/dlq` · `/ops/pipeline` · `GET /ops/settings` · `PUT /ops/settings/{key}`(If-Match) · `GET /ops/audit` · `POST /ops/stats/aggregate` · `POST · GET /ops/resolutions` · `DELETE /ops/resolutions/{id}` · `GET /ops/logs` · `/ops/logs/groups` · `/ops/logs/{id}` |
| WS | `/ws/v1` — 클라이언트 10종(hello · subscribe · layers · select · select_ship · resync · pause · resume · ping · pong), 서버 약 17종(`schemas/ws`) |

### 화면 (8 경로)
`/`(상황판 — 지도 · 레이어 · 검색 · 카드 · 경보 · 선박 목록 · 상태 바 · 레이더 타임라인) · `/replay` · `/stats` · `/airports/[icao]` · `/ops`(탭 7) · `/logs`(목록 · 묶음 · 상세) · `/about` · `/guide`

### 기존 시험 · 빌드 · 실행(2026-10-02 최종 검증 결과)
pytest 1,919 · collector 실 Redis 16 · 실 PostgreSQL 7 · JUnit 1,071(JaCoCo LINE 97.18 % · BRANCH 86.53 %) · Vitest 1,658 · Playwright E2E 43 · 인프라 정책 157 · 버리는 컨테이너 456 · 이미지 검사 11 ·
계약 검사 · REST 36종. 명령은 [CLAUDE.md](../../../CLAUDE.md) '명령'. 측정 도구: k6(고정 이미지) · Playwright(Chromium 설치됨) · axe-core(`node_modules` 에 있음) · Lighthouse(npx 로 받음 — 레지스트리, 무료) · trivy · gitleaks.

## 2. 위험이 큰 곳(검증 순서)
1. **보안**: 운영 API 의 인증 · 인가 · CSRF · Origin(외부에서 운영 설정을 바꿀 수 있는가), 로그 화면의 저장형 XSS(클라이언트 오류 · 공급자 글자 · 선박 이름이 그대로 그려지는가), 입력 → SQL · Redis 키, 비밀값이 로그 · 오류 응답에 나가는가.
2. **데이터 손실**: 기록기(항적 · 선박 · 순서 큐)가 DB · Redis 장애 · 재시작 · 공개 조회 폭주 중에 행을 잃거나 겹치는가, 스트림 소비 그룹 · DLQ, 운영 설정 동시 수정(낙관적 잠금), 백업 → 복원.
3. **기능 정확성**: 모든 API 의 정상 · 경계 · 비정상 입력, 시각 처리(KST 표시 · UTC 저장 · 날짜 경계), 지도 · 표의 값.
4. **신뢰성 · 성능 · 접근성 · 회귀**.

## 3. 영역별 검증
### 3.1 보안
| 항목 | 방법 | 도구 · 산출 |
|---|---|---|
| 인증 · 인가 누락 | 운영 경로 19개를 세션 없음 · 만료 · 로그아웃 뒤 · 다른 메서드 · 인코딩한 경로(`%6Fps`, `//`, `;`, 대소문자)로 호출 → 404/403 이어야 한다. 시험 계정 두 개로 한 사용자의 세션 · 해결 표시 · 감사 기록을 다른 사용자가 바꿀 수 있는지(역할이 하나라 설계상 공유인지 문서로 판단) | `tools/qa/authz_matrix.py`(요청 표 → 기대 상태) |
| CSRF · Origin | 토큰 없음 · 틀림 · `_csrf` 파라미터 · 교차 Origin · `Sec-Fetch-Site: cross-site` · 로그인 강요 · 세션 고정(로그인 전 쿠키 유지) | 같은 스크립트 + Playwright(다른 포트의 페이지에서 폼 · fetch) |
| XSS | 저장형: `/client-errors` 의 message · stack · component, 선박 이름 · 목적지(AIS fixture 에 조작 글자 주입), 운영 설정 값, 해결 메모, 로그 검색어 → `/logs` · `/ops` · 카드 렌더 확인. 반사형: 쿼리 · 해시(`#id=`) · 공항 경로 | Playwright(`window.__qa_xss` 표식) |
| 인젝션 | 모든 쿼리 · 경로 값에 SQL 메타문자 · 매우 긴 글자 · 유니코드 · NUL · 인코딩 우회. 로그 필터(q · rid · fp)는 Redis/정규식 처리 확인 | `tools/qa/fuzz_api.py`(정상 · 경계 · 비정상 표) — 500 · 스택 노출 · 지연 폭증을 결함으로 |
| 보안 헤더 · CSP | 모든 화면 · API 응답의 CSP(nonce) · X-Frame-Options · nosniff · Referrer-Policy · Permissions-Policy · COOP · 캐시 헤더, Host 허용 목록(421), XFF 위조 | `tools/qa/headers_check.sh` |
| 비밀값 | 코드 · 이력(gitleaks) · 컨테이너 로그 · 오류 응답 · 시스템 로그 스트림 · 브라우저 번들에 키 · 비밀번호 · 토큰 형태가 남는가(격리 스택에 가짜 키를 넣어 흔적을 찾는다) | gitleaks · grep · Playwright 번들 검색 |
| 버전 · 알려진 취약점 | 런타임 · 프레임워크 · 라이브러리 지원 종료 일자(endoflife.date · 공식 문서로 확인한 것만), trivy(이미지) · npm audit · pip-audit · Gradle 의존성 | `make security` + 버전 표 |

### 3.2 기능(모든 API · 화면)
- API 마다 정상 · 경계 · 비정상 표(아주 큰 수 · 음수 · 0 · NaN · 지수 표기 · 잘못된 형식 · 빈 값 · 중복 파라미터 · 매우 긴 값 · 조작한 문자열 · 미래 · 과거 시각 · 역순 구간 · 세계 전체 bbox · 날짜 변경선)을 만들어 상태 코드 · 문제 응답(RFC 9457) · 값의 범위를 확인한다. 500 은 모두 결함 후보.
- WS: 메시지 종류마다 형식 오류 · 범위 밖 숫자 · 큰 메시지 · 빠른 반복 · 순서 바꿈(hello 전 subscribe) · 연결 수 상한.
- fixture 응답으로 화면에 그려지는 값이 원본과 맞는지(시각 KST 변환 · 단위 · '값 없음' 처리 — README '정직성' 규칙).

### 3.3 화면(실제 브라우저)
- Playwright 로 8 경로의 모든 메뉴 · 버튼 · 탭 · 폼 · 표 정렬 · 필터를 눌러 보며 **콘솔 오류 · 실패한 요청(4xx/5xx · 끊김) · 같은 요청의 중복**을 모은다.
- 화면 폭: 데스크톱 1440×900 · 태블릿 768×1024 · 모바일 375×812(가로 넘침 · 겹침 · 잘림 스크린샷).
- 키보드: Tab 순서 · 포커스 표시 · Enter/Space 동작 · Esc 로 닫기 · 포커스 갇힘.
- 운영 · 로그는 시험 계정으로 로그인해 쓰기(설정 저장 · 공급자 끄고 켬 · 해결 표시)까지.

### 3.4 신뢰성(격리 스택)
| 상황 | 방법 | 확인할 불변식 |
|---|---|---|
| DB 느림 · 끊김 | `docker pause` db N 초 · `pg_sleep` 잠금 · 컨테이너 정지 | 공개 API 503 + Retry-After, 기록기 행 손실 · 중복 없음, 회복 뒤 따라잡기 |
| Redis 느림 · 끊김 · 재시작 | pause · 재시작(AOF LOADING) | 스트림 소비 그룹 pending 회복, 세션 유지 · 로그인, 예산 · 임대 |
| 외부 API 느림 · 끊김 | fixture 스택의 공급자 호스트를 막거나 목 서버로 지연 · 오류 응답 | 폴백 체인 · 실행 기록 · 화면 표시(멈춘 값의 나이) |
| 작업 중 재시작 | 기록기 묶음 저장 중 api kill, 수집 주기 중 collector kill(`tools/chaos.sh` 를 `WAKELINE_PROJECT=wakeline-e2e` 로) | 행 수 · 키 중복 · 순서 큐 작업 · 기상청 프레임 목록 ↔ 영상 |
| 동시 요청 | 같은 If-Match 로 설정 동시 저장 · 공급자 동시 토글 · 동시 로그인 실패(잠금 5회) · 동시 해결 표시 · 같은 날 집계 동시 실행 · WS 연결 상한 | 한쪽만 성공(나머지 412 · 409), 감사 기록 일치 |
| 백업 → 복원 | `make backup P=wakeline-e2e` → 새 빈 볼륨에 `make restore` | 표마다 행 수 · 표본 행 일치, 앱이 복원본으로 기동 |

### 3.5 성능
- **부하**: k6 를 격리 스택 망에서 api 에 직접(측정 동안만 격리 api 의 제한 상향) · edge 경유(제한 동작) 둘 다. REST 핵심 경로(`/aircraft` · `/ships` · `/sigmets` · `/status` · `/replay` · `/stats/*` · 항적) 도착률 고정, WS 연결 200. 기준: REST p95 ≤ 300 ms, WS 지연 p95 ≤ 500 ms(`perf/*.js` 의 임계값), api 메모리 ≤ 512 MB(NFR-03).
- **데이터 크기**: 격리 DB 에 합성 시험 데이터(항적 72 h · 선박 · SIGMET · 통계)를 넣어 운영 규모에 맞춘 뒤 잰다(`tools/qa/seed_*.sql`).
- **느린 쿼리**: 격리 db 에 `log_min_duration_statement` 를 켜고 부하 중 느린 문장을 모은다 + 핵심 쿼리 `EXPLAIN (ANALYZE, BUFFERS)`.
- **큰 응답**: 모든 GET 의 응답 크기 · 압축 여부(전세계 bbox · detail · 긴 구간).
- **화면**: Lighthouse(데스크톱 · 모바일) — LCP · TBT · CLS · 성능 점수, 첫 화면 JS 예산(550,000 B). 설계서(PDF)의 NFR-04 LCP 목표값은 이 환경에서 PDF 를 읽지 못해 확인하지 못했다 → **Core Web Vitals 'good' 기준(LCP ≤ 2.5 s · CLS ≤ 0.1 · TBT ≤ 200 ms)**으로 판단하고 그렇게 적는다.

### 3.6 접근성(WCAG 2.1 AA)
- axe-core(태그 wcag2a · wcag2aa · wcag21a · wcag21aa)를 Playwright 로 8 경로 × 상태(카드 열림 · 탭마다 · 오류 · 빈 상태) × 데스크톱/모바일에 돌린다 + Lighthouse 접근성.
- 자동으로 못 보는 것: 키보드만으로 핵심 작업(검색 → 선택 → 카드 → 닫기, 운영 로그인 → 설정 저장), 라이브 영역 알림, 대비(지도 위 글자), 200 % 확대.

### 3.7 회귀
- 기존 시험 전체(pytest · JUnit · Vitest · E2E · 인프라 · 버리는 컨테이너 · 계약 · 보안 게이트)를 깨끗한 내보내기에서 다시 돌린다.
- 중요한데 시험이 없는 경로: JaCoCo · pytest 커버리지에서 빠진 줄 중 위험 경로(인증 · 기록기 · 스트림 · 운영 쓰기)를 골라 목록으로. Vitest 커버리지 도구는 설치돼 있지 않아 같은 버전의 `@vitest/coverage-v8` 을 npx 로만 써 보고(저장소 의존성은 바꾸지 않음), 안 되면 미측정으로 적는다.

## 4. 진행 순서
1. 준비: 이미지 태그 표시 → 격리 스택 기동(fixture) → 시험 계정 → 합성 데이터.
2. 보안(3.1) → 데이터 손실 · 신뢰성(3.4) — 치명 · 데이터 손실은 발견 즉시 알린다.
3. 기능(3.2) · 화면(3.3) · 접근성(3.6).
4. 성능(3.5).
5. 회귀(3.7).
6. 결함마다 재현 시험 작성 · 커밋(`qa/2026-10`).
7. **독립 재검토**: 별도 에이전트가 DEFECTS.md 의 재현 절차를 그대로 따라 재현되는지 · 심각도가 맞는지만 확인 → 반영.
8. 정리: 격리 스택 · 볼륨 · 시험 계정 삭제, `:local` 태그 되돌림, 최종 보고.

## 5. 결함 기록 형식(DEFECTS.md)
번호 · 심각도 · 영역 · 환경(커밋 · 스택 · 브라우저 · 폭) · 재현 절차 · 기대 결과 · 실제 결과 · 증거(명령과 출력 · 로그 · 스크린샷 경로) · 의심되는 원인(파일:줄) · 재현 시험(경로 · 실패 메시지).

## 6. 멈춤 조건(이때만 묻는다)
- 운영 환경 · 실제 계정 · 지울 수 없는 데이터로 시험해야 할 때
- 호출 한도나 비용이 있는 외부 서비스를 실제로 불러야 할 때
- 비밀값 · 계정 · 환경 변수를 사용자가 넣어야 할 때
- 코드 · 문서만으로 기대 동작을 알 수 없어 결함인지 의도인지 판단하기 어려울 때

## 7. 하지 않는 것 · 한계
- 실제 공급자 응답의 변화 · 공급자 쪽 장애는 fixture · 목으로만 흉내 낸다.
- HTTPS · 인증서 · 공개 배포 환경은 범위 밖(로컬 http 전용 설계 — `cookie-secure` 설정만 확인).
- 지도 조작 30 fps(NFR-04)는 headless 의 소프트웨어 GL 로는 잴 수 없다 — 미측정으로 적는다.
- amd64 · CI 환경 수치는 재지 않는다(이 기계 M1 수치만).
