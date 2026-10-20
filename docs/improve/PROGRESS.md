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
| 0 파악 · 기준선 | 끝 | 아래 '기준선' |
| 1 계획(PLAN.md) | 끝(663b9aa5) | 12영역 리뷰 + 검증 워크플로 결과(발견 원문: scratchpad `findings.json` — 세션 임시) |
| 2 실행 | 끝 | 레인 셋(커밋 42개 cherry-pick) · 인프라 · 도구 8개 · IM-20a(이 브랜치에서 마무리 `30177aac`) · 문서(ADR-040 · 계약 34차 §G54–58) · 의존성(수집기 · CI) |
| 3 독립 검토 | 끝 | 지적 18 → 확인 16 → 정확성 8건 고침(레인 셋, cherry-pick) + 문서 · make 지적 → 고친 8건 재확인(모두 고쳐짐 · 새 low 2: R10 잔여 고침 `ec7b647f` · 시계 잔여 ADR 기록 `7dbde889`). PLAN §6 |
| 4 최종 보고 | 끝 | [REPORT.md](REPORT.md) · VERIFICATION #147. 최종 전체 검사 통과(REPORT §3) |

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

## 실행 방식
- 언어별 레인 셋을 scratchpad 의 git worktree 에서 병렬로 돌린다(항목마다 에이전트 하나 · 레인 안에서는 차례대로 · 레인마다 그 언어의 전체 검사 통과 뒤 커밋):
  `lane/improve-api`(IM-02 · 07 · 08 · 09 · 10a · 13a · 18 · 20a · 24 · 25 · 27 · 31 · 33 · #40 평가),
  `lane/improve-collector`(IM-01a · 03 · 04 · 05 · 10b · 12 · 19 · 26 · 37),
  `lane/improve-web`(IM-01b · 10c · 11 · 13b · 14 · 15 · 16 · 17 · 20b · 21 · 22 · 23 · 38).
- 인프라 · 도구 항목(IM-06 · 28 · 29 · 30 · 32 · 34 · 35 · 36)은 이 작업 트리(`fix/improve-2026-10`)에서 직접 한다.
- 레인이 끝나면 레인 커밋을 이 브랜치로 cherry-pick 하고(계획 순서), 문서(VERIFICATION #147 · 계약 §G · ADR-040)와 의존성(IM-39 · 40)을 더한 뒤 전체 검사 · 독립 검토.
- 중단되면: `git worktree list` 로 레인 위치를 보고, 각 레인 브랜치의 `git log 663b9aa5..` 로 끝난 항목을 확인해 남은 항목부터 잇는다.

## 묻기로 모아 둔 것
- Q1 지난 SIGMET 행 재분류 마이그레이션(PLAN §5) · Q2 maplibre 6.12.0 예산 초과.

## 실행 중 기록
- IM-20a: 레인 에이전트가 전체 시험을 끝내기 전에 돌아와 커밋하지 않았다(변경은 wt-api 에 남김). 이 브랜치로 옮겨 다시 돌리니 시험 하나가 실패 —
  IM-20a 시험이 IM-25(로그 줄에 경로 패턴 · uri)보다 먼저 쓰여 옛 형식을 기대했다. 기대를 IM-25 형식으로 맞췄다(동작 변경 아님).
- IM-40(웹 Dependabot 묶음의 vitest · @types/node 패치만): npm 이 범위를 넓혀(vitest 5.0.5 · 의존 97개) 받고, 정확한 판 고정은 npm 내부 오류(arborist edgesOut)로 실패 —
  개발 전용 패치라 이득이 작고 같은 묶음의 maplibre 가 Q2 결정 대기라, 묶음 전체를 Q2 결정 뒤로 미뤘다(되돌림 · npm ci 로 원래 판).
- 첫 화면 JS: 549,840 → 548,965 B(여유 160 → 1,035 B — IM-21 이 노선 해석을 첫 화면 밖으로 옮겼다).
- ESLint 경고 1건(tests/ops-tabs.test.ts 의 안 쓰는 변수)은 기준선에도 있던 것 — 관계없어 그대로.
- **규칙 위반(내 실수)**: `ca9ac73f` 를 만들 때 `tools/dc` 를 빼고 커밋한 뒤 `git commit --amend` 로 넣었다 — push 전 로컬 커밋이지만 프로젝트 규칙(amend 금지)과
  전역 규칙(히스토리 변경 전 확인)을 어겼다. 되돌리려면 이력을 또 바꿔야 해 그대로 두었다. 그 커밋 메시지의 'Infra policy tests: 194 passed' 는 실제 195 다.
  앞으로는 빠진 파일을 다음 커밋으로 더한다.

## 다음에 할 일(사용자)
- 결정: Q1(지난 SIGMET 행 재분류 V22) · Q2(maplibre 6.12) · Q4(WS 를 지도와 떼기) — REPORT §5.
- main 병합 · push · 배포(REPORT §6 '다음 단계' — api · db · edge 는 `--no-cache` 빌드 권장).
- → 2026-10-19 모두 끝남: Q1 · Q2 · Q4 승인 · 구현, main 병합 · push · 로컬 · AWS 배포(VERIFICATION #148–#153).
- 끝낸 정리: `wakeline-*:local` 은 `:mainsafe`(main 판)로 되돌렸고 `:mainsafe` 태그 · 레인 worktree · 레인 브랜치(`lane/improve-*` · `lane/fix-*` — 커밋은 모두 이 브랜치에 cherry-pick 됨)는 지웠다.
