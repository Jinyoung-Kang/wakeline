# 검증 보고서(VERIFICATION) — 리뷰 4단계

대상: 기준선 커밋 `80716cb`(측정)·`fcb2c52`(진단, 같은 코드) → 검증 커밋 `0ab26cd`(코드 · 설정의 마지막 커밋 — 정적 검사 최종 측정은 `05b895b` 에서. 그 뒤 세 커밋은 시험 1건의 대기 시간(`ff57ab4`), edge `/maplibre` · E2E 작업자 설정(`c27b2d5`), R-50 문서·주석·README 검사(`0ab26cd`) — E2E · edge · 인프라 정책 시험은 이 뒤에 다시 돌렸다) · 측정 2026-09-28 기준선 05:45–05:58 UTC · 이후 10:00–15:15 UTC · 이 기계(Apple Silicon, macOS 26.7, Docker Desktop 엔진 29.8.0) ·
개발 스택(127.0.0.1:8700, 실데이터 수집 중).

**원자료**: `perf/results/` 는 저장소에 넣지 않는다(.gitignore) — 이 문서가 인용하는 값은 [evidence/](evidence/) 에 작은 텍스트로 옮겼다:
정적 검사 요약 `summary-baseline.tsv` · `summary-after-1030Z.tsv`(첫 재측정) · `summary-final.tsv`(모든 수정 뒤 같은 명령, 커밋 `05b895b` — 이 실행의 api 줄은 시간 초과 1건으로 gradle 이 멈춰 JaCoCo 가 부분 값이다. 창을 넓힌 뒤 전체 재실행 534/0 · LINE 95.86 % · BRANCH 83.56 % 는 `gates-and-tests.txt` 끝(빌드 산출물에서 읽음)), k6 실행별 요약 `k6-runs.txt`,
메모리·경합 표본 `memory-and-contention-samples.txt`, DB 크기 `db-size.txt`, `/status` 표본 `status-samples.txt`, 기준선 web 커버리지 재측정 `web-coverage-baseline-rescoped.txt`, api NMT 요약 `api-native-memory-tracking.txt`, Lighthouse 5회 `lighthouse-root-5runs.tsv`, 게이트·시험 요약 `gates-and-tests.txt`.

**측정 절차**: 정적 검사·시험·스캔은 `bash perf/review_measure.sh <label>`, 부하는 `make bench SHIPS=1`(같은 절차). 저장소 스크립트가 없는 수동 절차는 셋이다 — Lighthouse `/` 5회(같은 lighthouse@12 명령 반복),
`MALLOC_ARENA_MAX` A/B(api 환경만 바꾼 `make bench` 절차), 메모리·힙·경합 20 s 표본(`docker stats` · 관리 포트 Prometheus · `vm.loadavg`). 측정하지 않은 수치는 적지 않았고, 계산값은 "계산"·"추정"이라고 적었다.
이 문서의 수치·커밋·시험 이름은 독립 확인자가 원자료와 대조했다(3회 — 42건 · 39건 · 14건을 고침, §4 끝). evidence/ 에 원자료가 없는 값은 본문에 출처(레인 보고 · REVIEW-v1 · 세션 출력)를 적었다.

관련 문서: [BASELINE](BASELINE.md) · [REVIEW-v1](REVIEW-v1.md) · [ADR-017](../adr/ADR-017-review-v1-contract-changes.md) · 화면 전후 [ui/](ui/).

## 0. 완료 기준 점검
| 기준 | 상태 | 근거 |
|---|---|---|
| BASELINE.md | 완료 | 1단계, 코드 변경 없음 |
| REVIEW-v1.md | 완료 | 고유 97건 + 3단계 추가 1건(R-98) · 승인 85(원래 97건 중 84 + R-98) · 보류 13(이유 기록) |
| 승인 항목 커밋 | 완료 | 기준선 뒤 커밋 137개(ID 가 제목에 있는 것 130개). 승인 85건 모두 1개 이상, 버그·보안은 실패하는 시험 먼저. R-50(문서가 계약보다 뒤처짐)은 두 번째 문서 사실 확인에서 커밋이 없는 것을 찾아 4단계에 했다(`0ab26cd`, §4 끝) |
| 전/후 비교표 | 완료 | §1 |
| VERIFICATION.md | 완료 | 이 문서 — 항목마다 증상 → 재현 → 원인 → 수정 → 회귀 테스트(§3·§4) |
| 필요한 ADR | 완료 | ADR-017(공개 API·DB V9·인증·인프라 변경과 되돌리기, 3단계 결정 §5) |
| Critical/High 0 | **Critical 0 · High 0(결함)** — 단 NFR-04 의 400 KB 목표는 미충족(사용자 결정) | High 2건: R-01 수정. R-02 는 결함(MapLibre 공용 모듈 두 번 받기) 수정 — 첫 화면 JS 613.6 → 497.7 KiB. 목표 400 KB 는 MapLibre 가 첫 화면에 있는 한 닿을 수 없다(레인 측정: 앱 코드 전 426.5 KiB) |
| 모든 시험·스캔 통과 | **모두 통과** — collector 746 · api 534(최종 측정에서 1건 시간 초과 → 창을 넓혀 전체 재실행 534/0, §4 끝) · web 378 · E2E 16(연속 2회) · 인프라 정책 113(R-50 문서 검사 3건 포함, `0ab26cd` 뒤 재실행) · 버리는 컨테이너 시험(edge 35 · Redis ACL 219 · db 권한 36 · 백업·복원 48 · 비밀번호 교체 27) · 계약 27/27 · 보안 게이트(`make security`, 오프라인 DB): gitleaks·자체 이미지 3종·edge·redis **PASS**, db·k6 보고만 · Semgrep 0 · npm/pip audit 0 | §1 · §2 NFR-10 |
| 성능 목표표 | 완료 | §2 |

## 1. 전/후 비교(같은 기계·같은 명령)
| 항목 | 기준선 | 이후 | 설명 |
|---|---|---|---|
| collector 시험 | 682 통과 · 줄 96 % | **746 통과** · 97 % | 6건 건너뜀 = 실 Redis 시험(CI 가 `collector_redis_test.sh` 로 실행, 로컬 버리는 Redis 로 6/6 통과) |
| api 시험 | 457 · LINE 95.7 % · BRANCH 83.1 % | **534** · 95.9 % · 83.6 % | 실패 0, JaCoCo 하한(95/80) 통과 |
| web 시험 | 286 | **378** | |
| web 커버리지 — 같은 범위(소스 전체, R-34) | Lines 61.1 % · Branches 57.4 % | **78.4 % · 65.7 %** | 기준선 수치(92.1 %·79.9 %)는 시험이 불러온 파일만 센 값이다(1,824줄). R-34 가 범위를 소스 전체로 넓혔으므로 기준선 커밋 `fcb2c52` 를 새 범위로 다시 쟀다(2,749줄 중 1,680). 이후 3,197줄 중 2,506(최종 측정 `summary-final.tsv`) |
| E2E(Playwright, 격리 스택 8701) | 16 통과 | **16 통과**(연속 2회, 39 s) | 최종 코드에서 처음엔 4건 실패 — edge IP당 제한 429(§4 끝) → 고친 뒤 |
| 계약(스키마 사본·REST) | 일치 · 27/27 | 일치 · 27/27 | |
| ruff · mypy · eslint · tsc | 0 · 0 · 0 · 0 | 0 · 0 · 0 · 0 | |
| `javac -Xlint:all` 경고 | 19 | **19** | 첫 재측정 23 — 리뷰 코드가 만든 4건을 고쳤다(`931ed30`) |
| Semgrep(같은 규칙 파일) | 9건 · 파싱 오류 6 | **0건** · 파싱 오류 8 | Dependabot cooldown 6건 수정(`af746de`). `$host` 3건 중 `infra/edge/proxy_headers.conf` 1건은 `nosemgrep` 로 사유 기록, `docs/adr/ADR-003` 2건(ADR 본문의 nginx 예시)은 `docs/` 를 스캔 범위에서 빼서 사라졌다(`b9f87fd`) — 그래서 기준선과 스캔 범위가 다르다. 파싱 오류는 도구 한계(bash case 패턴·Python 3.13 문법·gradlew) |
| npm audit · pip-audit | 0 · 0/26 | 0 · 0/26 | |
| Trivy api 이미지 | CRITICAL 3 | **0** · HIGH 0 | Tomcat 11.0.26(R-37) |
| Trivy web 이미지 | HIGH 4 | **0** | 실행 이미지에서 npm·corepack 제거(R-29) |
| Trivy collector 이미지 | HIGH 46 | HIGH 44 | pip 가 품은 2건 제거(R-29). 남은 44건은 Debian 기반 패키지(수정판 없음 — CI 게이트는 `ignore-unfixed`) |
| gitleaks(이력 전체) · 작업 트리 비밀값 | 2 · 3(모두 시험용 가짜 값·측정 산출물) | **0 · 0** | `.gitleaksignore`(지문 고정) · 추적 파일 사본만 스캔(R-07·R-38) |
| 첫 화면 JS(`/`, Lighthouse 전송량) | 613.6 KiB | **497.7 KiB** | MapLibre 공용 모듈 중복 제거(R-02). 목표 400 KB 는 미충족 |
| 정적 js+css 전체(gzip) | 553 KiB | 558 KiB | 모든 경로 합계 — 첫 화면 아님 |
| Lighthouse `/`(단일 실행) | 39 · LCP 3.1 s · TBT 2,165 ms · CLS 0.133 | 10:30: 38 · 3.6 s · 2,991 ms · 0.112 / 최종: 47 · 2.5 s · 2,134 ms · 0.090 | headless SwiftShader(소프트웨어 WebGL) — 아래 5회 참고 |
| Lighthouse `/`(5회 중앙값) | 측정 안 함(기준선은 1회) | **53 · LCP 2.39 s · TBT 698 ms · CLS 0.067** | 범위 LCP 1.97–2.95 s · TBT 620–2,732 ms · CLS 0.038–0.079 — 한 번의 값은 비교에 쓸 수 없을 만큼 흔들린다 |
| Lighthouse `/ops` | 71 · TBT 660 ms | **100 · TBT 33 ms**(최종 98 · 0 ms) | |
| Lighthouse `/about` · `/stats` | 98 · 99 | 98 · 97(최종 98 · 97 — `/stats` CLS 0.054) | 접근성 네 쪽 모두 100 |
| k6 REST p95(aircraft · sigmets · status, 100 rps) | 9.4 · 10.9 · 13.7 ms | 경합 기록 없음 6회: 6.0–16.1 · 6.4–17.9 · 5.1–9.3 ms · 중간 경합 2회: 67.5–126.9 · 67.0–121.7 · 60.1–140.5 ms | 실패 0 % — 실행별 값·경합 기록은 §1.1 |
| k6 REST p99 | 87.7 · 86.5 · 130.0 ms | 경합 없음 6회: 25.6–267.3 · 26.0–315.2 · 21.6–228.7 ms · 중간 경합 2회: 265.3–523.7 · 306.1–516.7 · 266.3–621.9 ms | 경합 없는 6회 중 4회는 세 경로 모두 기준선 이하. 10:53 실행은 sigmets p99 137.1 ms 로 기준선(86.5 ms)보다 높고, 11:21 실행은 세 경로 모두 높음 |
| k6 WS 항공기 지연 p50 · p95 · p99(200 연결) | 23 · 151 · 225 ms | 경합 없음 6회: 18–45 · 123–266 · 243–908 ms · 중간 경합 2회: 10–44 · 175–287 · 338–472 ms | 오류 0. p95 는 8회 모두 목표(500 ms) 안, p99 는 실행마다 크게 흔들린다(§5.3) |
| k6 WS 선박 p95 | 35 ms | 17–54 ms · 중간 경합 77–91 ms | |
| api 메모리 | 611 MiB(k6 시작 전, 측정 스크립트) · 같은 명령 이후 613.7 MiB(10:30, 기본 아레나) | 최종 설정(`MALLOC_ARENA_MAX=2`, `3b2255f`): 경합 기록 없음 — 부하 중 최대 497 MiB(11:21, 20 s 표본) · 실행 끝 501 MiB(11:38) · 최종 측정 스크립트 527.2 MiB(14:23, k6 없음 — 같은 스크립트의 시험·빌드·Lighthouse 직후) / 중간 경합 — 최대 577–611 MiB | 힙 비율(R-25)만(기본 아레나 32): 버리지 않은 실행 최대·끝 628–672 MiB(10:45 · 11:31 · 11:46). 부하·경합이 크면 힙 커밋이 늘어 RSS 가 오른다(§1.1) — §2 NFR-03 |
| db 메모리 | 210 MiB | 437 MiB(10:30 측정 스크립트) · 최종 381 MiB(14:23, 같은 명령) · 430–468 MiB(버린 10:36 k6 실행 중 표본 — 버리지 않은 실행에서는 재지 않음) | `shared_buffers 256MB`(R-24) — 의도한 증가 |
| collector 메모리 | 142 MiB(`docker stats`, 한 시점) | 재기동 뒤 40분 RssAnon(1분 표본): 수정 전 99 → 289–298 MiB · **수정 뒤 88 → 173–217 MiB** | 레이더 해석(수십 MB numpy)이 공용 스레드 풀의 아무 스레드에서 돌아 스레드마다 malloc 아레나가 최고점을 따로 쥐었다(누수 아님 — 코드 감사·반박 검증). 해석은 기준선부터 풀에서 돌았고, R-21 이 풀을 쓰는 호출을 늘려 작업 스레드가 많아진 것으로 본다(추정) → 전용 해석 스레드 + `MALLOC_ARENA_MAX=2`(`05b895b`). 기준선 값은 페이지 캐시를 포함한 `docker stats` 라 같은 척도가 아니다 |
| DB 크기 | 측정 안 함(리뷰 v1 수정 전 1,354 MB, 09-28 06:29 UTC — REVIEW-v1 R-06) | 2,038 MB(09-28 15:11 UTC, `db-size.txt`) | 자료가 쌓인 파티션은 09-27 · 09-28 뿐이라 보존 정상 상태는 아직 아님(09-26 은 거의 빈 파티션, 09-29–10-01 은 미리 만든 빈 파티션) |

### 1.1 k6 실행별 결과(`make bench SHIPS=1` 과 같은 절차)
같은 기계의 다른 작업이 결과를 크게 흔들었다. 그래서 실행마다 **경합 기록**(다른 프로젝트 `aptlake` 컨테이너 CPU 합 · 호스트 1분 부하 평균, 20 s 표본)을 함께 적는다. 오전 실행은 경합을 기록하기 전이다.

| 시각(UTC) | api `MALLOC_ARENA_MAX` | 경합 기록 | REST p95 / p99(aircraft · sigmets · status, ms) | WS 항공기 p50 · p95 · p99 · 최대(ms) | WS 선박 p95 | api 메모리 |
|---|---|---|---|---|---|---|
| 기준선 05:50 | (기본) | 기록 없음 | 9.4 · 10.9 · 13.7 / 87.7 · 86.5 · 130.0 | 23 · 151 · 225 · 320 | 35 | 611 MiB(k6 시작 전, 측정 스크립트) |
| 10:45 | 기본(32) | 기록 없음 | 7.8 · 7.5 · 5.6 / 33.7 · 27.2 · 30.1 | 45 · 226 · 908 · 1,017 | 48 | 494–628 MiB(20 s 표본) |
| 10:53 | 기본(32) | 기록 없음 | 10.1 · 12.1 · 7.4 / 87.6 · 137.1 · 89.5 | 26 · 166 · 243 · 329 | 17 | — |
| 11:21 | 2 | 기록 없음 | 16.1 · 17.9 · 9.3 / 267.3 · 315.2 · 228.7 | 27 · 266 · 602 · 1,225 | 54 | 최대 497 MiB(20 s 표본) |
| 11:31 | 기본(32) | 기록 없음 | 6.9 · 7.6 · 5.5 / 50.3 · 43.2 · 51.2 | 42 · 159 · 482 · 730 | 31 | 끝 646 MiB |
| 11:38 | 2 | 기록 없음 | 6.3 · 6.6 · 5.2 / 35.3 · 29.2 · 21.6 | 34 · 198 · 420 · 508 | 33 | 끝 501 MiB |
| 11:46 | 기본(32) | 기록 없음 | 6.0 · 6.4 · 5.1 / 25.6 · 26.0 · 43.1 | 18 · 123 · 254 · 461 | 33 | 끝 672 MiB |
| 13:54 | 2 | 중간: aptlake 18–77 % · 부하 3.2–6.3 | 67.5 · 67.0 · 60.1 / 265.3 · 306.1 · 266.3 | 44 · 287 · 472 · 694 | 91 | 최대 577 MiB(20 s 표본) |
| 14:05 | 2 | 중간: aptlake 0–115 % · 부하 2.4–7.6 | 126.9 · 121.7 · 140.5 / 523.7 · 516.7 · 621.9 | 10 · 175 · 338 · 424 | 77 | 최대 611 MiB(14:12:45 힙 표본, WS 끝 무렵 — 20 s 모니터 표본으로는 579) |

**버린 실행**(판정에 쓰지 않음, 값은 숨기지 않는다):
- 10:36 — 브라우저 패널에 상황판(선박 약 1.4만 척 WebGL)을 열어 둔 채 — 같은 CPU 를 나눔(REST p99 207–228 ms). 닫고 다시 쟀다.
- 11:54 · 12:03 · 12:10 · 13:21 · 13:30 — 같은 Docker VM 의 CPU 경합이 컸다. 13:21 · 13:30 은 `docker stats` 로 확인: 실행 중 다른 프로젝트 `aptlake` 컨테이너 CPU 합 23–244 %, 호스트 1분 부하 4.8–12.6. 12:03 · 12:10 은 호스트 1분 부하 5.3–12.4 만 기록했고(원인은 12:2x 에 `docker stats` 로 본 aptlake Dagster·Trino·MinIO — 실행 중 값은 기록 안 함), 11:54 는 경합 기록 안 함.
  설정과 무관하게 모두 나빴다 — REST p95 는 `MALLOC_ARENA_MAX=2` 인 12:03 이 가장 나쁨(55.3 rps 밖에 못 내고 7,901 · 8,191 · 30,134 ms), WS 항공기 p95 는 기본 32 인 12:10 이 가장 나쁨(6,738 ms).
  api 메모리(끝 또는 최대): 11:54 506 · 12:03 670(2) · 12:10 766(기본 32) · 13:21 최대 702 · 13:30 최대 619 MiB.

**api 메모리가 부하·경합에 따라 달라지는 이유(측정)**: RSS ≈ 힙 커밋 + 약 280 MiB(메타스페이스·코드 캐시·GC 구조·스레드 등). 힙 표본(관리 포트, `memory-and-contention-samples.txt`)에서 힙 커밋이 13:54 실행 중 241 → 298 MiB, 14:05 실행 중 217 → 316 MiB 로 늘었고 RSS 가 함께 468 → 611 MiB 로 움직였다. k6 없이 큰 경합 속에서 게이트를 기다리던 13:39–13:54 에도 힙 커밋 223 → 381 MiB · RSS 최대 661 MiB 까지 늘었다.
GC 일시정지 최대: 13:54 실행 344 ms · 14:05 실행 939 ms(CPU 가 모자랄 때 늘어남). 오전(경합 기록 없음) 10:45 실행은 GC 합계 약 1.4 s / 7분 · 최대 68 ms · 힙 커밋 약 200 MiB 였다.

k6 실행 조건: 개발 스택 실데이터(선박 2구역 수신). 실행 중 항공기·SIGMET·선박 수는 기록하지 않았다 — `/status` 로 읽은 값만 있다(`status-samples.txt`): 10:23 관심 지역 110 · 전세계 7,651 · 선박 14,686 · SIGMET 130, 10:53(k6 직전) 130 · 7,978 · 14,449.

## 2. 성능·비기능 목표(NFR, 설계서 v0.2 §2.4)
| ID | 목표 | 측정 | 판정 |
|---|---|---|---|
| NFR-01 | 수집기 수신 → 브라우저 반영 p95 ≤ 1.5 s(관심 지역, Playwright 100회) | 구간 전체는 재지 않았다. 부분: api → k6 WS 클라이언트 지연 p95 123–287 ms(버리지 않은 8회) | **측정 안 함** |
| NFR-02 | REST p95 ≤ 80 ms(캐시)·≤ 300 ms(미스), 100 rps | 잰 경로: 항공기 bbox · SIGMET(active) · status — p95 경합 기록 없음 6회 5.1–17.9 ms · 중간 경합 2회 60.1–140.5 ms(세 경로), 실패 0 %. 상세 API(`/aircraft/{hex}`)는 재지 않았고 캐시 적중·미스를 나눠 재지 않았다 | 경합 없을 때 **충족**(잰 경로만) · 같은 기계에 중간 부하가 있던 2회 중 14:05 1회는 80 ms 초과(121.7–140.5 ms), 13:54 는 60.1–67.5 ms |
| NFR-03 | WS 200 연결 diff p95 ≤ 500 ms · api 메모리 ≤ 512 MB | WS p95 123–287 ms(버리지 않은 8회) · 메모리 최종 설정(`MALLOC_ARENA_MAX=2`) — 경합 기록 없음: 부하 중 최대 497 MiB(11:21) · 실행 끝 501 MiB(11:38) / 최종 측정 스크립트 527.2 MiB(14:23, k6 없음) / 중간 경합: 최대 577–611 MiB / 버린 실행(큰 경합): 506–702 MiB · 참고 — 힙 비율만(기본 아레나 32): 버리지 않은 실행 628–672 MiB | WS **충족**(8회 모두) · 메모리 **미충족** — 512 MiB 이하는 경합 기록이 없는 k6 실행 2회(497–501 MiB, 10⁶ 바이트 MB 로는 약 521–525 MB)뿐이고 최종 측정 스크립트(k6 없음) 527.2 MiB · 중간 경합 577–611 MiB. 아레나 낭비(약 160 MiB)는 없앴고 남은 차이는 힙 커밋 증가(§1.1) — 힙 상한 조정은 경합 없는 측정이 필요해 다음 후보(§6) |
| NFR-04 | 첫 화면 JS ≤ 400 KB(gzip) · LCP ≤ 2.5 s(5회 중앙값) · 지도 조작 ≥ 30 fps(3,000대) | JS 497.7 KiB · LCP 중앙값 2.39 s(headless SwiftShader) · fps 측정 불가(실제 GPU 필요) | **JS 미충족**(사용자 결정) · LCP 충족(조건부) · fps 측정 안 함 |
| NFR-05 | 10,000대 × SIGMET 200 교차 판정 ≤ 50 ms(JMH) | JMH 미실행. 참고: 운영 엔진 주기 전체(스냅샷 갱신 + 판정 + 10분 예측 + FSM, 전세계 약 7,600대 · SIGMET 130) p50 39 ms · p95 159 ms · 최대 171 ms(176주기, 교차 판정만의 시간이 아님) | **측정 안 함**(마이크로벤치) |
| NFR-06 | 공급자별 무료 한도 대비 ≤ 50 %(OpenSky 는 계정 크레딧 72 % 예외) | 09-27(UTC, 하루): OpenSky 1,668 크레딧 = 계정 4,000 의 42 % · 우리 예산 대비 adsb.lol 1,509/10,000 · adsb.fi 3,559/40,000 · AWC 489/2,000 · RainViewer 897/2,000 · 기상청 444/1,000 · adsbdb 8(09-28, 새 기능) | OpenSky **충족**(09-27 하루 관측 — 설계서 측정 방법인 7일 관측은 아직 안 함). 나머지는 공급자 공개 한도를 이 저장소에서 확인하지 못해 **판정 못 함**(우리 예산 대비만) |
| NFR-07 | 공급자 1곳 장애 시 지속, 전부 장애 시 stale 표시로 지속 | 시험(공급자 전환·5xx·429 주입) 통과. 장애 주입(09-27, PERF §4) 이후 다시 돌리지 않음 | **충족**(시험) |
| NFR-08 | api·collector 강제 종료 뒤 60 s 안 복귀, 스트림 유실 0 | 09-27 장애 주입: api 6.2 s · collector 3.4 s · PEL 재처리 · 중복 0. 이번 변경 뒤 장애 주입은 다시 하지 않음 — 대신 보존 창 밖 손실을 감지·기록(R-14 `StreamTrimLossIT`) | **충족**(09-27 측정) · 재측정 안 함 |
| NFR-09 | 원해상도 72 h · 요약 30일 · DB ≤ 10 GB | DB 2,038 MB(09-28 15:11 UTC). 원해상도는 하루 단위 파티션으로 지운다 — 파티션 끝(다음 날 00:00 UTC)이 now − 72 h 를 지나면 매시 작업이 1시간 안에 지우므로 가장 오래된 행은 최대 약 97 h(V9 주석). R-06 시험은 오늘−4일 파티션 삭제 · 오늘−3일 유지를 확인 | DB 크기 **충족**(현재) · 정상 상태 미관측 |
| NFR-10 | gitleaks·Trivy·npm/pip audit High 0 · 위조 XFF 3경로 차단 | 자체 이미지 CRITICAL/HIGH(수정판 있는 것) 0 — collector 는 수정판 없는 HIGH 44 남음 · edge·redis 이미지 PASS · **db 이미지(imresamu/postgis) 는 고칠 수 있는 고유 CVE CRITICAL 9 · HIGH 76(보고만)** · npm/pip 0 · gitleaks 0 · 위조 XFF·X-Request-Id 덮어쓰기(edge 시험) · CodeQL 은 로컬에서 돌리지 않음 | 자체 이미지 **조건부 충족** — 수정판 있는 HIGH/CRITICAL 0(CI 게이트 `ignore-unfixed` 기준 통과), collector 에 수정판 없는 HIGH 44 가 남아 'High 0' 문자 그대로는 아님 · db 이미지 **미충족**(교체는 사용자 결정 R-63) · CodeQL 측정 안 함 |
| NFR-11 | 운영 API 세션+CSRF+역할, 비인가 404 | SecurityIT(익명 404 · CSRF 403 · 절대 수명 · 비밀번호 교체 뒤 세션 종료 · 인코딩한 경로 우회 차단 R-98) | **충족** |

## 3. 1차 수정(레인) — 항목별 검증

3단계 1차 수정 90커밋(6개 레인, 레인별 작업 트리에서 만든 뒤 main 으로 옮김 — 커밋은 main 의 SHA). 각 항목은 레인 구현자의 보고를 옮겼고, 검토자가 다시 확인해 문제를 찾은 것은 §4 에서 다시 고쳤다.

### R-01 · web-core — 외부 배경지도 스타일이 막히면 WS 가 열리지 않아 상황판이 'WS CONNECTING / NO DATA' 에 멈춘다

- **증상** `tiles.openfreemap.org` 가 막히거나 실패하면 상황판이 WebSocket 을 열지 않고 'WS CONNECTING / NO DATA / 알림 목록 수신 대기' 에 머문다. 정상일 때도 첫 데이터가 외부 style·TileJSON·sprite 를 기다린다.
- **재현 방법** `MapView` 를 마운트하고 지도 'load' 이벤트를 끝까지 내지 않는다(스타일이 오지 않는 상황). 수정 전에는 `client.connect()`, 워커 시작, 구독, `/radar/kr`·`/airports` 폴링이 한 번도 호출되지 않는다. 스타일 단계의 'error' 를 내도 아무 효과가 없다. 미뤄 둔 그리기가 `map.once('load')` 리스너로 쌓인다(SIGMET 갱신 20번 뒤 27개).
- **원인** `MapView.tsx` 가 `worker.postMessage({type:'start'})`, `client.connect()`, `subscribeViewport()`, `pollKr`, `pollAirports` 를 `map.on('load')` 안에서만 불렀다. MapLibre 는 외부 스타일이 로드된 뒤에야 'load' 를 낸다. 지도 'error' 처리기가 없었다.
- **수정** 데이터는 이제 effect 본문에서 시작한다: 워커 시작, 연결, 뷰포트 구독(`map.getBounds` 는 생성 직후부터 동작), 두 폴링과 그 타이머. 그리기만 'load' 를 기다린다: `applyRender` 와 `applyAirports` 는 load 처리기에서 부른다. 'style.load' 전에 도착한 sourceId 없는 지도 'error' 는 스타일 실패로 본다. 이때 `FALLBACK_STYLE`(`lib/maplayers.ts`)로 바꾼다. 이 스타일은 background 레이어 하나만 있고 source·sprite·glyph URL 이 없으며 앱 배경색을 쓰는 로컬 스타일이라 육지·바다를 칠하지 않는다. 그다음 배너 '배경지도를 불러오지 못함 — 항공기·기상 데이터는 계속 수신·표시합니다(새로고침하면 다시 시도)' 를 띄운다. 이 모드에서는 `applyBasemap` 과 배경지도 출처 표기를 건너뛰고, 오류는 계속 콘솔에 남긴다. `onReady()` 는 이제 키마다 가장 최근의 미뤄 둔 그리기 하나만 남기므로, 'load' 전에 도착한 데이터가 리스너를 쌓지 못한다.
- **회귀 테스트** `tests/mapview-lifecycle.test.ts`: `react-dom/client` 로 최소 DOM(`tests/helpers/mini-dom.ts`) 위에 `MapView` 를 마운트하고 MapLibre 대역(`tests/helpers/fake-maplibre.ts`)을 쓰는 새 하네스다. 수정 전 결과는 3 실패 / 2 통과였다: `expected [ …(3) ] to include 'connect'`, `expected [] to have a length of 1`(대체 스타일 `setStyle` 없음), `expected 27 to be less than or equal to 8`(load 리스너 누적). 수정 후 모두 통과한다. 대체 스타일은 `validateStyleMin` 으로도 검사한다. style.load 뒤의 타일·sprite 오류는 스타일을 바꾸지 않는다. `tests/basemap.test.ts` 의 소스 정규식 검사는 새 style.load 처리기에 맞게 고쳤다. 외부 호스트를 모두 해석할 수 없게 한 상태에서 `next start` 를 headless Chromium 으로도 확인했다: 배너가 보이고 canvas 가 그려졌다.
- **커밋** `f9fbe27`

### R-02 · web-core — 상황판 '/' 첫 로드 JS 가 약 612 KiB(gzip)로 NFR-04 400 KB 를 넘고 MapLibre 공용 코드를 두 번 받는다

