# api-live 증거(2026-10-14)

상세는 [../../findings/api-live.md](../../findings/api-live.md). 라이브 실행은 모두 격리 스택 **A**(`wlqa-a` · http://localhost:8701 · fixture 모드 ·
이미지 `wakeline-*:qa` · 공개 데모 끔 = A0)에서, 재현 시험은 이 Mac 의 JUnit(Testcontainers — 버리는 PostGIS · ACL Redis)에서 돌렸다.
AWS · 외부 공급자 · 운영 스택(8700)은 쓰지 않았다. 퍼징 동안만(04:56–05:22 KST) api 를 `PUBLIC_RATE_LIMIT_PER_MIN=1000000` 으로 다시 만들었고,
끝난 뒤 그 변수 없이 다시 만들어 기본값 120 으로 되돌렸다(`rate-limit-default.txt` 는 되돌린 뒤의 확인).
운영 경로 점검은 시험 운영자 `qa-ops`(자격 증명은 `QA_CREDS=<ops-A.json>` 파일로만 — `tools/qa/qa_session.py` 가 계정 하나 모양도 읽게 고쳤다).

| 파일 | 명령 | 내용 |
|---|---|---|
| `fuzz-20261013T195646Z.{md,jsonl}` | `QA_CREDS=… python3 tools/qa/fuzz_api.py --base http://localhost:8701 --out docs/qa/2026-10-aws/evidence/api-live` | 공개 + 운영 GET 1,444건 — 5xx 0 · 표시 2(도구 기대가 옛 계약: `limit=21` 끝값 자르기 §G41 · 시작 시각 기준 `31d_minus_1m` 이 실행 중 31일을 넘음) |
| `boundary_api.jsonl` | `QA_CREDS=… QA_EVIDENCE=… python3 tools/qa/boundary_api.py http://localhost:8701` | 경계 값 619건(빠진 9경로 더함 · Accept 를 GeoJSON 으로 고친 뒤) — 후보 0, 최대 48 ms |
| `endpoint-sweep.{txt,json}` | `python3 tools/qa/endpoint_sweep.py --base http://localhost:8701 --label api-live --out …` | 공개 GET 32경로(빠진 7경로 더함) 한 번씩 — 500 0 |
| `authz_matrix.{txt,jsonl}` | `QA_PACE_S=0.3 QA_CREDS=… QA_EVIDENCE=… python3 tools/qa/authz_matrix.py http://localhost:8701` | 운영 19경로 × 익명 · CSRF 쌍 · 위조 쿠키 · 로그아웃 재생 · 경로 속임수 29 · 쓰기 속임수 8 · 메서드 9 — 234줄 기대와 다름 0(첫 실행의 429 5건은 퍼저와 동시에 돌려 edge 초당 10 에 걸린 것 — 혼자 다시 돌려 0) |
| `ws-20261013T195901Z.{md,jsonl}` | `python3 tools/qa/ws_probe.py --base http://localhost:8701 --out …` | WS 86 시나리오 — 기대와 다름 1(binary_frame 1006 — 미확인, 20회 다시 해 재현 안 됨) · 스키마 위반 0 |
| `writes-20261013T201153Z.md` | `QA_CREDS=… python3 tools/qa/write_probe.py --base http://localhost:8701 --out …` | 쓰기 228건 — 다름 4(도구 기대가 옛 계약: §G45 같은 값 저장은 version 그대로 2건 · 중복 공급자 거절 1건 · edge 429 1건 — 따로 다시 보내 400) |
| `values-20261013T201330Z.md` | `python3 tools/qa/value_checks.py --base http://localhost:8701 --out …` | 값 점검 33 — 다름 1(track_deg 180° — QA-210 수정의 fixture 되돌아가기, 결함 아님) |
| `sizes-2500sqdeg.txt` | `python3 tools/qa/api_live_sizes.py` | bbox 2,500 sq° 의 `/aircraft` · `/ships` · `/replay` 크기 · 시간(fixture 규모) |
| `rate-limit-default.txt` | `python3 tools/qa/rate_limit_live.py --base http://localhost:8701` | 기본값 120 의 경계(120 → 200, 121 → 429 RATE_LIMITED + Retry-After · problem+json) · 익명 운영 404 는 세지 않음(QA-1100 과 같음) · 형식 오류 400 은 셈 · 방화벽 400 은 세지 않음 · /healthz 는 세지 않음 · /openapi 는 셈 |
| `qa-1310-failure.txt` · `qa-1311-failure.txt` · `qa-1312-failure.txt` · `qa-1313-failure.txt` | 각 파일 첫 줄 | 재현 시험의 실패 글(그대로) · 대조군 통과 |
| `qa-1310-1311-live.txt` | `python3 tools/qa/qa_1310_1311_live.py --base http://localhost:8701` | QA-1310 · QA-1311 라이브(REST · WS) |
| `qa-1312-live.txt` | `QA_CREDS=… python3 tools/qa/qa_1312_live.py --base http://localhost:8701` | QA-1312 — 공개 GET 29경로 × (`&x=%zz` · 파라미터 1,001개 · 1,000개) + 운영 로그의 ERROR |
| `qa-1313-live.txt` | (파일 안 명령 — 쿠키 199 · 200 · 201 · 300개) | QA-1313 라이브 |
| `suggestion-probes.txt` | (파일 안 명령) | 개선 제안 근거(관심 대상 원시 항목 상한 · 모르는 커서 · 공항 404 문구 · 특보 이력 잘림 표시) |
