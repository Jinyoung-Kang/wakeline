# 기준선(2026-10-14 03:10–03:50 KST, 브랜치 qa/aws-2026-10 = main 29d39e38 + QA 도구) — QA 시험을 더하기 전

| 묶음 | 명령 | 결과 |
|---|---|---|
| 수집기 | `cd apps/collector && uv run --offline pytest -q -p no:cacheprovider` + ruff · format · mypy | 1,994 통과 · 27 건너뜀(실 Redis · PG — 따로) · 린트 통과 |
| api | `cd apps/api && ./gradlew --offline test --rerun-tasks` | 1,227 중 1,224 통과 · **3 실패** → 다시 돌리면 3개 모두 통과(아래) |
| 화면 | `npx vitest run` · `npx eslint .` · `npx tsc --noEmit` | 1,827 통과 · 3 건너뜀 · 린트 · 타입 통과 |
| 인프라 정책 | `python3 -m unittest discover -s infra/tests` | 181 통과(새 tools/qa compose 파일 포함) |
| aws-deploy gate | `python3 -B -I -m unittest discover -s gate` | 32 통과 |

## api 3 실패 → QA-1290(시험 안정성)
`RedisPausedIT` · `Qa102RedisDownSessionCookieIT` · `Qa104FrozenDbPublicReadIT` 가 같은 NPE:
`Cannot read the array length because "<local6>" is null at RedisPausedIT.redisContainerId(RedisPausedIT.java:79)` — 시험이 `docker ps` 의 모든 컨테이너에 포트 목록이 있다고 가정한다.
실행 도중 QA 스택 A · B 를 만들었다(`compose up`) — 그 순간의 컨테이너가 포트 목록 없이 나온 것으로 보인다. 스택이 다 뜬 뒤 다시 돌리면 3개 모두 통과했다.