- **증상** '/' 의 첫 로드 JS 가 gzip 약 612 KiB 로 NFR-04 한도 400 KB 를 넘는다. MapLibre 공용 코드(gzip 145 KiB)를 두 번 내려받는다.
- **재현 방법** `next build` 를 실행하고 '/' 의 첫 로드 청크를 합한다. 기준선 `ba31766` 에서 gzip 610.6 KiB 다: `2v5dqe5g89ze4.js` 가 278.2 KiB(shared 가 안에 묶인 `maplibre-gl.mjs`)이고 `public/maplibre/maplibre-gl-shared.mjs` 가 또 147.2 KiB 다. 실패하는 테스트(`tests/maplibre-load.test.ts`, 새 모듈을 스텁으로 둠)는 다음을 보고했다: `'components/MapView.tsx: import * as maplibregl from "maplibre-gl"'`(런타임 import), 버전을 넣은 public 경로 없음, `page.tsx` 가 `loadMaplibre()` 를 기다리지 않음.
- **원인** MapLibre GL 6 은 `maplibre-gl.mjs` 와 `maplibre-gl-worker.mjs` 를 배포하고, 둘 다 `./maplibre-gl-shared.mjs` 를 import 한다. `MapView` 의 정적 import 때문에 Turbopack 이 main 과 shared 를 한 청크로 묶었다. 워커는 `public/` 으로 복사되고(Turbopack 은 MapLibre 의 모듈 워커를 묶지 못함) public 의 shared 파일을 한 번 더 import 하므로 코드가 공유되지 않는다. `/maplibre/*` 는 `max-age=0` 으로 제공되기도 했다.
- **수정** 새 `lib/maplibre.ts`: `loadMaplibre()` 가 `import(/* webpackIgnore */ '/maplibre/6.11.2/maplibre-gl.mjs')` 를 실행하고 `setWorkerUrl` 을 부른다. `maplibre()` 는 로드된 모듈을 돌려준다. `app/page.tsx` 는 `MapView` 청크와 `loadMaplibre()` 를 모두 기다린다. `MapView` 와 `lib/*` 는 `maplibre-gl` 을 타입으로만 import 한다. `scripts/copy-maplibre-worker.mjs` 는 main·worker·shared 를 `public/maplibre/<version>/` 에 복사하고 옛 버전 폴더를 지운다. `next.config.ts` 의 `headers()` 가 `/maplibre/:version/:file*` 를 `'public, max-age=31536000, immutable'` 로 제공한다. `MAPLIBRE_WORKER_URL`(maplayers 가 다시 export 하고 `ReplayMap` 도 씀)은 이제 버전 폴더를 가리킨다. '/' 결과: gzip 610.6 → 489.6 KiB, gzip -1(nginx 기본값) 기준 722.3 → 579.0 KiB. headless Chromium 에서 워커의 shared import 는 HTTP 캐시 적중이다(transferSize 0).
- **회귀 테스트** `tests/maplibre-load.test.ts` 가 세 가지를 검사한다: 상황판 모듈에 `maplibre-gl` 런타임 import 가 없음, `MAPLIBRE_VERSION` 이 설치된 `maplibre-gl` 버전과 같음, `page.tsx` 가 `loadMaplibre()` 를 기다림. 수정 전: 스위트 import 오류 `Cannot find package @/lib/maplibre`, 모듈을 스텁으로 두면 재현 방법에 적은 단언 실패 3/3. 수정 후 모두 통과한다. `tests/mapview-lifecycle.test.ts` 는 이제 `@/lib/maplibre` 를 mock 한다.
- **커밋** `d3a4cc8`

### R-03 · collector — KMA 레이더: 목록에 있으나 아직 받을 수 없는 프레임을 영구 제외해 애니메이션 프레임이 빠진다

- **증상** 한국 레이더 애니메이션에 프레임이 빠졌다(09-28 KST 기준 182개 중 14개). 목록에는 있지만 'file not exist' 를 받은 tm 은 영구히 `_bad` 로 들어갔다. 저장된 최신 프레임보다 오래된 프레임은 선택되지 않았다. 23:55 KST 프레임은 날짜 경계에서 빠졌다.
- **재현 방법** `tests/test_kma_radar.py`: 가짜 공급자가 목록에 있는 tm 에 한 번 'not gzip: # file not exist' 로 답하고, 다음 주기에 그 프레임을 준다. 이와 별도로, 구멍이 있는 저장 창, 그리고 23:55 프레임이 전날 목록에만 있는 00:02 KST 시계를 쓴다.
- **원인** `jobs/kma_radar.py` 가 ValueError(gzip 이 아닌 본문, 예: file not exist)를 해석 실패처럼 처리했다(`_mark_bad`). `select_candidates` 는 tm > max(저장분)만 고른 뒤 `[-4:]` 로 잘랐다. 그날 KST 목록만 조회했다.
- **수정** gzip 이 아닌 본문의 ValueError 는 이제 일시 오류로 본다. 그 tm 은 이후 주기에 `MAX_NOT_READY_TRIES=3` 번까지 재시도하고, 그 뒤에는 품질 규칙 `kma_radar_missing` 으로 기록하고 건너뛴다. `_BadFrame` 과 `ResponseTooLarge` 만 여전히 곧바로 `_bad` 로 간다. 후보는 저장 창(목록에 오른 tm 중 now 이하인 최신 12개) 안에서 아직 저장하지 않은 tm 이며, 최신 4개를 먼저 고르므로 구멍이 채워진다. KST 00:00–00:14 에는 전날 목록을 합친다(예산 호출 1회 추가). 정상 상태 테스트는 이제 기동 직후 첫 몇 주기가 저장 창을 채운 뒤 주기당 1프레임으로 안정되는 것을 허용한다.
- **회귀 테스트** `tests/test_kma_radar.py`: `test_r03_frame_not_yet_available_is_retried_next_cycle`, `test_r03_missing_frame_gives_up_after_bounded_tries`, `test_r03_candidates_backfill_holes_inside_storage_window`, `test_r03_just_after_kst_midnight_previous_day_listing_is_consulted`. 4개 모두 수정 전 실패했다: `assert '202609271955' not in {'202609271955': None}`(tm 이 `_bad` 에 들어감), `MAX_NOT_READY_TRIES` 없음, `assert [] == ['202609271930']`(구멍을 고르지 않음), `assert '20260927' in ['20260928']`(전날을 조회하지 않음). 수정 후 모두 통과한다.
- **커밋** `a5a8b23`

### R-04 · web-core — 선택 항공기 항적이 수신 공백(최대 950 s·288 km)을 고도색 실선으로 이어 관측한 경로처럼 그린다

- **증상** 선택한 항공기의 항적이 수신 공백(최대 950 s / 288 km)을 고도색 실선으로 이어, 그 경로를 관측한 것처럼 보인다.
- **재현 방법** 10 s 간격 점에 950 s 공백 하나(05:48:37Z → 06:04:27Z)를 넣고 `trackFeatureCollection()` 을 부르면 모든 쌍이 공백 표시 없는 일반 선분으로 나온다. 수정 전 `tests/track-gaps.test.ts` 는 4/4 실패했다: `TRACK_GAP_MS` undefined, kind 가 `['track','track','gap','track']` 이 아니라 `[undefined, …]`, `kind:'track'` 없음, tracks source 에 `'track-line'` 레이어만 있음.
- **원인** `lib/track.ts` 의 `trackFeatureCollection` 이 시간 간격과 관계없이 연속한 모든 쌍으로 LineString 을 만들었다. `track-line` 은 이를 모두 끝점 고도색 실선으로 그렸다.
- **수정** `TRACK_GAP_MS = STALE_AFTER_S*1000`(60 s). 상황판에 이미 있는 stale 규칙이다. 항적 점에는 공급자 정보가 없으므로 `thresholds()` 규칙에 따라, 모르는 공급자는 더 짧은 지역 임계값을 받는다. 이보다 멀리 떨어진 쌍은 `kind:'gap'` feature 가 되고 '수신 없음 hh:mm–hh:mm' 라벨이 붙는다(UTC, 선박 항적 공백과 같은 형식). 관측한 쌍은 `alt_ft` 를 가진 `kind:'track'` 이다. maplayers 는 `track-line` 에 filter 를 더하고 새 레이어 두 개, `track-gap`(회색 점선 `#8a929d`)과 `track-gap-label` 을 선박 공백과 같은 스타일로 추가한다. '항적' 레이어 토글이 이제 세 레이어를 모두 제어한다.
- **회귀 테스트** `tests/track-gaps.test.ts`: 임계값이 stale 규칙과 같음, 950 s 공백이 라벨 '수신 없음 05:48–06:04' 를 가진 gap feature 가 됨, 정확히 60 s 는 이어진 채로 남음, 새 레이어에 filter 가 있고 style spec 을 통과함. 수정 전 4/4 실패, 수정 후 통과.
- **커밋** `376aa27`

### R-05 · web-ui — 재생 지도를 줌 약 3.7 이하로 축소하면 422 BBOX_TOO_LARGE 가 나고 이전 프레임이 새 시각 라벨 아래 남는다

- **증상** 재생 지도를 약 z3.7 이하로 축소하면 422 `BBOX_TOO_LARGE` 가 났다. 그 뒤 이전 프레임이 새 시각 라벨 아래 지도에 남았고, 사용자는 서버의 영문 detail 원문을 봤다.
- **재현 방법** 이전 `ReplayMap` 은 `subscriptionBbox(..., Infinity, centre)` 를 그대로 보냈다. 리뷰 화면의 `90,10,170,60` 은 4000 sq° 로 서버 상한 2500 을 넘는다. 페이지의 catch 는 `setErr` 만 불러 프레임이 남았다.
- **원인** 요청 bbox 에 면적 제한이 없었다(minZoom 2). 오류 경로가 이전 프레임을 유지하고 `e.message` 를 그대로 출력했다.
- **수정** `lib/replay.ts`: `replayQueryBbox` 가 화면 비율을 유지하고 화면 안에 머물면서, 지도 중심 기준으로 뷰를 2500 sq° 이하로 줄인다. `fmtReplayBbox` 는 안쪽으로 반올림해 반올림 때문에 면적이 상한을 넘지 않게 한다. `replayReduce` 는 실패 시 프레임을 비운다. `replayErrorText` 는 한국어 문구를 준다(422 는 확대하라는 안내). `replayFrameAtLabel` 은 프레임 자체의 at 을 보인다. `ReplayMap` 은 잘라 낸 bbox 를 보내고, 잘렸을 때 조회한 상자를 점선으로 그리며, frame 이 null 이면 source 를 비운다. 재생 페이지는 'map <frame time>' 을 보이고, 프레임이 라벨보다 뒤처지면 경고를, 상자가 잘렸으면 안내를 함께 보인다.
- **회귀 테스트** `tests/review-v1-ui.test.ts` `R-05 replay request area and stale frame`(테스트 3개). 수정 전 `TypeError: replayQueryBbox is not a function` 과 `replayReduce is not a function` 으로 실패했다. 이전 경로의 bbox 면적이 4000 이라는 것도 단언한다.
- **커밋** `279e7de`

### R-06 · api-data — 보존 삭제가 72 h 가 아니라 99-123 h 를 남기고, alert_event 는 보존 기한 없이 하루 약 50 MB 씩 늘어난다

- **증상** 항적·선박 위치 파티션이 72 h 가 아니라 99-123 h 동안 남았다. `alert_event` 는 보존 기한 없이 하루 약 50 MB 씩 늘어 NFR-09(DB <= 10 GB)를 위태롭게 했다.
- **재현 방법** `RetentionDbTest`: migrator 로 today-4 의 `track_point`/`ship_position` 파티션을 만들고 `track_point_drop_old(72)` 를 부른다. 이전 코드는 0개를 지웠다. `left_at` 이 31일·40일 전인 닫힌 알림을 넣고 `dropOldPartitions` 를 실행한다: 이전 코드는 아무것도 지우지 않았다.
- **원인** V2/V5 drop 함수가 `cutoff = (now-retention)::date - 1` 을 쓰고 날짜가 cutoff 보다 작은 파티션만 지워 하루를 더 남겼다. drop 은 하루 한 번 03:00 에 돌았다. 알림은 ADR-007 에 따라 영구 보존이었다.
- **수정** V9 가 두 drop 함수를 바꾼다: 파티션의 상한(d+1 00:00 UTC)이 now - retention 이하이면 지운다. 소유자, SECURITY DEFINER, search_path, 인자 범위는 그대로다. `MaintenanceJobs.dropExpiredPartitions` 는 매시 :02 UTC 에 돈다. 일일 보존 작업은 `wakeline.alert-retention-days`(기본 30, 0 이면 끔, env `WAKELINE_ALERT_RETENTION_DAYS`)보다 오래된 닫힌 `alert_event` 행도 5,000개씩 나눠 지운다. 열린 알림은 남긴다. 보존 삭제가 이미 그날에 이르렀으면 재집계는 그날의 알림 통계를 그대로 두므로, 영구 통계가 빈 값으로 다시 집계되지 않는다. 롤백 SQL 은 V9 머리글에 있다.
- **회귀 테스트** `persist/RetentionDbTest`(테스트 4개)와 `MigrationDbTest.v9RollbackSqlInTheHeaderRestoresV8AndV9ReappliesCleanly`(머리글의 롤백 SQL 을 실행한 뒤 V9 를 다시 적용). 수정 전 실패: `partitionsAreDropped...`(`expected >= 1 but was 0`), `closedAlertsOlderThan30DaysAreDeleted...`([1,2,3,4,5] 가 나옴, 기대 [3,4,5]), `reaggregatingADayOutsideTheAlertRetentionKeepsItsAlertStats`([] 가 나옴, 기대는 알림 행 2개), 매시 작업 테스트(메서드가 없었음).
- **커밋** `4c2587f`

### R-07 · infra — CI 보안 게이트가 한 번도 실행되지 않았고, 실행되면 gitleaks 오탐 2건 때문에 trivy 게이트를 모두 건너뛴다

- **증상** CI 보안 게이트가 한 번도 실행되지 않았다(저장소에 remote 가 없음). 실행되면 gitleaks 가 합성 테스트 값 2개에서 실패한다. 그러면 build 단계를 건너뛰고, 이 때문에 trivy 게이트 3개도 모두 건너뛴다. 현재 이미지로는 어차피 게이트가 실패한다: api CRITICAL 3, web HIGH 4, collector HIGH 2, edge HIGH 1.
- **재현 방법** 새 clone 에서 gitleaks v8.30.1(`--network none`)을 돌리면 누출 2건, exit 3 이다: `5251859…:apps/collector/tests/test_ais_server.py:generic-api-key:35`, `94ae84e…:apps/collector/tests/test_masking.py:jwt:12`. 둘 다 가짜 값이다. `ci.yml` 의 `build` 단계에는 `if:` 가 없고, trivy 단계는 `steps.build.outcome == 'success'` 를 요구한다. edge `4714e0b1…` 에 오프라인 trivy 를 돌리면 libexpat CVE-2026-93990 HIGH(2.8.4-r0 -> 2.8.5-r0)가 나온다.
- **원인** gitleaks 허용 목록이 없었다. build 단계가 암묵적 `success()` 조건을 썼다. edge digest 가 오래됐다. web·collector 이미지에 쓰지 않는 패키지 관리자가 남아 있었다(R-29 에서 수정). api 의 Tomcat 11.0.24 는 R-37(api 레인) 몫이다.
- **수정**
  - `.gitleaksignore` 에 정확한 fingerprint 2개만 적는다(정규식·경로 허용 목록 없음, `.gitleaks.toml` 없음).
  - `ci.yml` 의 build 단계는 이제 `if: ${{ !cancelled() }}` 로 실행된다. 자체 이미지 trivy 게이트는 계속 차단형이다(HIGH,CRITICAL, ignore-unfixed, exit-code 1).
  - edge 를 `nginx-unprivileged 1.30-alpine@sha256:ed04ec1f…`(nginx 1.30.5, libexpat 2.8.5)로 옮긴다.
  - 새 `make security`(`tools/security_gate.sh`, `tools/scan_lib.sh`)가 같은 게이트를 로컬에서 돌린다. 이미지별 차단 여부는 `ci.yml` matrix 에서 읽는다. 스캐너는 digest 로 고정하고 docker.sock 을 주지 않으며 `--network none` 으로 실행한다. `SECURITY_OWN_IMAGES` 로 다른 태그도 스캔할 수 있다.
- **회귀 테스트** `infra/tests/test_ci_policy.py` 에 테스트 3개 추가: `test_image_build_runs_even_if_gitleaks_fails`, `test_gitleaks_allowlist_is_exact_fingerprints_only`, `test_local_security_gate_uses_ci_matrix`.
  - 수정 전: 기준 코드에서 돌리면 3개 모두 실패했다(`FAILED (failures=3)`: `.gitleaksignore` 없음, build `if` 정규식을 찾지 못함, `security` 타깃 없음).
  - 현재: 통과한다. 변경 뒤 gitleaks: 누출 없음, exit 0.
  - 다시 빌드한 이미지에 `make security`: api(Tomcat, R-37)를 빼고 모든 게이트 통과. 새 edge digest 에서 `edge_test.sh` 28/28 통과.
- **커밋** `ad7420a` · `43b826e`

### R-08 · web-ui — 알림 행을 클릭하면 펼침이 곧바로 사라지고, 화면 밖 항공기로 지도가 이동하지 않는다

- **증상** 알림 행을 클릭하면 펼치기와 항공기 선택이 한 동작으로 일어났다. 선택이 패널을 바꾸면서 `AlertPanel` 이 언마운트돼 펼침 상태와 스크롤 위치를 잃었다. 화면 밖에 있는 항공기로 지도가 이동하지 않았다. 선박 목록과 SIGMET hex 칩도 같았다.
- **재현 방법** 이전 `app/page.tsx` 는 `panel === 'alerts'` 일 때만 `AlertPanel` 을 렌더했다. 행의 onClick 이 `setOpen` 과 `select(hex)` 를 불렀다. `AircraftSearch` 밖에는 `requestFlyTo` 가 없었다.
- **원인** 한 버튼에 두 동작, 목록의 조건부 마운트, 위치로 이동하는 도우미 없음.
- **수정** 행 버튼은 이제 근거 펼치기만 토글한다. `aria-expanded` 와 `aria-controls` 는 보이는 내용과 맞다. 펼친 영역의 별도 'open aircraft card' 버튼이 항공기를 선택한다. 측면 패널은 `components/SidePanel.tsx` 로 옮겼고, 다른 탭을 보이는 동안 `AlertPanel` 은 마운트된 채 숨는다. `lib/focus.ts` 의 `panIfOutside` 는 알려진 위치(실시간 사본, 없으면 알림 `evidence.position`)가 뷰포트 밖일 때만 현재 줌으로 flyTo 를 요청한다. 알림 목록, 선박 목록, SIGMET 칩이 이를 쓴다. e2e 상황판 spec 을 고쳤다.
- **회귀 테스트** `tests/review-v1-ui.test.ts` `R-08 alert row: expand stays, selection moves the map`(테스트 3개). 수정 전 실패: `SidePanelView` 와 `lib/focus` 가 없었다. 스텁 모듈을 두면 이동·위치 단언이 실패했고, 이전 Dashboard 는 alert-panel 을 렌더하지 않았다. 이전 정적 렌더는 panel=alerts 일 때만 `AlertPanel` 을 보였다.
- **커밋** `c355105`

### R-09 · web-core — 첫 로드 때 모르는 알림 수를 0으로 보이고, '관심 지역' 범위에 전세계 목록이 잠깐 떴다가 줄어들며 CLS 를 만든다

- **증상** 첫 로드 때 알림이 하나도 오기 전에 패널이 '전세계 0 · 0 inside · 0 predicted' 를 보인다. '관심 지역' 에서는 전세계 목록(308 inside)이 뜬 뒤 status 가 오면 약 10개로 줄어 CLS 가 생긴다. 정상적인 첫 연결 중에도 'WS connecting' 이 오류 색을 쓴다.
- **재현 방법** conn open, `alertsVersion` null 로 `AlertPanel` 을 SSR 렌더한다. 이어서 알림은 있고 status 는 null 인 경우를 렌더하고, `lastEvent` 가 있을 때와 없을 때의 배너 자리를 비교한 뒤, conn connecting, `reconnectAttempt` 0 으로 `StatusBar` 를 렌더한다. 수정 전 `tests/alert-panel.test.ts` 는 4/4 실패했다: `expected …전세계 00 inside… to contain 전세계 —`, 관심 지역 범위에 전세계 alert-item 이 보임, role=status 자리에 고정 높이 없음, conn 배지가 'warn' 이 아니라 'bad'.
- **원인** `AlertPanel` 이 `alertsVersion` 이 null 일 때도 `all.length` 와 관측 수를 렌더했다. `inRegion()` 은 `status.region` 이 없으면 true 를 돌려줬다(전세계 목록을 지역 목록으로 씀). 배너 컨테이너 높이가 내용에 따라 달라졌다. `StatusBar` 는 open·paused 를 뺀 모든 상태를 'bad' 로 매핑했다.
- **수정** 첫 alerts 메시지 전까지 수는 '—' 로 보인다. 관심 지역 범위는 status 가 올 때까지 '관심 지역 설정(중심·반경) 수신 대기' 안내를 보인다: 목록은 비어 있고 수는 '—' 이며, '없습니다' 라고 하지 않는다. 중심이나 반경이 없는 status 를 받으면 이전처럼 모든 알림을 뜻한다. 배너 자리는 고정 높이(`h-[26px]`)이고 배너는 잘린다. 새 `lib/ws-protocol.ts` 의 `connTone()`: 재시도 없는 첫 연결·paused·silent 는 warn, closed·재시도 중은 bad. `web-fixes.test.ts` 의 기존 SSR 테스트는 이제 `status.region` 을 넘긴다.
- **회귀 테스트** `tests/alert-panel.test.ts` `alert panel first load (R-09)`(테스트 3개)와 `status bar connection badge (R-09)`. HEAD~ 의 `AlertPanel`·`StatusBar` 를 잠시 되돌려 수정 전 실패를 확인했다: 4개 실패, 단언 메시지는 재현 방법에 적은 것과 같다. 수정 후 모두 통과한다.
- **커밋** `9f22c8a`

### R-10 · web-ui — 재생 시각을 147 px 슬라이더로만 고를 수 있고, 30일 1분 요약 구간에는 갈 수 없다

- **증상** 재생 시각은 147 px 슬라이더(1 px 당 약 29분)로만 고를 수 있었다. 범위가 72 h 로 고정돼 약속한 30일 1분 요약 구간에 갈 수 없었다.
- **재현 방법** 이전 페이지는 `range.min` 을 now-72h 로 두었고, 입력은 `type=range` 하나뿐이었다.
- **원인** 72 h 로 하드코딩한 범위, 정밀 입력 없음.
- **수정** `replayRange` 는 30일 전까지를 준다(요약 보존 기간, api 는 31일까지 받음). 'UTC' 라벨이 보이는 UTC `datetime-local` 입력(후속 커밋 `da9a608`), 범위 안으로 제한되는 -1h/-10m/-1m/+1m/+10m/+1h 이동 버튼, 72 h 경계에 datalist 눈금이 있는 가변 슬라이더, 구간(zone) 라벨, 줄바꿈되는 도구 막대를 더했다. `fromUtcInput` 은 존재하지 않는 날짜를 거부한다.
- **회귀 테스트** `tests/review-v1-ui.test.ts` `R-10 ...`(테스트 4개). 수정 전 실패: `ReplayPage` 정적 렌더에 `datetime-local` 입력과 이동 버튼 묶음이 없었고, `replayRange` 가 함수가 아니었으며, UTC 가 보이는지 확인하는 테스트는 `da9a608` 이전의 커밋된 R-10 코드(`00fa274`)에서 실패했다.
- **커밋** `00fa274` · `da9a608`

### R-11 · web-core — 기상청 레이더가 unavailable 로 바뀌어도 마지막 KMA 에코가 지도에 남고, 레이더를 끄거나 소스를 바꿔도 숨겨지지 않는다

- **증상** KMA 레이더가 unavailable 이 된 뒤(frames 목록이 비어 있음, 예: 수집이 3 h 넘게 멈춤) 마지막 KMA 에코가 지도에 남는다. 레이더를 끄거나 RainViewer 로 바꿔도 숨겨지지 않는다.
- **재현 방법** `MapView` 를 마운트하고 load 를 낸 뒤 `radarSource` 를 'kma' 로, `radarKr` 를 프레임 2개가 있는 available 로 둔다(`kmar-202609281200` 레이어가 그려짐). 그다음 `radarKr` 를 프레임 없는 `available:false` 로 둔다. 수정 전에는 레이어가 남아 있었다: `expected [ kmar-202609281200 ] to deeply equal []`.
- **원인** `MapView` 의 KMA effect 가 `!available` 이거나 좌표가 없으면 `syncFrames` 전에 일찍 반환해, 이미 추가된 레이어를 숨기거나 지우지 않았다. 토글과 소스 전환은 레이더가 available 일 때만 `syncFrames` 에 닿는다.
- **수정** 레이더가 unavailable 이면 effect 가 `onReady(map,'kma', …)` 로 빈 프레임 목록에 맞춘다: 모든 `kmar-*` 레이어와 source 를 지우고 `krCoordsKey` 를 초기화한다. 레이더가 다시 available 이 되면 처음부터 그린다. 타임라인은 이미 '0 frames' 와, 서버 안내가 붙은 비활성 KMA 버튼을 보인다.
- **회귀 테스트** `tests/mapview-lifecycle.test.ts` `MapView KMA radar layers (R-11)`: unavailable 이면 제거, 다시 available 이면 다시 그림, 그린 것이 없으면 아무것도 하지 않음. 수정 전 실패(위 단언), 수정 후 통과.
- **커밋** `5827ebe`

### R-12 · web-ui — 운영 화면: 세션이 만료돼도 이전 표를 계속 보이고, 로그아웃은 처리되지 않은 거부를 던진다

- **증상** 운영 세션이 만료된 뒤에도 운영 대시보드가 'no such resource' 와 함께 오래된 표를 계속 보였다. 로그아웃은 처리되지 않은 거부(unhandled rejection)를 던지고 아무것도 하지 않았다.
- **재현 방법** 이전 refresh 는 401/404 에서 `setErr` 만 불렀다. 이전 logout 은 try 없이 `await apiSend('DELETE', ...); onLogout()` 이었다.
- **원인** 만료 처리 경로가 없고, logout 이 `onLogout` 호출을 보장하지 않았다.
- **수정** `lib/ops.ts` 의 `classifyOpsError`: 운영 호출의 401/404 는 `GET /ops/session` 도 401/404 를 줄 때만 만료로 본다. 세션이 살아 있거나 네트워크가 실패하면 오류로 보고한다. `signOut` 은 finally 에서 항상 `done` 을 부르고, 서버 세션이 남아 있을 수 있으면 이를 알린다. 운영 페이지는 'session expired' 안내와 함께 로그인 폼으로 돌아가고(dashboard 는 언마운트), 마지막으로 성공한 새로고침 시각을 보이며, 오류에는 `role=alert` 가 붙는다.
- **회귀 테스트** `tests/review-v1-ui.test.ts` `R-12 ...`(테스트 2개). 수정 전 실패: `classifyOpsError is not a function`, `signOut is not a function`. signOut 테스트는 이전 실패를 그대로 담는다: send 가 reject 해도 `done` 은 불려야 한다.
- **커밋** `df5e02a`

### R-13 · infra — PostgreSQL 백업·복원 절차가 없어 '영구' 데이터가 볼륨 하나에만 있다

- **증상** PostgreSQL 백업·복원 절차가 없었다. '영구' 데이터(SIGMET, 알림, 통계, 감사 로그, 운영자, 설정)가 `wakeline_db_data` 볼륨에만 있다.
- **재현 방법** `git grep -i 'pg_dump|pg_restore'` 결과가 없고, Makefile 타깃도 없다.
- **원인** 구현한 적이 없다.
- **수정**
  - `tools/db-backup.sh`(`make backup`, `full=1`): db 컨테이너 안에서 로컬 소켓으로 `pg_dump --format=custom` 을 실행하므로 비밀번호를 쓰지 않는다. `umask 077`(디렉터리 0700, 파일 0600)로 `backups/<project>-<UTC>.dump` 를 쓴다. 임시 이름으로 쓰고 `pg_restore --list` 로 확인한 뒤 이름을 바꾼다. 기본값에서는 72 h 파티션 `track_point_YYYYMMDD` 와 `ship_position_YYYYMMDD` 의 행을 빼고 구조는 남긴다.
  - `tools/db-restore.sh`(`make restore f=… confirm=<project>`)는 다음 조건을 모두 만족하지 않으면 거부한다:
    - confirm 단어가 대상 이름과 같다;
    - api, collector, ais, migrate 가 멈춰 있다;
    - 대상 DB 에 확장이 아닌 relation 이 없다;
    - 파일이 올바른 아카이브다.

    `--single-transaction --exit-on-error` 로 복원한 뒤 ANALYZE 를 실행한다.
  - `backups/` 를 `.gitignore` 에 추가했다. README 에 백업·복원 절차가 있다.
- **회귀 테스트** `infra/tests/db_backup_test.sh`(`make infra-docker-test` 에 추가해 CI infra 작업에서 실행)와 `test_scripts_policy.BackupRestoreTest`.
  - 수정 전: 컨테이너 테스트가 `백업 종료 코드 0 → tools/db-backup.sh: No such file or directory` 에서 실패했고, 정책 테스트는 3개 실패했다.
  - 현재: 41/41 통과. 다루는 범위: 파일·디렉터리 권한, 기본값에서 72 h 행 제외와 `FULL=1` 에서 포함, 모든 거부 경로에서 DB 불변(틀리거나 없는 confirm, 비어 있지 않은 DB, api 실행 중, 깨진 파일), 새 볼륨으로 복원. 복원 뒤 행 수, 소유자, 권한별 ACL, 기본 권한, 서비스 계정 로그인이 모두 원본과 같다.
- **커밋** `a85f227`

### R-14 · collector · api-data — 스트림 MAXLEN ~200 창보다 api 가 오래 멈추면 항적·선박 위치가 읽히기 전에 잘려 사라진다

