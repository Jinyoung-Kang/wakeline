# 화면 · 접근성 — 출시 QA 2차(2026-10-10)

환경 표기는 [기능](functional.md)과 같다(U · A). 브라우저: Playwright Chromium(headless) · 브라우저 시간대 UTC(화면이 KST 로 그리는지 드러나게) · 외부 호스트 차단.

## 점검한 것
| 항목 | 방법 | 결과 |
|---|---|---|
| 새 화면 · 탭 13상태: 'wx' 탭(육상 펼침) · 관심 탭(알림 켜기) · 선박 카드(신뢰도 · 해상특보 줄 · 관심 단추) · 항공기 카드 · 알림 근거 카드 · `/alerts/[id]`(1440 · 375 · 320 · 인쇄) · `/m`(375 · 320) · 재생 링크 안내 | `e2e/qa/qa-r2-screens.spec.ts`(A) — 콘솔 오류 · 페이지 오류 · 4xx/5xx · 끊긴 요청 · 1.5 s 안 중복 요청 · axe WCAG 2.1 A · AA · 가로 넘침 | axe **0** · 콘솔 0 · 실패 0 · 중복 0 · 넘침 0 — 나온 것은 `/m` 의 React #418(QA-800) 두 폭뿐(`evidence/ui-a11y/r2-screens.json`) |
| 앞선 QA 의 화면 점검 35건(전 화면 sweep 1440 · 768 · 375 · 키보드 · KST · 접근성 추가 · 문구 · 대비 · 재현 시험) | `e2e/qa/*.spec.ts`(A) | 35 통과(XSS 묶음 1건은 시험 자신의 타이밍 — 단독 두 번 통과) |
| 표준 E2E | `make e2e`(REPORT §2) | — |
| 첫 화면 JS 예산 | `check:first-js --in-image` | 548,679 B / 550,000 B |

## 결함

### QA-800 · 낮음 · 웹 `/m` — 저장된 관심 대상이 있으면 하이드레이션 불일치(React #418)
- **환경**: A(운영 빌드). **재현**: `cd apps/web && ./node_modules/.bin/playwright test -c e2e/qa/playwright.qa.config.ts qa-800`(저장소에 관심 대상 · 알림 허락 'default').
- **기대**: 콘솔 오류 없음. **실제**: `pageerror: Minified React error #418`(서버 HTML 과 첫 그리기가 다름) — React 가 그 영역을 클라이언트에서 다시 그린다(깜박임 · 서버 그리기 손실).
  시스템 로그로는 가지 않는다(확인).
- **원인**: `apps/web/lib/watch-store.ts:34,49` — 모듈을 불러올 때 저장소 · `Notification.permission` 을 읽어 첫 상태로 쓴다(서버는 빈 목록 · 'unsupported'). `/m` 은 서버가 그린다
  (`components/MobileAlerts.tsx`). 상황판의 관심 탭은 조각(클라이언트만)이라 나지 않는다.

### QA-801 · 낮음 · 웹 관심 대상 — 배너 '닫기' · 관심 탭 '지우기' 뒤 초점이 문서 밖으로 떨어짐
- **환경**: U(mini-dom). **재현**: `npx vitest run tests/qa/qa-712-801-803-watch-ui.test.ts -t QA-801`.
- **기대**: 누른 단추가 사라지면 초점을 옮긴다 — 이 프로젝트의 규칙(앞선 QA-304 · `lib/focus-rescue`, WCAG 2.4.3). **실제**: 초점이 떨어진 요소에 남는다(브라우저에서는 body).
- **원인**: `apps/web/components/watch/WatchRunner.tsx:127` · `components/WatchPanel.tsx:47`.

### QA-803 · 낮음 · 웹 `/m` — 배너 단추 이름 "<대상> 카드"가 동작과 다름
- **환경**: U. **재현**: `-t QA-803` — 공항 사건의 단추 `'공항 RKSI 카드'`.
- **기대**: `/m` 에는 카드가 없다 — 알림 사건은 근거 화면으로 가고, 그 밖은 누르면 배너만 닫힌다 — 이름이 하는 일을 말해야 한다(WCAG 2.4.6 · 2.5.3).
- **원인**: `WatchRunner.tsx:126`(이름 고정) · `MobileAlerts.tsx`(동작만 바꿈).
