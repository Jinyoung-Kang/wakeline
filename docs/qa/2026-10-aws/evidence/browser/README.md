# evidence/browser — 실제 브라우저 점검 증거(QA 2026-10-aws, 스택 A 8701)

상세는 [findings/browser.md](../../findings/browser.md). 모두 `cd apps/web && E2E_BASE_URL=http://localhost:8701 QA_BASE_URL=http://localhost:8701 QA_CREDS=<세션 임시 폴더>/qa/ops-A.json QA_EVIDENCE_DIR=<이 폴더> WLQA_PROJECT=wlqa-a npx playwright test -c e2e/qa/playwright.qa.config.ts <spec>` 로 만들었다.

| 파일 | 만든 spec | 내용 |
|---|---|---|
| `regress-e2e-qa-run1.log` · `regress-e2e-qa-run2-secxss-sweep.log` | 앞선 QA `e2e/qa/*` 전체 · 재실행 | 회귀 40 시험(38 통과 · 1 주입 경쟁 실패 · 1 못 돎) → 재실행 7/7 |
| `sweep-*.json/png` · `dashboard-*` · `ops-*` · `logs-*` · `pages-steps.json` · `keyboard.json` · `kst-scan.json` · `a11y-extra.json` · `reflow-*` · `r2-screens.json` · `replay-*` · `airport-rksi.png` | 앞선 QA spec(증거 폴더만 이곳으로) | 단계별 콘솔 · 요청 · 중복 · axe · 초점 |
| `aws-sweep-w{1440,768,375,320}.json` · `aws-sweep-*.png` · `aws-sweep-run.log` | `qa-aws-sweep.spec.ts` | 10경로 × 4폭 첫 화면 + Tab 40번 |
| `aws-click-all-{1440,375}.json` · `aws-click-all-run.log` | `qa-aws-click-all.spec.ts` | 보이는 단추를 모두 누름 |
| `aws-flows.json` · `aws-flow-*.png` · `aws-flows-run.log` | `qa-aws-flows.spec.ts` | 설정 409 · 해결 확인 · 오류 화면 · 옛 청크 · WS 끊김 · 로그인 429 · 세션 만료 |
| `aws-xss.json` · `aws-xss-*.png` · `aws-xss-wakeline-alert-*.json` · `aws-xss-run.log` | `qa-aws-xss.spec.ts` | 조작 SIGMET · 항공기 · 특보 · 선박 · 오류 보고 · 공역 이름 |
| `qa-1420-*` … `qa-1424-*` · `final-new-specs-run.log` · `qa-14*-run.txt` | `qa-1420` – `qa-1424` | 재현(지금 실패) — 실패 글 원문 |
| `aws-probe-*.json/png` | `qa-aws-probe-*.spec.ts`(일부는 지움) | 결함이 아님을 가른 탐색 |

외부 지도 타일(OpenFreeMap · RainViewer)은 새 spec 에서 빈 응답으로 대신했고(`qa-aws-helpers.ts emptyExternal`), 앞선 spec 은 끊었다. 비밀번호는 어느 파일에도 없다(검사 — 0회).