#### collector

- **증상** 항공기·선박 스트림을 `MAXLEN ~200` 으로 잘랐다(항공기 약 35분, 선박 33분). 이보다 긴 api 중단 동안 항적 점과 선박 위치가 읽히기 전에 사라졌다.
- **재현 방법** `tests/test_publisher.py` 와 `tests/test_ais_sink.py` 에서, MAXLEN/MINID 를 적용하고 시계 기반 ID 를 쓰는 `FakeRedis` 로 2 h 중단을 흉내 내고(region 10 s 마다, global 120 s 마다, 선박은 10 s 마다 flush) 남은 항목 수를 센다.
- **원인** `publisher._xadd` 와 `ais/sink.py` 가 모든 스트림에 고정 `MAXLEN=200` 을 썼다.
- **수정** 항공기·선박 스트림은 이제 `XADD MINID ~ (now - STREAM_RETENTION_S = 2.5 h)` 를 쓴다: 2 h 중단에 재시작·따라잡기 30분을 더한 값이다. 메모리는 이 프로세스가 창 안에서 쓴 바이트를 추적하는 `StreamTrim` 으로 제한한다. `STREAM_BUDGET_BYTES`(항공기 80 MiB, 선박 16 MiB)를 넘으면 그 XADD 는 들어가는 최신 항목만 남도록 `MAXLEN ~ n` 을 쓰고, 이를 `stream_budget_trims` 로 센다. 이 카운터는 collector heartbeat 와 `wakeline:ais:status` 에 노출된다. SIGMET(300 s)과 radar(60 s)는 이미 2 h 넘게 담으므로 `MAXLEN ~200` 을 유지한다.

  저장소 fixture 로 잰 항목 크기(스크래치 스크립트):
  - region: 상태 127개 = 9,265 B/항목, adsb_fi 상태 117개 = 8,641 B/항목
  - global: 상태 6,604개 = 447,618 B/항목(합성, region 상태로 만듦)
  - ships: 49 B/척, ADR-014 측정값은 항목 200개 = 2.5 MiB(약 12.8 KB/항목)

  api 중단 중에는 focus/hot 항목이 발행되지 않는다. 그 임대를 api 가 쓰기 때문이다. 따라서 항공기 2.5 h 는 약 42 MB(region 이 500대면 약 66 MB), 선박은 약 12 MB 다. 이 한도는 publisher docstring 에 적었다. 운영자가 고를 수 있는 가장 빠른 주기(region 5 s, global 60 s)에 큰 region 이면 바이트 예산 때문에 창이 약 2 h 로 줄어든다. 창이 가득 찬 상태에서 collector 가 재시작하면, 재시작 전 항목은 세지 않으므로 일시적으로 최대 2배가 남을 수 있다. MINID 기준은 collector 의 벽시계다(Redis 와 같은 호스트).
- **회귀 테스트** `tests/test_publisher.py`: `test_r14_aircraft_stream_keeps_everything_published_during_a_two_hour_api_outage` 는 수정 전 `assert 200 == 780` 으로 실패했다. `tests/test_ais_sink.py`: `test_r14_ships_stream_keeps_a_two_hour_api_outage_then_trims_by_time` 는 수정 전 sink 에서 `assert 200 == 721` 로 실패했다. `test_r14_aircraft_stream_is_trimmed_by_time_after_the_retention_window`, `test_r14_byte_budget_bounds_memory_when_the_rate_is_unexpectedly_high`, `test_r14_other_streams_keep_count_trim` 도 추가했다. `test_main` 은 `stream_budget_trims=0` 을 단언한다. 실제 Redis: `tests/test_redis_integration.py::test_r14_publisher_time_trim_on_real_redis_under_collector_acl` 가 `start.sh` 의 collector ACL 로 `redis:8-alpine` 에서 통과하고, 기존 ais ACL 테스트도 MINID 로 통과한다. 수정 후 모두 통과한다.
- **커밋** `2a7074a`

#### api-data (api 부분)

- **증상** api 가 스트림 창(MAXLEN ~200, 약 11-35분)보다 오래 멈추면, 멈춘 동안 잘린 항목이 조용히 사라졌다.
- **재현 방법** `StreamTrimLossIT`: consumer 를 멈추고 radar 항목 3개를 XADD 한 뒤 admin 으로 `XTRIM MAXLEN 1` 을 하고 consumer 를 시작한다. 수정 전에는 손실이 세어지지 않았다: `timed out after PT15S waiting for trim loss counted`.
- **원인** 소비를 재개할 때 그룹의 위치와 스트림에 아직 남은 것을 비교하는 곳이 없었다. Redis 8 은 MAXLEN 잘림을 `max-deleted-entry-id` 에 기록하지 않으므로(XDEL 만 기록) 이 필드로도 알아낼 수 없다.
- **수정** 매 (재)시작의 첫 XREADGROUP 전에, 이미 있던 그룹마다 `entries-added - group entries-read > length` 이면 읽지 않은 항목이 잘린 것이다. 이를 `wakeline_stream_trim_loss_events_total{stream,kind=unread}` 로 센다. 창도 기억한다: from = 마지막으로 전달된 항목의 시각(그룹이 한 번도 읽지 않았으면 null), to = 남아 있는 첫 항목의 시각. 저장되기 전에 잘린 PEL 항목도 같은 방식으로 기록한다(`kind=pending`). 같은 손실을 두 번 세지 않는다. `StreamConsumer` 가 `trimLossEvents()` 와 `lastTrimLoss()` 를 노출하고, 운영 pipeline 엔드포인트가 이를 쓴다.
- **회귀 테스트** `it/StreamTrimLossIT`: 읽지 않은 항목의 잘림을 창과 함께 셈, 재시작 뒤 중복 계산 없음, pending 잘림의 창, 이미 읽은 항목만 잘리면 손실이 아님. 수정 전 실패: 읽지 않은 항목 잘림 테스트가 시간 초과됐다.
- **커밋** `43971f9`

### R-15 · api-data — 알림 이력 hex 필터가 hex 인덱스를 쓰지 못해 창 안의 알림을 모두 훑는다

- **증상** `GET /alerts/history?hex=` 가 창 안의 모든 알림을 훑었다. `alert_event_hex` 는 idx_scan 0 이었고, 조회 비용이 표 크기와 함께 커졌다.
- **재현 방법** `QueryPlanDbTest.alertHistoryHexFilterUsesAHexIndex`: 알림 20,000개를 넣고 저장소의 정확한 문장을 plan cache 의 generic plan 으로 EXPLAIN 한다(`PlanCapture`, GENERIC 모드). 수정 전: 전체 범위에 대한 `alert_event_entered` Index Scan, Filter `(($3)::text IS NULL OR hex = $4)`. hex 인덱스 없음.
- **원인** 한 문장이 `(:hex::text IS NULL OR e.hex = :hex)` 로 두 경우를 모두 처리했다. plan cache 가 generic plan 으로 바뀌면 이 OR 은 hex 인덱스를 쓸 수 없다.
- **수정** hex 가 주어졌을 때만 `e.hex = :hex::bpchar` 조건을 더한다. V9 가 `alert_event (hex, id DESC)` 를 추가하므로 한 페이지를 cursor 순서로 읽고, limit 에 이르면 스캔이 멈춘다. 롤백 SQL(DROP INDEX)은 V9 머리글에 있다.
- **회귀 테스트** `persist/QueryPlanDbTest.alertHistoryHexFilterUsesAHexIndex`(plan 이 `alert_event_hex*` 인덱스를 써야 함, cursor 로 끝까지 넘겨 읽어도 중복 없음)와 `MigrationDbTest` 의 V9 롤백 테스트. 테스트 도구는 `dev.wakeline.PlanCapture`. 수정 전에는 위와 같이 실패했다.
- **커밋** `574d473`

### R-16 · api-data — REST bbox 에 NaN 을 넣으면 범위·면적 검사를 모두 통과해 /replay 면적 상한이 우회된다

- **증상** NaN bbox 가 범위·면적 검사를 통과했다. `/replay` 는 면적 상한 2,500 sq-degree 를 넘어 전세계를 조회했고(응답 1.1 MB), 목록 엔드포인트는 400 대신 빈 결과로 200 을 돌려줬다.
- **재현 방법** `GET /api/v1/replay?at=...&bbox=-180,NaN,180,NaN` 이 수정 전 200 을 돌려줬다(`BboxValidationIT`: `expected 400 but was 200`). `BboxTest` 에서 `Bbox.parse("-180,NaN,180,NaN")` 이 예외를 던지지 않았다.
- **원인** `Double.parseDouble` 은 NaN, Infinity, 지수, 16진 실수, d/f 접미사를 받아들이고, NaN 과의 비교는 모두 false 다. WS 경로는 isFinite 를 검사했지만 REST 는 하지 않았다.
- **수정** REST bbox 의 각 값은 단순한 10진수 패턴(부호와 소수점 허용)과 맞아야 한다. `split(",", -1)` 로 나누므로 빈 원소나 남는 원소는 거부한다. REST 와 WS 가 `Bbox.checked`(유한값, 범위 안, min < max)를 공유한다. 결과: 400 `BAD_BBOX`.
- **회귀 테스트** `domain/BboxTest.nonFiniteOrNonDecimalNumbersAreBadBbox` 와 `sharedRuleRejectsNonFiniteAndOutOfRange`. `it/BboxValidationIT` 는 `/replay`, `/aircraft`, `/ships`, `/airports`, `/sigmets` 를 다룬다. 수정 전 실패: `BboxTest` 사례(`Expecting code to raise a throwable`)와 `BboxValidationIT`(`/replay` 200).
- **커밋** `0fc55d6`

### R-17 · collector — 관심 지역 adsb_lol 429 가 수렴하지 않고 약 7분마다 반복된다

- **증상** 관심 지역의 adsb_lol 이 약 7분마다 끝없이 429 를 받았고, adsb_lol 과 adsb_fi 사이를 하루에 방향별로 약 220번씩 오갔다.
- **재현 방법** `tests/test_fallback.py` 시뮬레이션: region 은 10 s 마다 돌고, primary 는 어느 300 s 창에서든 20번 넘게 불리면 429 를 준다(가정한 한도이며 테스트에서만 씀). 시뮬레이션으로 6시간을 돌린다.
- **원인** `fallback.ProviderChain` 이 429 back-off 를 300 s 로 제한한 뒤 같은 주기로 primary 에 돌아갔다. 429 가 약 7분 간격으로 나서 15분 무사(quiet) 초기화가 한 번도 일어나지 않았고, 순환이 끝나지 않았다.
- **수정** `RATE_LIMIT_RESET_S` 안에 429 가 되풀이되면 그 공급자를 10 -> 20 -> 40 -> 60분 동안 뒤로 미루고, 그동안 다음 공급자가 정상 주기로 region 을 맡는다. 이 보류는 선호 순서일 뿐 차단이 아니다: 다른 공급자를 쓸 수 없으면 보류 중인 공급자도 back-off(최대 300 s)가 끝나면 쓴다. '무사' 는 back-off 나 보류가 끝난 시점부터 세므로, 보류가 끝나는 순간 단계가 초기화되지 않는다. 공급자 한도 수치는 가정하지 않았고, `api.adsb.lol` 호스트 버킷도 추가하지 않았다. AIMD 속도 조절 대신 리뷰의 히스테리시스 방안을 골랐다: adsb_lol 호출을 늦추면 region 신선도가 api 의 60 s stale 한도 쪽으로 밀리기 때문이다.
- **회귀 테스트** `tests/test_fallback.py`: `test_r17_repeated_429_converges_instead_of_flapping_every_few_minutes` 는 수정 전 6 h 에 429 45번으로 실패했다(`assert 45 <= 12`). 수정 후: 6 h 에 9번, 전환 17번. 24 h 실행에서는 429 26번(이전에는 하루 약 180번)이고, 모든 주기가 여전히 처리된다. `test_r17_held_primary_is_still_used_when_no_other_provider_is_available` 는 가용성을 지키는 테스트로 수정 전후 모두 통과한다. `test_rate_limited_backoff_grows_and_resets` 는 이제 `_last_429` 를 직접 건드리지 않고 가짜 시계를 쓴다.
- **커밋** `b31e791`

### R-18 · collector · api-data · web-ui — 데이터 손실 신호(드롭·트림·저장 실패)를 운영자가 볼 수 있는 곳이 없다

#### collector

- **증상** 데이터 손실 신호(드롭, 트림, 쓰기 실패)가 드러나지 않았다. collector 부분: collector 가 api 가 읽을 수 있는 곳에 이 신호를 발행하는지 확인한다.
- **재현 방법** DB 에 닿을 수 없는 상태에서 fixture 모드로 `main()` 을 실행한 뒤 `wakeline:collector` 해시를 읽는다. AIS sink 를 실행하고 `wakeline:ais:status` 를 읽는다.
- **원인** collector 결함은 없다. `publish_dropped`, `publish_queued`, `db_dropped`, `db_pending`, `db_failures`, `db_ok`, `http_throttled` 는 이미 heartbeat 해시에 있었고, `dropped_total` 과 `quarantined_total` 은 이미 `wakeline:ais:status` 에 있었다. 빈 곳은 이를 표시하지 않는 api/web 쪽이다.
- **수정** R-14 의 새 `stream_budget_trims` 외에 운영 코드 변경은 없다. api/web pipeline 패널이 기댈 수 있도록 회귀 테스트가 이 필드들을 고정한다. 후속 커밋(`c27dcb5`)이 단언 하나를 시점에 무관하게 만들었다: 마지막 heartbeat 의 `db_failures` 는 아직 0 일 수 있으므로 대신 `db_ok == 0` 을 단언한다.
- **회귀 테스트** `tests/test_main.py::test_main_fixture_mode_smoke` 가 heartbeat 의 모든 손실 필드가 숫자이고 `db_ok == '0'` 임을 단언한다. `tests/test_ais_sink.py::test_single_shard_status_keeps_the_pre_v4_fields` 는 `dropped_total`, `quarantined_total`, `invalid_total`, `publish_errors`, `gaps_pending`, `stream_budget_trims` 를 단언한다. 검증 항목이라 수정 전에 실패하는 테스트는 없다: 필드가 이미 있었다.
- **커밋** `d1e69e6` · `c27dcb5`

#### api-data (api 부분)

- **증상** 드롭, 트림, 저장 실패를 운영자에게 보여 주는 곳이 없었다.
- **재현 방법** `OpsPipelineIT`: 수정 전에는 로그인한 `GET /api/v1/ops/pipeline` 에 collector/ais/api 필드가 없었다. 엔드포인트가 없었기 때문이다.
- **원인** 손실 카운터는 내부 Prometheus 지표와 heartbeat 해시 필드로만 있었다. 이를 노출하는 운영 화면이 없었다.
- **수정** 새 `OpsPipelineController`, `GET /api/v1/ops/pipeline`. 같은 운영 세션 규칙을 쓴다(익명 404, GET 은 CSRF 헤더 불필요). 형태: `{collector:{publish_dropped,db_dropped,db_pending,heartbeat_age_s}, ais:{dropped_total,quarantined_total}, api:{track_queue_dropped,ship_queue_dropped,receipts_force_released,dlq,stream_trim_loss_events,last_stream_trim_loss:{stream,from,to}|null}, generated_at}`. null 도 항상 쓴다. `heartbeat_age_s` 는 가장 최근의 `*_at` 필드에서 구한다. heartbeat 가 120 s 보다 오래되면 collector 값은 null 이 되고, `updated_at` 이 30 s 보다 오래되면 ais 값은 null 이 된다. 없거나 형식이 틀리거나 음수인 값, Redis 오류도 null 을 준다. 해시는 읽기만 한다. api 카운터는 프로세스 시작 이후 값이다: `dlq` 는 이 프로세스가 DLQ 로 옮긴 메시지 수, `receipts_force_released` 는 track 과 ship 의 합이다. OpenAPI 스냅샷을 다시 만들었다.
- **회귀 테스트** `it/OpsPipelineIT`: 익명 404, 해시가 비었으면 모두 null, 새 heartbeat 의 값, 형식이 틀린 값은 null, 오래된 heartbeat 는 값이 null 이지만 age 는 유지, api 카운터 연결. 수정 전 실패(엔드포인트 없음).
- **커밋** `e970760`

#### web-ui (web 부분)

- **증상** 데이터 손실 카운터(드롭, 트림, 저장 실패)가 운영 UI 어디에도 보이지 않았다.
- **재현 방법** 이전 운영 페이지는 collector heartbeat 키 중 `_at` 으로 끝나는 것만 보였다.
- **원인** 손실 신호를 보여 주는 화면이 없었다.
- **수정** 운영 대시보드가 다른 운영 GET 과 함께 `GET /api/v1/ops/pipeline` 을 폴링하고(같은 15 s, 같은 세션·오류 처리) 'pipeline' 탭(`components/OpsPipeline.tsx`)을 더한다. `lib/ops.ts` 의 `pipelineRows` 가 모든 필드에 라벨을 붙인다. 손실 카운터(`publish_dropped`, `db_dropped`, ais `dropped_total`, track/ship 큐 드롭, `receipts_force_released`, `dlq`, `stream_trim_loss_events`)는 0 이 아니면 빨간색, 0 이면 초록색이다. `db_pending`, `quarantined_total`, heartbeat 나이는 중립색이다. null, 없음, 음수, 숫자가 아닌 값은 0 이 아니라 '—' 로 보인다. `last_stream_trim_loss` 는 stream 과 범위로 보이고, `generated_at` 도 보이며, 탭 라벨에 0 이 아닌 손실 카운터 수가 붙는다.
- **회귀 테스트** `tests/review-v1-ui.test.ts` `R-18 ops pipeline tab ...`(테스트 2개). 수정 전 실패: `pipelineRows is not a function`, 그리고 스텁 컴포넌트가 `''` 를 렌더했다.
- **커밋** `f098034`

### R-19 · collector — 예산 일별 스냅샷이 매일 마지막 최대 1시간의 호출을 빠뜨린다

- **증상** `provider_budget_day` 가 끝난 날마다 최대 마지막 1시간만큼 적게 셌다(adsb_fi 3549 vs 3559 등). live 모드에서도 `'fixture|0|0'` 행을 썼다.
- **재현 방법** `tests/test_maintenance.py`: 어제 키 `budget:adsb_fi:20260927` 를 used=3559 로 두고, 시계를 00:20 UTC 로 맞춘 뒤 `MaintenanceJob` 을 실행한다.
- **원인** `maintenance.py` 는 오늘 키만 스냅샷했고, 작업은 매시 돈다. `build_limits` 가 'fixture' 를 포함했고 모든 항목이 스냅샷 대상이었다.
- **수정** 매 실행이 어제 키가 남아 있는 동안(TTL 48 h) 어제 키도 새 `Budget.recorded_usage` 로 다시 스냅샷한다. 어제 키가 없으면(호출 없음, 또는 Redis 초기화) 행을 0 으로 덮어쓰지 않고 그대로 둔다. `Budget.usage` 는 선택적 day 인자를 받는다. `main.snapshot_providers` 는 live 모드에서 'fixture' 를 뺀다. 오늘 값이 확정값이 아님을 UI 에 표시하는 것은 api/web 레인 몫이다.
- **회귀 테스트** `tests/test_maintenance.py`: `test_r19_first_snapshot_after_midnight_finalizes_yesterday` 는 수정 전 실패했다(행이 `[('adsb_fi','2026-09-28',7,40000), ('awc','2026-09-28',0,0)]` 이고 2026-09-27 행이 없음). `test_r19_live_mode_does_not_snapshot_the_fixture_provider` 는 수정 전 ImportError 로 실패했다(`snapshot_providers` 가 없었음). 둘 다 수정 후 통과한다.
- **커밋** `ed550f6`

### R-20 · collector — heartbeat 의 lag_s 가 실제 값이 아니다: 기상 작업은 0.0 고정, 항공기는 자료 나이가 아니라 처리 시간

- **증상** heartbeat `{job}_lag_s` 가 sigmet, radar, metar, radar_kr 에서는 상수 0.0 이었고, 항공기에서는 자료 나이가 아니라 처리 시간(now - fetched_at)을 보였다.
- **재현 방법** `SigmetJob`, `KmaRadarJob`, 또는 seen_pos 가 12 s 인 `AircraftJob` region 을 실행한 뒤 `wakeline:collector` 해시를 읽는다.
- **원인** `weather.py` 와 `kma_radar.py` 가 `lag_s=0.0` 을 넘겼다. `aircraft.py` 와 `demand.py` 는 `now - fetched_at` 을 썼다.
- **수정** 기상 작업은 이제 `lag_s=None` 을 넘기고, 이는 빈 값(모름)으로 쓰인다. region, global, focus, hot 은 `status.newest_age_s` 를 쓴다: 발행한 상태의 `now - max(seen_at)`, 발행한 것이 없으면 빈 값.
- **회귀 테스트** `tests/test_aircraft_job.py::test_r20_region_lag_is_age_of_newest_published_observation` 은 수정 전 `assert 12.0 <= 0.0` 으로 실패했다. `test_r20_region_lag_is_unknown_when_nothing_was_published` 는 `'0.0' == ''` 로 실패했다. `tests/test_sigmet_job.py::test_r20_sigmet_heartbeat_lag_is_unknown_not_zero` 와 `tests/test_kma_radar.py::test_r20_radar_kr_heartbeat_lag_is_unknown_not_zero` 는 둘 다 `'0.0'` vs `''` 로 실패했다. 수정 후 모두 통과한다.
- **커밋** `e7149fe`

### R-21 · collector — 원천 보관 gzip·파일 쓰기와 전세계 정규화가 이벤트 루프에서 실행되고, KMA 본문은 gzip 을 한 번 더 한다

- **증상** aircraft, SIGMET, radar, METAR, KMA 작업에서 원천 보관 gzip 과 파일 쓰기가 이벤트 루프 위에서 실행됐다. 이미 gzip 인 KMA 본문을 다시 압축했다. 전세계 정규화와 인코딩(~100 ms)도 루프 위에서 돌았다.
- **재현 방법** 작업을 실행하면서 `RawStore.save` 와 `normalize_opensky` 에서 `threading.get_ident()` 를 기록하고, gzip 본문을 `RawStore` 로 저장한다.
- **원인** `RawStore.save` 를 동기로 불렀고(demand 만 `to_thread` 를 씀), save 는 본문을 항상 gzip 했다.
- **수정** `raw_store.archive()`(`asyncio.to_thread`)를 추가해 모든 호출 지점에서 쓴다. `0x1f8b` 로 시작하는 본문은 받은 그대로 `.bin.gz` 접미사로 쓴다. `AircraftJob._process` 는 정규화, 품질 게이트, envelope 인코딩을 스레드에서 실행한다. `self.gate` 는 이 작업만 쓴다.
- **회귀 테스트** `tests/test_weather_jobs.py::test_r21_raw_archive_runs_off_the_event_loop_for_every_job` 은 수정 전 실패했다: save 6번이 모두 루프 스레드에서 실행됐다. `test_r21_global_normalization_and_encoding_run_off_the_event_loop` 는 수정 전 실패했다: `normalize_opensky` 가 루프 스레드에서 실행됐다. `tests/test_raw_store.py::test_r21_already_gzipped_body_is_stored_as_is` 는 수정 전 실패했다(`'.bin.gz'` 대신 `'.json.gz'`, 본문 이중 압축). 수정 후 모두 통과한다.
- **커밋** `62ba297`

### R-22 · collector — 쓰지 않는 상태 상수, 실제 동작과 다른 docstring, 쓰지 않는 AircraftProvider 프로토콜

- **증상** `STATES_FOCUS` 와 `STATES_HOT` 은 쓰이지 않았고, api 가 받아들이는 'disabled' 가 빠져 있었다. docstring 하나는 비활성 공급자가 'throttled' 를 보고한다고 했지만 코드는 'disabled' 를 쓴다. `AircraftProvider` 프로토콜은 쓰이지 않았다.
- **재현 방법** 상수를 grep 하고 api 의 `CollectorDemandStatus.STATES` 와 비교한다.
- **원인** disabled 상태를 추가한 뒤 남은 죽은 코드.
- **수정** 두 상수를 api 집합과 같은 `STATES = {active, throttled, not_found, error, disabled}` 로 바꿨다. `status_value` 는 이제 그 밖의 상태에 ValueError 를 던진다. docstring 두 곳(`_disabled` 와 모듈 머리말)을 고쳤다. `main` 이 공급자 맵을 `dict[str, AircraftProvider]` 로 타입 지정하므로 mypy 가 각 어댑터를 프로토콜에 비춰 검사한다.
- **회귀 테스트** `tests/test_demand.py::test_r22_status_states_match_the_api_and_are_enforced` 는 `CollectorDemandStatus.java` 에서 `Set.of(...)` 를 파싱해 집합을 비교한다. 수정 전 `module 'wakeline_collector.demand' has no attribute 'STATES'` 로 실패했고, `status_value` 도 아무 상태나 받아들였다. 수정 후 통과한다.
- **커밋** `eadcdd3`

### R-23 · web-core — 알림 배너(lastEvent)가 시각 없이 무기한 남아 오래된 진입이 방금 일어난 일처럼 보인다

- **증상** 알림 배너(`lastEvent`)에 시각이 없고, 재연결을 거쳐도 무기한 남아, 몇 시간 전의 진입이 방금 일어난 일처럼 읽힌다.
- **재현 방법** `lastEvent` 를 01:02:03Z 로 두고 `AlertPanel` 을 SSR 렌더해 시각을 찾는다. TTL 도우미를 확인한다. `lastEvent` 를 설정한 뒤 WS 클라이언트에 welcome 을 넣는다. 수정 전 테스트 3개가 실패했다: '수신 01:02:03Z' 없음, `EVENT_BANNER_TTL_MS` undefined, welcome 뒤에도 `lastEvent` 가 남음.
- **원인** `lastEvent` 는 설정(alerts_batch)만 되고, 테스트 전용 `resetData` 말고는 지워지지 않았다. 배너는 시각을 렌더하지 않았다.
- **수정** 배너(이제 `AlertPanel.tsx` 안의 작은 `EventBanner` 컴포넌트)는 고정 문자열 '수신 HH:MM:SSZ', 즉 추정 서버 시계 기준 수신 시각을 보인다(`AlertPanel.tsx:121` 에서 확인). 고정 문자열이라 aria-live 영역을 매초 다시 읽지 않는다. `EVENT_BANNER_TTL_MS`(5분, `lib/alerts.ts` `eventBannerVisible`)보다 오래되면 배너를 숨긴다. `ws.ts` 의 welcome 이 `lastEvent` 를 지운다.
- **회귀 테스트** `tests/alert-panel.test.ts` `last-event banner (R-23)`(테스트 3개). 수정 전 3/3 실패, 수정 후 통과.
- **커밋** `7626678`

### R-24 · infra — DB 가 기본 설정으로 돌아 WAL 의 약 86 % 가 전체 페이지 이미지다

- **증상** DB 가 기본 설정(checkpoint 5분, `max_wal_size` 1 GB, WAL 압축 없음, `shared_buffers` 128 MB)으로 돌았다. WAL 의 약 86 % 가 전체 페이지 이미지였고, WAL 이 하루 약 16 GB 였다.
- **재현 방법** compose 방식으로 띄운 일회용 db 에서 SHOW 결과가 `checkpoint_timeout=5min`, `max_wal_size=1GB`, `wal_compression=off`, `shared_buffers=128MB` 였다.
- **원인** compose db 서비스에 `command:` 튜닝이 없었다.
- **수정** db 서비스에 이제 `command: [postgres, -c checkpoint_timeout=15min, -c max_wal_size=2GB, -c wal_compression=on, -c shared_buffers=256MB]` 가 있다(ADR-017 §4). 초기화와 권한 내림은 여전히 공식 entrypoint 가 맡는다.
- **회귀 테스트** `test_compose_policy.test_db_wal_and_memory_settings`(dev 와 iso)는 수정 전 실패했다(`[] != ['postgres']`). `db_hardening_test.sh` 는 이제 `compose.yml` 에서 읽은 compose command 로 db 를 띄우고, SHOW 값과 그 출처가 'command line' 인지 확인한다. 수정 전: 5개 실패(5min / 1GB / off / 128MB / configuration file,default). 현재: 15min / 2GB / pglz / 256MB, 출처 command line.
- **커밋** `dbafe84`

### R-25 · infra — api 힙 상한 616 MiB 가 NFR-03 예산 512 MB 를 넘는다

- **증상** api 힙 상한이 616 MiB 로 NFR-03 예산 512 MB 를 넘었다. RSS 는 약 700 MiB 였다.
- **재현 방법** `docker run --memory 1g --entrypoint java wakeline-api:local -XX:+PrintFlagsFinal -version` 결과가 `MaxHeapSize = 645922816`(616 MiB), `MaxRAMPercentage = 60` 이다.
- **원인** `apps/api/Dockerfile` 이 `-XX:MaxRAMPercentage=60` 을 설정한다.
- **수정** 40 으로 바꿨다(ADR-017 §4). compose 한도 1 GiB 에서 상한은 약 410 MiB 다. 배포 뒤 RSS 는 오케스트레이터가 다시 잰다.
- **회귀 테스트** `test_dockerfile_policy.ApiHeapTest` 는 수정 전 실패했고(`60.0 != 40`), 이제 한도 x 비율 <= 512 MiB 도 단언한다. 다시 빌드한 이미지에서 `infra/tests/image_test.sh` 는 `--memory 1g` 일 때 힙 상한 410 MiB 를 보고한다(이전 이미지 616 MiB).
- **커밋** `a5c7139`

### R-26 · api-data — 재생 응답의 72 %(REVIEW-v1 측정) 가 bbox 와 무관한 전세계 SIGMET 인데 재생 중 매초 다시 보낸다

- **증상** 각 `/replay` 응답의 약 70 % 가 bbox 와 무관한 전세계 SIGMET 이었고, 재생 중 매초 다시 보냈다.
- **재현 방법** `ReplayIT.replaySigmetsAreLimitedToTheRequestedBbox`: 수정 전에는 한국 bbox 재생에 EU SIGMET 이 나왔다.
- **원인** `SigmetRepository.validAt` 에 공간 조건이 없었다.
- **수정** `validAt(at, bbox)` 가 `geom IS NULL OR geom && ST_MakeEnvelope(bbox)` 를 더하며, 이는 GiST 인덱스를 쓴다. 좌표 없는 SIGMET 은 위치를 모르므로 남긴다.
- **회귀 테스트** `it/ReplayIT.replaySigmetsAreLimitedToTheRequestedBbox`. 수정 전 실패(EU SIGMET 포함).
- **커밋** `120cd58`

