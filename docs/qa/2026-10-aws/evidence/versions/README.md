# 증거 — 버전 · 지원 종료 · 알려진 취약점(versions, 2026-10-14)

| 파일 | 내용 |
|---|---|
| `versions-inventory.txt` | QA 이미지(:qa) 안의 실제 판(`docker exec … --version` · package.json · dpkg · jar 목록), aws-deploy 의 Caddy · gate, 상류 최신 다이제스트 |
| `eol-table.txt` · `endoflife/*.json` | endoflife.date API 원본(2026-10-14)과 쓰는 줄의 활성 지원 · 지원 끝 날짜, 90일 안 표시 |
| `libraries-latest.txt` | 주요 라이브러리의 쓰는 판 vs 레지스트리 최신(PyPI · npm · Maven Central), GitHub Advisory DB 질의 |
| `security-gate-qa-images.txt` | `SECURITY_OWN_IMAGES="…:qa" bash tools/security_gate.sh` 원문(gitleaks · trivy · npm audit · pip-audit) — PASS |
| `trivy-wide-summary.txt` · `trivy/*.compact.json` | 게이트보다 넓게(MEDIUM 이상 · 고칠 수 있는 것 / HIGH 이상 · 고칠 수 없는 것 포함) — 자체 5 · redis · Caddy · gate |
| `qa-1130-repro.txt` · `qa-1130-pytest.txt` · `qa-1130-probe.py` · `qa-1130-parse_stdin.py` | QA-1130 재현(최고 메모리 · 512m 에서 종료 137 · 3.14.8 대조) |
| `qa-1131-caddy.txt` · `qa-1131-probe.Caddyfile` | QA-1131 재현(Caddy 의 Go 1.26.8 · trivy HIGH 4 · 평문 리스너 h2c) |

다시 돌리기: `bash tools/qa/qa_1130_collector_python_zip_bomb.sh` · `bash tools/qa/qa_1131_caddy_go_cves.sh` ·
`cd apps/collector && uv run --offline pytest tests/qa/test_qa_1130_airspace_kmz_bzip2_lzma_bomb.py -q`.
