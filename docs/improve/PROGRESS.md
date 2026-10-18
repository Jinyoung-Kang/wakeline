# 개선 작업 진행 기록 (2026-10)

이 파일만 읽고 이어갈 수 있게 쓴다. 계획: [PLAN.md](PLAN.md) · 최종 보고: [REPORT.md](REPORT.md)(끝나면).

## 상태
- 브랜치 `fix/improve-2026-10`(main `1d4589ba` 에서). push · main 병합은 하지 않는다(사용자가 한다).
- 운영 이미지 보존: 시작할 때 `wakeline-{api,web,collector,edge,db}:local` 을 `:mainsafe` 로 태그했다.
  `make test-api` · `infra-docker-test` · `e2e` 가 `:local` 을 덮으므로 **끝나면 `:mainsafe` → `:local` 로 되돌린다**
  (zsh 에서는 `"wakeline-${s}:local"` 처럼 감싼다 — `$s:local` 은 `:l` 수정자로 먹힌다, VERIFICATION #113. 이번에도 한 번 걸려 바로 고쳤다).
- 돌고 있는 로컬 운영 스택(8700)은 건드리지 않는다.

## 단계
| 단계 | 상태 | 메모 |
|---|---|---|
| 0 파악 · 기준선 | 진행 중 | 아래 '기준선' |
| 1 계획(PLAN.md) | 대기 | 12영역 리뷰 + 검증 워크플로 결과로 작성 |
| 2 실행 | 대기 | |
| 3 독립 검토 | 대기 | |
| 4 최종 보고 | 대기 | |

## 기준선(main 1d4589ba, 2026-10-18, 이 Mac · Docker Desktop 4 CPU / 7.7 GiB)
| 검사 | 결과 |
|---|---|
| collector ruff · format · mypy | 통과 |
| collector pytest(+커버리지 하한 80) | 2,031 통과 · 28 건너뜀 · 97.40 % |
| web eslint · tsc · build | 통과 |
| web vitest | 1,860 통과 · 3 건너뜀(166 파일) |
| 첫 화면 JS(--in-image) | 549,840 B / 550,000 B(여유 160 B) |
| 인프라 정책 | 186 통과 |
| 스키마 계약 | 통과 |
| api gradle test + JaCoCo(하한 LINE 95 · BRANCH 80) | 1,288 통과 · 실패 0 · LINE 97.50 % · BRANCH 87.02 %(8분 12초) |
| REST 계약 | 46 통과 |
| collector 실 Redis | 16 통과 |
| 버리는 컨테이너(make infra-docker-test) | edge 42 · Redis ACL 301 · db 권한 36 · 백업 48 · 비밀번호 교체 27 · 이미지 교체 11 · 수집기 PG 11 — 모두 통과 |
| E2E(make e2e, 격리 8701) | 51 통과(2.2분) |

기준선에서 실패하는 항목: 없음. 로그: scratchpad `baseline-main/`(세션 임시 — 수치는 이 표가 원본).

### 기준선에 붙은 관찰
- Dependabot web 묶음(maplibre-gl 6.12.0 · vitest 5.0.3 · @types/node)을 버리는 작업 트리에서 빌드하면 첫 화면 JS 551,987 B — 예산을 1,987 B 넘는다
  (maplibre 304,573 → 307,164 B). 그대로 병합하면 CI web job 이 실패한다.
- ESLint 10: `eslint-plugin-react` 7.37.5 의 peer 가 여전히 `^9.7` — 막힘 그대로(VERIFICATION #117).
- Tomcat 11.0.27 이 나왔지만 보안 공지(security-11.html)에 11.0.27 고침 항목이 없다 — 올릴 보안 이유 없음. jackson 2.22.4 는 어제(10-17) 나왔다.

## 묻기로 모아 둔 것
- (없음)

## 다음에 할 일
- 기준선 나머지 확인 → 리뷰 결과로 PLAN.md 작성.