### R-27 · api-data — 일 통계 traffic_by_hour 집계의 정렬이 디스크로 넘친다

- **증상** 일일 `traffic_by_hour` 집계의 정렬이 디스크로 넘쳤다(external merge, 임시 파일).
- **재현 방법** `QueryPlanDbTest.dailyTrafficAggregationDoesNotSpillToDisk`: 지역 안 점 30k 개, 세션 `work_mem` 64kB 에서 실제와 같은 INSERT 를 EXPLAIN ANALYZE 한다(savepoint 로 롤백). 수정 전: `Sort Method: external merge`, `Sort Space Type: Disk`, temp 블록 179개 기록.
- **원인** 시간별 `count(DISTINCT hex)` 가 기본 `work_mem` 에서 하루치 지역 점 전체를 정렬한다.
- **수정** `aggregateDay` 가 자기 트랜잭션에만 `SET LOCAL` 로 `work_mem = 64MB` 를 설정한다. 인덱스는 추가하지 않았다(ADR 은 'index if needed'): 지역 행이 전세계 행과 페이지를 공유하므로 공간 인덱스를 써도 거의 모든 페이지를 읽는다. 이것은 하루 한 번 도는 배치이지 요청 경로가 아니다. 롤백은 쿼리 변경을 되돌리는 것이다.
- **회귀 테스트** `persist/QueryPlanDbTest.dailyTrafficAggregationDoesNotSpillToDisk`(Disk 정렬 없음, temp 블록 0, 시간별 행 24개). 수정 전 실패.
- **커밋** `0172829`

### R-28 · api-security — api 기동 로그에 Spring Boot 가 자동 생성한 보안 비밀번호가 매번 찍힌다

- **증상** api 를 기동할 때마다 `UserDetailsServiceAutoConfiguration` 이 `Using generated security password: ...` 를 로그에 남겼다. 로그에 비밀값이 남고, 쓰이지 않는 메모리 내 'user' 계정이 생긴다.
- **재현 방법** IT 컨텍스트를 기동한다. 테스트 출력에 `Using generated security password` 가 있고, 컨텍스트에 `inMemoryUserDetailsManager` 빈이 있다.
- **원인** `UserDetailsService`, `AuthenticationManager`, 제외 설정 어느 것도 정의되지 않아 Boot 가 메모리 내 사용자를 자동 생성했다.
- **수정** `WakelineApplication` 에 `@SpringBootApplication(exclude = UserDetailsServiceAutoConfiguration.class)`. web 과 CLI 프로필 모두에 적용된다. 운영 로그인은 `OpsUserService` 만 쓴다.
- **회귀 테스트** `it/SecurityIT.noGeneratedInMemoryUserAccountExists` 가 `UserDetailsService` 빈이 없음을 확인한다. 수정 전 실패: `Expecting empty but was: ["inMemoryUserDetailsManager"]`. 수정 후 `SecurityIT` 출력에 'generated security password' 줄이 0개다.
- **커밋** `7dd044b`

### R-29 · infra — 런타임 이미지에 남은 쓰지 않는 패키지 관리자가 고칠 수 있는 HIGH 를 모두 만든다

- **증상** 런타임 이미지의 쓰지 않는 패키지 관리자가 고칠 수 있는 HIGH 전부를 만들었다: web 의 npm(tar, brace-expansion, ip-address), collector 의 pip 에 vendoring 된 msgpack 과 setuptools.
- **재현 방법** `wakeline-web:local` 과 `wakeline-collector:local` 에서 `image_test.sh` 가 `/usr/local/bin/{npm,npx,corepack,yarn,yarnpkg}`, `/usr/local/lib/node_modules/{npm,corepack}`, `/opt/yarn-v…`, `/usr/local/bin/pip*`, `site-packages/pip` 를 찾았다. 오프라인 trivy: web HIGH 4, collector HIGH 2.
- **원인** 런타임 단계가 기반 이미지의 패키지 관리자를 그대로 남겼다.
- **수정** web 런타임 단계는 npm, npx, corepack, yarn/yarnpkg, `/opt/yarn-*` 를 지운다. collector 런타임 단계는 `python -m pip uninstall -y pip` 를 실행한다(앱은 uv `.venv` 를 씀). api 는 healthcheck 가 curl 을 쓰므로 curl 을 남긴다. CI security 작업은 이제 빌드 뒤 `image_test.sh` 를 실행한다.
- **회귀 테스트** `test_dockerfile_policy.RuntimeToolsTest` 는 수정 전 하위 테스트 9개가 실패했다. `infra/tests/image_test.sh`: 이전 이미지에서 4개 실패, 다시 빌드한 이미지에서 11/11 통과(node 와 `.venv` 는 계속 동작하고, 사용자는 non-root). 다시 빌드한 이미지의 trivy: 고칠 수 있는 HIGH/CRITICAL 이 web 4 -> 0, collector 2 -> 0.
- **커밋** `df4343c`

### R-30 · web-ui — 모든 화면 제목이 같고 건너뛰기 링크가 없으며, 첫 알림 전에 지도 출처 링크 13개를 Tab 으로 지나야 한다

- **증상** 모든 경로의 문서 제목이 같았다. `/`, `/replay`, `/ops` 에 h1 이 없었다. 건너뛰기 링크가 없었고, 지도 위 출처 링크 13개가 Tab 순서에서 첫 알림보다 앞에 있었다. 알림 행에는 읽어 줄 구분자가 없었다.
- **재현 방법** `layout.tsx` 에 metadata title 이 하나뿐이다. 클라이언트 페이지는 metadata 를 export 할 수 없다.
- **원인** 구조가 빠져 있었다.
- **수정** 루트 title 은 template(`'%s — Wakeline'`)을 쓴다. `layout.tsx` 파일들이 replay, stats, ops, `airports/[icao]` 의 제목을 정하고, about 은 자기 metadata 를 export 한다. 상황판, 재생, 운영에 sr-only h1 을 둔다. Shell 은 건너뛰기 링크로 시작하고('본문으로 건너뛰기', `/` 에서는 `#side-panel` 로 가는 '알림 목록으로 건너뛰기'), main 과 aside 는 포커스를 받는다. `mapAttributionHtml` 링크는 `tabindex=-1` 을 받는다(footer 는 포커스 가능한 사본을 유지). 알림 행에는 sr-only `', '` 구분자와 INSIDE 뒤 '경보 안' 이 붙는다. Shell 은 null pathname 을 견딘다.
- **회귀 테스트** `tests/review-v1-ui.test.ts` `R-30 ...`(테스트 4개). 수정 전 실패: title 이 template 없는 단순 문자열, h1·건너뛰기 링크 없음, 출처 앵커 13개 중 `tabindex=-1` 0개, 구분자 0개. 브라우저 확인: 모든 경로의 제목이 다르고, 두 번째 건너뛰기 링크에서 Enter 를 누르면 side-panel 에 포커스가 간다.
- **커밋** `5fb6d2d`

### R-31 · web-ui — 기본으로 열린 범례가 지도의 23–27% 와 지도 출처 표기를 가리고, 한국어 버튼이 단어 중간에서 줄바꿈된다

- **증상** 기본으로 열린 범례가 1280x720 과 1440x900 에서 지도의 23–27% 를 가리고 지도 출처 표기와 겹쳤다. KMA STALE 배지는 상태 바의 스크롤 끝 너머에 있었다. 한국어 버튼이 단어 중간에서 줄바꿈됐다.
- **재현 방법** `legendOpen` 기본값이 true, `LayerPanel` 이 `bottom-3`, KMA STALE 배지가 상태 바 끝 근처에 있었다.
- **원인** 레이아웃 기본값.
- **수정** `LEGEND_OPEN_MIN_WIDTH` 를 1600 으로 정했다(저장된 선택이 여전히 우선). 레이어 열은 출처 표기 위인 `bottom-16` 에서 끝난다. KMA STALE 배지는 연결·fixture 배지 바로 뒤로 옮겼다. 단어 중간 줄바꿈은 R-39 의 `.btn` 규칙으로 이미 고쳐졌다. e2e legend 와 ships spec 을 고쳤다.
- **회귀 테스트** `tests/review-v1-ui.test.ts` `R-31 ...`(테스트 3개). 수정 전 실패: `legendDefaultOpen(1280)` 이 true, `bottom-3`, 배지 index 988 vs 264.
- **커밋** `8ab3bc3`

### R-32 · web-ui(R-45 대응 포함) — 통계 알림 표가 내부 키를 그대로 보이고 체류 값에 단위가 없으며, 지난 날짜의 빈 상태 문구가 틀리다

- **증상** 통계 알림 표가 내부 키(day/metric/dim/value, `alert_dwell_avg_s`)를 단위가 섞인 채 보였고, 체류 값에는 단위가 없었다. 빈 상태 문구는 2020-01-01 에도 'first aggregation at next 03:30 UTC' 를 약속했다. 막대 라벨이 4글자로 잘렸다. 날짜를 JVM 시간대 타임스탬프에서 잘라 냈다.
- **재현 방법** 이전 `stats/page.tsx` 는 `r.metric` 을 렌더했고, `Empty` 컴포넌트는 고정 문구였으며, `BarChart` 는 라벨을 5글자에서 잘랐다.
- **원인** 원자료를 그대로 렌더했고, aggregated 신호가 없었다.
- **수정** `lib/stats.ts` 와 `components/AlertStatsTable.tsx`: UTC 날짜·종류마다 한 행이고, 건수('19,546건')와 평균 체류(`fmtDuration`, 툴팁에 초)를 별도 열로 둔다. 종류 라벨은 한국어이고 † 는 유지한다. `statsEmptyText` 는 `aggregated:false`(다음 03:30 UTC, 또는 7일 catch-up 범위 밖이면 약속하지 않음), `aggregated:true`(기록 없음), 플래그 없음(알 수 없음)을 구분한다. 날짜 입력의 max 는 UTC 기준 어제다. `statsDay` 는 `'YYYY-MM-DD'` 를 받고, 예전 UTC 자정 ISO 문자열은 그 날짜로 읽으며, 그 밖에는 '—' 를 보인다. 운영 예산·격리 day 열에도 쓴다. `aggregatedFlag` 는 최상위 boolean 을 읽는다. `BarChart` 는 3글자보다 긴 라벨을 회전하고, 전체 라벨을 SVG `<title>` 로 준다.
- **회귀 테스트** `tests/review-v1-ui.test.ts` `R-32 / R-45 ...`(테스트 4개). 수정 전 실패: `'@/lib/stats'` 없음, `BarChart` 단언이 `'SBAO…'` 에서 실패.
- **커밋** `34e42df`

### R-33 · collector — 문자열 'inf' 가 든 레코드 하나가 region·global·focus·hot 묶음 전체를 실패시킨다

- **증상** 숫자 필드에 문자열 'inf' 나 'Infinity' 를 담은 레코드 하나가 region, global, focus, hot 묶음 전체를 `OverflowError` 로 실패시켰고, 아무것도 발행되지 않았다.
- **재현 방법** `normalize_readsb({... 'alt_baro': 'inf'})` 나 `normalize_opensky(vec[7]='inf')` 를 부른다. 또는 정상 레코드 50개와 `alt_baro='inf'` 레코드 1개로 `AircraftJob('region')` 을 실행하거나, 같은 레코드로 focus tick 을 실행한다.
- **원인** `normalize._num` 은 NaN 은 버렸지만 +/-inf 는 통과시켰다. 그러면 `int(round(inf))` 가 `OverflowError` 를 던졌다. 레코드별 루프에 보호 장치가 없었다.
- **수정** `_num` 은 이제 유한하지 않은 값에 모두 None 을 돌려준다(`ais/parse.py` 와 같은 규칙). `normalize_readsb` 와 `normalize_opensky` 가 레코드마다 감싸므로, 예상하지 못한 예외(예: 단위 변환 뒤 넘치는 유한값)는 `Rejected('invalid_record')` 가 된다. `AircraftState` 도 마지막 방어선으로 `allow_inf_nan=False` 를 둔다.
- **회귀 테스트** `tests/test_normalize.py`: `test_r33_readsb_non_finite_numbers_are_unknown_not_crash`(파라미터 5개), `test_r33_opensky_non_finite_numbers_are_unknown_not_crash`(파라미터 2개), `test_r33_finite_value_that_overflows_after_unit_conversion_is_isolated`. `tests/test_aircraft_job.py`: `test_r33_one_inf_record_does_not_sink_the_region_batch`. `tests/test_demand_job.py`: `test_r33_focus_survives_inf_numbers_in_one_record`. 10개 모두 수정 전 `OverflowError: cannot convert float infinity to integer` 로 실패했다. 수정 후 모두 통과한다.
- **커밋** `b88b0ff`

### R-34 · web-core — 웹 커버리지 92.1 % 는 테스트가 불러온 파일만 센 값이다

- **증상** 웹 커버리지 92.1 % 는 테스트가 import 한 파일만 센다. 전체 소스 기준으로는 61.3 % 였고, `MapView` 와 페이지들은 0 % 였다.
- **재현 방법** 이전 설정으로 `vitest run --coverage` 를 실행한다. 보고서에 import 된 파일(테스트 도우미 포함)만 나온다. 수정 전 `tests/coverage-config.test.ts` 는 `expected undefined to be v8`(coverage 설정 없음)로 실패했다.
- **원인** `vitest.config.ts` 에 `coverage.include` 가 없어 v8 coverage 가 로드된 파일만 보고한다.
- **수정** `vitest.config.ts` 가 coverage provider v8 과 include `app/**/*.{ts,tsx}`, `components/**/*.{ts,tsx}`, `lib/**/*.ts`, `public/*.js`, `proxy.ts` 를 설정하고 `**/*.d.ts` 를 뺀다. 테스트 없는 파일은 이제 0 % 로 센다. 같은 HEAD 에서 같은 테스트로 잰 수치: 로드된 파일만 Lines 87.61 %(2108/2406), 전체 소스 71.68 %(2013/2808). 최종 HEAD: Lines 72.63 %, Statements 66.94 %. 수치를 올리려 하지 않았다. `MapView` 가 더는 0 % 가 아닌 것은 R-01 과 R-11 을 위해 추가한 생명주기 테스트 때문일 뿐이다.
- **회귀 테스트** `tests/coverage-config.test.ts` 가 provider v8 인지, 그리고 include glob 이 `app/`, `components/`, `lib/` 아래의 모든 .ts, .tsx, .js 파일과 `public/interpolate.worker.js`, `proxy.ts` 를 덮는지 확인한다. 수정 전 실패, 수정 후 통과.
- **커밋** `b90a989`

### R-35 · web-ui — 운영 설정 폼: 15 s 자동 새로고침이 If-Match 낙관적 잠금을 무력화한다

- **증상** 운영자가 편집하는 동안 15 s 자동 새로고침이 설정의 version 을 바꿨다. 저장하면 새 version 을 If-Match 로 보내 동시 변경을 조용히 덮어썼다.
- **재현 방법** 이전 `SettingsForm` 은 편집 상태를 value 문자열로만 들고 있었고, 새로고침된 version 으로 `save(s.key, s.version)` 을 불렀다.
- **원인** 편집을 시작할 때 version 을 잡아 두지 않았다.
- **수정** 편집 상태는 이제 편집 시작 때 잡은 `{value, version}` 이다(`editSetting`). If-Match 는 편집 상태에서 온다(`settingIfMatch`). 서버 version 이 더 새로우면 'show new value' 와 'overwrite with mine' 을 가진 충돌 표시가 나온다(`rebaseSetting`). 둘 중 하나를 고를 때까지 저장은 비활성이다. 409 는 설명을 붙이고 설정을 다시 불러온다.
- **회귀 테스트** `tests/review-v1-ui.test.ts` `R-35 ...`. 수정 전 실패: `editSetting is not a function`. 서버가 v4 로 바뀐 뒤에도 If-Match 가 '3' 으로 남는지 단언한다.
- **커밋** `5305881`

### R-37 · api-security — api 가 Tomcat 11.0.24 로 실행 중이다(CRITICAL CVE 3건, 11.0.25 에서 수정)

- **증상** api 가 내장 Tomcat 11.0.24 로 실행됐다. 이 버전에는 CRITICAL CVE 3건(CVE-2026-65182, 65905, 68525)이 있고, 모두 11.0.25 에서 고쳐졌다.
- **재현 방법** `./gradlew dependencies --configuration runtimeClasspath` 를 실행하면 `tomcat-embed-core` 가 Boot 4.1.1 BOM 에서 11.0.24 로 해석된다.
- **원인** 빌드가 Boot BOM 을 `platform()` 으로 import 하고 `io.spring.dependency-management` 플러그인이 없어서 `extra["tomcat.version"]` 이 효과가 없다. Boot 4.1.1 은 11.0.24 를 고정한다.
- **수정** `apps/api/build.gradle.kts` 에 `tomcat-embed-core`, `tomcat-embed-el`, `tomcat-embed-websocket` 을 11.0.26 으로 올리는 의존성 제약을 추가했다. 이 버전은 이미 로컬 Gradle 캐시에 있었고 11.0.25 이상이다. 블록 주석에 Boot 패치가 11.0.25 이상을 포함하면 이 블록을 지우라고 적었다.
- **회귀 테스트** `config/TomcatVersionTest.embeddedTomcatIsAtLeast11_0_25` 가 `ServerInfo.getServerNumber() >= 11.0.25` 를 확인한다. 수정 전 실패: `embedded Tomcat 11.0.24.0 must be >= 11.0.25`. 수정 후 통과하고, jar 에는 11.0.26 이 들어 있다.
- **커밋** `3f5546c`

### R-38 · infra — 리뷰 측정 스크립트가 :latest 스캐너 이미지에 docker.sock 과 저장소(.env 포함)를 넘기고 네트워크 제한이 없다

- **증상** `perf/review_measure.sh` 가 docker.sock 과 `$PWD` 를 마운트한 채 `aquasec/trivy:latest` 를, `$PWD`(`.env` 포함)를 마운트한 채 `semgrep/semgrep:latest` 를 실행했고, gitleaks 는 태그로만 지정했다. 어느 것도 네트워크 제한이 없었다.
- **재현 방법** 기준 `ba31766` 의 `perf/review_measure.sh` 50-51, 66, 73, 75행을 본다.
- **원인** 이 스크립트는 `ci.yml` 과 Makefile `K6_IMAGE` 가 따르는 고정(pinning) 정책보다 먼저 쓰였다.
- **수정** 스크립트가 이제 `tools/scan_lib.sh` 를 쓴다:
  - trivy 0.74.0, semgrep 1.177.0, gitleaks v8.30.1 을 tag@sha256 으로 고정한다.
  - trivy 는 `--input` 으로 `docker save` tar 를 스캔하므로 docker.sock 이 없다.
  - semgrep 규칙 팩은 먼저 호스트 curl 로 `https://semgrep.dev/c/p/<pack>` 에서 파일로 받는다. 이 주소는 고정한 이미지의 `config_resolver.py` 에서 오프라인으로 확인했다: `f"{env.semgrep_url}/c/{registry_id}"`. 그다음 semgrep 은 git 이 추적하는 파일만 복사한 사본에서 `--network none` 으로 실행하므로 `.env` 는 마운트되지 않는다.
  - gitleaks 는 새 clone 을 `--network none` 으로 스캔한다. trivy secret 은 추적 파일 사본을 스캔한다.
  - 네트워크를 쓰는 컨테이너는 trivy DB 다운로드뿐이며, 캐시만 마운트한다. `SCAN_OFFLINE=1` 이면 다운로드를 건너뛴다.
- **회귀 테스트** `test_scripts_policy.ScannerIsolationTest` 가 docker.sock 없음, `:latest` 없음, digest 고정 도구 이미지, 저장소 전체 마운트 없음, 코드·이미지를 읽는 스캐너에 네트워크 없음을 확인한다.
  - 수정 전: 하위 테스트 8개 실패, 모두 `review_measure.sh`.
  - 현재: 통과한다. 스캐너 블록도 같은 도우미 호출로 오프라인 실행했다: semgrep 은 `.env` 가 없는 512개 파일 사본에서 71개 파일을 스캔했고, trivy image, gitleaks(발견 0건), trivy secret(발견 0건)이 모두 실행됐다.
- **커밋** `f34625e`

### R-39 · web-ui — 390 px 폭에서 지도 폭이 10 px 로 줄고 레이어 버튼·메뉴가 화면 밖으로 나간다(768 px 에서는 범례가 지도 대부분을 덮음)

- **증상** 390 px 에서 지도 폭이 10 px 였고 레이어 버튼과 메뉴가 화면 밖에 있었다. 768 px 에서는 범례가 지도 대부분을 덮었고, 버튼이 음절 중간에서 줄바꿈됐다('레/이/더').
- **재현 방법** aside 가 `w-[380px] shrink-0` 로 고정돼 있었고, 레이어 행은 줄바꿈되지 않고 왼쪽 경계도 없었으며, 범례는 기본으로 열려 있었고, `.btn` 은 줄바꿈을 허용했다.
- **원인** 데스크톱 전용 레이아웃.
- **수정** 900 px 미만에서는 측면 패널이 지도 아래에 전체 폭으로 쌓인다(높이 42%). 레이어 패널은 `left-12` 에서 경계를 갖고 버튼 행이 줄바꿈된다. 범례는 저장된 선택이나 폭 규칙이 달리 정하지 않으면 닫힌 채 시작한다(`prefs.legendDefaultOpen`, ui-store 기본값은 이제 닫힘). `.btn` 은 `white-space:nowrap` 과 `word-break:keep-all` 을 쓴다. 헤더는 줄바꿈되고, nav 는 스크롤되며, 영문 부제는 lg 부터만 보인다. 레이더 타임라인, 운영 도구 막대, 재생 도구 막대가 줄바꿈된다. 검색 결과, KMA 패널, 재생 inspector 는 뷰포트 크기로 제한된다. 재생 캡션도 줄바꿈된다(브라우저 실행에서 발견).
- **회귀 테스트** `tests/review-v1-ui.test.ts` `R-39 narrow screens`(테스트 3개). 수정 전 단언 실패: 반응형 aside 클래스 없음, 레이어 패널에 왼쪽 경계·flex-wrap 없음, `.btn` 에 nowrap 없음. headless Chromium 에서도 확인했다: 휴대폰에서 지도 390x310, 태블릿에서 768x492, 가로 페이지 스크롤 없음.
- **커밋** `5491059`

### R-40 · web-ui — SIGMET·공항·재생 항목은 지도 클릭으로만 열리고(키보드 경로 없음), 공항 비행 카테고리는 지도에서 색으로만 구분된다

- **증상** SIGMET, 공항, 재생 항목은 지도를 클릭해야만 열 수 있어 키보드 경로가 없었다. 지도의 공항 비행 카테고리는 색으로만 표시됐다.
- **재현 방법** `selectSigmet` 과 `selectAirport` 는 `MapView` canvas 클릭에서만 불렸다. airport-label 의 text-field 는 `['get','icao']` 였다.
- **원인** 목록 UI 가 없고, 색만으로 부호화했다.
- **수정** 아무것도 선택하지 않은 SIGMET 탭은 `SigmetList` 를 보인다: 실시간 알림에서 얻은 inside/predicted 수(알림이 오기 전까지 '—')가 붙은 활성 SIGMET 을 inside 항공기 수 순으로 정렬하고, 다각형 중심으로 지도를 옮긴다(날짜변경선 안전). 공항 탭은 `AirportList` 를 보인다: 감시 공항과 글자로 적은 카테고리, 또는 'METAR 오래됨' / 'METAR 없음'. 카드를 닫으면 그 탭의 목록으로 돌아간다. 재생 페이지에는 프레임의 SIGMET 과 항공기(필터 가능, 200개 표시)를 inspector 로 여는 '목록' 토글이 있다. `lib/maplayers` 의 `AIRPORT_LABEL_EXPR` 는 줌 7 이상에서 'RKSI IFR' 을 그린다(stale 이거나 모를 때는 ICAO 만, fill 과 같은 규칙). 범례가 이를 설명한다. 레이어 id 는 바뀌지 않았다.
- **회귀 테스트** `tests/review-v1-ui.test.ts` `R-40 ...`(테스트 4개). 수정 전 실패: 라벨이 'RKSI IFR' 이 아니라 'RKSI' 로 평가됨(style-spec 평가), `sigmetListItems is not a function`, `SigmetList`/`AirportList`/`ReplayList` 모듈 없음.
- **커밋** `54a753e`

### R-41 · infra — CI 가 실제 Redis 테스트를 건너뛰어 예산 Lua·ACL 규칙이 실제 Redis 에서 검증되지 않는다

- **증상** CI 가 실제 Redis 테스트(예산 Lua, 임대, 노선 캐시, ACL 아래의 ais 프로세스)를 건너뛰었다. opt-in 테스트도 실제 규칙 대신 손으로 옮긴 `COLLECTOR_RULES` 와 정규식으로 파싱한 셸 변수를 썼다.
- **재현 방법** `ci.yml` 의 collector 작업에 Redis 도 `WAKELINE_TEST_REDIS_URL` 도 없어서 pytest 결과가 682 passed, 5 skipped 였다.
- **원인** 이 테스트들은 환경 변수로 opt-in 하는데, CI 가 이를 준 적이 없다.
- **수정**
  - `infra/tests/collector_redis_test.sh` 가 compose 에 고정된 redis 를 127.0.0.1 의 무작위 포트, 무작위 비밀번호로 일회용 컨테이너로 띄운다. 비밀번호는 환경 변수 이름으로만 넘기고 argv 에는 싣지 않는다. opt-in 테스트 파일 두 개를 실행하고, 하나라도 건너뛰면 실패한다.
  - CI collector 작업이 단위 테스트 뒤 이를 실행한다.
  - `apps/collector/tests/acl_rules.py` 는 stub redis-server 로 `start.sh` 를 실행해 실제 규칙을 읽는다. 두 opt-in 테스트가 이를 쓴다.
  - 예산 테스트는 admin 으로 TTL 을 읽는다.
- **회귀 테스트** `test_ci_policy.test_collector_job_runs_real_redis_checks` 는 수정 전 실패했고(`0 != 1`) 지금은 통과한다. `collector_redis_test.sh`: R-86 ACL 변경 전후 모두 5 passed, 0 skipped.
- **커밋** `9dc3699`

### R-42 · collector — MetarJob·RadarJob.run_once 와 DB 쓰기 인자 조립에 단위 테스트가 없다(weather.py 커버리지 75%)

- **증상** `MetarJob.run_once`, `RadarJob.run_once`, `_guard` 예산 분기, 그리고 `upsert_airports`, `upsert_metar`, `insert_radar_frames` 의 DB 인자 조립에 테스트가 없었다(`weather.py` 커버리지 75%).
- **재현 방법** `pytest --cov` 에서 230-254, 311-335, 34-42행이 빠진 것으로 나왔다.
- **원인** 테스트 공백.
- **수정** 테스트만 추가했다. 다룬 것: radar 발행, 프레임 insert 인자, 예산, status, heartbeat. radar 공급자 실패 분기. METAR 에서 airport 를 `metar_obs` 보다 먼저 쓰는 순서와 `metar_parse_error` 격리. `_METAR_UPSERT` 에서 파싱한 17개 열 이름과 1:1 로 맞춘 `upsert_metar` 인자, 그리고 airport 인자. `_guard` 의 예산 소진(공급자를 부르지 않음)과 예산 저장소가 죽었을 때의 fail-open.
- **회귀 테스트** `tests/test_weather_jobs.py`: `test_r42_radar_run_once_publishes_frames_records_db_and_heartbeat`, `test_r42_radar_provider_failure_publishes_nothing_and_records_error`, `test_r42_metar_run_once_writes_airports_before_metar_and_isolates_bad_items`, `test_r42_metar_db_arguments_match_column_names_one_to_one`, `test_r42_weather_guard_budget_exhausted_does_not_call_the_provider`. 이 테스트들은 수정 전 코드에서도 통과한다: 커버리지 공백이었고 결함은 찾지 못했다. `weather.py` 커버리지는 75% 에서 96% 로 올랐다.
- **커밋** `9e7fdc7`

### R-43 · collector — redis-py 8 기본 재시도(10회)를 그대로 써서 Redis 호출 하나가 4.27 s, 응답 없는 Redis 에서는 약 1분까지 걸린다

- **증상** redis-py 8 기본 재시도(10회, 최대 1 s jitter backoff): 닫힌 포트로 보내는 XADD 하나가 이 환경에서 4.27 s(리뷰에서는 3.2 s) 걸렸고, 응답 없는 Redis 는 보조 호출을 약 1분 붙잡을 수 있었다.
- **재현 방법** `make_redis(Settings(redis_host='127.0.0.1', redis_port=1)).xadd(...)`, 그리고 status·demand-status 쓰기에 대한 `HangingRedis` 가짜 객체.
- **원인** collector 와 ais 클라이언트에 명시적 재시도 설정이 없고, 보조 쓰기에 시간 제한이 없었다.
- **수정** 새 모듈 `redis_retry.short_retry()`, 즉 `Retry(ExponentialBackoff(cap=0.5, base=0.05), 2)` 를 두 `make_redis` 함수가 쓴다. `ProviderStatus`(`hset_meta`, `failure`, `switch_event`, `is_disabled`)와 `DemandStatus`(`put`, `delete`, `prune`)는 각 Redis 호출을 `asyncio.timeout(AUX_TIMEOUT_S=1.5)` 로 감싼다. 발행 경로는 바뀌지 않았고, 여전히 로컬 큐로 대체한다.
- **회귀 테스트** `tests/test_main.py::test_r43_redis_clients_use_a_short_explicit_retry` 는 수정 전 `assert 10 <= 2` 로 실패했다(수정 전 XADD 4.27 s). `tests/test_status.py::test_r43_status_writes_give_up_quickly_when_redis_does_not_answer` 와 `test_r43_demand_status_writes_give_up_quickly_when_redis_does_not_answer` 는 수정 전 실패했다: 호출이 5 s `wait_for` 를 넘겨 멈춰 있었다. 수정 후 모두 통과하고, 닫힌 포트로 보내는 XADD 는 이제 1.5 s 안에 실패한다.
- **커밋** `be77a68`

