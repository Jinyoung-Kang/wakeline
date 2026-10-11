# AWS 데모 리뷰 · 개선 결과 (2026-10-11)

계획: [PLAN.md](PLAN.md)(사용자 승인 — 1–14 전부, 배포 · AWS 설정 변경 포함). 결정: [ADR-039](../../adr/ADR-039-aws-demo-deployment.md) 덧붙임 2.
기록: [VERIFICATION](../../VERIFICATION.md) #137–#143. 브랜치 `fix/aws-review-2026-10`(19커밋) → `main` 병합 `935efcd0` → EC2 배포.

## 1. 바꾼 것과 이유

| ID | 무엇 | 왜 |
|---|---|---|
| B-1 | 1분 요약 따라잡기 창 24 h → 원해상도 보존 − 2 h | 주말 정지(약 63 h) 때문에 매주 금 17–18시 KST 요약이 빠지고, 72 h 뒤 재생이 영구히 비었다 |
| B-2 | 따라잡기 실패 → 1분 뒤 재시도(이어지면 두 배씩, 30분 상한). 성공 뒤 주기는 3 h 그대로 | AWS 에서는 03:30 정시 집계가 돌지 않는다. 기동 직후 실패(10-10 실측)의 다음 시도가 3 h 뒤라 금요일 교통량이 빠질 수 있었다 |
| D-1 | 브라우저 오류 보고 `credentials:"same-origin"` | 앞단 잠금 쿠키가 없어 방문자 오류 보고가 모두 401 로 막혔다(30 h 동안 0건) |
| B-6 | 순번 ETag(특보 · SIGMET · 선박)에 프로세스 표식 `Etags.BOOT` | 매일 같은 시각에 기동하면 어제 본문이 304 로 되살아날 수 있었다 |
| D-2 | 알림 `blocked` 상태(안드로이드 크롬 등) | 알림이 뜨지 않는데 "켜짐"이라 보였고, 숨은 탭에서 헛되이 조회했다 |
| A-1 | CloudFront(wakeline) IPv6 끔(AWS 설정) | IPv6 /64 안에서 주소를 바꾸면 IP 별 제한을 피해 전역 상한을 혼자 차지할 수 있었다 |
| C-1 | RDS 인증서 검증(`verify-full` + AWS RDS CA 묶음) — api · migrate · collector | `require` · `prefer` 는 상대가 RDS 인지 확인하지 않았다 |
| B-4 | 줄을 버린 특보 목록에서는 이력의 특보를 끝내지 않음 | 줄만 버려진 발효 중 특보가 그 시각에 끝난 것으로 남았다(QA 보고 §7-1) |
| D-5 · D-8 · D-4 · D-7 | 잠금 만료 안내 · 공개 데모 문구 · 방금 열린 알림의 재생 시각 · /m 모양 오류 | AWS 공개 화면에서 원인을 알 수 없는 401 · 없는 운영 메뉴를 가리키는 글 · 10분 전으로 열리는 재생 · 끝나지 않는 "불러오는 중…" |
| D-6 → D-3 | `WatchRunner` 상태 · 부수효과를 훅(`useWatchRunner`)으로 옮김(리팩터링 커밋) → 늦은 답 버림 · 미리 받기 재시도(수정 커밋) | ADR-029 에서 벗어난 유일한 곳이었다. 다른 화면에서 알림이 뜨고, 첫 미리 받기가 실패하면 세션 내내 관심 대상 알림이 없었다 |
| C-2 | 입출항 다시 받기 — 비율이 같으면 빈 곳 먼저 | 매일 새로 기동하면 18–30일 전 빈 곳의 차례가 오지 않아 색인이 complete 가 되지 못했다 |
| (리뷰 M1) | 되돌리기(`RDS_SSLMODE=require`)에 빈 `RDS_SSLROOTCERT=` 도 함께 | asyncpg 는 루트 인증서가 있으면 require 에서도 검증해 collector 가 되돌아가지 않았다 |
| (시험) | `QueryPlanDbTest` 분 경계 경합 | 전체 실행에서 한 번 실패(`09:54` 기대 · `09:53`) — 두 번째 단언도 저장된 값과 견준다 |

고치지 않은 것과 이유는 PLAN §2.3 에 있다. 새 계층 · 추상화 · 인프라는 더하지 않았다(구조 규칙은 이미 가드 시험이 지킨다 — ArchitectureTest · test_layering · ADR-029).
성능 변경도 없다 — 측정 근거가 있는 성능 문제를 찾지 못했다.

