# Wakeline QA 계획 — AWS 공개 데모판 출시 기준 검증 (2026-10-14)

- 대상: `main` `29d39e38`. AWS(EC2 `i-01a2eeec216bd9ce2`)에서 도는 `004f26dc` 와 제품 코드가 같다(그 뒤 커밋은 문서뿐).
  AWS 판 = `infra/compose.yml` + `infra/compose.aws.yml`(RDS · 공개 데모 · 연결 풀 6/3/2 · realip) + aws-deploy 저장소의 앞단(CloudFront → Caddy → 접근 코드 관문 gate → edge).
- QA 브랜치: `qa/aws-2026-10`. 결과 폴더: 이 폴더(`docs/qa/2026-10-aws/`).
- 앞선 QA: [2026-10-02](../2026-10/REPORT.md)(32건 · 29 수정) · [2026-10-10 출시 2차](../2026-10-release/REPORT.md)(22건 · 모두 수정). 그 뒤 80커밋 — AWS 리뷰 후속(따라잡기 · 파티션 보류 · ETag 표식 · 특보 dropped · 공개 데모 화면 · 잠금 안내 · RDS verify-full).
- 목적: 결함을 찾아 재현하고 증명한 뒤(실패 시험), 근본 원인을 고친다(같은 시험이 통과).
- 이 계획은 별도 리뷰 에이전트의 검토(빠진 위험 7 · 틀린 전제 5 · 환경 충돌 6)를 반영했다.
- 상태: **끝남**(2026-10-14) — 결과는 [REPORT](REPORT.md) · [DEFECTS](DEFECTS.md). 사용자 승인(§8)과 진행 중 결정(aws-deploy 도 고침 · QA-1350 IP 당 몫)대로 진행했다.