### R-44 · api-security — fixedDelay 작업 전부가 단일 스케줄러 스레드에서 직렬로 실행된다

- **증상** 모든 fixedDelay `@Scheduled` 작업이 단일 스케줄러 스레드에서 차례로 실행됐다. 느린 유지보수 catch-up 이나 Redis 지연이 SIGMET 만료 검사, WS heartbeat, AIS 상태 갱신을 늦췄다.
- **재현 방법** IT 컨텍스트에서 앱의 `taskScheduler` 에 막히는 fixedDelay 작업을 두면, 두 번째 fixedDelay 작업이 3 s 안에 실행되지 못한다.
- **원인** `spring.threads.virtual.enabled` 에서 Boot 의 `SimpleAsyncTaskScheduler` 는 모든 fixed-delay 작업을 단일 스케줄러 스레드에서 실행한다.
- **수정** `SchedulingConfig` 가 `taskScheduler` 를 가상 스레드, 풀 크기 16 의 `ThreadPoolTaskScheduler` 로 정의한다. 이는 현재 `@Scheduled` 작업 14개(R-79 가 추가한 2개, R-06 이 추가한 매시 cron 1개 포함)보다 크다. fixed-delay 의미와, 작업이 자기 자신과 겹치지 않는다는 규칙은 그대로다. `MaintenanceJobs` 나 다른 작업 클래스는 고칠 필요가 없었다.
- **회귀 테스트** `it/SchedulingIT.aBlockedFixedDelayJobDoesNotHoldBackTheOthers` 는 수정 전 실패했다: `another fixed-delay job ran while the slow one was still running. Expecting value to be true but was false`. `SchedulingIT.poolIsLargerThanTheNumberOfScheduledJobs` 는 풀이 등록된 작업 수보다 크고, 앱의 작업이 이 executor 에서 도는지 확인한다.
- **커밋** `c0b2e7a`

### R-45 · api-data — 통계 응답의 day 가 날짜가 아니라 JVM 시간대의 자정 타임스탬프이고, 집계 전 날짜와 자료 없음을 구분하지 못한다

- **증상** 통계 행의 day 가 JVM 시간대의 자정 타임스탬프였다(`'2026-09-27T00:00:00.000Z'`, KST JVM 에서는 하루 이른 날짜). 아직 집계하지 않은 날이 자료 없는 날과 똑같이 보였다.
- **재현 방법** `StatsIT`: 수정 전 `items[].day` 가 `'2026-09-27T00:00:00.000Z'` 였고, 운영 quality/providers 의 day 열도 같은 형태였다.
- **원인** `listOfRows()` 가 `java.sql.Date` 를 그대로 직렬화했고, 완료 신호가 없었다.
- **수정** `/stats/sigmet`, `/stats/alerts`, `/stats/traffic`, 그리고 운영 `/quality` 의 `rule_counts` 와 `/providers` 의 `budget_days` 에서 DB 가 day 를 `to_char(day,'YYYY-MM-DD')` 로 만든다. `/stats/traffic` 은 `aggregated`(traffic 마커, 오늘은 false)를 더한다. `/stats/sigmet` 과 `/stats/alerts` 는 범위 안 모든 날짜에 대해 `days: [{day, aggregated}]` 를 더한다. `tools/rest_contract_check.py` 가 날짜 문자열, `aggregated`, `days` 를 검사하고, item 의 day 가 `days` 안에 있는지 교차 확인한다.
- **회귀 테스트** `it/StatsIT`(테스트 2개)와 collector 규칙 테스트 `test_stats_days_are_utc_date_strings_with_an_aggregated_flag`. `StatsIT` 테스트 2개 모두 수정 전 실패했다(날짜 패턴 불일치).
- **커밋** `8e5d300`

### R-46 · api-data — catch-up 의 '행이 하나라도 있으면 집계 완료' 규칙: 자료 없는 날은 영원히 재집계되고, 운영자가 오늘을 부분 집계하면 그 값이 굳을 수 있다

- **증상** 자료 없는 날이 3 h 마다 영원히 다시 집계됐다. 운영자가 오늘을 부분 집계하면 그 값이 영구히 남을 수 있었다.
- **재현 방법** `StatsAggregationDbTest`: 수정 전 두 번째 `catchUpStats` 가 빈 날 7개를 모두 다시 돌려줬다. `OpsStatsIT`: 수정 전 `POST /ops/stats/aggregate?day=today` 가 200 을 돌려줬다(기대 400).
- **원인** catch-up 이 'stats_daily 행이 하나라도 있음' 을 '집계됨' 으로 봤고, 운영 엔드포인트는 어떤 날이든 받았다.
- **수정** 계열별 완료 마커를 `stats_daily (day, 'aggregated_at', sigmet|traffic|alerts) = epoch seconds` 로 저장한다. 끝난 날(UTC)에만 쓰고, metric 으로 거르는 통계 API 에서는 보이지 않는다. catch-up 은 원천이 아직 보존 중인 계열에 마커가 없을 때만 그날을 집계한다. 원천이 사라진 계열(72 h 지난 원 항적, 30 d 지난 알림)은 지우지도 다시 세지도 않는다. `POST /ops/stats/aggregate` 는 오늘 이전 날짜만 받는다: 그 밖에는 400 `BAD_DAY`.
- **회귀 테스트** `persist/StatsAggregationDbTest`(테스트 3개)와 `it/OpsStatsIT`, 그리고 마커 규칙에 맞게 고친 기존 `PersistDbTest` 와 `RetentionDbTest`. 새 테스트 4개 모두 수정 전 실패했다.
- **커밋** `da8fa3f`

### R-47 · web-ui — 재생 요청 중(inflight)에 들어온 최신 요청을 버려 라벨과 지도 데이터가 어긋난 채 멈춘다

- **증상** 다른 재생 요청이 진행 중일 때 들어온 요청이 버려져, 다음 변경 전까지 라벨과 지도 데이터가 어긋날 수 있었다.
- **재현 방법** 이전 페이지의 `load()` 는 `inflight.current` 가 설정돼 있으면 일찍 반환하고 다시 시도하지 않았다.
- **원인** 최신 요청을 담아 둘 큐가 없었다.
- **수정** `lib/replay` 의 `ReplayLoader`: 진행 중인 요청은 하나다. 대기 요청은 최신 것 하나만 남기고, 현재 요청이 끝나면 보낸다. 프레임은 도착 순서로 적용한다. 대체된 요청의 실패는 무시한다. 방금 받은 요청과 같은 대기 요청은 다시 보내지 않는다. `dispose()` 는 전송과 콜백을 멈춘다. 페이지는 마운트마다 loader 를 만들며, 이는 StrictMode 에서도 안전하다(`next dev` 에서 확인).
- **회귀 테스트** `tests/review-v1-ui.test.ts` `R-47 ...`(수동 deferred 를 쓰는 테스트 2개). 수정 전 실패: `ReplayLoader is not a constructor`. fetch 순서가 [A, C] 이고 최종 프레임이 C 임을 단언한다.
- **커밋** `17f0f59`

### R-49 · api-security — edge→api 요청 상관관계가 끊기고 api 로그 줄에 요청 id 가 나오지 않는다

- **증상** edge 와 api 요청을 이어 볼 수 없었다: api 는 항상 새 X-Request-Id 를 만들었고, api 로그 줄에는 MDC 에 담긴 요청 id 가 나오지 않았다.
- **재현 방법** 신뢰 프록시(10.77.0.10)에서 X-Request-Id `3f2b8c1d9e7a4b6c8d0e1f2a3b4c5d6e` 로 요청을 보낸다: 응답 헤더와 problem 의 `request_id` 에 새로 만든 다른 id 가 담긴다.
- **원인** `RequestIdFilter` 가 들어온 헤더를 무시했고, `application.yml` 에 MDC 값을 포함하는 로그 패턴이 없었다.
- **수정** `RequestIdFilter.resolve` 는 (a) 요청이 `wakeline.trusted-proxy` 에서 왔고(`ClientIp` 와 같은 규칙) (b) `[0-9A-Za-z-]{8,64}` 와 맞을 때만(nginx `$request_id` 와 UUID 를 덮음) 들어온 X-Request-Id 를 쓴다. 아니면 이전처럼 새 id 를 만든다. `ProblemErrorReportValve` 도 컨테이너 수준 오류에 같은 규칙을 적용한다. `logging.pattern.correlation` 이 요청 처리 중에 쓴 로그 줄에 `[rid:<id>]` 를 붙이고, 요청 밖에서는 아무것도 붙이지 않는다.
- **회귀 테스트** `SecurityIT.requestIdFromTheTrustedEdgeIsUsedInProblemsAndLogs`(신뢰 프록시에서 보낸 MockMvc 와 OutputCapture)는 수정 전 실패했다: `expected: "3f2b8c1d9e7a4b6c8d0e1f2a3b4c5d6e" but was: "1a0e6ff3aebf4ed9e9517cf6617"`. 지금은 통과한다: 헤더, problem 본문, `[rid:3f2b...]` 가 든 로그 줄이 모두 일치한다. 형식이 틀리거나 너무 긴 id 는 CRLF 주입을 포함해 모두 교체된다. `RequestIdFilterTest` 가 신뢰하지 않는 원격, 프록시 미설정, 헤더 없음, UUID 에 대한 단위 테스트를 더한다.
- **커밋** `f2a204a`

### R-51 · api-data — 항공기 검색이 aircraft 표 전체를 순차 스캔한다

- **증상** 항공기 검색의 DB 쪽이 보존 기한 없이 커지는 aircraft 표 전체를 순차 스캔했다.
- **재현 방법** `QueryPlanDbTest.aircraftSearchUsesPrefixIndexesAlsoInTheGenericPlan`: 항공기 20k 대, 수정 전 generic plan: aircraft 에 Seq Scan, Filter `(upper(hex) ~~ $1) OR (upper(registration) ~~ $2)`.
- **원인** 접두사 인덱스가 없었고, 있더라도 generic plan 에서는 LIKE 파라미터가 이를 쓸 수 없다.
- **수정** V9 가 `aircraft_hex_prefix`(`upper(hex) text_pattern_ops`)와 `aircraft_registration_prefix`(`upper(registration) text_pattern_ops`)를 추가한다. 쿼리는 접두사를 `~>=~` 와 `~<~` 로 바이트 순서 범위 [p, 마지막 글자를 + 1 한 p) 로 적으며, 인덱스가 파라미터가 있는 상태에서도 이를 처리한다(BitmapOr). 입력은 이미 컨트롤러에서 `[A-Z0-9-]` 로 제한된다. 롤백 SQL 은 V9 머리글에 있다.
- **회귀 테스트** `QueryPlanDbTest.aircraftSearchUsesPrefixIndexesAlsoInTheGenericPlan`(Seq Scan 없음, 두 인덱스 모두 사용, 올바른 접두사 결과와 순서)와 `MigrationDbTest` V9 롤백. 수정 전 실패.
- **커밋** `4055bfa`

### R-52 · api-data — /aircraft/{hex}/track 에 점 수 상한이 없다

- **증상** `/aircraft/{hex}/track` 에 점 수 상한이 없었다: 10 s 피드 24 h 면 약 8,600점, 약 1.5 MB 다.
- **재현 방법** `AircraftTrackIT`: 2 h 동안 5,010점이면 수정 전 5,010점을 모두 돌려줬다(`expected 5000 but was 5010`).
- **원인** `TrackRepository.track` 에 LIMIT 이 없었다.
- **수정** 항적을 5,000점으로 제한하고, 선박 항적과 마찬가지로 오래된 것부터(oldest first) 둔다. LIMIT 5,001 로 조회하므로 `properties.truncated` 가 정확하다. 계약 검사가 `truncated` 를 요구하고, 점을 5,000개로 제한하며, points = coordinates = `properties.points` 인지 확인한다. 좌표 중복 제거 부분은 하지 않았다. 아래 '이번 단계에서 고치지 않은 부분' 을 본다.
- **회귀 테스트** `it/AircraftTrackIT.trackIsCappedAt5000PointsAndSaysSo` 와 collector 규칙 테스트 `test_aircraft_track_is_capped_and_says_so`. 수정 전 실패.
- **커밋** `1ee794d`

### R-53 · api-data — 캐시 적중률 지표가 없고 REST /status 가 요청마다 Redis 해시를 여러 번 읽는다

- **증상** 캐시 hit/miss 지표가 없었고, REST `/status` 가 요청마다 Redis 해시 여러 개를 읽었다.
- **재현 방법** `CacheMetricsIT`: 수정 전 연속한 `GET /api/v1/status` 두 번이 서로 다른 `server_time` 을 돌려줬고(매번 새로 만듦), `wakeline_cache_requests_total` 계열이 없었다.
- **원인** 3 s status 캐시를 WS 만 썼고, 캐시에 계측이 없었다.
- **수정** `wakeline_cache_requests_total{cache=status|aircraft_json|route,result=hit|miss}` 를 추가했다. `GET /api/v1/status` 는 WS 세션이 받는 것과 같은 3 s 캐시 status 인 `WsHub.status()` 를 쓴다: REST 와 WS 를 합쳐 3 s 마다 Redis 갱신이 최대 한 번이다. `RestSamplesIT` 는 이제 같은 값을 기다린다.
- **회귀 테스트** `it/CacheMetricsIT`. 수정 전 실패(`server_time` 이 달랐음).
- **커밋** `5296c82`

### R-54 · api-security — /ops 탭을 열어 두면 운영 세션이 만료되지 않는다(15 s 폴링이 유휴 제한을 계속 연장하고 절대 수명이 없음)

- **증상** 열어 둔 `/ops` 탭이 운영 세션을 영원히 살려 뒀다: 15 s 폴링이 요청마다 8 h 유휴 제한을 연장했고, 절대 수명이 없었다.
- **재현 방법** 로그인해 `/api/v1/ops/providers` 를 폴링한 뒤, Redis 에서 세션의 로그인 시각과 creationTime 을 8 h 넘게 전으로 바꾼다. 다음 요청도 200 을 돌려준다.
- **원인** `spring.session.timeout` 은 유휴 제한(`maxInactiveInterval`)이다. 로그인 이후 경과 시간을 확인하는 곳이 없었다.
- **수정** 로그인이 세션 속성 `ops_auth_at`(epoch ms, Long, 이미 역직렬화 허용 목록에 있음)을 저장한다. 새 `OpsSessionLifetimeFilter` 를 `SecurityContextHolderFilter` 앞에 둔다. 이 필터는 `/api/v1/ops/**` 에서 `wakeline.ops-session-max-age`(8h, ADR-017 §3)보다 오래된 세션을 무효화한다. 그러면 요청은 익명으로 계속 진행돼 404 를 받고, Redis 세션은 지워진다. 이 속성이 없는 세션은 creationTime 으로 대신한다. 다시 로그인하면 새 8 h 가 시작된다.
- **회귀 테스트** `SecurityIT.opsSessionEndsAtItsAbsoluteLifetimeEvenWhenKeptBusy` 와 `SecurityIT.sessionWithoutLoginTimeFallsBackToItsCreationTime` 모두 수정 전 실패했다: `status of /api/v1/ops/providers expected: 404 but was: 200`. `OpsSessionLifetimeFilterTest` 가 경계, 운영이 아닌 경로, 세션 없음, 잘못된 설정에 대한 단위 테스트를 더한다.
- **커밋** `29189d8`

### R-55 · api-security — 로그인 실패 감사가 입력한 아이디 원문을 저장한다(없는 계정 포함)

- **증상** 로그인에 실패하면 입력한 아이디를 그대로 append-only `audit_log` 에 저장했고, 없는 계정도 마찬가지였다. 아이디 칸에 잘못 친 비밀번호가 그곳에 영구히 남는다.
- **재현 방법** 아이디 `'Pw-typed-into-username-<n>'` 로 `POST /api/v1/ops/session` 을 보낸다. 그러면 `audit_log` 에 target 이 그 문자열인 `LOGIN_FAILED` 행이 생긴다.
- **원인** `OpsSessionController` 가 `UNKNOWN_USER` 를 포함한 모든 실패 사유에서 `audit.record(..., body.username(), ...)` 를 불렀다.
- **수정** `UNKNOWN_USER` 이면 감사 target 은 이제 리터럴 `'unknown account'` 다(`after.reason = unknown_user` 는 유지). 존재하는 계정(비밀번호 틀림, 잠김)은 입력과 같은 정확한 이름을 그대로 쓴다.
- **회귀 테스트** `SecurityIT.failedLoginForAnUnknownAccountDoesNotStoreWhatWasTyped` 는 수정 전 실패했다: `typed name stored anywhere in audit_log expected: 0L but was: 1L`. `OpsSessionControllerTest.unknownAccountFailureDoesNotRecordTheTypedName` 도 새로 추가했다.
- **커밋** `c78573d`

### R-56 · web-ui — 운영 로그인·설정 폼: 클라이언트 검증 없이 서버 영문 원문 오류를 보이고, 설정 저장 성공과 실패가 똑같이 보인다

- **증상** 운영 로그인에 클라이언트 검증이 없었고, 서버의 영문 오류 원문('invalid request', 'too many login attempts', 'Failed to fetch')을 대기 시간 없이 보였다. 설정 성공과 실패가 똑같이 보였다(text-accent, role 없음). 모든 키가 text 입력을 썼고, '숫자처럼 보이는' 값은 숫자로 보냈다. `/airports/ZZZZ` 는 'airport not watched: ZZZZ' 를 보였다.
- **재현 방법** 이전 페이지의 입력에는 required 도 minLength 도 없었고, 401 만 번역했으며, 설정 메시지는 클래스 하나를 썼다.
- **원인** 검증도 상태 매핑도 없었다.
- **수정** `components/OpsLogin.tsx`: 두 필드에 required, 비밀번호에 minLength 8, 한국어 인라인 메시지와 함께 noValidate, `aria-invalid` 와 포커스 처리. `loginErrorText` 가 400/401/403/429(Retry-After 초 포함)/503/5xx/네트워크 오류를 매핑한다. `lib/api` 의 `ApiError.retryAfterS` 는 Retry-After 에서 파싱한다. `settingSpec`/`parseSetting` 은 `SettingsService.validate` 를 그대로 따르고(정수 범위는 number 입력, `global_enabled` 는 checkbox, providers 와 `region_center` 는 패턴, `ais_bboxes` 는 자유 텍스트) PUT 전에 검사한다. 성공은 `role=status` 의 text-ok, 실패는 `role=alert` 의 text-bad 다. `lib/format` 의 `airportErrorText` 가 공항 페이지 오류를 한국어로 준다.
- **회귀 테스트** `tests/review-v1-ui.test.ts` `R-56 ...`(테스트 5개). 수정 전 실패: `OpsLogin` 없음, `loginErrorText` 와 `parseSetting` 없음, `retryAfterS` undefined(이전 `ApiError`), `airportErrorText` 없음. 브라우저 확인: 비밀번호가 비었거나 짧으면 한국어 오류를 보이고, 그 필드에 포커스를 주며, GET 이 아닌 요청을 0개 보낸다.
- **커밋** `43dc708`

### R-57 · web-ui — 기상청 레이더 범례에서 45/50/55 dBZ 칸의 검은 글자 명암비가 AA 기준에 못 미친다

- **증상** KMA 레이더 범례에서 45/50/55 dBZ 칸의 검은 글자 명암비가 3.52/3.00/3.48:1 로 AA 에 못 미쳤다.
- **재현 방법** `KrRadarPanel` 과 `MapLegend` 가 `color:#000` 을 하드코딩했다.
- **원인** 고정 글자색.
- **수정** `lib/format` 의 `legendTextColor` 가 WCAG 명암비로 검정이나 흰색을 고른다. 두 범례 모두 이를 쓴다. 그 칸들은 이제 약 6–7:1 의 흰 글자다.
- **회귀 테스트** `tests/review-v1-ui.test.ts` `R-57 ...` 가 서버 범례 색으로 두 범례를 렌더하고, 모든 칸이 4.5:1 이상인지 확인한다. 수정 전 실패: `45 dBZ: expected 3.52 to be >= 4.5`.
- **커밋** `9250b88`

### R-58 · web-core — 수신이 끊긴 반쯤 열린 연결(45–75 s) 동안 상태 바는 STALE 인데 알림 목록은 실시간처럼 ETA 를 계속 센다

- **증상** 45–75 s 동안 메시지가 없는 반쯤 열린 연결에서 상태 바는 'WS open · 수신 없음 / STALE' 을 보이는데, 알림 목록과 근거 카드는 실시간처럼 예측 ETA 를 계속 줄여 나간다.
- **재현 방법** `alertListState('open', 3, false)` 를 부르고, conn open, `alertsVersion` 3, `lastRxAt` now-50 s, PREDICTED 알림으로 `AlertPanel` 을 SSR 렌더한다. 수정 전: `expected live to be silent`, 그리고 alerts-stale 안내 없음(ETA 가 계속 셈).
- **원인** `alertListState()` 는 conn 과 `alertsVersion` 만 봤다. 상태 바와 지도 칩은 `isRxFresh`(`RX_FRESH_MS` 45 s)를 쓰고, watchdog 는 75 s 에야 재연결한다.
- **수정** `alertListState(conn, alertsVersion, rxFresh=true)` 는 연결이 열려 있지만 rx-fresh 가 아니면 새 'silent' 상태를 돌려준다. `AlertPanel` 은 '수신 없음(연결은 열림) — 마지막으로 받은 목록 · 갱신 안 됨 · ETA 멈춤' 을 보이고 ETA 를 멈춘다. `EvidenceCard` 는 ETA 를 '—' 로 보인다. `lib/clock.ts` 의 새 `useRxFresh()` 가 store(새 export `subscribeData`)와 공용 1 s 시계에서 boolean 을 구하고, 값이 바뀔 때만 다시 렌더한다. 'live' 를 뜻하던 SSR 테스트는 이제 최근 `lastRxAt` 도 설정한다.
- **회귀 테스트** `tests/alert-panel.test.ts` `alert list freshness follows the status bar's receive rule (R-58)`(테스트 2개). 수정 전 2/2 실패, 수정 후 통과.
- **커밋** `3b28e3e`

### R-59 · web-ui — SIGMET 카드의 'Aircraft inside' 가 hex 코드만 보여 어떤 항공기인지 알 수 없다

- **증상** SIGMET 카드의 'Aircraft inside' 가 대문자 hex 버튼만 보였다.
- **재현 방법** 이전 `SigmetCard` 는 hex 를 `.btn` 버튼으로 매핑했다.
- **원인** 알려진 식별 정보를 찾아보지 않았다.
- **수정** `InsideAircraftList` 는 각 hex 의 콜사인과 관측 고도를, 이 SIGMET 의 OBSERVED 알림에서, 없으면 실시간 항공기 사본에서(GND 포함), 그것도 없으면 '—' 로 보인다. 다른 SIGMET 의 알림이나 예측 고도는 절대 쓰지 않는다. hex 는 소문자이고, 행에는 aria-label 과 출처 안내가 있으며, 툴팁은 선택하면 focus 추적이 시작된다고 알린다. 선택하면 여전히 지도가 이동한다.
- **회귀 테스트** `tests/review-v1-ui.test.ts` `R-59 ...`. 수정 전 실패: `InsideAircraftList` 가 export 되지 않았다.
- **커밋** `38b5300`

### R-62 · api-data — DB 느림에 대한 격벽 없음: 공개 조회와 수집 기록기가 한 풀(12)을 쓰고 statement/lock timeout 이 없다

- **증상** 공개 조회와 수집 기록기가 연결 12개짜리 풀 하나를 statement·lock timeout 없이 함께 써서, 느린 DB 가 모든 연결을 붙잡고 기록기를 막을 수 있었다.
- **재현 방법** `DbTimeoutsIT`: 수정 전 `SHOW statement_timeout` 이 `'0'` 을 돌려줬다. `radar_frame` 을 ACCESS EXCLUSIVE 로 잡아 두면 `GET /replay` 가 빨리 실패하지 않고 잠금 보유자를 기다렸다(약 9 s 뒤 200).
- **원인** statement_timeout, lock_timeout, 쿼리 timeout 이 어디에도 설정되지 않았다.
- **수정** Hikari data-source 옵션 `-c statement_timeout=30s -c lock_timeout=5s` 가 모든 api 연결에 적용된다. 공개 REST 읽기 문장(track, replay, 시각 t 의 SIGMET, stats, 알림 이력, aircraft find/search, airports, ship find/track/gaps)은 3 s JDBC 쿼리 timeout 인 `Sql.publicRead` 를 쓴다. 취소된 읽기는 `QueryTimeoutException` 을 던지고, Retry-After 와 함께 503 으로 돌려준다. migrate 프로세스는 영향받지 않는다.
- **회귀 테스트** `it/DbTimeoutsIT`: 연결 설정, 그리고 잠금에 막힌 공개 읽기가 2.5-4.9 s 안에 503 과 Retry-After 로 끊김. 두 테스트 모두 수정 전 실패했다.
- **커밋** `b2f145d`

### R-64 · infra — 단일 평면 네트워크(internal 아님)라 모든 컨테이너가 서로의 모든 포트와 인터넷에 닿는다

- **증상** internal=false 인 평면 bridge 네트워크 하나뿐이었다. 모든 컨테이너가 다른 모든 컨테이너의 포트와 인터넷에 닿을 수 있어, '외부 호출은 collector/ais 에서만' 규칙을 네트워크가 강제하지 않았다.
- **재현 방법** `infra/compose.yml` 은 `networks: wakeline`(bridge, internal 아님)만 정의했다.
- **원인** 단일 네트워크 compose 설계.
- **수정** ADR-017 §4 에 따라:
  - public: edge 만, 공개된 127.0.0.1 포트용.
  - wakeline: ADR 의 internal 네트워크로, `internal: true`(게이트웨이·NAT 없음). web, api, migrate, db, redis 는 이 네트워크에만 있고, edge, collector, ais 도 여기에 붙는다. 고정 IP 는 여기 남는다(edge .10 은 `WAKELINE_TRUSTED_PROXY`, api .30 은 bench 가 씀).
  - egress: collector 와 ais 만.

  10.78.0 의 격리 스택도 같은 구성을 갖는다. `tools/chaos.sh` 의 AIS 차단은 이제 ais 컨테이너의 모든 네트워크를 끊었다가 다시 잇는다.
- **회귀 테스트** `infra/tests/test_compose_policy.py` 에 새 테스트 4개(dev 와 iso 스택): 서비스별 정확한 네트워크, `internal:true`, egress 에는 collector/ais 만·public 에는 edge 만, internal 네트워크의 고정 IP 와 신뢰 프록시.
  - 수정 전: 10개 실패.
  - 현재: 통과한다. `edge_test.sh` 는 이제 upstream 을 `--internal` 네트워크에, edge 를 public+internal 에 두고 돌린다: 공개 포트는 여전히 api 에 닿고, internal 전용 컨테이너에는 기본 경로가 없다(외부 호출은 하지 않았음).
- **커밋** `9d05574`

### R-66 · collector — OpenSky 토큰을 401 뒤에도 무효화하지 않아, 만료(최대 약 29분)까지 전세계 수집이 계속 실패할 수 있다

- **증상** `states/all` 에서 401 을 받은 뒤에도 캐시된 OpenSky 토큰을 만료(최대 약 29분)까지 다시 써서, 전세계 뷰가 계속 실패할 수 있었다.
- **재현 방법** respx: 토큰 엔드포인트가 옛 토큰, 그다음 새 토큰을 주고, states 호출이 401, 그다음 200 을 준다.
- **원인** `opensky._states` 가 `ProviderHttpError` 401 에서 `_token` 을 지우지 않았다.
- **수정** 401 이면 공급자가 `_token=None`, `_token_exp=0` 으로 두고 예외를 다시 던진다. 실패는 이전처럼 기록되고, 다음 실행이 새 토큰을 받는다.
- **회귀 테스트** `tests/test_providers.py::test_r66_opensky_401_drops_the_cached_token_so_the_next_run_refreshes_it` 는 수정 전 `assert 1 == 2` 로 실패했다(토큰 엔드포인트가 한 번만 불림). 수정 후 통과한다: 두 번째 호출이 `Bearer new` 를 싣는다.
- **커밋** `827a7f1`

### R-67 · collector — HTTP 요청 전체에 걸린 시간 상한이 없다(httpx timeout 은 읽기마다 적용)

- **증상** HTTP 요청 전체에 시간 상한이 없었다. httpx timeout 은 읽기마다 적용되므로, 바이트를 조금씩 흘려보내는 공급자가 호출(과 region 작업)을 몇 분 동안 붙잡을 수 있었다.
- **재현 방법** 50 ms 마다 1바이트를 끝없이 내는 async stream 을 가진 respx 응답. 수정 전에는 3.0 s `wait_for` 가 발동할 때 `c.get()` 이 여전히 스트리밍 중이었다(스크래치 실행으로 확인).
- **원인** `http._request` 에 send 와 스트림 읽기를 감싸는 `asyncio.timeout` 이 없었다.
- **수정** `HttpClient.get` 은 `total_s`(기본 `DEFAULT_TOTAL_S=30`)를 받고, `post_form` 은 `total_s` 인자 없이 항상 `DEFAULT_TOTAL_S`(30 s)를 쓴다. readsb region 호출은 `REGION_TOTAL_S=15`, KMA 목록과 바이너리는 `KMA_TOTAL_S=40`(측정 최대 25 s)을 쓴다. send 와 본문 읽기를 `asyncio.timeout` 으로 감싼다. 이를 넘으면 `RequestTimedOut` 을 던지는데, 이는 `httpx.TimeoutException` 의 하위 클래스이고 `NOT_SENT_ERRORS` 에 없으므로, 보낸 뒤 실패한 호출로 세고 fallback 이 적용된다. 속도 제한 대기 시간은 포함하지 않는다.
- **회귀 테스트** `tests/test_http.py`: `test_r67_whole_request_has_a_total_time_limit_and_counts_as_sent` 와 `test_r67_callers_get_their_own_total_limits`. 둘 다 수정 전 실패했다(`RequestTimedOut` 과 `DEFAULT_TOTAL_S` 가 없었고, 요청이 끝나지 않음). 둘 다 수정 후 통과한다: 호출이 0.5 s 에 포기하고 보낸 호출로 세어진다.
- **커밋** `e61a564`

