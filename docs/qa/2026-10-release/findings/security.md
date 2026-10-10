# 보안 — 출시 QA 2차(2026-10-10)

환경 표기는 [기능](functional.md)과 같다(U · A). **치명 · 높음 보안 결함 없음.**

## 점검한 것
| 항목 | 방법 | 결과 |
|---|---|---|
| 인증 · 인가 · CSRF · Origin(운영 19경로 + 새 설정 키 `airspace_alerts` · `retain_targets`) | `tools/qa/authz_matrix.py`(A — 익명 · 위조 쿠키 · 로그아웃 세션 · 다른 메서드 · 경로 속임수 · CSRF 없음 · 교차 Origin) | 234줄 기대대로 · 실패 0(`evidence/security/authz_matrix.jsonl`) |
| 교차 사이트 요청(폼 · no-cors fetch · `_csrf` · text/plain · 사용자 머리 · 로그인 강요) | 앞선 QA 의 `e2e/qa/qa-sec-csrf.spec.ts`(A) | 통과 |
| 보안 머리 · CSP(새 화면 `/m` · `/alerts/[id]` · 재생 링크 + 새 API `/warnings` · `/airspace` · `/watch` · `/alerts/{id}` · `/warnings/history`) | `tools/qa/headers_check.py`(A) | 138/138 — 화면은 nonce + strict-dynamic · unsafe-inline 없음 · no-store, API 는 `default-src 'none'`, `/watch` 는 `private`(공개 캐시 없음) · Host 허용 목록 421 · X-Request-Id 위조 덮어씀 |
| 저장형 XSS — 특보 원문 · 구역 이름 · 종류 · 수준 · 명령 · 때 · 해제예고(스트림 주입), 관심 대상 이름(저장소 조작) → 'wx' 탭 · 관심 탭 · 배너 · 브라우저 알림 · `/m` | `tools/qa/inject_stream.py warnings` + `e2e/qa/qa-r2-xss.spec.ts`(A) | 스크립트 표식 · 주입 요소 · CSP 위반 · 대화상자 없음, 표식은 글자로 보임 |
| 반사형 XSS — `/alerts/{id}` 경로 값 · `/replay?at&bbox&hex` | 같은 spec | 같음 — 틀린 값 안내(3줄) |
| 앞선 QA 의 XSS · CSRF 점검(로그 · 감사 메모 · 선박/항공기 스트림 · 공항 경로 · 로그 해시) | `e2e/qa/qa-sec-xss.spec.ts` · `qa-sec-csrf.spec.ts`(A) | 통과(묶음 실행 중 한 번은 시험 자신의 타이밍으로 실패 — 단독 두 번 4/4) |
| 입력 퍼징(새 경로 375사례) | `tools/qa/fuzz_api.py`(A) | 5xx 0 · 받아들이면 안 되는 것 1(QA-500) |
| 비밀값 | `make security` 의 gitleaks(1,3xx 커밋 · 누출 0) · 특보 공급자의 키 처리 코드 읽기 | 누출 없음. 키 일부가 오류 글에 남을 수 있는 경로는 '미확인'(아래) |
| 알려진 취약점 | `make security`(trivy 자체 이미지 6 · npm audit · pip-audit) — REPORT §2 | PASS |
| Redis ACL(새 스트림 `wakeline:wxwarn`) | `make infra-docker-test` 의 Redis ACL 301 | 수집기만 쓰기 · ais 거절 |

### 런타임 · 프레임워크 지원 기간(2026-10-10 — endoflife.date API 로 확인, 실제 이미지 안 판 확인)
| 구성 | 쓰는 판(이미지 안) | 최신 | 지원 종료 | 판단 |
|---|---|---|---|---|
| Spring Boot | 4.1.1 | 4.1.1 | OSS 2027-07-31 | 지원 중 |
| Java(Temurin) | 25.0.4.1 LTS | 25.0.4.1 | 2031-09-30 | 지원 중 |
| Next.js | 16.3.8 | 16.4.0(2026-10-06) | 16 줄 지원 중 | 지원 중 — 16.4 가 나왔다(16.3 줄의 보안 수정이 계속 나오는지는 공식 공지로 확인 필요 — 참고) |
| Node.js | 24.21.0 | 24.21.0 | 활성 지원 2026-10-20 끝 → 보안 지원 2028-04-30 | **곧 활성 지원 끝(10일 뒤)** — 보안 수정은 2028-04 까지. 26 이 2026-10-28 LTS(참고 · 결함 아님) |
| Python | 3.13.15 | 3.13.16 | 버그 수정 2026-10-01 끝 · 보안 2029-10-31 | 보안 수정만 받는 단계(참고) · 패치 하나 뒤 |
| PostgreSQL | 18.6 | 18.6 | 2030-11-14 | 지원 중 |
| PostGIS | 3.6.4 | — | (PostgreSQL 18 과 함께) | 지원 중 |
| Redis | 8.10.2 | 8.10.2 | 현재 줄 | 지원 중 |
| nginx | 1.30.5(stable) | 1.30.5 | 현재 stable | 지원 중 |

## 결함

### QA-500 · 낮음 · api 공역 — `category` 값 앞뒤의 제어 문자(NUL · 탭 · 줄바꿈 · 0x1F)를 지우고 받아들임
- **환경**: A(퍼징 `category=a%00` → 200) · U.
- **재현**: `cd apps/api && ./gradlew --offline test --tests 'dev.wakeline.qa.Qa500AirspaceCategoryControlCharTest'`.
- **기대**: 계약 v5 §G47 "[a-z_]{1,32} 쉼표 목록" — 제어 문자는 400 `BAD_CATEGORY`(§G43 에서 `trim()` → `strip()` 으로 고친 것과 같은 부류).
- **실제**: `prohibited\0` · `\0prohibited` · `prohibited\t` · `restricted,danger\n` · `prohibited\x1f` 모두 200.
- **원인**: `apps/api/src/main/java/dev/wakeline/airspace/web/AirspaceController.java:70` — `c.trim()`. 값은 메모리 거르기에만 쓰여(SQL · 키 아님) 피해는 없다.