## 0. 원칙과 제약
| 항목 | 정한 것 |
|---|---|
| 바꾸는 순서 | **찾기 단계**: 시험 코드 · 시험 데이터 · 점검 스크립트 · QA 문서만 더한다. 결함마다 재현 시험을 먼저 커밋(`test(qa): QA-NNNN …` — 실패, 실패 글을 메시지에). **고치기 단계**: 제품 코드를 고치는 커밋(`fix(…): QA-NNNN …` — 같은 시험 통과)을 따로 한다. 재현 시험 커밋 전에 기존 시험 전체의 기준선을 먼저 남긴다 |
| 시험 환경 | 로컬만. §1.4 의 스택(모두 fixture 모드 — 서버의 외부 호출 0, 외부 키는 빈 값, 버리는 볼륨). 단위 · 통합 시험은 Testcontainers · 버리는 컨테이너 |
| env 파일 | 격리 스택도 지금 Makefile 대로면 사용자의 `.env` 를 `--env-file` 로 읽는다(Makefile:8). 이번 QA 는 `.env.example` 에서 **새로 만든 시험 전용 env 파일**(세션 임시 폴더, 0600)을 쓴다 — 사용자의 `.env` 를 읽거나 쓰지 않는다 |
| 쓰지 않는 것 | AWS 운영(EC2 · RDS · CloudFront)의 데이터 · 계정 · 설정 변경, 로컬 운영 스택(8700)의 데이터, 실제 공급자 호출(저장된 fixture 와 목만 — `make fixtures` 금지), aws-deploy 의 `*.env` · 이전 리허설 볼륨(`rds-emu_rds-data` · `wakeline_aws_rehearsal_*` — 건드리지 않고 새 이름을 쓴다) |
| 시험 비밀값 | 운영자 계정 · GATE_SECRET · GATE_CODES · ORIGIN_SECRET · DB 비밀번호는 새로 만들어 세션 임시 폴더의 0600 파일에만 둔다(대화 · 저장소 · 로그에 적지 않는다). 끝나면 스택과 함께 지운다 |
| 이미지 태그 | QA 빌드는 고정 QA 태그(`wakeline-*:qa`, `compose.qa-fix.yml` 방식)로 하고, 그래도 시작 전에 `wakeline-*:local` 을 `:mainsafe` 로 보관한다(셸 변수는 `${i}:mainsafe` 처럼 감싼다 — VERIFICATION #113). 끝나면 되돌린다 |
| 다른 프로젝트 | aws-deploy 는 Macro · BuildRisk 와 함께 쓰는 저장소다. **읽고 로컬 리허설로 시험만** 한다. 그 저장소의 결함은 재현 · 보고하고, 고치기는 사용자에게 묻는다 |
| 브라우저의 외부 호출 | 지도 배경(OpenFreeMap)은 브라우저가 직접 부른다(lib/maplayers.ts:9). 자동 점검에서는 Playwright 로 막고 빈 타일로 대신한다 — 승인 질문 2 |
| 결함 번호 | 앞선 QA(001–403 · 500–900번대)와 겹치지 않게 네 자리: 보안 `QA-1100`– · 신뢰성 · 데이터 `QA-1200`– · 기능 `QA-1300`– · 화면 · 접근성 `QA-1400`– · 성능 `QA-1500`– · AWS 앞단 · 배포 `QA-1600`–. 재현 시험 이름에 번호(`Qa1301…Test` · `test_qa_1301_…` · `qa-1401-….spec.ts`) |
| 기록 | `DEFECTS.md`(결함 목록) · `findings/<영역>.md`(상세) · `evidence/<영역>/`(명령 · 출력 · 로그 · 스크린샷) · `REPORT.md`(최종 보고) — 모두 이 폴더. 증거 경로가 옛 QA 폴더로 고정된 도구(qa-helpers.ts:12 · qa-r2-screens.spec.ts:15 · rel_warnings_restart.py:32)는 경로 인자를 더해 옛 증거를 덮지 않게 한다 |
| 구분 | **결함**(재현됨) · **미확인**(의심했지만 재현 못 함 — 따로 표시) · **개선 제안**(계층 위반 · 순환 의존 같은 구조 문제, 설계상 수용한 위험 — 결함 수에 넣지 않음) |

### 심각도(앞선 QA 와 같다)
| 등급 | 뜻 |
|---|---|
| 치명 | 인증 우회 · 원격 실행 · 비밀값 노출 · 데이터 영구 손실이나 오염 · 전체 중단. **발견 즉시 알리고 이어서 진행** |
| 높음 | 핵심 기능이 틀린 값을 보이거나 동작하지 않음 · 운영 기능 일부의 인가 우회 · 조건부 데이터 손실 · 저절로 회복되지 않는 장애 · 익명 요청으로 자원 고갈이나 다른 방문자 차단 |
| 보통 | 일부 기능 오류(우회 가능) · 성능 목표 초과 · 핵심 작업을 막는 WCAG AA 위반 |
| 낮음 | 표시 · 문구 · 드문 조건 · 경미한 접근성 위반 · 400 이어야 할 입력의 500(사용자 기능 손실 없음) |

## 1. 파악한 대상
### 1.1 기능 · API · 화면
- **API 51경로**: 공개 32(OpenAPI 스냅샷과 일치) + 운영 19(세션 · CSRF · 정확한 Origin, 익명은 404) + `/api/v1/openapi`. WebSocket `/ws/v1` — 클라이언트 10종 · 서버 17종.
  공통 규칙: IP당 분당 120회, 같은 파라미터 두 번이면 400, 정수는 ASCII 10진수, 시각 1970–9999, bbox 면적 2,500 sq° 초과 422, 문제 응답 RFC 9457.
  역할은 운영자(OPS) 하나뿐이다 — 'ID 를 바꿔 남의 데이터 보기'의 대상은 공개 자원(알림 · 항적 · 로그 항목)이고, 운영자 사이의 경계는 비밀번호 교체 · 세션 폐기로 본다.
- **화면 10경로**: `/` · `/replay` · `/stats` · `/airports/[icao]` · `/alerts/[id]` · `/m` · `/ops` · `/logs` · `/about` · `/guide`. 공개 데모(`WAKELINE_PUBLIC_DEMO=1`)는 운영 · 로그 메뉴와 링크를 감추고 문구를 바꾼다.
- **수집 작업 11개**(region · global · sigmet · radar · metar · radar_kr · kma_warning · maintenance · portcalls_index · traffic_grid · demand) + AIS 수신기. fixture 모드는 서버의 외부 호출을 0 으로 만든다(KMA 레이더 · 교통량 · 입출항은 꺼짐 — 그 경로는 저장된 응답 · 가짜로 시험).

### 1.2 AWS 판에만 있는 것
| 층 | 내용 | 시험 근거 |
|---|---|---|
| CloudFront | HTTPS · CachingDisabled · 원본 **HTTP** :8103 + `X-Origin-Verify` · 502/504 를 S3 오프라인 HTML 503(오류 캐시 10 s) · IPv6 끔 | 콘솔 설정(코드 없음) |
| Caddy 2.11.7 | 비밀 헤더 검사 → gate forward_auth → `/ops*` · `/logs*` · `/api/v1/ops*` 404 → edge(Host=localhost, XFF 덮어쓰기) · HSTS | aws-deploy `caddy/Caddyfile` — 시험 없음 |
| gate | Python 단일 파일, 쿠키 `__Host-pf_gate` 12 h · HMAC 서명 · scrypt, IP당 15분 5회 · 전체 1시간 30회 넘으면 30분 잠금(세 프로젝트 공유), 메모리 96 MiB | aws-deploy `gate/test_gate.py` 32개 |
| compose.aws.yml | RDS(`sslmode=verify-full` + CA 묶음) · Hikari 6 · 공개 조회 허가 3 · 읽기 풀 2 · `COOKIE_SECURE`(기본 true — 하지만 `.env.example` 의 false 가 이긴다: .env.example:41 · init_env.py:4 · compose.aws.yml:51) · `PUBLIC_ORIGIN` · OpenSky 끔 · 공개 데모 · realip(사설 대역 XFF 신뢰) · api 에 `rds` bridge 망 | `test_compose_aws_policy.py` 2개(TLS 만) |
| 공유 RDS | max_connections 78, 다른 두 프로젝트가 약 14 를 쓴다(#144). wakeline 최대 약 12 + 배포 때 migrate 1. AWS 자료 규모는 DB 약 219 MB · shared_buffers 179 MB(#144) | 측정 기록만 |
| 평일 운영 | EventBridge(08:40 RDS · 08:50 EC2 시작, 18:00 EC2 · 18:10 RDS 정지) · 부팅 때 dockerd 가 `unless-stopped` 컨테이너를 순서 없이 띄우고 start-stack.sh 가 뒤따른다 · 따라잡기 · 파티션 보류 · ETag 표식 | DB 시험 일부 |
| 백업 | RDS 자동 백업 1일 · aws-deploy `rds/backup.sh`(`pg_dump -Fc --no-owner --no-privileges`) | **복원 시험 없음** |

### 1.3 기존 시험(2026-10-14 기준선 — 실행해 다시 센다)
api 1,227(JaCoCo LINE 95 · BRANCH 80 하한) · 수집기 1,994(+실 Redis · PG 27 건너뜀) · Vitest 1,827(+3) · Playwright E2E 50 · QA e2e 24파일 43 · 인프라 정책 181 ·
버리는 컨테이너 시험(`make infra-docker-test`) · 계약(`make contract`) · 보안 게이트(`make security`) · aws-deploy gate 32. CI 가 돌리지 않는 것: e2e/qa · perfTest · k6 · Lighthouse · compose.aws.yml 실제 기동 · 공개 데모 모드 e2e.

### 1.4 시험 스택(자원: Docker VM 4 CPU · 7.75 GiB — 동시에 두 스택까지, P 는 혼자)
| 이름 | 무엇 | 프로젝트 · 포트 · 망 |
|---|---|---|
| **A0 격리 표준** | `make e2e` 와 같은 구성(공개 데모 끔) — 회귀 · 운영 화면 점검 | `wlqa-a` · 8701 · 10.78.0 |
| **A1 격리 AWS 흉내** | A0 + `tools/qa/compose.aws-sim.yml`(공개 데모 · 풀 6/3/2). realip 는 넣지 않는다(호스트가 XFF 로 IP 를 고를 수 있어 요청 제한 결과가 무의미해진다 — realip 는 R 에서만) | `wlqa-a` 재기동 · 8701 |
| **B 장애 주입** | 같은 QA 이미지, 재시작 · kill · pause 전용 | `wlqa-b` · 8702 · 10.80.0 |
| **R AWS 리허설** | RDS 흉내(TLS 강제 · 슈퍼유저 아닌 마스터 · max_connections 78, 다른 프로젝트 몫 14연결을 더미로 붙잡음) + 실제 `compose.aws.yml` + Caddy · gate(운영과 같은 메모리 상한 128m · 96m 을 덧붙임 파일로). 시험 CA 로 verify-full 도. aws-deploy 파일은 읽기만, 덧붙임 · env 는 세션 임시 폴더 | `wlqa-rds` · `wlqa-aws`(18710 · 10.81.0) · `wlqa-front`(8101–8103) · RDS 흉내 55432 |
| **P 성능** | `compose.perf.yml` + 합성 자료 두 규모: **AWS 규모**(OpenSky 끔 — 관심 지역 항공기 · 선박, DB 수백 MB)와 **상한 규모**(앞선 QA 의 9 GB · 항공기 1만 · 선박 1.5만). 풀은 AWS 값 6/3/2, api 1g | `wakeline-e2e` 고정 — 다른 스택을 내린 뒤 혼자 |

QA 도구(tools/qa · e2e/qa)는 8701/8702 만 받고 앞단 헤더 · 잠금 쿠키를 모른다 — 기준 주소 · 헤더 · 쿠키 · 증거 경로를 인자로 받게 확장한다(점검 스크립트 수정).

## 2. 위험이 큰 곳(검증 순서) — 모두 **미확인**, 재현되면 결함으로 올린다
1. **보안(AWS 앞단 · 공개 데모 노출)**
   - Caddy 경로 차단 우회: `/api/v1/%6Fps/…` · `/API/v1/ops` · `//api/v1/ops` · `/api/v1/ops;x` · `/api/v1/./ops` · `/ops/../ops` · 뒤 슬래시. api 는 디코딩한 경로로 운영 요청을 처리한다(2차 방어는 세션 · CSRF).
   - 공개로 열린 운영 정보: `/guide` 의 운영 · 로그 절과 캡처(GuideView.tsx:419-453), `/ops` · `/logs` 화면의 JS 조각(`_next/static` 은 Caddy 차단 밖).
   - gate: 무관한 IP 두 개로 30회 실패 → 모든 방문자 · 세 프로젝트의 잠금 해제가 30분 막히는가. 동시 scrypt 로 96 MiB 넘어 재시작 → 시도 제한 초기화 · Caddy 502.
   - 익명 `/client-errors` → 운영 `/logs` 의 저장형 XSS, 홍수(전체 분당 120 vs 스트림 MAXLEN)로 진짜 오류가 밀려나는가.
   - 잠금 통과자의 남용: WS 구독으로 수요 임대 · 일일 예산 · 전역 상한(WS 200 · 공개 조회 허가 3)을 혼자 차지하는가.
   - `COOKIE_SECURE`(코드로는 false 가 이긴다 — 실제 AWS 값은 승인 질문 1), realip 위조, 오류 보고의 쿠키 동봉과 운영 세션 · CSRF.
   - CloudFront → Caddy 평문 구간(비밀 헤더 · 잠금 쿠키)은 로컬로 재현할 수 없다 — 설계 위험으로 기록.
2. **데이터 손실(평일 정지 · 재기동 · 백업)**
   - 백업 → 복원: `backup.sh` 옵션(`--no-owner --no-privileges`)으로 뜬 덤프를 새 RDS 흉내에 복원했을 때 `wakeline_api` · `wakeline_collector` 권한 · SECURITY DEFINER 함수가 살아 api 가 뜨는가.
   - 70 h 를 넘는 정지 뒤 1분 요약 영구 누락, 금요일 마지막 약 10분의 공급자 예산 기록 누락, dropped > 0 이 이어지면 특보가 끝나지 않음(승인 질문 4), 정지 때 종료 유예 안에 저장기가 비우는가,
     AIS 가 Redis 장애 중 재시작되면 모은 위치가 사라짐, **부팅 때 dockerd 가 RDS 준비 전에 컨테이너를 띄우는 경우**(데몬 재시작으로 흉내).
3. **기능 정확성**: 51경로 · WS 의 정상 · 경계 · 비정상 입력 표(`boundary_api` 에 빠진 9경로 · `endpoint_sweep` 에 빠진 4경로를 더한다), 공개 데모 화면, 18:00 정지 뒤 열려 있던 화면이 받는 오프라인 503.
4. **회귀**: 기존 시험 전체 + 앞선 QA 의 재현 시험(CI 밖 e2e/qa 13개 포함).
5. **신뢰성 · 성능 · 화면 · 접근성**.

## 3. 영역별 검증
### 3.1 보안
| 항목 | 방법 |
|---|---|
| 인가 · 인증 | `authz_matrix.py` 를 A0 · R 에서(운영 19경로 × 세션 없음 · 만료 · 인코딩 · 대소문자 · 중복 슬래시 · `;` · `..`). R 에서는 Caddy 를 거쳐 — 404 가 Caddy 에서 나는지 api 에서 나는지 구분. 익명 404 를 19경로 전수로. 공개 경로의 ID 바꾸기(알림 · 항적 · 항목). 운영자: 비밀번호 교체 뒤 옛 세션 폐기 · 로그인 실패 제한 · 세션 8 h |
| gate | 쿠키 위조 · 서명 변조 · 만료 · 다른 서비스 쿠키 재사용 · 열린 리디렉션 · Origin 검사 · 시도 제한(IP · 전체 · 재시작 초기화) · 동시 scrypt 메모리(`docker stats`) |
| 입력 · 인젝션 | `fuzz_api.py` · `boundary_api.py` — 큰 수 · 음수 · 잘못된 형식 · NUL · 유니코드 숫자 · 매우 긴 값 · 중복 파라미터 · SQL/경로 조작 문자열. WS 메시지 퍼징(`ws_probe.py`). 500 · 스택 노출 · 지연 폭증은 결함 후보 |
| XSS | 공급자 문자열(선명 · 목적지 · SIGMET · 특보 · 공역 이름)을 조작 fixture 로 스트림에 주입(`inject_stream.py`) → 모든 화면 · 브라우저 알림 · 근거 화면 · JSON. 익명 `/client-errors` → `/logs`. URL 값(`/alerts/[id]` · `/airports/[icao]` · 재생 쿼리 · logs 해시) |
| CSRF · 헤더 · CSP | `qa-sec-csrf.spec` · `headers_check.py` 를 A0 와 R(앞단 포함 — HSTS · `X-Robots-Tag` · CSP 가 한 번만 붙는가, `-Server`) |
| 공개 노출 | 공개 데모에서 `/guide` · JS 조각 · `/api/v1/openapi` · `/api/v1/status` 가 운영 정보를 얼마나 보이는가 |
| 비밀값 | gitleaks(이력) · 격리 스택 로그 · 오류 응답 · 원문 보관(`/data/raw` — 가림 없음)에 가짜 키 흔적. `http.py` 의 `body[:200]` 자른 뒤 가리기 순서로 키 앞부분이 남는가(목으로) |
| 버전 · 취약점 | `make security`(trivy · npm audit · pip-audit · gitleaks) + Caddy · gate 이미지 trivy. 런타임 · 프레임워크(Node 24 · Next 16.3 · Spring Boot 4.1 · Java 25 · Python 3.13 · PostgreSQL 18 · Redis 8 · nginx 1.30 · Caddy 2.11)의 지원 종료 일자는 **공식 문서 · endoflife.date 로 확인한 것만** 적는다 |
| 망 | api 의 `rds` bridge 망으로 인터넷에 나갈 수 있는가(R — 설계상 수용인지 기록) |

### 3.2 기능
- 51경로마다 정상 · 경계 · 비정상 표(상태 코드 · 문제 응답 · 값 범위 · 상한). 시험이 약한 경로를 먼저: `/aircraft/{hex}/track?stepS>0` · `/sigmets/{id}` 404 · `?active=false` · `?watched=false` · `/radar/frames` 304 · 선박 항적 정확히 5,000점.
- 응답 크기 상한이 없는 경로(`/aircraft` · `/replay` — bbox 2,500 sq°)의 크기와 시간.
- 공개 데모 화면(A1): 메뉴 · '로그 보기' 링크 · 오류 화면 문구 · 특보 문구 · 머리말. 잠금 만료 때 REST · ETag 조회 · **WS** 의 안내, 정지 뒤 오프라인 503 을 받은 화면(R).
- 규칙 단위: 따라잡기 창 · 파티션 보류 상한 경계(6 h ± 1분) · `catchUpSummaries(Instant.now())` 와 주입 시계의 어긋남 · ETag 표식 · 특보 dropped.

### 3.3 화면(실제 브라우저 — A0 · A1 · R)
- `e2e/qa/*`(sweep · dashboard · pages · ops-logs · keyboard · kst · a11y-extra · xss · csrf)를 새 빌드에. sweep 경로에 `/m` · `/alerts/[id]` 를 더하고, **공개 데모 모드로 한 번 더**.
- 모든 버튼 · 탭 · 폼 · 표를 눌러 **콘솔 오류 · 실패한 요청 · 중복 요청**을 모은다. 1440 · 768 · 375 · 320 px 가로 넘침, 키보드(Tab · Enter · Esc · `/` · 초점).
- 시험이 없는 흐름: 설정 409 충돌 · 해결/되돌리기 확인 · 오류 경계 화면 · 배포 뒤 옛 청크 · WS 끊김 · 재접속 표시 · 로그인 429 · 세션 만료 뒤 돌아오기.

### 3.4 신뢰성(B · R · 버리는 컨테이너)
| 상황 | 확인할 불변식 |
|---|---|
| api · 수집기 · AIS 재시작 · kill(쓰는 중) · `docker compose stop`(유예 30 s) | 행이 사라지거나 겹치지 않음, ACK 는 저장 뒤(스트림 ↔ DB 대조 `stream_db_integrity.py`) |
| 평일 정지 흉내(정지 → 시계를 건너뛴 DB 상태 → 기동) · 데몬 재시작(순서 없는 동시 기동, RDS 늦게) | 따라잡기 · 파티션 보류 · 금요일 교통량 · 1분 요약 · 공급자 예산 기록이 빠지지 않음, 스스로 이어짐. 70 h 초과 정지 |
| RDS 흉내 정지 · 느림 · 연결 고갈(R) | api 503 + Retry-After, 수집기 대기열 보존, 돌아오면 스스로 이어짐. verify-full 에서 다른 CA 는 거절 |
| Redis 재시작(AOF) · 장애 중 AIS 재시작 | 수집 · 소비가 스스로 이어짐, 모은 위치의 손실 범위 |
| 같은 요청 동시 · 같은 메시지 재전달 | 멱등(알림 · 특보 · 입출항 색인 · 보존 복사) |
| 백업 → 복원 | 로컬 도구(`make backup/restore` — 격리 프로젝트)와 **AWS 방식(`backup.sh` 옵션)** 둘 다 — 행 수 · 권한 · api 기동 |

### 3.5 성능(P — AWS 값으로)
- k6(api 직접): 공개 32경로(빠진 4경로를 `perf/qa/rest-routes.js` 에 추가) — **AWS 규모**는 공개 데모에 맞는 부하(초당 20건)와 앞선 QA 와 같은 100 rps, **상한 규모**는 100 rps · 몰림(300 → 400 rps). 각 3분 · 3회, 경로별 p95 · 처리량 · 오류율.
  목표: REST p95 ≤ 300 ms · WS 200 연결 p95 ≤ 500 ms · api ≤ 768 MiB(앞선 QA 와 같다). 허가 3(1 s 뒤 503)이라 **503 비율 1 % 이하**를 함께 본다(몰림은 기록만).
- 앞단 포함(R): Caddy · gate 를 거친 p95 와 gate CPU · 메모리(소량 부하 — 로컬).
- 느린 쿼리: `pg_stat_statements` · EXPLAIN(새 경로 · 보존 조회 · 특보 이력), 큰 응답(`perf_large_responses.py`).
- 화면: Lighthouse(`/` · `/m` · `/alerts/[id]` 와 앞선 QA 가 재지 않은 `/replay` · `/stats` · `/guide` · `/about` · `/airports/[icao]`) — 소프트웨어 렌더러와 실제 GPU 를 섞지 않는다. 첫 화면 JS 예산.

### 3.6 접근성
axe-core(WCAG 2.1 A · AA)를 10경로 · 공개 데모 · 탭 · 카드 · 배너 · 모바일 폭에서. 위반은 규칙 · 대상 · 영향 · WCAG 항목으로 정리한다. 후보: SidePanel 탭 이름의 언어 표시(3.1.2) · 관심 단추의 `aria-pressed` 와 바뀌는 이름.

### 3.7 회귀
`make test` · `make test-collector-db` · `make infra-docker-test` · `make contract` · `make e2e`(다른 스택을 내린 뒤) · `make security` · e2e/qa 전체 · aws-deploy gate 시험. 중요한데 시험이 없는 경로를 정리한다(후보: compose.aws.yml 정책 · realip · 공개 데모 e2e · WS 잠금 · 평일 경계 · 운영 19경로 익명 404 전수 · RateLimitFilter).

## 4. 진행 방식
1. 준비: `:mainsafe` 태그, QA 이미지(`:qa`) 빌드, 시험 env 파일, 기존 시험 전체 기준선.
2. 찾기: 영역별 독립 에이전트가 점검한다. 같은 스택을 쓰는 점검은 읽기 점검끼리만 동시에(한 IP 의 분당 120 · edge 초당 10 을 나눠 쓰지 않게 스택마다 순서를 정한다), 재시작 · kill 은 B 에서만.
3. 결함마다 재현 시험 → 커밋. 치명 보안 · 데이터 손실은 발견 즉시 알린다.
4. 검증: 결함 목록을 **처음 보는 별도 에이전트**가 적힌 재현 절차대로 재현되는지 · 심각도가 맞는지만 확인한다.
5. 고치기: 근본 원인 수정 → 같은 시험 통과 → 전체 시험 · 빌드 · 린트 · 타입 검사. 리팩터링은 따로.
6. 보고: `REPORT.md` — 범위 · 방법, 시험 수 · 결과, 심각도별 결함, 검증하지 못한 것, 성능 수치, 출시 판단과 근거, 수정 우선순위. 스택 · 시험 비밀값 · QA 이미지를 지우고 태그를 되돌린다.

## 5. 멈춤 조건(이때만 묻는다)
AWS 운영 · 실제 계정 · 지울 수 없는 데이터가 필요할 때, 호출 한도 · 비용이 드는 외부 서비스를 실제로 불러야 할 때, 사용자가 직접 넣어야 하는 값이 필요할 때,
코드 · 문서로 기대 동작을 정할 수 없을 때(예: 공공데이터포털 429 를 호스트 단위로 쉬는 동작 #141), 고치기가 계약 · 제품 동작 · 공유 저장소(aws-deploy)를 바꾸거나 되돌릴 수 없는 Flyway 마이그레이션을 더할 때.

## 6. 고치는 범위
재현된 wakeline 결함은 근본 원인을 고친다(커밋은 재현 시험과 따로). 계약 변경 · 제품 동작이 바뀌는 수정 · 새 마이그레이션 · aws-deploy 수정은 고치기 전에 묻는다.
개선 제안은 기록만 한다. main 병합 · AWS 배포 · push 는 끝난 뒤 묻는다.

## 7. 로컬로 확인할 수 없는 것
CloudFront(실제 캐시 · 오류 페이지 · WS 지원), 보안 그룹, EventBridge 일정, RDS 의 백업 창 · 보존 · 파라미터 · 실제 인증서, EC2 정지 순서 · 종료 유예, 실제 `COOKIE_SECURE` 값.
이것은 AWS 를 **읽기만** 해야 확인할 수 있다 — 승인 질문 1.

## 8. 승인 때 정한 것(2026-10-14 사용자)
1. **AWS 읽기 허용**: Describe 류 조회 · 공개 주소에 잠금 해제 없는 GET 몇 번 · 실행 중 api 컨테이너의 `COOKIE_SECURE` 한 값. 설정 변경 · `.env` 열기는 하지 않는다.
2. **외부 지도 타일**: 자동 점검(전수 클릭 · 접근성)은 막고 빈 타일로 대신한다. Lighthouse · 화면 캡처 몇 번만 실제 타일을 받는다. Lighthouse 는 npx 로 받는다.
3. **기대 동작**: dropped > 0 이 이어질 때 특보가 끝나지 않는 것(보통)과 70 h 초과 정지 뒤 1분 요약 누락(데이터 손실 — 높음)은 재현되면 **결함으로 고친다**. 고치는 방식이 계약 · 동작을 바꾸면 그때 묻는다.
4. **계획 승인** — 끝까지 진행. aws-deploy 수정 · 새 마이그레이션 · 계약 변경 · 치명 결함은 알리거나 묻는다.