### R-68 · collector — METAR 조회 상자가 날짜변경선 근처에서 lomin > lomax 가 된다

- **증상** 관심 지역이 +/-180 근처면 METAR 조회 상자가 lomin > lomax 가 됐다: `(52,178,250)` 이 `47.83,171.23,56.17,-175.23` 을 줬다.
- **재현 방법** `ctx.rt.region=(52.0,178.0,250)` 인 `MetarJob` 과, 받은 상자를 기록하는 가짜 AWC.
- **원인** `geo.bbox_around` 가 각 경도를 따로 감싼다(wrap).
- **수정** 새 `geo.boxes_around` 가 상자 하나를 돌려주거나, 상자가 날짜변경선을 넘으면 `[lomin,180]` 과 `[-180,lomax]` 를 돌려준다. `MetarJob` 은 상자마다 조회하고(상자당 예산 1) 각 본문을 보관한다. 행을 합치면서 `(icao, obs_time)` 마다 하나만 남기고, 수집 실행(ingest run)은 하나로 기록한다. 날짜변경선에서 먼 지역은 여전히 호출 한 번이다.
- **회귀 테스트** `tests/test_weather_jobs.py`: `test_r68_boxes_around_split_at_the_antimeridian` 은 수정 전 ImportError 로 실패했다. `test_r68_metar_job_queries_both_sides_of_the_antimeridian` 은 수정 전 실패했다: 상자 하나 `(47.83, 171.23, 56.17, -175.23)` 를 보냈다. 둘 다 수정 후 통과한다.
- **커밋** `741f924`

### R-70 · api-data — 재생(/replay) 응답이 1시간 공개 캐시되는데 radar 프레임은 지금 기준 2시간 안의 것만 제공된다

- **증상** 과거 시각의 `/replay` 가 1 h 동안 공개 캐시됐지만, 그 안의 radar 프레임은 지금 기준 2 h 안의 것만 제공된다.
- **재현 방법** `ReplayIT.replayIsCachedForAtMostOneMinute`: 수정 전 at = now-100 min 이 `max-age=3600, public` 을 줬다.
- **원인** Cache-Control 이 15분보다 오래된 모든 'at' 에 3600 s 를 썼다.
- **수정** 과거 시각은 `max-age=60`(최근 15분에 대한 30 s 는 그대로).
- **회귀 테스트** `it/ReplayIT.replayIsCachedForAtMostOneMinute`. 수정 전 실패.
- **커밋** `d1bcfa9`

### R-71 · api-data — 기간 검증이 절삭(toHours/toDays)이라 한도를 넘는 요청을 받는다 — 선박 항적은 같은 창을 거절한다

- **증상** track 은 24 h 59 m 을, replay 는 31 d 23 h 를 받았고, 선박 항적은 같은 창을 거절했다.
- **재현 방법** `AircraftTrackIT.rangeLimitIsExact` 와 `ReplayIT.replayRangeLimitIsExact`: 수정 전 200, 기대 400.
- **원인** `Duration.toHours()` 와 `toDays()` 는 절삭한다.
- **수정** Duration 자체를 비교한다: `TRACK_MAX_RANGE` 24 h, `REPLAY_MAX_AGE` 31 d. 정확히 24 h 는 허용하고, 1초라도 넘으면 400 이다.
- **회귀 테스트** `AircraftTrackIT.rangeLimitIsExact` 와 `ReplayIT.replayRangeLimitIsExact`. 둘 다 수정 전 실패했다.
- **커밋** `9340190`

### R-72 · api-data — radar_kr Redis 해시: 공개 /status 는 원본 해시를 통째로 내보내고, /radar/kr 는 잘못된 값에 500 이 된다

- **증상** `/status` 의 `radar_kr` 가 collector 의 Redis 해시 전체를 공개했다. `/radar/kr` 는 형식이 틀린 collector 값에 500 을 돌려줬다.
- **재현 방법** `RadarKrIT`: 수정 전 `/status` 의 `radar_kr` 에 grid, observed_cells, 그리고 주입한 `'secret_like'` 필드가 있었다. width 가 `'six-hundred'` 인 `/radar/kr` 는 수정 전 500 INTERNAL 을 돌려줬다.
- **원인** 해시를 허용 목록 없이 공개했고, `readTree`, `parseInt`, `Instant.parse` 에 오류 처리가 없었다.
- **수정** `/status` 의 `radar_kr` 는 허용 목록이다: `available`(bool), `status`(3자리 문자열), `latest_tm`(12자리), `fetched_at` 과 `checked_at`(offset 이 있는 ISO). 형식이 틀린 값은 뺀다. `/radar/kr` 는 형식이 틀린 필드를 null 로 두고 `wakeline_radar_kr_parse_errors_total{field}` 를 센다. 좌표나 이미지 크기가 없으면 radar 는 available/georeferenced false 로 보고한다. 프레임 목록이 깨졌으면 프레임 없이 200 이다. 계약 검사가 `radar_kr` 필드 목록을 고정한다.
- **회귀 테스트** `it/RadarKrIT`(테스트 2개)와 collector 규칙 테스트 `test_status_radar_kr_carries_only_validated_fields`. `RadarKrIT` 테스트 2개 모두 수정 전 실패했다.
- **커밋** `bdb9a6e`

### R-73 · api-security — WS outbox 작업의 예외가 DEBUG 로만 남고 세지 않아, 세션이 조용히 클라이언트와 어긋난다

- **증상** WS outbox 작업의 예외가 DEBUG 로만 기록되고 세어지지 않았다. `DiffCalculator` 는 전송 전에 'sent' 를 앞당기므로, 세션이 주기적 스냅샷 전까지 조용히 클라이언트와 어긋날 수 있었다.
- **재현 방법** `WsHubTest` 의 결함 주입: 항공기를 선택한 뒤 FANOUT 작업 안에서 예측 조회가 예외를 던지게 한다. 지표는 바뀌지 않고, 다음 fanout 은 resync 가 아니라 `[diff, selected]` 만 보낸다.
- **원인** `SerialOutbox.drain` 이 `RuntimeException` 을 `log.debug` 로 잡았다. `WsSession.schedule` 에는 실패 처리가 없었다.
- **수정** `WsSession` 이 모든 outbox 작업(예약 작업과 REPLY 게시)을 감싼다. 예외가 나면 `needsResync`, `stateResync`, `shipsForce` 를 설정해, 다음 fanout 이 전체 초기 세트를 보내고 선박 전용 세션은 전체 선박 세트를 받게 한다. 그다음 `WsHub.taskFailed` 에 보고하며, 이는 `wakeline_ws_task_errors_total{job}`(0 으로 미리 등록)을 세고 작업마다 최대 분당 한 번 스택과 함께 WARN 을 남긴다. 결정적 결함에서 끝없는 루프를 피하려고 곧바로 다시 예약하지는 않는다. `SerialOutbox` 의 대체 처리는 이제 WARN 이다. 후속 커밋이 이제 쓰이지 않는 생성자를 지운다.
- **회귀 테스트** `WsHubTest.outboxTaskError_isCounted_andTheNextFanoutResyncsTheSession` 은 수정 전 두 가지로 실패했다. 카운터 검사: `expected: 1.0 but was: 0.0`. 카운터 검사를 잠시 건너뛰면 resync 검사가 실패했다: `Expecting SubList ["diff","selected"] to contain ["snapshot","alerts","radar","status","selected"]`. 지금은 둘 다 통과하며, 되풀이된 실패가 세어지지만 로그는 한 번만 남는 경우도 포함한다.
- **커밋** `99f628c` · `a7abdf2`

### R-74 · api-data — /ops/audit 마지막 페이지의 next_cursor 가 빈 문자열이다

- **증상** `/ops/audit` 마지막 페이지의 `next_cursor` 가 `""` 였고, 다른 cursor 엔드포인트는 키를 뺀다.
- **재현 방법** `CursorPagesIT`: 수정 전 `/ops/audit` 를 마지막 페이지까지 따라가면 `next_cursor ... is ""` 가 나왔다.
- **원인** `Map.of` 는 null 을 받지 않아서 코드가 대신 `""` 를 썼다.
- **수정** `next_cursor = null` 인 `LinkedHashMap` 을 쓴다. 이는 `non_null` 에서 빠지므로 `/ops/runs`, `/alerts/history` 와 같아진다. 계약 검사는 정수나 null 만 받는다. 테스트는 세 cursor 엔드포인트를 끝까지 따라가고(중복·누락 없음) 자기가 넣은 행을 치운다.
- **회귀 테스트** `it/CursorPagesIT` 와 collector 규칙 테스트 `test_cursor_is_a_number_or_absent`. `CursorPagesIT` 는 수정 전 실패했다.
- **커밋** `06750d0`

### R-75 · web-core — 이전 WS 클라이언트의 늦은 onclose 가 새 연결의 상태를 'closed' 로 덮어쓴다

- **증상** 이전 WS 클라이언트의 늦은 onclose 가 새 연결의 store 를 conn 'closed', demand null 로 덮어쓴다. 상태 바는 WS closed, 알림은 '연결 끊김' 을 보이고, 다음 재연결까지 demand 칩이 숨는다.
- **재현 방법** 클라이언트 A 가 연결되고 welcome 을 받는다. A 의 소켓은 close 에서 멈춘다. `A.close()`. 클라이언트 B 가 연결되고, welcome 과 demand 를 받는다. 그다음 A 의 onclose 가 발생한다. 수정 전, 새 동기 close 단언 없이 돌린 탐색 실행은 A 의 늦은 onclose 뒤 `expected closed to be open` 을 냈다. 커밋된 테스트는 `close()` 가 store 를 갱신하지 않았으므로 먼저 `expected open to be closed` 에서 실패한다.
- **원인** `ws.ts` 의 `close()` 는 `ws.close(1000)` 만 불렀다. `this.ws` 와 처리기를 그대로 두었으므로 늦은 onclose 가 `this.ws !== ws` 검사를 통과했고, `connectionDown` 이 공유 store 에 썼다.
- **수정** `close()` 는 이제 onopen, onmessage, onclose, onerror 를 떼고, `this.ws=null`, `welcomed=false` 로 둔 뒤 소켓을 닫고, `{conn:'closed', demand:null}` 을 동기로 한 번 쓴다. 이 수정은 R-01 바로 뒤에 들어갔다(엄격한 심각도 순서 밖). R-01 이 마운트 즉시 연결하므로(dev 의 StrictMode 는 다시 마운트함) 리뷰 자체가 지적했듯 이 경합 창이 넓어지기 때문이다.
- **회귀 테스트** `tests/ws-client.test.ts` `a late onclose from a closed client does not overwrite the next client's connection state (R-75)`. 수정 전 실패, 수정 후 통과.
- **커밋** `6180fd5`

### R-77 · infra — '외부 호출은 collector/ais 에서만' 규칙을 강제하는 것이 없어 api·web·db·redis 가 인터넷으로 보낼 수 있다

- **증상** '외부 호출은 collector/ais 에서만' 을 강제하는 것이 없었다: api, web, db, redis 모두 인터넷으로 보낼 수 있었다.
- **재현 방법** R-64 와 같다. `test_compose_policy` 에 internal·egress 검사가 없었다.
- **원인** R-64 와 같다.
- **수정** 같은 네트워크 분리로 고쳤다(두 ID 는 떼어 낼 수 없다): egress 는 collector 와 ais 만, 나머지는 모두 internal 네트워크, 격리 스택도 같다.
- **회귀 테스트** R-64 와 같은 테스트(`test_only_collector_ais_and_edge_sit_on_networks_that_reach_the_internet` 등 — `9d05574` 에서 `test_only_collector_and_ais_reach_the_internet_and_only_edge_is_public` 로 추가됐고, `public` 도 일반 bridge 라 edge 도 인터넷에 나갈 수 있어 `75d6c49` 에서 이름을 바꿨다. §4 R-77·R-64 참고). 수정 전 실패했고, 지금은 통과한다.
- **커밋** `9d05574`

### R-78 · api-data — 소비 그룹을 '$' 에서 만들어 그 전에 발행된 항목을 건너뛰고, collector·ais 가 api 의 healthy 상태에 묶여 있다

- **증상** 소비 그룹을 `'$'` 에서 만들어, 그룹이 생기기 전에 발행된 항목을 건너뛰었다. collector 와 ais 가 api 가 healthy 인 것에 의존해, api 가 crash loop 에 빠지면 이들을 시작하거나 다시 만들 수 없었다.
- **재현 방법** `StreamTrimLossIT.aGroupCreatedAfterEntriesWerePublishedStillConsumesThem`: 그룹을 없애고 XADD 한 뒤 consumer 를 재시작한다. 수정 전에는 그 항목이 끝내 소비되지 않았다(시간 초과). `test_compose_policy.test_collectors_do_not_wait_for_api_health` 는 이전 compose 에서 실패했다(collector `depends_on` 에 'api' 가 있음).
- **원인** `xGroupCreate` 가 `ReadOffset.latest()` 를 썼고, compose 에 `depends_on api: service_healthy` 가 있었다.
- **수정** 그룹을 `0-0` 에서 만든다. 다시 읽는 항목은 자연 키와 `fetched_at` 보호로 흡수되고, 새로 만든 그룹은 트림 손실로 세지 않는다. compose: collector 는 redis healthy, db healthy, migrate `service_completed_successfully` 에 의존하고, ais 는 redis 에만 의존한다. 실행 중인 스택은 건드리지 않았다.
- **회귀 테스트** `StreamTrimLossIT.aGroupCreatedAfterEntriesWerePublishedStillConsumesThem` 과 `infra/tests/test_compose_policy.test_collectors_do_not_wait_for_api_health`(dev 와 e2e 프로젝트). 둘 다 수정 전 실패했다.
- **커밋** `8050155`

### R-79 · api-security — api 가 암묵적으로 단일 인스턴스를 전제하는데, 이를 문서화하거나 막는 장치가 없다

- **증상** api 는 암묵적으로 단일 인스턴스다: 스트림 consumer 이름은 상수 `'api-1'` 이고, 수요 임대 기록기는 집합 전체를 바꾸며, 알림 id 는 프로세스별이다. 이 중 어느 것도 문서화되거나 보호되지 않아, 두 번째 인스턴스가 조용히 상태를 망가뜨릴 수 있었다.
- **재현 방법** api 가 실행 중일 때 Redis 에 인스턴스 표식이 없고(`GET wakeline:api:instance` 가 null), 두 번째 프로세스를 막거나 보고하는 것이 없다.
- **원인** 단일 인스턴스 장치가 없었다.
- **수정** 새 `ingest/SingleInstanceGuard`, phase MAX-200 의 `SmartLifecycle`: 스트림 consumer, WS hub, ship fanout 보다 먼저 시작하고 나중에 멈춘다. `wakeline:api:instance` = 인스턴스 id 를 PX 15 s 로 잡고, 5 s 마다 Lua compare-and-extend 로 갱신하며, 정상 종료 때 compare-and-delete 로 놓는다. 기동 때 다른 살아 있는 인스턴스가 임대를 잡고 있으면 최대 20 s 기다린 뒤(죽은 이전 인스턴스의 임대는 그 안에 만료됨), 단일 인스턴스 설계를 설명하는 `IllegalStateException` 으로 곧바로 실패한다. Redis 에 닿지 못하면 WARN 을 남기고 그대로 기동하므로, Redis 장애가 기동을 막지 않는다. 실행 중 임대를 빼앗기면 최대 분당 한 번 ERROR 로, 그리고 gauge `wakeline_api_instance_conflict=1` 로 보고한다. 30 s 마다, 최근 60 s 안에 그룹 'api' 에서 다른 consumer 이름이 활동했으면 WARN 을 남긴다. `StreamConsumer.CONSUMER` 의 주석과 guard 의 Javadoc 이 설계를 설명한다.
- **회귀 테스트** `it/SingleInstanceIT.theRunningApiHoldsTheInstanceLease` 는 수정 전 실패했다: `instance lease holder Expecting not blank but was: null`. 지금은 통과한다: 보유자가 앱 guard 의 id 와 같고, TTL 이 15 s 이하다. `ingest/SingleInstanceGuardTest`(전용 Testcontainers Redis)는 시험 5개로 다음을 다룬다: 두 번째 인스턴스 기동 실패, 만료 뒤 오래된 임대 인수, 정상 종료 시 임대 해제, 실행 중 인수를 표시하고 다른 인스턴스의 임대는 지우지 않음, Redis 장애가 기동을 막지 않음, 외부 consumer `'api-2'` 는 감지하고 `'api-1'` 은 무시함.
- **커밋** `0064731`

### R-80 · infra — 비밀값 보간에 누락 방지 장치가 없고, DB 비밀번호 교체 절차가 없다

- **증상** 여러 비밀값 보간(DB_ROOT/API/COLLECTOR 비밀번호, `REDIS_PASSWORD`, db 서비스 쪽 사본)에 보호 장치가 없어, 값이 빠지면 빈 비밀번호로 시작했다. DB 비밀번호 교체 절차가 없었고, `.env` 값이 바뀌거나 사라지면 DB 인증이 조용히 실패했다.
- **재현 방법** `.env` 에서 `DB_API_PASSWORD`(또는 `DB_ROOT_PASSWORD`, `DB_COLLECTOR_PASSWORD`, `REDIS_PASSWORD`)를 빼도 `docker compose config` 가 성공했다. `db_rotate_test.sh`(일회용 db): `.env` 의 `DB_API_PASSWORD` 를 바꾼 뒤 `.env` 값으로 로그인하면 `password authentication failed` 로 실패한다.
- **원인** 보호 장치가 일부 변수에만 있었다. 역할 비밀번호는 initdb 때만 설정되고, 이를 다시 맞추는 것이 없었다.
- **수정**
  - 모든 내부 비밀값 보간이 이제 `${VAR:?…}` 를 쓴다.
  - 새 `tools/db_rotate_passwords.py`(`make rotate-db-passwords`, 복구는 `sync=1`):
    - 새 값을 만들고, 로컬에서 계산한 SCRAM-SHA-256 verifier 만 stdin 으로 psql 에 보낸다(argv 에 평문 없음);
    - 옛 verifier 를 저장한 뒤, 컨테이너의 네트워크 주소로 새 값의 로그인을 확인한다. 127.0.0.1 은 쓸 수 없다: 이미지 기본 pg_hba 에 `host all all 127.0.0.1/32 trust` 가 있다(`pg_hba_file_rules` 로 확인);
    - 로그인이 실패하면 옛 verifier 를 되돌리고, 아니면 `.env` 를 원자적으로 바꾼다(0600).
  - README 에 비밀번호 교체 절(DB, Redis, root, 외부 키)을 더했고, `.env.example` 에 주석을 달았다.
- **회귀 테스트** `test_compose_policy.test_missing_secret_is_refused_by_name` 과 `test_every_secret_interpolation_is_guarded` 는 수정 전 9개 실패했다. `db_rotate_test.sh`: 수정 전 10개 실패(도구 없음, 그리고 재현한 불일치). 지금은 27/27 통과: 새 로그인은 되고 옛 로그인은 거부됨(다른 컨테이너에서 scram 으로 확인), 키 3개만 바뀜, 0600, 임시 파일 없음, verifier 저장됨, 아무것도 출력하지 않음, `--sync` 는 `.env` 를 건드리지 않고 복구함, 실패한 실행은 `.env` 를 그대로 둠.
- **커밋** `1848d33`

### R-82 · web-core — 쓰지 않는 csp-nonce meta 태그가 요청별 스크립트 nonce 를 DOM 에 드러낸다

- **증상** 쓰지 않는 `<meta property="csp-nonce" content={nonce}>` 가 요청별 스크립트 nonce 를 DOM 에 넣어, CSS 속성 선택자가 이를 읽을 수 있다(style-src 가 `'unsafe-inline'` 을 허용).
- **재현 방법** `next/headers` 가 x-nonce 를 돌려주도록 mock 하고 `RootLayout` 을 렌더한다. 수정 전: `expected <html lang="ko"><head><meta property=… not to contain csp-nonce`. 실행 중인 스택의 `/about` HTML 에도 이 meta 가 있었다.
- **원인** `app/layout.tsx` 가 그 meta 태그를 렌더하려고만 `headers()` 로 x-nonce 를 읽었고, 이를 읽는 코드는 없다.
- **수정** meta 태그와 `headers()` 읽기를 지웠다. layout 은 `connection()`(`next/server`)을 불러 모든 경로를 동적으로 유지하므로, Next 는 요청의 CSP 헤더에서 파싱한 nonce 를 계속 스크립트에 적용한다. 확인: `next build` 에서 모든 경로가 ƒ 로 나오고, `next start` 의 HTML 에 csp-nonce 가 없으며, 모든 `<script>` 에 `nonce="<header nonce>"` 가 있다. 상황판은 headless Chromium 에서 CSP 위반 없이 로드된다.
- **회귀 테스트** `tests/layout-nonce.test.ts` 가 HTML 에 csp-nonce 와 nonce 값이 없고 `connection()` 이 한 번 불리는지 확인한다. 수정 전 실패, 수정 후 통과.
- **커밋** `aa7c752`

### R-83 · collector — 마스킹이 패턴 모양만 가리고 실제 비밀값은 가리지 않으며, 여러 로그 경로가 mask() 를 거치지 않는다

- **증상** collector 마스킹은 key=value, Bearer, JWT 모양만 가렸고 실제 비밀값 자체는 가리지 않았다. 여러 로그 경로가 `mask()` 를 건너뛰었다: `kma_radar` 의 `_fail` 이 `repr(e)`(응답 본문 앞부분 포함)를 기록했고, scheduler 의 `log.exception` traceback, ais main 의 `%r` 작업 예외도 그랬다.
- **재현 방법** `mask('{"authKey":"KMA_SECRET_1"}')` 는 키를 보이는 채로 뒀다. 비밀값을 담은 예외를 일반 handler 로 기록하면 그대로 출력됐다.
- **원인** 패턴만 쓰는 마스킹, 그리고 두 프로세스의 root handler 에 로깅 필터가 없었다.
- **수정** `mask` 는 이제 JSON 과 repr 모양(`"authKey": "..."`, APIKey, access_token 등)도 가린다. `register_secrets` 는 설정된 비밀값 자체를 더한다: KMA 키, OpenSky client secret, aisstream 키, Redis·DB 비밀번호(6자 미만 값은 무시). `MaskFilter` 는 각 레코드의 메시지와 args, traceback, stack 을 가린다. collector 의 `main.configure_logging` 과 ais 의 `main._configure_logging` 이 비밀값을 등록하고 root handler 에 필터를 붙이므로, 두 프로세스의 로그 경로가 모두 이를 거친다. `kma_radar` 경고도 `repr(e)` 를 명시적으로 가린다.
- **회귀 테스트** `tests/test_masking.py`: `test_r83_json_shaped_secrets_are_hidden`(파라미터 4개)은 수정 전 실패했다(예: JSON 본문에 `'KMA_SECRET_1'` 이 그대로 있음). `test_r83_registered_secret_values_are_replaced_anywhere`, `test_r83_log_filter_masks_message_args_and_tracebacks`, `test_r83_collector_and_ais_logging_install_the_mask_filter` 는 `register_secrets`, `MaskFilter`, `configure_logging` 이 없어서 수정 전 실패했다. 수정 후 모두 통과한다.
- **커밋** `bec6c76`

### R-84 · api-security — 방화벽 거부가 RFC 9457 problem+json 이 아니고, 보안 헤더를 edge 와 Spring 이 두 번 보낸다

- **증상** 방화벽 거부(`//`, `;x=1`, `/./`)는 Boot 기본 JSON 을, `%2F` 는 Tomcat HTML 오류 페이지를 돌려줬고, RFC 9457 형식이 아니었다. X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy 가 두 번(edge 와 Spring) 전송됐다.
- **재현 방법** `GET /api/v1//ops/providers`, `/api/v1/ops;x=1/providers`, `/api/v1/./ops/providers`, `/api/v1/ops%2Fproviders`: content type 이 `application/problem+json` 이 아니다. `GET /api/v1/status`: edge 가 다시 붙이는 헤더를 api 응답이 이미 싣고 있다.
- **원인** StrictHttpFirewall 의 `RequestRejectedException` 이 컨테이너의 `/error` 처리기로 갔다. Tomcat 은 `%2F` 를 앱보다 먼저 거부하므로 host 의 `ErrorReportValve` 가 HTML 을 썼다. Spring Security 와 edge `security_headers.conf` 가 같은 헤더를 더했다.
- **수정** (1) `RequestRejectedHandler` 빈이 `request_id` 가 든 400 `BAD_REQUEST` problem+json 을 쓴다. (2) `ProblemErrorReportValve` 가 host 가 시작되기 직전에 host 의 `ErrorReportValve` 들을 대체한다. 이 valve 는 컨테이너 수준 오류에 problem+json 을 쓰고 자체 X-Request-Id 를 설정하며, 앱이 이미 쓴 본문은 건드리지 않는다. (3) `ProblemJson` 은 JSON 문자열을 올바르게 escape 하고(instance 는 원문 경로) `SecurityConfig` 가 이를 재사용한다. (4) Spring 은 더는 X-Content-Type-Options 나 X-Frame-Options 를 더하지 않고, Referrer-Policy·Permissions-Policy writer 는 제거했다. 이 헤더들은 edge 가 맡고, api 는 자기 CSP 와 캐시 헤더만 둔다. 후속 커밋이 잘못 놓인 Javadoc 을 해당 빈으로 되돌린다.
- **회귀 테스트** `SecurityIT.rejectedPathsAreProblemDetailsToo` 는 수정 전 실패했다: `content type Expecting "application/json" to start with application/problem+json`. `SecurityIT.responsesCarrySecurityHeadersAndNoCorsGrant`(다시 씀)는 수정 전 실패했다: `X-Content-Type-Options is added by the edge only Expecting empty but was: ["nosniff"]`. `ProblemJsonTest` 가 escape, status 이름, valve 한 번 설치에 대한 단위 테스트를 더한다.
- **커밋** `be2f8b1` · `76e4e64`

### R-85 · infra — Dockerfile 기반 이미지와 uv 바이너리가 태그로만 지정돼 빌드를 재현할 수 없다

- **증상** Dockerfile 기반 이미지와 uv 바이너리가 태그로만 지정돼 빌드를 재현할 수 없었다.
- **재현 방법** 고정되지 않은 참조 11개: `FROM eclipse-temurin:25-jdk/25-jre`, `node:24-alpine`(x3), `python:3.13-slim`(x2), `COPY --from=ghcr.io/astral-sh/uv:0.8`, `# syntax=docker/dockerfile:1.7`(x3).
- **원인** digest 정책이 compose 이미지에만 있었다.
- **수정** 모든 FROM, `COPY --from=<image>`, syntax 줄이 이제 현재 index digest 를 쓴 tag@sha256 이다(`docker buildx imagetools inspect` 로 다시 확인). 각 Dockerfile 에 갱신 명령을 적었다.
- **회귀 테스트** `test_dockerfile_policy.BaseImagePinningTest` 는 수정 전 하위 테스트 11개가 실패했고, 이제 한 파일 안에서 태그마다 digest 가 하나일 것도 요구한다. 다시 빌드한 이미지는 `image_test.sh` 11/11 을 통과한다. trivy 결과는 그대로다: web 0, collector 0, api CRITICAL 3(R-37).
- **커밋** `ae99519`

### R-86 · infra — collector·ais Redis 사용자가 `+@all -@dangerous` 라 스트림을 지우거나 덮어쓰고 api 소비 그룹과 PEL 을 날릴 수 있다

- **증상** collector 와 ais 의 Redis 사용자가 `+@all -@dangerous` 여서, 스트림을 DEL, UNLINK, XTRIM, EXPIRE 하거나 덮어쓸 수 있었고 api consumer group 과 PEL 도 날릴 수 있었다. SCRIPT FLUSH, FUNCTION FLUSH, SELECT 도 실행할 수 있었다.
- **재현 방법** 이전 `start.sh` 를 쓴 일회용 redis 에서 collector 로: `DEL wakeline:aircraft` -> 1, `SET wakeline:aircraft x` -> OK, `EXPIRE` -> 1, `SCRIPT FLUSH` -> OK, `SELECT 1` -> OK, `EVAL` -> 1, DEL 스크립트의 EVALSHA -> 0. ais 사용자도 `wakeline:ships` 에서 똑같았다. `redis_acl_test.sh` 에 실패 31개가 기록됐다.
- **원인** XGROUP 계열만 막는 deny-list ACL.
- **수정** collector 와 ais 는 이제 `-@all` 에서 시작하는 allowlist 를 쓴다. 둘 다 연결 명령(redis-py 8 이 `HELLO 3 AUTH` 로 연결할 때 쓰는 HELLO, 그리고 PING, INFO, CLIENT SETINFO/SETNAME/ID)과 자기 코드가 쓰는 명령을 받는다:
  - collector: XADD, XREVRANGE, HSET, HGET, HGETALL, HMGET, HINCRBY, HDEL, HKEYS, EXISTS, GET, ZRANGEBYSCORE, SCRIPT LOAD, EVALSHA. SET, DEL, EXPIRE 는 이를 쓰는 키에 대한 selector 로만 준다: route·radar 문자열 키에 SET, radar 목록과 이미지에 DEL, `budget:*` 에 EXPIRE.
  - ais: XADD, HSET, HGET, HGETALL.

  api 사용자는 바뀌지 않았다.
- **회귀 테스트** `test_redis_acl_rules.py` 에 수정 전 실패한 정적 테스트 4개를 추가했다. `redis_acl_test.sh` 에는 수정 전 실패한 새 거부 검사 31개가 있고, 이제 219/219 통과한다. 실제 규칙으로 돌린 `collector_redis_test.sh` 도 통과하고, 실제 collector·ais 이미지가 이 규칙 아래에서 40 s 동안 실행되는 동안 ACL LOG 가 비어 있었다.
- **커밋** `4017264`

### R-87 · infra — migrate-from-skywx.sh 가 Redis admin·migrator 비밀번호를 docker CLI argv 로 넘기고, 이미지를 태그로만 지정했다

