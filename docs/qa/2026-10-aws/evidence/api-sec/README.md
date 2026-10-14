# api-sec 증거(2026-10-14)

상세는 [../../findings/api-sec.md](../../findings/api-sec.md). 모든 실행은 이 Mac 의 JUnit 통합 시험(Testcontainers — 버리는 PostGIS · ACL Redis)이고,
라이브 스택 · AWS · 외부 공급자는 쓰지 않았다.

| 파일 | 내용 |
|---|---|
| `qa-1100-failure.txt` · `qa-1101-failure.txt` · `qa-1102-failure.txt` · `qa-1103-failure.txt` | 재현 시험 실행 명령 · 실패 글(그대로) · 서버 ERROR 발췌(1101 · 1102) |
| `qa-1101-flood-probe.txt` | QA-1101 영향 측정 — 한 IP 의 요청이 서버 로그 스트림에 쌓이는 수 · 퍼센트 인코딩으로 지문 억제를 피하는지 |
| `probe-output.txt` | 탐침 출력(후보 1–9 — 결함이 아닌 확인 포함) |
| `probes/*.java.txt` | 탐침 IT 원본(저장소 시험에서는 지웠다 — 다시 돌리려면 `apps/api/src/test/java/dev/wakeline/qa/` 로 복사) |
| `junit/*.xml` | 대조군 단위 시험 결과(OpsSessionLifetimeFilterTest 9 · RateLimitFilterTest 2 통과). SecurityIT(25 통과)와 재현 시험의 원본 XML 은 앱 전체 로그가 들어 커서 발췌만 남겼다 |