## 2. 검증 증거

| 무엇 | 명령 | 결과 |
|---|---|---|
| api 단위 · 통합 | `./gradlew --offline test jacocoTestReport jacocoTestCoverageVerification`(최종 상태) | 1,224 통과 · 0 실패 · 커버리지 검증 통과 |
| collector | `uv run --offline pytest -q` · ruff · ruff format · mypy | 1,994 통과 · 27 건너뜀 · 모두 깨끗 |
| web | eslint(오류 0 — 기존 경고 1) · tsc · `vitest run` · `npm run build` · `check:first-js` | 1,825 통과 · 3 건너뜀(155 파일) · 첫 화면 JS 546,628 → 546,874 B(예산 550,000) |
| 인프라 정책 | `python3 -m unittest discover -s infra/tests` | 181 통과(새 AWS 덧붙임 정책 2) |
| 계약 | `make contract` | REST 계약 46 통과 · 언어 간 계약 통과 |
| E2E | `make e2e`(격리 8701) | 50 통과 |
| 보안 | `make security` | gitleaks PASS · trivy(api · collector · web · db · edge) PASS · npm audit · pip-audit PASS(k6 는 보고만 — 기존) |
| 독립 리뷰 | 별도 에이전트(처음 보는 리뷰어) | High 0 · Medium 3 · Low 4 → M1 · M2 고침, M3 · L1 · L2 는 남은 위험(아래) |
| 배포 전 TLS | EC2 일회용 컨테이너(asyncpg, 없는 사용자) | 서울 루트: 검증 통과 → 비밀번호 단계 실패 · 다른 루트: `self-signed certificate in certificate chain` |
| 배포 | EC2 `git merge --ff-only` 48c18826 → 935efcd0 · `build api collector web`(124 s) · `run --rm migrate` · `up -d --wait` | migrate `verify-full` 로 접속 · 0건(스키마 21) · api · collector · ais · web healthy |

| 배포 뒤 10분 | `docker logs` · 공개 API · CloudWatch · CloudFront · dig | ERROR 0 · TLS 오류 0 · 재시작 0 · 지연 항공기 8.2 s / AIS 4.9 s · 새 ETag · 공개 머리말 `demo` · 교통량 다시 `available` · RDS 연결 20–21(같음) · CloudFront IPv6 꺼짐(AAAA 없음) |

자세한 것은 VERIFICATION #143.

## 3. 남은 위험 · 다음 단계

- ~~금요일 교통량(M3)~~ → 후속에서 고침(#138 · #144): 파티션이 남아 있으면 다시 세고, 기동 뒤 첫 따라잡기 전에는 항적 파티션 삭제를 미룬다(상한 6 h).
- **공공데이터포털 키(O-1)**: 사용자 결정으로 로컬의 `portmis` · `mof_grid4` · `komsa_traffic` 공급자를 끈다(로컬 /ops). AWS 가 격자 기하를 다 채우면(평일 약 4–5일 추정) 다시 켤 수 있다.
  오래 함께 돌릴 거라면 AWS 용 키를 따로 받아 EC2 `.env` 에 넣는다(직접).
- ~~공역 자료(O-2)~~ → 후속에서 가져옴(#144): AIP 25년 5차 · 도형 697.
- **RDS 메모리(B-7)** → 후속에서 잼(#144): wakeline 연결 8/21 · 임시 파일 0 · ReadIOPS 4–7 로 스왑이 오가지 않는다. 바꿀 근거가 없어 설정은 그대로다.
- ~~L1 · L2~~ → 후속에서 고침(#144). 특보 `ended_at` 은 밤 · 주말 정지 뒤 첫 수신 시각이다(B-3 — 화면에서 쓰지 않음).
- **공유 호스트**(이번 범위 밖, aws-deploy): Redis `vm.overcommit_memory=0` 경고 · Docker 빌드 캐시 약 5.6 GB · 기동 스크립트가 Makefile 을 거치지 않아 설정 해시 라벨이 `unset`
  (edge 설정만 바뀐 배포는 `--force-recreate edge`).
- **개발 도구**: ESLint 9 지원 종료(2026-08-06). `eslint-config-next` 16.3 의 peer 는 `eslint >=9` 라 10 을 막지 않지만, 플러그인 호환은 확인하지 않았다.
- **로컬 이미지**: 이전 세션의 zsh `:l` 실수로 생긴 `wakeline-*ocal:latest` 이미지 다섯 개가 남아 있다(VERIFICATION #113 과 같은 원인). 지우지 않았다.