- **증상** `tools/migrate-from-skywx.sh` 가 Redis admin 과 migrator 비밀번호를 docker CLI argv 로 넘겼다. alpine 과 flyway 이미지는 태그로만 지정됐다.
- **재현 방법** 28행: `exec -T -e REDISCLI_AUTH="$RP"`. 36행: `-e FLYWAY_PASSWORD="$MP"`. 이미지: `alpine:3.22`, `flyway/flyway:11-alpine`.
- **원인** argv 규칙 없이 쓴 일회성 스크립트.
- **수정**
  - redis-cli 는 이제 redis 컨테이너 안에서 컨테이너 자신의 `REDIS_PASSWORD` 로 실행한다(`sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" exec redis-cli …'`).
  - `FLYWAY_PASSWORD` 는 export(셸 내장 명령)하고, 값 없이 `-e FLYWAY_PASSWORD` 로 넘긴다.
  - 두 이미지를 digest 로 고정했다.

  ADR-015 가 이 스크립트를 참조하므로 스크립트는 남겨 둔다.
- **회귀 테스트** `test_scripts_policy.SecretsNotOnArgvTest` 가 `tools/*.sh`, `perf/*.sh`, Makefile 에서 `-e *PASSWORD|SECRET|TOKEN|AUTH*=` 와 고정되지 않은 `docker run` 이미지를 잡아낸다. 수정 전: 4개 실패(28행과 36행, 두 이미지). 지금: 통과한다. 두 방식 모두 일회용 컨테이너로 확인했다: 값 없는 -e 가 컨테이너에 닿고, rename 루프가 동작하며, 컨테이너 Cmd 에 비밀값이 없다.
- **커밋** `b64eec0`

### R-88 · api-data — 기본 권한이 wakeline_api 에 새 표마다 DML 을 주고(fail-open), track_point 파티션에 api 의 직접 DML 이 붙는다

- **증상** 기본 권한이 `wakeline_api` 에 새 표마다 DML 을 줬다(fail-open). ensure 함수가 만든 `track_point` 파티션에 api 의 직접 DML 이 붙었다.
- **재현 방법** `RolePrivilegesDbTest`: 수정 전 `pg_default_acl` 에 `wakeline_api` 에 대한 grant 가 4개 있었고(`expected 0L but was 4L`), 새 `track_point` 파티션에 api SELECT 가 있었다(`track_point_20261001 SELECT expected false but was true`).
- **원인** V1 의 `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wakeline_api`.
- **수정** V9 가 `ALTER DEFAULT PRIVILEGES ... REVOKE` 를 실행해 명시적 GRANT 만 남긴다. 기존 표는 모두 이미 명시적 grant 가 있었다. `track_point_ensure_partitions` 는 이제 ship 함수처럼 새 파티션마다 모든 권한을 revoke 하고, DO 블록이 기존 `track_point` 파티션의 직접 grant 를 revoke 한다. api 는 여전히 부모 표를 통해 읽고 쓴다. 롤백 SQL 은 V9 머리글에 있다.
- **회귀 테스트** `RolePrivilegesDbTest.apiPrivilegesAreExplicitPerTableWithNoDefaultGrants`(표별 권한 스냅샷, 기본 grant 없음, 파티션 grant 없음), 고친 `partitionFunctions...` 테스트, `MigrationDbTest` 의 V9 롤백/재적용 단언. 레인 보고는 "둘 다 수정 전 실패" 라고만 적어 세 시험 중 어느 둘인지 밝히지 않았다. V9 롤백 시험 자체는 R-06(`4c2587f`)에서 V9 와 함께 생겼고, R-88(`efca2ce`)은 여기에 기본 권한 0건·ensure 함수 `REVOKE ALL` 단언을 더했다.
- **커밋** `efca2ce`

### R-89 · api-security — 공개 OpenAPI 가 운영 경로 10개와 요청 스키마를 싣는다

- **증상** 공개 `GET /api/v1/openapi` 가 `/api/v1/ops/**` 경로 10개와 요청 스키마를 나열했다. 익명 운영 요청은 존재를 숨기려고 404 를 돌려주는데도 그랬다.
- **재현 방법** `GET /api/v1/openapi`: paths 에 `/api/v1/ops/settings/{key}`, `/ops/stats/aggregate` 등이 있다.
- **원인** springdoc 이 모든 컨트롤러를 문서화했다. 경로만 설정돼 있었다.
- **수정** `springdoc.paths-to-exclude: /api/v1/ops/**`(ADR-017 §1). `./gradlew updateOpenApi` 로 `openapi/openapi-v1.json` 을 다시 만들었다: 운영 경로와 그 스키마(Login, JsonNode)만 빠졌다. 인증된 운영 문서 엔드포인트는 새 엔드포인트가 되므로 추가하지 않았다.
- **회귀 테스트** `OpenApiSnapshotIT.publicSpecDoesNotDescribeOpsEndpoints` 는 수정 전 실패했다: `ops paths in the public spec Expecting empty but was: ["/api/v1/ops/settings/{key}", "/api/v1/ops/stats/aggregate", ...]`. 스냅샷 테스트는 새 스냅샷으로 통과한다.
- **커밋** `9f7b450`

### R-90 · api-security — 세션·CSRF 쿠키의 Secure 속성이 false 로 하드코딩돼 HTTPS 로 바꾸려면 코드를 고쳐야 한다

- **증상** 세션·CSRF 쿠키의 Secure 속성이 false 로 하드코딩돼, HTTPS 로 바꾸려면 코드를 고쳐야 했다.
- **재현 방법** `wakeline.cookie-secure=true` 로 설정해도 세션 Set-Cookie 는 Secure 없이 `WAKELINE_SESSION=...; Path=/; HttpOnly; SameSite=Strict` 다.
- **원인** `SecurityConfig` 에 `setUseSecureCookie(false)` 와 `.secure(false)` 가 리터럴로 있었다.
- **수정** 두 쿠키 빈이 `wakeline.cookie-secure` 를 읽는다. 값은 env `WAKELINE_COOKIE_SECURE` 에서 오고, loopback 전용 HTTP edge 를 위해 기본값은 false 다.
- **회귀 테스트** `config/SecurityCookieConfigTest.secureCanBeSwitchedOnForHttpsDeployments` 가 `WebApplicationContextRunner` 에서 `SecurityConfig` 를 띄우고 실제 Set-Cookie 를 만든다. 수정 전 실패: `session cookie Expecting "WAKELINE_SESSION=...; Path=/; HttpOnly; SameSite=Strict" to contain "; Secure"`. 기본값 false 테스트는 통과한다.
- **커밋** `20275a2`

### R-95 · api-security — make ops-user 로 비밀번호를 바꿔도 그 사용자의 기존 세션이 살아 있다

- **증상** `make ops-user`(`OpsUserService.upsert`)로 운영자 비밀번호를 바꿔도 그 사용자의 기존 세션이 유효해, 탈취한 세션이 비밀번호 변경 뒤에도 살아남았다.
- **재현 방법** 브라우저 두 개가 it-rotate 로 로그인한 뒤 `users.upsert("it-rotate", newPw)` 를 부른다. 옛 세션 둘 다 `/api/v1/ops/providers` 에서 여전히 200 을 받는다.
- **원인** upsert 는 `ops_user` 만 갱신했다. Redis 세션 저장소는 색인되지 않아 사용자의 세션을 찾을 방법이 없었다.
- **수정** 새 `OpsSessionRegistry`. 로그인 때 최종 세션 id(`changeSessionId` 뒤, security context 저장 전)를 `wakeline:ops:user-sessions:{userId}` 에 TTL = 절대 수명 + 1 h 로 추가한다. 로그아웃은 이를 지운다(best effort). upsert 는 이제 id 를 RETURN 하고, 목록에 있는 모든 `'<namespace>:sessions:<id>'` 키와 목록 자체를 지우며, 지운 수를 돌려준다. Redis 가 실패해도 새 비밀번호는 그대로 적용된다: `SessionsNotRevoked` 를 던지고, CLI 는 분명한 메시지를 출력한 뒤 exit 3 으로 끝난다(다시 실행해도 안전). 성공하면 CLI 는 'ended N existing session(s)' 를 출력한다. 지시대로 먼저 Spring Session 의 `RedisIndexedSessionRepository` 를 시도했으나 쓰지 않았다. 이는 세션 생성 때 PUBLISH 하고 PSUBSCRIBE 와 `CONFIG SET notify-keyspace-events` 가 필요한데, `wakeline_api` ACL 이 이를 모두 막는다(resetchannels, -@dangerous; 일회용 Redis 로 확인). 로그인이 NOPERM 으로 실패하게 된다. registry 는 ACL 이 이미 허용하는 명령으로 같은 일을 한다. DB 마이그레이션은 필요 없었다.
- **회귀 테스트** `SecurityIT.changingThePasswordEndsAllExistingSessionsOfThatUser` 는 수정 전 실패했다: `status of /api/v1/ops/providers expected: 404 but was: 200`. 지금은 통과한다: 두 세션 모두 404, Redis 키가 사라짐, 다른 운영자는 영향 없음, 옛 비밀번호는 401, 새 비밀번호는 동작. 그 밖의 새 테스트: `OpsDbTest.passwordChangeDeletesTheUsersRegisteredSessions` 와 `passwordChangeStillAppliesWhenSessionsCannotBeEnded`(Testcontainers Redis 와 죽은 Redis 사례), 등록/해제와 장애 중 로그아웃에 대한 `OpsSessionControllerTest`, `WakelineApplicationTest.opsUserReportsEndedSessionsAndRevocationFailure`(exit code 0 과 3).
- **커밋** `82bfbc8`

### R-97 · api-security — 세션 쿠키가 Path=/ 라 운영 세션 토큰이 모든 web(Next) 요청에 실린다

- **증상** `WAKELINE_SESSION` 이 `Path=/` 를 써서, 운영 세션 토큰이 `/api` 뿐 아니라 모든 web(Next) 요청에 실렸다.
- **재현 방법** 로그인하면 `WAKELINE_SESSION` 의 Set-Cookie 에 `; path=/;` 가 있다.
- **원인** `DefaultCookieSerializer.setCookiePath("/")`.
- **수정** 세션 쿠키 `Path=/api`(ADR-017 §3). `WAKELINE_CSRF` 는 페이지 JS 가 읽으므로(`apps/web/lib/api.ts`) `Path=/` 를 유지한다. 같은 호스트의 다른 포트로 쿠키가 가는 것은 표준 쿠키 동작이라(RFC 6265 는 포트를 무시) 여기서 고칠 수 없다. 전용 호스트명은 여전히 소유자가 결정할 일이다.
- **회귀 테스트** `SecurityIT.loginSetsHttpOnlySameSiteStrictSessionStoredUnderTheAclNamespace` 가 이제 `; path=/api;` 를 단언한다. 수정 전 실패: `Expecting "wakeline_session=...; path=/; httponly; samesite=strict" to contain "; path=/api;"`. `SecurityCookieConfigTest.sessionCookieIsScopedToTheApiPath` 도 새로 추가했다.
- **커밋** `817ed30`

### 이번 단계에서 고치지 않은 부분(레인 보고)

- **R-02 (NFR-04 < 400 KB gzip 목표만)** · web-core — 중복 다운로드는 고쳤다(gzip 610.6 → 489.6 KiB). MapLibre 가 첫 화면에 있는 한 '/' 를 400 KB 아래로 내릴 수 없다: 앱 코드 전에 Next/React 루트 청크(130.2 KiB)와 MapLibre main(146.5), shared(143.8), worker(6.0)만으로 이미 426.5 KiB 다. 숨은 카드(AircraftCard, ShipPanel 등)를 나눠도 약 10–20 KiB 만 줄고 로딩 깜빡임이 생기므로 하지 않았다. 이 근거로 NFR-04 를 약 480 KiB 로 정할지는 오케스트레이터가 정할 문서·제품 결정이다(리뷰의 방안 4).
- **R-13 (일부)** · infra — 제안의 '최근 백업이 없으면 `make clean` 이 확인을 묻는다' 는 추가하지 않았다. 이를 테스트하려면 개발 스택을 건드리는 `make clean` 을 실행해야 한다. 백업·복원 절차 자체는 완료했고 테스트했다.
- **R-30 (일부: 스타일이 넣는 출처 링크)** · web-ui — 우리 출처 HTML 의 링크는 이제 `tabindex=-1` 이지만, OpenFreeMap 스타일이 더하는 배경지도 출처(링크 약 3개)는 web-core 소관인 `MapView.tsx` 안에서 MapLibre 가 만든다. 알림 패널로 가는 건너뛰기 링크가 `MapView` 를 건드리지 않고 Tab 부담을 없앤다. 원하면 web-core 가 AttributionControl 을 추가한 뒤 `.maplibregl-ctrl-attrib a` 에 `tabindex=-1` 을 설정할 수 있다.
- **R-32 (날짜 입력 min)** · web-ui — 리뷰는 min = 첫 집계일을 제안하지만, 그 날짜를 돌려주는 API 가 없고, 날짜를 지어내면 추측 금지 규칙을 어긴다. max = 어제(UTC)는 설정했고, 서비스 이전 날짜는 이제 약속 대신 'never aggregated' 빈 상태 문구를 받는다.
- **R-41 (일부)** · infra — fake Redis(`apps/collector/tests/fakes.py` 의 evalsha)에 EXPIRE/TTL 을 모델링하는 일은 그 파일이 collector 레인 소관이라 하지 않았다. 대신 예산 Lua 의 TTL 은 이제 CI 에서 실제 Redis 로 검사한다(`collector_redis_test.sh`).
- **R-52 (좌표 중복 제거 부분)** · api-data — 상한과 `truncated` 플래그는 끝냈다. 중복 좌표를 없애면 어느 쪽을 지우든 소비자 하나가 깨진다. web 은 `points[].lon/lat` 를 읽고(`apps/web/components/MapView.tsx:630` 와 `lib/track.ts` 의 `trackFromRest`), 응답은 LineString geometry 를 가진 GeoJSON Feature 로 남아야 한다(RFC 7946, `rest_contract_check` 가 검사). ADR-017 은 R-52 에 'no web impact' 라고 적었으므로, 둘 중 하나를 빼려면 web 과 계약을 함께 바꿔야 한다. 중복분은 payload 의 약 14 % 이고, 새 5,000점 상한이 전체 크기를 제한한다. web 레인과 일정을 잡도록 오케스트레이터에게 남긴다.
- **R-63** · infra — 옮겨 갈 새 digest 가 없다. 2026-09-28 에 레지스트리는 `imresamu/postgis:18-3.6` 에 대해 이미 고정한 digest(`sha256:b5766ee7…`, 2026-02-09 생성, PG 18.1, Debian 13.3)를 돌려준다. Debian/trixie 태그는 2026-02-09 이후 다시 빌드되지 않았고, 오프라인 trivy 는 여전히 고칠 수 있는 고유 CVE CRITICAL 9 / HIGH 76 을 보인다.

  다시 빌드된 -alpine 변형(`18-3.6-alpine3.23`, PG 18.6)은 같은 볼륨에 그대로 바꿔 끼울 수 없다. OS 패키지는 깨끗하지만 gosu 의 Go stdlib 에 CRITICAL 1 / HIGH 21 이 있다. Debian 이미지가 초기화한 볼륨에서 이를 띄우면 텍스트 정렬이 바뀌고(`'a' < 'B'` 가 t 에서 f 로) collation 버전 경고가 나며, 이는 기존 텍스트 인덱스를 조용히 망가뜨린다.

  이미지를 바꾸려면 ADR-004 결정이 필요하다. 예: apt upgrade 를 하는 얇은 Dockerfile, 백업/복원을 거친 Alpine 이미지, 또는 공식 postgres 와 pgdg PostGIS. 커밋 `eef9c23` 는 조회·검증·갱신 절차와 이 제약을 `compose.yml` 에 문서로만 남긴다. `ci.yml` 은 db 를 보고 전용(report-only)으로 둔다.
- **R-80 (일부)** · infra — 하지 않은 것: initdb 뒤 db 컨테이너에서 서비스 DB 비밀번호를 없애는 일(별도의 init 전용 서비스 설계가 필요), 그리고 '공개 배포' 스위치나 ADR 메모(소유자 결정과 문서 작업이며, 쿠키 Secure 는 다른 레인의 R-90).

## 4. 수정 검증(2차) — 독립 검토자가 1차 수정에서 찾은 문제

1차 수정 90커밋을 합친 뒤, 수정 레인마다 독립 검토자가 코드를 다시 열고 시험을 돌려 **35건**(Medium 10 · Low 25)을 보고했다. 모두 아래에서 처리했다.
고친 순서는 심각도 순이고, 버그·보안 항목은 **먼저 실패하는 시험을 쓰고(실패 확인) 고친 뒤 통과를 확인**했다.

### R-98 · 보안 · Medium(3단계에 새로 추가) — 경로를 퍼센트 인코딩하면 운영 세션 절대 수명·CSRF·요청 제한을 건너뛴다
- **증상** `/api/v1/%6Fps/providers` 처럼 경로 글자를 인코딩하면 만료된 운영 세션으로 200, CSRF 헤더 없이 쿠키만으로 `POST /api/v1/%6Fps/providers/opensky/disable` 204(공급자가 실제로 꺼짐), 분당 한도를 넘긴 뒤 `GET /%61pi/v1/status` 200.
- **재현 방법** 실제 HTTP(Tomcat·Spring Security 방화벽 포함)로 보내는 `SecurityIT` 시험 3개 — 수정 전 각각 200(기대 404) · 204(기대 403) · 200(기대 429). 익명 `GET /api/v1/%6Fps/providers` 는 수정 전에도 404(인가 자체는 디코딩해 맞춤).
- **원인** `OpsSessionLifetimeFilter`·CSRF 면제 규칙·`RateLimitFilter` 가 원문 `getRequestURI()` 앞부분으로 대상을 골랐다. 인가 규칙과 Spring MVC 는 퍼센트 디코딩한 경로 조각(PathPattern)으로 맞춘다. edge 는 `proxy_pass http://api;`(URI 없음)라 원문 URI 를 그대로 넘기고, StrictHttpFirewall 은 `%6F` 같은 일반 글자 인코딩을 막지 않는다.
- **수정** 경로 판단을 인가와 같은 매처 하나로(`ApiPaths` — `PathPatternRequestMatcher`). 원문 URI 앞부분 비교 3곳을 없앴다.
- **회귀 테스트** `SecurityIT.percentEncodedOpsPathCannotSkipTheLifetimeCheck` · `percentEncodedOpsPathStillNeedsCsrf` · `anonymousPercentEncodedOpsPathIs404` · `publicApi121stRequestGets429WithRetryAfterAndForgedForwardedForIsIgnored`(인코딩 경로 줄) · `OpsSessionLifetimeFilterTest.percentEncodedOpsPathIsCheckedLikeTheAuthorizationRule`
- **커밋** `81c49c0`

### R-49 · 보안 · Medium — 클라이언트가 보낸 X-Request-Id 를 api 가 그대로 믿었다
- **증상** api 는 edge 에서 온 형식이 맞는 `X-Request-Id` 를 요청 id 로 쓰는데, edge 가 클라이언트 헤더를 그대로 넘겨 누구나 로그·오류 본문의 상관 id 를 고를 수 있었다.
- **재현 방법** `infra/tests/edge_test.sh`(버리는 컨테이너) — `X-Request-Id: forged-client-id-0001` 이 가짜 상류까지 그대로 도착(수정 전 "위조 X-Request-Id 덮어쓰기" FAIL).
- **원인** `infra/edge/proxy_headers.conf` 가 `X-Forwarded-For` 는 덮어쓰지만 `X-Request-Id` 는 두었다.
- **수정** `proxy_set_header X-Request-Id $request_id;` · edge 접근 로그 형식에 `rid=$request_id rt= urt=` — edge 와 api 로그 줄이 같은 id 로 이어진다.
- **회귀 테스트** `infra/tests/test_edge_policy.py`(정적) · `edge_test.sh`(32 통과 · 0 실패)
- **커밋** `65e8ccf`

### R-54 · 보안 · Medium — 절대 수명 필터가 인코딩한 경로를 건너뛴다
R-98 과 같은 원인·수정(`81c49c0`). 절대 수명 IT 는 인코딩 경로로 다시 확인했다.

### R-95 · 보안 · Low — 로그인과 비밀번호 교체가 겹치면 옛 비밀번호로 만든 세션이 살아남는다
- **증상** 로그인은 읽어 둔 해시로 비밀번호를 확인한 뒤 세션 id 를 사용자 목록에 올리고, 세션 해시는 요청 끝에 저장된다. 그 사이에 교체(`upsert → revokeAll`)가 끼면 목록 삭제가 새 세션을 놓친다.
- **재현 방법** 경합에서 진 결과를 직접 만든다 — 로그인 뒤 해시만 바꾸고(목록 삭제 없음) 다음 운영 요청: 수정 전 200(기대 404). `SecurityIT.sessionFromBeforeAPasswordChangeEndsEvenIfRevocationMissedIt`.
- **원인** 세션 폐기가 "목록에 있는 세션 지우기" 하나에 의존했다(순서에 민감).
- **수정** 세션을 로그인 때 확인한 비밀번호 해시의 표식(SHA-256 앞 16바이트, 같은 행에서 읽음)에 묶고, 운영 요청마다 지금 값과 비교 — 다르거나 사용자·표식이 없으면 세션을 끝낸다. DB 를 읽지 못하면 503(세션 유지). 배포 직후 표식 없는 기존 세션은 한 번 다시 로그인(ADR-017 §3).
- **회귀 테스트** 위 IT · `OpsSessionLifetimeFilterTest.sessionIsBoundToTheCredentialItWasCreatedWith` · `OpsSessionControllerTest`(세션에 표식 저장)
- **커밋** `dbe5790` · `54c9043`(시험 컨텍스트 보강 — 아래 시험 문제 표)

### R-90 · R-06 · Low/Medium — 설정값이 compose 에서 api 로 전달되지 않았다
- **증상** `application.yml` 은 `WAKELINE_COOKIE_SECURE`·`WAKELINE_ALERT_RETENTION_DAYS` 를 읽지만 api 서비스는 환경변수를 명시 목록으로만 받아 두 값을 바꿀 방법이 없었다(보존 삭제를 끄는 되돌리기 수단 포함).
- **재현 방법** `test_compose_policy.test_api_cookie_secure_and_alert_retention_pass_through` — 수정 전 KeyError.
- **수정** `.env` 의 `COOKIE_SECURE`(기본 false) · `ALERT_RETENTION_DAYS`(기본 30)를 api 로 전달, `.env.example` 에 설명.
- **커밋** `b48916d`

### R-18 · 아키텍처 · Medium — 영구 손실이 운영 화면에 없었다 · 시작 시각을 모르는 트림 손실이 사라졌다
- **증상** (1) DB 가 거절해 재시도 없이 버린 항적·선박 행, 처리 중 예외로 건너뛴 메시지, 이벤트 리스너 오류가 `GET /api/v1/ops/pipeline` 에 없었다. (2) api 가 `last_stream_trim_loss.from = null`(시작 모름)로 보내면 웹이 구간 전체를 버렸다. (3) 수집기·ais 의 스트림 바이트 예산 트림 수(`stream_budget_trims`)가 운영 화면에 없었다(R-14 연계).
- **재현 방법** `OpsPipelineIT.reportsCollectorAisAndApiLossSignalsWithNullForUnknown`(수정 전 `api.track_rows_failed` · `collector.stream_budget_trims` 없음) · `review-v1-ui.test.ts` "permanent losses…" · "…from=null…" · "R-14 stream budget trims…"(수정 전 실패).
- **수정** `track_rows_failed` · `ship_rows_failed` · `stream_apply_errors` · `listener_errors` · `collector/ais.stream_budget_trims` 추가(모름은 null — 0 으로 채우지 않음), 웹 손실 행 추가, 시작 모름은 "시작 모름" 으로 표시.
- **결정** 공개 `/status` 에는 싣지 않는다(프로세스별 누계·내부 이름 — 공개 쪽 신호는 `/healthz` 의 `degraded`+`reasons`) — ADR-017 §5. 검토자가 지적한 OpenAPI camelCase 문제는 R-89 로 운영 경로가 공개 문서에서 빠져 더는 없다(스냅샷에 운영 스키마 0).
- **커밋** `0f443e7` · `c1a9b78` · `14dca2a`

### R-04 · 코드 · Medium — 전세계 공급자(OpenSky)로만 잡힌 항공기의 항적이 전부 "수신 없음" 점선
- **증상** 공백 기준이 60 s 하나라 약 120 s 마다 오는 OpenSky 점 사이가 모두 공백으로 그려졌다.
- **재현 방법** `tests/track-gaps.test.ts` — OpenSky 120 s 간격 점 3개가 수정 전 `['gap','gap']`(기대 `['track','track']`).
- **원인** 구현이 "항적 점에는 공급자가 없다" 고 보았지만 REST `points[]` 에 `provider` 가 있다(`TrackRepository.track()`).
- **수정** 선분마다 두 끝점 공급자 중 느린 쪽의 상황판 기준(`thresholds()` — 지역 60 s · OpenSky 300 s), 공급자를 모르면 60 s. 공급자는 기록된 값이다.
- **커밋** `09d9fd7`

### R-05 · 코드 · Medium — 재생 요청이 실패한 뒤 상세 창이 "기록 없음" 이라고 말했다
- **증상** 실패하면 프레임을 비우는데(R-05), 열린 상세 창이 빈 프레임에서 찾아 "이 시각·이 영역에 기록 없음" · "이 시각에 유효하지 않은 SIGMET" 을 보였다 — 서버가 말하지 않은 사실.
- **재현 방법** `review-v1-ui.test.ts` "…the inspector says the record is unknown…" — 수정 전 실패.
- **수정** 프레임이 없으면 "불러오지 못해 알 수 없음(오류)" · "불러오는 중", 응답이 말해 준 경우에만 "기록 없음".
- **커밋** `a41fa91`

### R-13 · R-80 · Medium — 권한 시험이 Linux(CI)에서 항상 실패
- **증상** `stat -f %Lp f || stat -c %a f` 는 GNU stat 에서 `-f`(파일 시스템 상태)로 해석돼 파일 시스템 정보가 먼저 출력되고 값이 틀린다.
- **재현 방법** `test_scripts_policy.PortableShellTest` — 수정 전 3곳 보고.
- **수정** 권한을 `python3 os.stat` 로 읽는 `file_mode`.
- **회귀 테스트** 위 정책 시험 · `db_backup_test.sh`(48/0) · `db_rotate_test.sh`(27/0)
- **커밋** `4ef2699`

### R-80 · 보안 · Medium — 격리 스택용 비밀번호 교체가 개발 스택의 `.env` 를 바꿨다
- **증상** 두 스택은 같은 `.env` 를 읽는다. `make rotate-db-passwords P=wakeline-e2e` 가 격리 스택 역할을 새 값으로 바꾸고 `.env` 를 덮어써, 개발 DB 가 옛 값으로 남았다(다음 `make up` 에서 인증 실패).
- **재현 방법** `infra/tests/test_db_rotate_tool.py` — 거부·안내 시험이 수정 전 실패.
- **수정** 새 값은 개발 스택에서만 만든다. 다른 프로젝트는 docker 를 부르기 전에 거부(`--sync` 만 허용). 교체 뒤 DB 볼륨이 남은 다른 스택이 있으면 맞추는 명령을 알린다. README 에 규칙.
- **커밋** `40a652e` · `7c00f42`

### R-13 · 아키텍처 · Low — 백업을 무기한 쌓았다
- **증상** 승인한 개선안(보관 개수)이 빠져 있었다. 백업에는 운영자 비밀번호 해시·감사 로그가 들어 있다.
- **재현 방법** `db_backup_test.sh` "보관 개수" 블록 — 수정 전 4개가 남음(기대 2).
- **수정** 새 백업을 확인한 뒤 같은 대상의 최신 `KEEP` 개(기본 10, `make backup keep=N`, 0 = 모두)만 남긴다. 이 도구의 이름 형식만 지우고, 지운 파일을 출력한다.
- **커밋** `a60c098`

### R-77 · R-64 · Low — 망이 강제한다는 설명이 사실보다 넓었다
- **증상** `public` 은 일반 bridge 라 edge 는 인터넷에 나갈 수 있다. 버리는 망으로 `enable_ip_masquerade=false` 를 시험했지만 Docker Desktop 에서 컨테이너가 외부에 닿았다(실측). 망 구성이 바뀐 뒤 일부만 다시 만들면 고정 IP 를 잃는다(검토자 실측).
- **수정** compose·ADR-017 의 설명을 사실대로(망이 막는 것은 web·api·migrate·db·redis), edge 는 설정으로 막는다 — 새 정책 시험(upstream 은 `api:8000`·`web:3000` 뿐, 모든 `proxy_pass` 가 그 둘, `resolver` 없음, 변수 `proxy_pass` 없음). 망 구성 변경 배포는 `make down` → `make up`.
- **커밋** `75d6c49`

### R-63 · 보안 · Low — db 이미지 CRITICAL 차단(임시안)을 적용도 거절도 하지 않았다
- **결정** 거절하고 이유를 `ci.yml` 에 적었다 — 고칠 수 있는 CRITICAL 이 약 20건이고 새 다이제스트가 없어 차단하면 모든 CI 가 실패한다. 교체안(공식 postgres:18 + Debian postgis 패키지로 직접 빌드 · Alpine 판)은 사용자 결정.
- **커밋** `c1fdd1c`

### R-43 · 코드 · Low — 응답하지 않는 Redis 에 호출 하나가 약 46 s 걸렸다
- **증상** 연결은 받지만 답하지 않는 Redis 에 `Publisher.publish` 가 46.3 s 동안 연결 9번 시도 뒤 대기열로(검토자 측정). `DemandPoller.poll` · `Budget.reserve` · ais 상태 쓰기도 같았다.
- **재현 방법** `tests/test_main.py::test_r43_calls_give_up_within_seconds_when_redis_accepts_but_never_answers` — 받기만 하는 TCP 서버, 수정 전 다섯 호출 모두 15 s 상한에 걸림.
- **원인** redis-py 가 연결 핸드셰이크와 명령 두 층에서 재시도하고, 재시도 대상에 시간 초과가 들어 있었다: (1+2)×(1+2)×5 s.
- **수정** 재시도는 빨리 실패하는 연결 오류(거부·리셋)만, 소켓 시간 초과 2 s(`REDIS_SOCKET_TIMEOUT_S`). 같은 서버에 publish 2.0 s · 연결 1번.
- **커밋** `aa5e7b3`

### R-03 · 코드 · Low(2건) — 기상청 레이더 메타가 다른 프레임 값으로 바뀜 · 자정 전날 목록 실패가 주기 전체를 버림
- **증상** (a) 과거 빈 칸만 채운 주기가 메타의 헤더 값·`fetched_at` 을 그 오래된 프레임 것으로 덮었다(`latest_tm` 은 최신 프레임 — 서로 어긋나고, 새로워 보이는 `fetched_at` 이 STALE 배지를 가릴 수 있음). (b) KST 00:00–00:14 의 전날 목록 호출이 실패하면 오늘 목록이 성공했어도 주기 전체를 잃었다.
- **재현 방법** `test_kma_radar.py::test_r03_backfilling_an_older_hole_keeps_meta_on_the_latest_frame`(수정 전 `('S1955','1955') != ('S2000','2000')`) · `test_r03_previous_day_listing_failure_keeps_todays_cycle[3종]`(수정 전 받은 프레임 0) · `test_r03_previous_day_listing_without_budget_records_no_run_of_its_own`(수정 전 `['budget_exhausted','ok']`).
- **수정** 헤더·`fetched_at` 은 저장한 프레임이 최신일 때만. 전날 목록은 따로 예외 처리·예산 예약(실행 기록을 따로 남기지 않음).
- **커밋** `b949820` · `47d7410`

### R-68 · 코드 · Low — 날짜변경선 METAR 상자 하나가 실패해도 성공으로 기록
- **재현 방법** `test_weather_jobs.py::test_r68_one_antimeridian_box_failing_is_not_reported_as_success[provider_error|budget_exhausted]` — 수정 전 연속 실패 수가 0 으로 초기화됨.
- **수정** 상자가 하나라도 빠지면 받은 관측은 저장하되 성공·heartbeat 는 쓰지 않는다(실패는 이미 기록됨).
- **커밋** `2d01493`

### R-01 · 코드 · Low(2건) — 멈춘 지도 스타일 호스트 · 대체 스타일 안내가 출처 표기를 가림
- **증상** (a) 스타일 호스트가 패킷을 버리면 오류 이벤트가 오지 않아 몇 분 동안 지도 레이어가 없었다. (b) 안내 배너가 1440×900 에서 출처 표기 왼쪽을 가렸다.
- **재현 방법** `tests/mapview-lifecycle.test.ts` 가짜 타이머 시험 — 수정 전 15 s 뒤에도 `setStyle` 0회 · 배너 클래스에 `bottom-10`.
- **수정** `STYLE_LOAD_TIMEOUT_MS = 15_000`(저장소의 다른 네트워크 한도 8 s · 10 s · 5 s 보다 길게) 뒤 로컬 대체 스타일, 늦게 온 스타일로 되돌아가지 않음. 배너는 줌 버튼 아래 왼쪽 위로.
- **커밋** `ce7189b` · `ef6ddd6` · `725cc38`

### R-09 · R-58 · R-11 · R-12 · R-47 · R-08 · R-32 · R-02 · UI/UX·코드 · Low
| ID | 증상 → 수정 | 회귀 테스트 | 커밋 |
|---|---|---|---|
| R-09 | 정상 첫 연결 중 지역 지연 배지가 빨강 → 첫 연결 시도 중 값이 없으면 노랑(`lagTone`), 실제 지연·실패 뒤 무자료는 빨강 유지 | `alert-panel.test.ts` "the region lag badge (NO DATA)…" | `f2a65f1` |
| R-58 | 연결은 열려 있고 수신만 없는 상태에서 ETA 툴팁이 "연결이 끊겨" → 상태별 문구 | `alert-panel.test.ts` "the frozen ETA's tooltip names the state…" | `fdea31c` |
| R-11 | 기상청 레이더를 골랐는데 없을 때 타임라인에 이유 없음 → "기상청 레이더 없음" + 서버 안내 + 마지막 수집 시각(있을 때만) | `mapview-lifecycle.test.ts` "RadarTimeline: KMA chosen but unavailable says why" | `4c9aa10` |
| R-12 | 운영 화면 "갱신" 시각이 아무 GET 성공으로 바뀌어 실패 중인 탭이 가려짐 → 탭별 마지막 성공·실패 표시 | `ops-page.test.ts` "R-12 ops…" 2건 | `66f7313` |
| R-47 | 대기 요청이 실패한 요청과 같으면 실패를 삼켜 "불러오는 중" 이 계속 → 실패를 알림 | `review-v1-ui.test.ts` "…T1 → T2 → T1, T1 fails" | `22b998e` |
| R-08 | 줌 < 7 에서 날짜변경선을 넘는 화면이면 구독 영역(위도 띠 전체) 기준이라 지도가 이동하지 않음 → 보이는 지도 경계 + 경도 감김 처리 | `review-v1-ui.test.ts` "…zoom 3 over the Pacific…" · `mapview-lifecycle.test.ts` | `ff867bc` |
| R-32 | (a) 날짜를 못 읽은 통계 행이 하나로 합쳐져 값이 덮임 → 따로 둠 (b) 원본 항적(72 h)이 이미 지워진 날에도 "다음 집계 뒤 채워집니다" → 보존 안일 때만 약속 | `review-v1-ui.test.ts` R-32 2건 | `851ea6a` · `63fbece` |
| R-02 | CSP 주석이 "MapLibre 는 번들" → 실제 로드 방식(`/maplibre/<버전>/`, `'strict-dynamic'`) | `maplibre-load.test.ts` | `56bfcca` |

### 합친 뒤 드러난 시험 문제(제품 코드 아님)
| 항목 | 원인 → 수정 | 커밋 |
|---|---|---|
| api IT 9건 NOPERM | R-86 명령 허용 목록 뒤 시험 도우미가 collector·ais 사용자로 `HMSET`·`ZSCORE`·`ZRANGE`·`ACL WHOAMI` 를 썼다 → 쓰기는 필드별 `HSET`(실제 사용 명령)으로, sorted set 조회(`ZSCORE`·`ZRANGE`)는 관리자 사용자로, `ACL WHOAMI` 는 NOPERM 응답의 사용자 이름으로 확인. 운영 ACL 은 넓히지 않았다 | `e7ead54` |
| api `SecurityCookieConfigTest` 컨텍스트 기동 실패 | R-95(`dbe5790`) 뒤 `SecurityConfig` 필터 체인이 자격 확인용 `OpsUserService` 를 요구해, 이 빈이 없는 최소 쿠키 시험 컨텍스트가 뜨지 않음 → 시험에 mock 등록. 운영 코드의 의존은 그대로 둔다(자격 확인이 빠지면 기동 자체가 실패) | `54c9043` |
| 웹 시험 2건 | R-09 의 "지역 설정 수신 전" 상태가 알림을 가림 → 지역이 있는 상태로 시험 | `e7ead54` |
| CI 실 Redis 시험 | R-86 뒤 없어진 `COLLECTOR_DENY` 를 읽어 시험 전에 실패(CI collector job 이 빨간불이었을 것) + 이어 붙인 `COLLECTOR_KEYS` 줄을 놓침 → start.sh 와 같은 규칙으로 사용자 생성 | `17594a1` |

### 4단계 재측정·사실 확인에서 나온 수정
재측정과, 이 문서의 모든 수치·커밋·시험 이름을 원자료와 대조한 사실 확인에서 나온 것이다. 사실 확인은 절마다 독립 확인자가 원자료(측정 파일·git·시험 코드)와 대조하고, 제기된 불일치마다 다른 확인자가 반박을 시도했다 — 1차: 제기 56건 중 반박 14건, 확인 42건. 고친 뒤 다시 쓴 부분·근거 파일·프로젝트 문서를 2차로 다시 대조해 제기 44건 중 반박 5건, 확인 39건(R-50 미이행 발견 포함). 3차(2차 수정 반영 · R-50 ADR · 근거 파일)에서 제기 16건 중 반박 2건, 확인 14건 — 모두 고쳤다. 같은 방식으로 collector 코드의 메모리 증가 원인을 감사했다(3개 갈래, 후보마다 반박 검증).

| 항목 | 증상 → 원인 → 수정 | 회귀·근거 | 커밋 |
|---|---|---|---|
| R-25 후속 · api 메모리 | 힙 비율을 줄여도(기본 아레나 32) 버리지 않은 실행 최대·끝 628–672 MiB(10:45 · 11:31 · 11:46) → NMT: JVM 이 쓴 것 427 MiB, 같은 순간 프로세스 익명 메모리 588 MiB — 약 160 MiB 는 JVM 밖 스레드별 glibc malloc 아레나(`api-native-memory-tracking.txt`) → 실행 이미지 `MALLOC_ARENA_MAX=2` | `test_dockerfile_policy.ApiNativeMemoryTest` · §1.1 · §2 NFR-03 | `3b2255f` |
| collector 메모리 | 기본 설정에서 재기동 뒤 40분에 RssAnon 99 → 289–298 MiB(한 시점 VmHWM 376 MB — 세션 출력, evidence 에 옮김), 계단식 — 누수는 아님(키 공간·스레드 수 모두 유한: 기본 풀 최대 8). 기상청 레이더 해석(수십 MB numpy 버퍼)이 공용 풀의 아무 스레드에서 돌아 스레드마다 아레나가 최고점을 따로 쥠 — 해석은 기준선부터 풀에서 돌았고 R-21 이 풀을 쓰는 호출을 늘린 것으로 본다(추정) → 해석은 전용 스레드 1개 · 이미지 `MALLOC_ARENA_MAX=2`(ais 도 같은 이미지) | `test_kma_radar.py::test_decode_runs_on_one_dedicated_thread_not_the_shared_pool` · `CollectorNativeMemoryTest` · 재기동 뒤 40분 RssAnon: 수정 전 99 → 289–298 MiB(계단식) · 수정 뒤 88 → 173–217 MiB(8스레드에서 평탄) — `evidence/memory-and-contention-samples.txt` | `05b895b` |
| `javac -Xlint` 경고 | 재측정 23(기준선 19) — 리뷰 코드가 만든 4건(this-escape 2 · serial 1 · this-escape 이어짐 1) → 두 클래스 `final` · `serialVersionUID` | 경고 수 19 | `931ed30` |
| Semgrep 9건 | Dependabot cooldown 없음 6 · `$host` 3 → 버전 갱신 7일 대기(보안 갱신에는 걸리지 않음 — GitHub 문서 확인) · `proxy_headers.conf` 는 Host 허용 목록을 통과한 값만이라 `nosemgrep` 로 사유 기록 · ADR 본문 예시 2건은 `docs/` 를 스캔 범위에서 뺌 | `test_ci_policy.DependabotCooldownTest` · 같은 규칙 파일로 오프라인 재실행 0건 | `af746de` · `b9f87fd` |
| 최종 측정의 api 시험 1건 | `ShipsIT.wsShipsLayer_snapshotThenDiffWithContiguousSseq` 가 20 s 안에 `ships_diff` 를 못 받음(호스트 부하 중) — 선박 팬아웃은 10 s 에 한 번 모으므로 20 s 는 두 주기뿐. 조용할 때 3/3 통과 → 창을 30 s(세 주기)로 | 전체 재실행 534/0 · LINE 95.9 % · BRANCH 83.6 % · REST 27/27 | `ff57ab4` |
| R-02 후속 · E2E 429 | 최종 코드의 E2E 가 4/16 실패 — edge IP당 제한 429(`limiting requests … zone "perip"`). R-02 가 MapLibre 를 `/_next/static`(제한 밖)에서 `/maplibre/<버전>/`(`location /`, 제한 안)으로 옮겨 첫 화면마다 양동이를 3–4칸 더 썼고, 병렬 작업자는 같은 IP 라 양동이를 넘겼다(느린 날엔 통과) → `/maplibre/` 를 `/_next/static` 처럼 제한 밖·1년 immutable 로, UI 시험은 작업자 1명으로(재시도로 가리지 않음) | `edge_test.sh`(양동이가 찬 뒤 `/maplibre` 100회 429 0) · `StaticAssetsTest` · `make e2e` 16/16 연속 2회 | `c27b2d5` |
| R-50 | 두 번째 문서 사실 확인에서 승인 항목 중 R-50(ADR·README·compose 주석이 계약 v1–v4 보다 뒤처짐)만 커밋이 없는 것을 찾음 → ADR-001·003·005·008 에 '이후 변경' 과 현재 값, compose 주석 2곳, README 수치 · 싼 문서 검사(README 의 Flyway 범위 · ADR 수 · 계약 범위를 저장소와 대조) | `test_scripts_policy.ReadmeFactsTest`(옛 README 에서 3건 실패) | `0ab26cd` |
| R-60 일부 | 2단계 계획("재생 두 뜻만 고침")이 실행되지 않았음(사실 확인에서 발견) → 레이더 버튼 '애니메이션 ▶' | `mapview-lifecycle.test.ts` "…does not reuse the menu word '재생'" | `0806b37` |

### 부분 처리로 남긴 것
- **R-27**(일 통계가 하루 파티션 전체를 읽음): 디스크 정렬 넘침은 고쳤다(1차). 나머지 절반(그날 1분 요약이 완전하면 `track_point_1m` 에서 세기)은 요약 행에 지역을 기록해야 결정적으로 판단할 수 있어 스키마 변경이 필요하다 — 하루 1회 배치(요청 경로 아님)라 이번 범위에서 뺐다.

## 5. 남은 문제
### 5.1 보류한 항목(2단계 승인 기록, 13건)
| ID | 영역 · 심각도 | 제목 | 보류 이유 |
|---|---|---|---|
| R-36 | 아키텍처 · Medium | 스키마 밖의 두 번째 언어 간 계약(공유 DB 테이블·Redis 해시)을 검사하지 않음 | DB·Redis 해시 계약 검사 도입은 구조 작업 — R-36 으로 따로 보강한 시험은 없다. 관련 부분만 다른 항목에서 고정했다: `/status` 의 radar_kr 는 허용 목록 필드만 싣고 REST 계약 검사로 잠갔다(R-72 `bdb9a6e`), `wakeline:ais:status` 손실 신호 필드는 R-18 시험(`d1e69e6` · `e970760`)이 고정한다. route 캐시 값에는 시험을 추가하지 않았다 |
| R-48 | 코드 · Low | 서버 값 검증 헬퍼가 4개 모듈에 복제돼 있고 규칙이 서로 다르다. 죽은 코드와 1,100줄 ships.ts도 있다 | 검증 헬퍼 통합 리팩터(동작 결함 아님) |
| R-60 | UI/UX · Low | 한국어와 영어가 섞인 용어, 같은 화면의 '재생' 두 가지 뜻, 내부 코드가 그대로 노출된다 | 화면 용어 전면 정리(M) — 다음 단계. 2단계 계획의 '재생 두 뜻'은 4단계에서 고쳤다(`0806b37`, 레이더 버튼 '애니메이션 ▶') |
| R-61 | 성능 · Medium | 지역 10 s 갱신마다 병합 뷰 전체(전세계 약 1만 대)를 스트림 소비 스레드에서 다시 판정한다 | 엔진 증분 판정은 구조 변경(L) — 측정상 전세계 예산 300 ms 안(리뷰 전 09-27 PERF §6 p95 109 ms · 2단계 검증 p95 56–268 ms · 4단계 운영 주기 p95 159 ms · 최대 171 ms, §2 NFR-05)이라 다음 단계 |
| R-65 | 아키텍처 · Low | '보내지 않은 호출' 판정과 Throttled 처리가 작업마다 제각각 (예산 되돌림·실패 집계 불일치) | 작업마다 흩어진 '보내지 않은 호출' 처리를 한 곳으로 모으는 리팩터 — 동작 결함은 개별 수정으로 막았고 구조 변경은 다음 단계 |
| R-69 | 코드 · Low | AlertStateMachine 의 '이전 시그니처' 분기(scopes == null)는 운영에서 도달 불가인데 FSM 단위 테스트 24개 중 21개가 그 분기만 검증 — 그 밖의 테스트 전용 운영 API 다수 | FSM 테스트를 새 시그니처로 옮기는 리팩터(동작 결함 아님) |
| R-76 | 아키텍처 · Low | WebSocket 프로토콜(16종 메시지)에 기계 검사되는 언어 간 계약이 없음 | WS 16종 메시지의 기계 검사 계약은 스키마 설계가 필요한 구조 작업 |
| R-81 | 성능 · Low | 전세계 뷰 WS 스냅샷 1.2 MB(원본 JSON) — 설계의 저해상 형식(소수 2자리·필드 6개)보다 크다 | 전세계 저해상 인코딩 개편은 WS 프로토콜 변경(M) — 다음 단계 |
| R-91 | 코드 · Low | DB writer가 결과가 모호한 실패(커밋 뒤 시간 초과)에도 record_run을 다시 실행해 중복 기록·이중 집계가 생길 수 있음 | 커밋 뒤 시간 초과의 모호한 실패 — 멱등 키(ingest_run 자연키) 설계가 필요해 다음 단계 |
| R-92 | 코드 · Low | TrackWriter 가 ReceiptBatchQueue(일반화 버전)와 같은 영수증 알고리즘·쓰기 루프를 손으로 다시 구현 — 이미 ShipWriter 와 방어 로직이 어긋났다 | TrackWriter 를 ReceiptBatchQueue 로 합치는 리팩터(동작 결함 아님, 위험 대비 이득 작음) |
| R-93 | 코드 · Low | 항공기·알림·selected·radar·sigmets 메시지를 검증 없이 캐스팅한다. 원소 하나가 잘못되면 부분 적용 뒤 지도(워커)와 카드가 갈라진다 | 메시지 전체 검증 도입은 프로토콜 계약(R-·WS 스키마)과 함께 설계해야 함 |
| R-94 | 아키텍처 · Low | 운영자 공급자 스위치가 Redis에만 있고, collector가 쓸 수 있는 키를 공유함 | 공급자 스위치 저장소 이전(DB)은 운영 계약 변경 — 다음 단계 |
| R-96 | 보안 · Low | IP 단위 제한이 호스트 전체 한도가 되고, 계정 단위 잠금과 겹쳐 로컬 프로세스가 운영자를 계속 잠글 수 있음 | IP·계정 제한 재설계(M) — 로컬 단일 사용자 환경에서 발생 가능성 낮음 |

### 5.2 부분 처리·고치지 않은 부분
| ID | 남은 것 | 이유 |
|---|---|---|
| R-02 | 첫 화면 JS 497.7 KiB — NFR-04 의 400 KB 초과 | MapLibre(main 146.5 · shared 143.8 · worker 6.0 KiB)와 Next/React 루트(130.2 KiB)만으로 426.5 KiB(레인 측정). 숨은 카드 분할은 약 10–20 KiB 뿐이고 로딩 깜박임이 생긴다 → **목표를 근거와 함께 다시 정할지 사용자 결정**(→ 2026-09-30 결정: ADR-026) |
| R-27 | 일 통계가 하루 파티션 전체를 읽음(약 560 MB, 하루 1회) | 디스크 넘침은 고쳤다. 1분 요약에서 세려면 요약 행에 지역을 기록하는 스키마 변경이 필요 — 요청 경로가 아닌 배치라 다음 단계 |
| R-52 | 항적 응답의 좌표 중복(약 14 %) | 상한·`truncated` 는 했다. 중복 제거는 GeoJSON Feature 형식과 웹 소비 코드를 함께 바꿔야 함 |
| R-30 | 지도 스타일이 넣는 출처 링크 약 3개의 탭 순서 | 우리 출처 링크는 `tabindex=-1`, 알림 패널로 건너뛰는 링크 추가. 스타일 링크는 MapLibre 가 만든다 |
| R-32 | 통계 날짜 입력의 최솟값 | 첫 집계일을 돌려주는 API 가 없다 — 짐작해 넣지 않는다 |
| R-41 | 가짜 Redis 의 TTL 모델 | 예산 Lua TTL 은 CI 의 실 Redis 시험으로 대신 확인 |
| R-80 | initdb 뒤 db 컨테이너의 서비스 비밀번호 제거 · "공개 배포" 스위치 | 별도 init 서비스 설계 · 배포 형태는 사용자 결정 |
| R-97 | 같은 호스트(localhost)의 다른 포트로 세션 쿠키(`Path=/api`)·CSRF 쿠키(`Path=/`, 화면 JS 가 읽음)가 계속 전송됨 | 세션 쿠키만 `Path=/api` 로 좁혀 Next 요청에서는 뺐다. 포트 간 전송은 표준 쿠키 동작(RFC 6265 는 포트를 무시)이라 여기서 막을 수 없다 → **전용 호스트 이름(`wakeline.localhost` 등)은 사용자 결정**(§7-3) |
| R-13 | `make clean` 전에 최근 백업이 없으면 확인 | 시험하려면 개발 스택을 지워야 한다 — 절차·도구는 완료 |
| R-63 | db 이미지(imresamu/postgis) 고칠 수 있는 CVE(오프라인 trivy 9 CRITICAL · 76 HIGH, 고유) | 새 다이제스트 없음 · Alpine 판은 정렬 규칙이 바뀜 → **이미지 교체는 사용자 결정**. CI 는 보고만(이유 `ci.yml`)(→ 2026-09-30 해결: 직접 빌드한 db 이미지 — [ADR-004 개정](../adr/ADR-004-postgis-from-mvp.md) · [VERIFICATION #69](../VERIFICATION.md), CI 차단 스캔) |

### 5.3 검증 중 새로 본 것
- **WS 항공기 지연의 꼬리가 실행마다 크게 흔들린다**: 같은 절차(§1.1) 8회에서 p99 — 경합 기록 없음 6회 243–908 ms(기본 32: 10:45 908 · 10:53 243 · 11:31 482 · 11:46 254 / `MALLOC_ARENA_MAX=2`: 11:21 602 · 11:38 420) · 중간 경합 2회 338–472 ms(09-27 PERF.md 786 ms). p95 는 모두 목표(500 ms) 안. 원인 후보는 전세계 공급자 갱신(약 120 s 마다 약 8,000대) 때 200세션 팬아웃이 몰리는 것 — 확인하지 않았다(추정). 다음 후보: 세션 격자 칸별 직렬화 공유(PERF §5-1).
- **collector 메모리 증가**(고침): 기상청 레이더 해석(프레임마다 수십 MB numpy 버퍼)이 공용 스레드 풀(`asyncio.to_thread`)의 아무 스레드에서 돌아, 해석이 올라간 스레드마다 glibc 아레나가 최고점을 따로 쥐었다(재기동 뒤 40분에 99 → 289–298 MiB). 해석은 기준선부터 풀에서 돌았다 — R-21 이 풀을 쓰는 호출(원천 보관·항공기 처리)을 늘려 작업 스레드가 많아지면서 해석이 더 여러 스레드에 흩어진 것으로 본다(추정 — 기준선의 40분 메모리 추이는 측정 안 함). 코드 감사(3개 갈래 + 반박 검증)에서 끝없이 자라는 자료 구조는 없었다(기본 풀 최대 8 · 캐시 모두 상한). 전용 해석 스레드 + `MALLOC_ARENA_MAX=2` 뒤 같은 40분에 173–217 MiB 로 평탄(`05b895b`). 해석 한 번이 약 120 MiB 를 올리는 것(88 → 215 MiB)은 그대로다 — 격자 해석을 조각으로 나누는 것은 다음 후보.
- **api 메모리는 부하·경합에 따라 달라진다**: `MALLOC_ARENA_MAX=2` 로 아레나 낭비(약 160 MiB)를 없앤 뒤 경합 기록이 없는 오전 k6 실행에서 497–501 MiB, 최종 측정 스크립트(k6 없음) 527.2 MiB, 같은 기계에 다른 부하가 있을 때 577–611 MiB, 큰 경합에서 최대 702 MiB. 힙 표본으로 보면 RSS ≈ 힙 커밋 + 약 280 MiB 이고, 처리가 밀리면 G1 이 힙 커밋을 217 → 316 MiB(k6 없이 큰 경합 속에서 381 MiB)로 늘린다. 1 GiB 한도 안이고 힙 상한(410 MiB)이 있어 끝없이 늘지는 않는다(측정 범위 안). WS 세션 우편함은 종류별 단일 비행으로 묶여 있어 원인이 아니다(코드 확인).
- **같은 기계의 다른 작업이 부하 시험을 크게 흔든다**: 다른 프로젝트(aptlake)의 CPU 를 실행 중 기록한 13:21 · 13:30 실행(aptlake 23–244 %)에서 REST p95 1.0–6.2 s, 호스트 부하만 기록한 12:03 · 12:10 실행(1분 부하 5.3–12.4)에서 3.1–30 s, 기록이 없는 11:54 실행은 0.4 s 였다. 중간 부하일 때는 60–141 ms(경합 기록 없을 때 5–18 ms). 이후 부하 시험은 경합을 함께 기록하고 게이트(다른 프로젝트 CPU 합 < 50 % 3회 연속) 뒤에 돌렸다 — 게이트는 시작 전만 보므로 실행 중 경합은 기록으로 판단한다.

## 6. 다음 개선 후보(우선순위 순, 측정 근거)
1. **부하 시험 격리** — 전용 러너(또는 다른 프로젝트를 멈춘 창)에서 k6 를 반복 실행해 경합 없는 값을 다시 잰다. 위 api 메모리·REST 수치의 판정이 여기에 달려 있다.
2. **api 힙 상한·커밋 조정**(NFR-03 여유) — `MaxRAMPercentage` 를 낮추거나 G1 주기 GC 로 커밋을 되돌리는 것은 GC 부하와 맞바꾸는 조정이라, 1 번(부하 시험 격리)의 깨끗한 측정으로 정한다.
3. WS 꼬리 지연 — 전세계 갱신 때 팬아웃 비용 측정(JFR) 뒤 칸 단위 직렬화 공유(R-61 과 함께: 전세계 판정 증분화).
4. R-36 · R-76 — 언어 간 계약(공유 표·Redis 해시·WS 16종 메시지)을 스키마로 묶고 양쪽에서 기계 검사.
5. R-81 — 전세계 WS 스냅샷 저해상 형식(1.2 MB → 설계 형식).
6. R-63 — db 이미지 교체(아래 결정 뒤) 후 CI 차단으로 전환. → 2026-09-30 교체 · CI 차단으로 전환함(ADR-004 개정).
7. R-27 후반 · R-52 — 요약 행 지역 기록(스키마) · 항적 응답 형식 정리.

## 7. 사용자 결정이 필요한 것
1. **NFR-04 첫 화면 JS 목표**: 400 KB 를 유지(지도를 첫 화면에서 빼는 설계 변경)할지, 측정 근거(MapLibre + Next 루트만 426.5 KiB)로 목표를 다시 정할지. 리뷰 방안 4 와 레인 보고(§3)가 제안한 약 480 KiB 는 수정 후 측정값(Lighthouse 전송량 497.7 KiB · `next build` gzip 489.6 KiB)보다 작아 그대로 정해도 미충족이다 — 다시 정한다면 어느 측정(Lighthouse 전송량 또는 `next build` gzip)을 기준으로 할지 함께 정하고 그 측정값 이상으로 잡아야 한다.
   → **2026-09-30 결정(사용자가 권장안으로 맡김): [ADR-026](../adr/ADR-026-first-screen-js-budget.md)** — 예산 550,000 B(gzip 본문 · 응답 머리 제외 · 웹 이미지의 Node 로 압축), 측정 [PERF §10](../PERF.md).
2. **db 이미지 교체(R-63)**: 공식 postgres:18(다이제스트 고정) + Debian postgis 패키지로 직접 빌드(REVIEW-v1 개선안 — 기반 이미지 갱신을 Dependabot 으로 받음. 공식 이미지의 arm64 지원·정렬 규칙이 지금 볼륨과 같은지는 확인 전 — 교체 전 버리는 볼륨 사본에서 collation 버전 경고와 `'a' < 'B'` 결과를 확인) · 지금 이미지 위에 apt upgrade 하는 얇은 Dockerfile · Alpine 판(백업·복원으로 옮기고 인덱스 재구축) · 지금 유지.
   → **2026-09-30 결정(사용자가 권장안으로 맡김): 공식 postgres:18-trixie + PGDG PostGIS 3.6 직접 빌드** — [ADR-004 개정](../adr/ADR-004-postgis-from-mvp.md) · [VERIFICATION #69](../VERIFICATION.md).
3. **공개 배포 여부와 전용 호스트 이름**: 지금은 로컬 전용(127.0.0.1). 공개하면 TLS 종단 · `COOKIE_SECURE=true` · 운영 계정 정책이 필요하다. 이와 별개로, 로컬에서 세션·CSRF 쿠키가 같은 localhost 의 다른 포트(SmartCollab 등)로 가는 것을 막으려면 전용 호스트 이름(`wakeline.localhost` 등 — 브라우저가 루프백으로 해석, R-97)을 쓸지 정해야 한다.
4. ADR-017 의 계약 변경(공개 API · DB V9 · 인증 · 망 분리)은 사용자 지시에 따라 확인 없이 적용했다 — 되돌리기 방법은 ADR 에 있다.

## 8. 재현
```bash
bash perf/review_measure.sh final     # 시험·커버리지·린트·SAST·의존성·이미지·비밀값·번들·Lighthouse(경로마다 1회)·런타임 → perf/results/review-final/summary.tsv
make bench SHIPS=1                    # k6 REST 100 rps × 3분 + WS 200 연결(선박 포함), api 층 직접 — 같은 기계의 다른 작업을 먼저 확인할 것(§1.1)
make test && make e2e && make contract
make infra-docker-test                # edge · Redis ACL · db 권한 · 백업·복원 · 비밀번호 교체(버리는 컨테이너)
bash infra/tests/collector_redis_test.sh   # collector 실 Redis 시험(버리는 Redis) — CI collector job 과 같음
SCAN_OFFLINE=1 make security          # gitleaks · Trivy(자체 이미지 차단, 제3자는 ci.yml 행렬대로)
```
