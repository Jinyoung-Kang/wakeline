# browser — 실제 브라우저 점검(QA 2026-10-aws)

- 대상: 격리 스택 **A**(표준 구성 · 공개 데모 끔 · fixture 모드 · 이미지 `wakeline-*:qa` · 합성 공역) — `http://localhost:8701`(compose `wlqa-a`). 제품 코드 = `main` `29d39e38`.
- 도구: Playwright 1.63.0 · Chromium(headless, `chromium-1243` · macOS arm64 · 시스템 글꼴) · axe-core 4.13.0(WCAG 2.1 A · AA). 브라우저 시간대 UTC(화면이 KST 로 그리는지 드러나게).
- 외부 지도 타일: 모든 새 spec 은 `page.route` 로 외부 호스트(OpenFreeMap · RainViewer)를 막고 **빈 응답**(스타일 JSON = 레이어 0 빈 스타일, 그 밖 204)으로 대신했다
  (`e2e/qa/qa-aws-helpers.ts emptyExternal`) — 막은 요청은 '실패한 요청'에서 빼고 호스트별로 따로 셌다(예: 1440 px 스윕 `tiles.openfreemap.org` 2 · `tilecache.rainviewer.com` 20).
  앞선 QA 의 spec 은 그대로(`qa-helpers instrument` — 끊기) 돌렸다. 외부 공급자 · AWS · 운영 스택(8700)은 부르지 않았다.
- 실행: `cd apps/web && E2E_BASE_URL=http://localhost:8701 QA_BASE_URL=http://localhost:8701 QA_CREDS=<세션 임시 폴더>/qa/ops-A.json QA_EVIDENCE_DIR=$PWD/../../docs/qa/2026-10-aws/evidence/browser WLQA_PROJECT=wlqa-a npx playwright test -c e2e/qa/playwright.qa.config.ts <spec>`
  — 자격 증명은 파일 경로로만 넘겼다(증거 · spec · test-results 에 비밀번호 0회 — 검사함). 요청 제한(분당 120 · edge 초당 10)에 걸린 429 는 이번 실행들에서 0건.
- 결함 5건(QA-1420 보통 · QA-1421 – 1424 낮음). 치명 · 높음 없음.

## 한 일과 결과(수)
| 항목 | 방법 | 결과 |
|---|---|---|
| 앞선 QA 회귀 | `e2e/qa/*` 24 파일 40 시험(sweep · dashboard · pages · ops-logs · keyboard · kst · a11y-extra · sec-xss · sec-csrf · r2-screens · r2-xss + 재현 spec 13개) | 1회차 38 통과 · 1 실패 · 1 못 돎(`regress-e2e-qa-run1.log`). 실패 1 = `qa-sec-xss` 항공기 주입 경쟁(아래 '결함 아님'), 다시 돌려 7/7 통과(`regress-e2e-qa-run2-secxss-sweep.log`) — **회귀 결함 0** |
| 10경로 × 4폭 스윕 | 새 `qa-aws-sweep.spec.ts`: `/` `/m` `/replay` `/stats` `/airports/RKSI` `/alerts/<실제 id>` `/ops` `/logs` `/about` `/guide` × 1440 · 768 · 375 · 320 — 가로 넘침 · 콘솔 · 실패 · 중복 요청(1.5 s) · axe · Tab 40번 순회 | 4/4 통과(수집용). **axe 위반 0**(40 화면). 중복 요청 0. 실패한 요청 = 익명 `/ops` · `/logs` 의 `GET /api/v1/ops/session` 404 뿐(설계 — R-12). 가로 넘침 = `/` 1440 · 375 · 320(→ **QA-1420**) · `/replay` 320 의 1 px(조각 없음 — 반올림) |
| 모든 단추 누르기 | 새 `qa-aws-click-all.spec.ts`: `/m` · `/alerts/[id]` · `/stats` · `/airports/RKSI` · `/about` · `/guide` · `/replay` 의 보이는 단추 · summary 를 하나씩(1440 · 375) | 콘솔 · 페이지 오류 · 실패 · 중복 0, axe 0. 상황판 · 운영 · 로그는 앞선 `qa-dashboard` · `qa-ops-logs` 가 단계별로 눌렀다(콘솔 · 실패 · 중복 0) |
| 시험이 없던 흐름 | 새 `qa-aws-flows.spec.ts` 6개: 설정 409('새 값 보기' · '내 값으로 덮어쓰기' · 저장 경쟁 409) · 해결/되돌리기 확인 패널(Esc · 취소 · 메모 201자 · 확인 · 되돌리기) · 오류 화면(없는 경로 404 · 오류 경계) · 배포 뒤 옛 청크(404 route) · WS 끊김 · 재접속(`routeWebSocket`) · 로그인 429 · 세션 만료 뒤 돌아오기 | 6/6 통과(수집용). 기능은 모두 동작 — 화면 · 초점 문제만 결함으로(QA-1421 · 1422 · 1423) |
| XSS | 새 `qa-aws-xss.spec.ts` 4개 + `tools/qa/inject_stream.py`(WLQA_PROJECT=wlqa-a, `sigmet` 추가): 조작 SIGMET(FIR 이름 · 발표 기관 · 위험 · 한정어 · 이동 · 변화 · 원문 — 다각형 한반도) + 조작 항공기(호출부호 · 등록 · 기종) → SIGMET 목록 · 카드 · 알림 패널 근거 · 관심 탭 · `/alerts/[id]` · JSON 내려받기 · `/m` · `/replay`; 특보 · 선박; 익명 `POST /api/v1/client-errors` → `/logs` 목록 · 상세 · 묶음; 공역 이름(응답만 조작) → 공역 상태 줄 · 항공기 카드 공역 줄 | **4/4 통과 — 실행 · 주입 요소 · CSP 위반 · 대화상자 0**, 표식은 글자로 보임(`aws-xss.json`). 내려받은 JSON 은 올바른 JSON(표식은 문자열 값). 정적 확인: `apps/web` 에 `innerHTML` · `dangerouslySetInnerHTML` · `setHTML` · `insertAdjacentHTML` 0 |
| 재현 spec | `qa-1420` – `qa-1424` 5 파일 10 시험 | **10 실패(모두 재현)** — `final-new-specs-run.log` |

합계: 실행한 브라우저 시험 40(회귀) + 7(재실행) + 4(스윕) + 2(누르기) + 6(흐름) + 4(XSS) + 10(재현) + 탐색 5 = 78회.

## QA-1420 · 보통 · 화면 · 접근성 — 상황판 오른쪽 패널 탭 줄이 넘쳐 데스크톱(≥ 900 px)에서 'watch'(관심) 탭이 보이지 않고, 키보드로 가면 화면 전체가 옆으로 밀린다
- 환경: A · Chromium 1440×900(기본 데스크톱) · 375×812 · 320×640. (768 px 는 패널이 화면 폭 전체라 넘치지 않음.)
- 재현 절차:
  1. `cd apps/web && E2E_BASE_URL=http://localhost:8701 QA_EVIDENCE_DIR=… npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1420`
  2. 손으로: 1440×900 에서 `/` 를 연다 → 오른쪽 패널의 탭 줄(ALERTS · AIRCRAFT · SHIP · SIGMET · AIRPORT · WX · WATCH)을 본다 → Tab 으로 'watch' 탭까지 간다.
- 기대: 일곱 탭이 모두 패널 안에 보이거나(줄바꿈 · 줄임) 탭 줄 안에서 스크롤로 닿는다. 문서 폭은 창 폭을 넘지 않는다(WCAG 1.4.10).
- 실제: 탭 줄이 패널(380 px)보다 넓어 `wx` 가 잘리고(right 1443) **`watch` 는 창 밖(right 1508)** — 문서 폭 1508 > 창 1440. 본문은 `overflow-hidden` 이라 마우스로는 닿을 수 없다.
  키보드로 `watch` 에 초점을 주면 브라우저가 문서를 68 px 옆으로 밀어 로고 · 상태 줄 · 지도 왼쪽이 잘린 채 남는다(스크린샷 `qa-1420-tabs-1440.png`, 다시 돌아오지 않음).
  375 px: wx · watch 밖(밀림 72 px), 320 px: airport · wx · watch 밖(밀림 127 px).
- 실패 글: `QA-1420 1440px doc=1508 > window=1440? tabs outside: tab-wx(right 1443), tab-watch(right 1508) · after keyboard focus on watch: scrollLeft=68 map.left=-68` ·
  `Error: keyboard focus on the watch tab shifts the whole page sideways — Expected: 0 Received: 68`
- 영향: 관심 대상(ADR-037 — 관심 목록 · 브라우저 알림 켜기)의 탭이 데스크톱 폭 전체(≥ 900 px — 패널 고정 380 px)에서 마우스로 보이지 않는다. 우회: 키보드 Tab(화면이 밀림) · `/m`. 앞선 QA 의 스윕 증거(`docs/qa/2026-10-release/evidence/ui-a11y/prior-specs-rerun/sweep-desktop.json` — scrollWidth 1508)에도 같은 값이 있었으나 보고되지 않았다.
- 증거: `evidence/browser/qa-1420-tabs-{1440,375,320}.{png,json}` · `aws-sweep-w1440.json`(`/` overflow) · `aws-sweep-w1440-dashboard.png` · `final-new-specs-run.log`
- 의심 원인: `components/SidePanel.tsx:107-111` — 탭 7개를 `flex` 한 줄(줄바꿈 · 가로 스크롤 · min-w-0 없음, 단추는 `btn flex-1` 의 글자 폭 + 대문자 · 자간)로 그린다. 패널 `app/page.tsx:31`(`min-[900px]:w-[380px]`, overflow 지정 없음) · 본문 `app/layout.tsx:21`(`overflow-hidden` — 손 스크롤만 막고 초점 스크롤은 막지 않음).
  글꼴(Inter 가 없으면 -apple-system)에 따라 넘치는 폭은 달라질 수 있다 — 다른 OS 는 확인하지 않음.
- 재현 시험: `apps/web/e2e/qa/qa-1420-side-panel-tabs-offscreen.spec.ts` — 3 실패

## QA-1421 · 낮음 · 화면 · 접근성 — 없는 경로는 Next 기본 404(영어 · lang 표시 없음 · 상황판과 같은 제목)
- 환경: A · Chromium 1440
- 재현 절차: `… npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1421` — 또는 `/no-such-page` 를 연다.
- 기대: 앱의 다른 오류 화면(ErrorScreen · `/alerts/[id]` '알림 번호가 아님')처럼 한국어로 까닭과 갈 곳을 말하거나, 영어 글자에 `lang="en"`(WCAG 3.1.2 — 앞선 QA-313 과 같은 규칙). 제목(title)에 없는 페이지임이 드러난다(WCAG 2.4.2).
- 실제: 응답 404, 본문 `404` · "This page could not be found."(영어, 문서 `lang="ko"`, lang 표시 없음), 제목은 상황판과 같은 "Wakeline — 실시간 항공기 · 선박 · 위험기상 상황판" — 탭 · 화면 읽기에서 없는 페이지임을 알 수 없다.
- 실패 글: `QA-1421 status=404 title="Wakeline — 실시간 항공기 · 선박 · 위험기상 상황판" html lang=ko h1=["404"] english=[{"text":"This page could not be found.","lang":"ko"}]` · `Error: title says the page does not exist`
- 증거: `evidence/browser/qa-1421-not-found.{png,json}` · `aws-flows.json`(errorScreens.notFound) · `aws-flow-404.png`
- 의심 원인: `apps/web/app/not-found.tsx` 가 없다(`app/` 에 `error.tsx` · `global-error.tsx` 만) → Next 기본 화면. 제목은 `app/layout.tsx:10` 의 기본값.
- 재현 시험: `apps/web/e2e/qa/qa-1421-not-found-page.spec.ts` — 1 실패
- 앞선 web-code 의 QA-1400(lang 남은 곳)과는 다른 화면(그 목록에 404 없음).

## QA-1422 · 낮음 · 접근성(WCAG 2.4.3) — 운영 화면 두 곳에서 누른 뒤 초점이 body 로 떨어진다
- 환경: A · Chromium 1440 · 시험 운영자 qa-ops(파일)
- 재현 절차: `… QA_CREDS=<ops-A.json> npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1422`
  1. 운영 → settings → `sigmet_poll_s` 값을 고치는 동안 다른 쓰기(같은 세션의 PUT, If-Match = 지금 version)가 먼저 저장 → 15 s 안에 충돌 줄 → '새 값 보기'에 초점 → Enter.
     (A 의 값은 시험 끝에 되돌린다 — 실행마다 version 이 오른다.)
  2. 운영 로그인 폼에서 서버 오류(429 — 응답만 계약 모양으로 대신: 서버 제한을 쓰면 같은 호스트의 다른 점검이 1분 동안 로그인하지 못한다) → Sign in 단추로(Enter · 클릭) 보낸다.
- 기대: (1) 초점이 그 줄의 값 입력(또는 줄)로, (2) 코드 주석(`OpsLogin` — "오류가 나면 해당 칸(또는 오류 문구)으로 초점을 옮긴다")대로 오류 문구(`#ops-login-err`, tabIndex −1)로.
- 실제: 둘 다 `document.activeElement === body` — 다음 Tab 은 문서 맨 앞(건너뛰기 링크)부터. (2)는 비밀번호 칸에서 Enter 로 보내면 초점이 그 칸에 남는다(오류 문구로는 가지 않음 — `evidence/browser/aws-probe-misc.json` login429Focus = `input#ops-pass`).
- 실패 글: `QA-1422 (1) focus after '새 값 보기' (Enter): {"tag":"body",…}` · `QA-1422 (2) error="로그인 시도가 너무 많습니다 — 37초 뒤 다시 시도하세요." focus={"tag":"body",…}` · `Expected: "div#ops-login-err" Received: "body"`
- 증거: `evidence/browser/qa-1422-settings-focus.json` · `qa-1422-login-focus.json` · `aws-flows.json`(settings409.afterDropFocus · login429AndExpiry.login429.focus) · `final-new-specs-run.log`
- 의심 원인: (1) `app/ops/page.tsx:457` — '새 값 보기'(`drop(s.key)`)가 충돌 줄을 지우는데 같은 컴포넌트의 저장(`:412 rescue(...)`)과 달리 초점 구조(useFocusRescue)를 쓰지 않는다(QA-304 와 같은 부류).
  (2) `components/OpsLogin.tsx:23` — 보내는 동안 단추가 `disabled`(초점이 body 로)이고, 오류 뒤 `setTimeout(() => errRef.current?.focus(), 0)` 이 오류 문구가 그려지기 전에 돌아 `errRef.current` 가 비어 있는 것으로 **추정**(React 19 의 비동기 갱신 커밋 시점 — 확인하지 않음).
- 재현 시험: `apps/web/e2e/qa/qa-1422-focus-lost-ops-forms.spec.ts` — 2 실패

## QA-1423 · 낮음 · 키보드 — Enter 로 연 그 자리에서 Esc 가 패널을 닫지 않는다(운영 실행 목록 · 로그 상세 · 재생 상세)
- 환경: A · Chromium 1440
- 재현 절차: `… npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1423`
  1. `/ops` runs 탭 → '실행 목록 열기' 단추에 초점 → Enter → 실행 목록이 열림(초점은 같은 단추, 이름이 '실행 목록 닫기: …'로 바뀜) → Esc.
  2. `/logs` 로그 표(grid)에 초점 → ↓ → Enter → 상세가 열림(초점은 표) → Esc.
  3. `/replay` 목록 열기 → 첫 항목에 초점 → Enter → 상세(inspector) → Esc.
- 기대: Esc 로 닫기 규칙(`lib/escape-stack.ts` 머리 — "초점이 그 패널(또는 그 패널을 연 단추) 안이면 그 패널을 닫는다", 대상 목록에 '운영 실행 목록 · 로그 상세 · 재생 상세')대로 닫힌다.
  같은 흐름의 기상청 레이더 패널(opener 를 넘김)은 닫힌다.
- 실제: 세 곳 모두 그대로 열려 있다 — 초점이 연 요소에 남은 채 Esc 를 누르면 '다른 요소의 Esc'로 보고 아무것도 하지 않는다. 키보드 사용자는 Tab 으로 '닫기'까지 가야 한다(조작은 가능 — 2.1.1 위반은 아님).
- 실패 글: `QA-1423 (1) focus at Esc=runs-drill-open "실행 목록 닫기: focus · fixture · ok" → run list still open=true` · `(2) focus at Esc=log-grid → detail still open=true` ·
  `(3) focus at Esc=replay-list-sigmet "TS FRQRJJJ" → inspector still open=true`
- 증거: `evidence/browser/qa-1423-{runs,logs,replay}.json` · `ops-logs-steps.json`('runs: close drill (Escape?)' — 앞선 spec 도 같은 결과) · `final-new-specs-run.log`
- 의심 원인: `components/OpsRunsDrill.tsx:35` · `components/logs/LogDetail.tsx:39` · `app/replay/page.tsx:95` 가 `useEscapeClose(…, { panel })` 만 넘기고 `opener` 를 넘기지 않는다(`components/KrRadarPanel.tsx:22` 는 넘긴다) — `lib/escape-stack.ts handleEscape` 는 초점이 panel · opener 밖이고 '중립'이 아니면 닫지 않는다.
- 재현 시험: `apps/web/e2e/qa/qa-1423-esc-after-keyboard-open.spec.ts` — 3 실패

## QA-1424 · 낮음 · 화면 표시 — 동적 경로 값(/alerts/[id] · /airports/[icao])을 퍼센트 인코딩된 글자로 보이고, 공항 화면은 그것을 다시 인코딩해 묻는다
- 환경: A · Chromium 1440 · Next 16.3.8 운영 빌드(QA 이미지)
- 재현 절차: `… npx playwright test -c e2e/qa/playwright.qa.config.ts qa-1424` — 또는 `/alerts/０１`(전각 숫자) · `/airports/김포 공항` 을 연다.
- 기대: 사람이 친 값(디코딩한 값)을 보인다 — "#０１" · "김포 공항". api 에는 그 값을 한 번 인코딩해 묻는다.
- 실제: 머리가 `ALERT EVIDENCE · #%EF%BC%90%EF%BC%91` · `AIRPORT WEATHER · %EA%B9%80%ED%8F%AC%20%EA%B3%B5%ED%95%AD`, 공항 오류 글도 "공항 코드 형식이 올바르지 않습니다: %EA%B9%80…",
  api 요청은 `/api/v1/airports/%25EA%25B9%2580…/wx`(이중 인코딩). ASCII 값(RKSI · 숫자 id)은 영향 없음 — 한글 · 전각 · 공백이 든 공유 링크 · 오타에서만.
- 실패 글: `QA-1424 alerts h1="ALERT EVIDENCE · #%EF%BC%90%EF%BC%91" · airport h1=["AIRPORT WEATHER · %EA%B9%80%ED%8F%AC%20%EA%B3%B5%ED%95%AD"] · api=["/api/v1/airports/%25EA%25B9%2580%25ED%258F%25AC%2520%25EA%25B3%25B5%25ED%2595%25AD/wx"]`
- 증거: `evidence/browser/qa-1424-route-param.json` · `qa-1424-airport.png` · `aws-probe-alert404.json`(id 7가지)
- 의심 원인: `app/alerts/[id]/page.tsx:16-24`(`use(params)` 의 id 를 디코딩하지 않고 머리 · 검사에 씀) · `app/airports/[icao]/page.tsx:20-21`(`icao.toUpperCase()` 를 그대로 보이고 `lib/endpoints/weather.ts:17` `pathSegment` 가 다시 `encodeURIComponent`).
  web-code 영역의 '미확인' 표 2번째 줄("Next 가 동적 조각을 디코딩해 주는지(이중 인코딩 여부)는 서버 없이 확인하지 못했다")을 실제 브라우저에서 확인한 것 — 디코딩하지 않는다.
- 재현 시험: `apps/web/e2e/qa/qa-1424-route-param-percent-encoded.spec.ts` — 1 실패

## 확인했고 결함이 아닌 것
| 내용 | 결과 · 증거 |
|---|---|
| 설정 409 흐름 | 편집 중 다른 쓰기 → 15 s 안에 충돌 줄("v3 → v4: 301") · 저장 단추 막힘 · '내 값으로 덮어쓰기' → 저장(v5) · '새 값 보기' → 서버 값 · 같은 If-Match 경쟁의 409 → "편집하는 동안 다른 곳에서 바뀌었습니다…" + 요청 id + 충돌 줄. 값은 되돌림(`aws-flows.json` settings409) |
| 해결/되돌리기 확인 패널 | 열면 초점 = 메모 칸 · 연 단추 `aria-expanded=true` · Esc · 취소 → 연 단추로 초점 · 메모 201자 → "메모는 200자 이하입니다(지금 201자)." · 확인 → "해결 처리됨: 묶음 …(해결 #3)" · 되돌리기 확인 → 표시 사라짐. 콘솔 · 실패 0 |
| WS 끊김 · 재접속 | `routeWebSocket` 로 서버 연결을 끊고 새 연결을 1013 으로 거절 → 칩 `WS CLOSED · RETRY 6`(1013 은 설계상 긴 백오프 — `lib/ws-protocol.ts attemptAfterClose`) · 알림 패널 "연결 끊김 — 마지막으로 받은 목록 · 갱신 안 됨 · ETA 멈춤" → 다시 받으면 `WS OPEN` · 안내 사라짐. 소켓 열림 시각 [0.3 s, 4.5 s, 33.5 s, 65.6 s] |
| 로그인 429 | "로그인 시도가 너무 많습니다 — 37초 뒤 다시 시도하세요." + 요청 id(Retry-After 반영). 단추 다시 쓸 수 있음(초점은 QA-1422) |
| 세션 만료 뒤 | 세션 쿠키를 지우고 새로고침 → 로그인 화면 + "세션이 만료되었습니다 — 다시 로그인하세요." · 초점 = 아이디 칸 → 다시 로그인하면 대시보드(탭은 providers 로 돌아감 — 개선 제안 2) · `/logs#level=ERROR` 는 해시를 지닌 채 로그인 화면 |
| 배포 뒤 옛 청크(조각) | 첫 화면 뒤 미리 받기(`DashboardParts prefetchDashboardPartsWhenIdle`)가 끝난 상황판은 청크를 모두 404 로 막아도 SIGMET 목록 · 카드가 열린다(청크 요청 0) — 설계 그대로 |
| 키보드 · 초점 표시 | 스윕의 '초점 표시 없음'(날짜 · 시각 입력)은 측정 순간 문제 — 탐색으로 다시 보니 `outline 2px solid` · `:focus-visible` 참(`aws-probe-focus.json`) |
| KST | 16 화면 상태에서 KST 아닌 시각 0(`kst-scan.json`, 브라우저 UTC) |
| `/logs` '새 항목' · 표 키보드 | 앞선 `qa-ops-logs` 의 두 단계 실패는 시험 쪽(그 전 단계 검색어 'QA' 뒤 줄이 없음 · 이름 바뀜) — 탐색에서 '새 항목 1건' 12.4 s 뒤 나옴 · 표 ↓ Enter 로 상세(`aws-probe-logs.json` · `aws-probe-ops-misc.json`) |
| `/alerts/[id]` 경계 id | 0 · 1 · 18자리 → 404 "보존 기간이 지나 볼 수 없음 … 또는 없는 알림 번호" + 요청 id, 23자리 · −1 · 1e3 · 전각 → 요청 없이 "알림 번호가 아님"(`aws-probe-alert404.json`) |
| XSS 전부 | 위 표 — 0 |

## 미확인(재현하지 못했거나 확인할 수 없음 — 결함 수에 넣지 않음)
| 내용 | 까닭 |
|---|---|
| 배포 뒤 **화면 이동**(클라이언트 이동)에서 옛 청크 | 같은 빌드에서 청크만 404 로 막으면 `/stats` 로 이동할 때 오류 경계(`app/error.tsx` — `ChunkLoadError`, "다시 시도는 이 화면을 다시 불러와 그립니다")가 나오고, 청크가 없는 동안 '다시 시도'는 같은 오류(`aws-flows.json` oldChunks.retryWhileGone), 청크를 돌려 놓으면 회복. 실제 배포에서는 새 서버의 RSC 응답이 다른 빌드라 Next 가 전체 새로고침으로 바꿀 수 있다(`node_modules/next/dist/docs/01-app/02-guides/self-hosting.md` 'Version Skew' — `deploymentId` 를 쓰지 않음, 빌드 ID 비교 동작은 확인하지 않음). 두 빌드가 필요해 이 단계에서 재현하지 않음 → 개선 제안 3 |
| 강제 그리기 오류의 오류 경계 화면 | `Number.prototype.toFixed` 를 바꿔 던지게 했으나 `/stats` 날짜 변경 그리기에서 쓰지 않아 오류가 나지 않았다. 오류 경계 화면 자체는 위 옛 청크 이동에서 실제로 봤다(종류 · 메시지 · 다시 시도 · 오류 내용 복사 · 상황판으로) |
| 브라우저 알림(Notification) 문구의 표식 | 관심 대상(0a5ec1)이 조작 SIGMET 안에 들어갔지만 시험 시간 안에 관심 알림이 뜨지 않았다(`aws-xss.json` notifications `[]`). 알림은 `new Notification(title, {body})` 글자뿐이라 HTML 이 해석될 길은 없다(`lib/notify.ts`) — 앞선 QA r2-xss 가 관심 이름 표식으로 확인 |
| 공급자 끄기 · 켜기 화면 | fixture 모드에는 opensky 행이 없고(앞선 spec 실패 까닭), `fixture` 공급자를 끄면 A 를 함께 쓰는 다른 점검의 자료가 멈춰 하지 않았다 |
| 로그인한 `/ops` 375 px 의 문서 폭 | providers 768 · settings 641 · runs 456(창 375) — 넘친 표는 탭 본문(`overflow-auto`) 안이고, Tab 순회 뒤 `scrollX` 0(`aws-probe-ops375.json`). 화면이 밀리는 경우를 찾지 못했다 |
| 다른 OS · 실제 Chrome 의 글꼴 | 모두 macOS headless Chromium — QA-1420 의 넘침 폭은 글꼴에 따라 다를 수 있다 |
| 공개 데모(A1) · 앞단(R) | 이 영역 범위 밖(스택 A 표준 구성만) |

## 개선 제안(결함 수에 넣지 않음)
1. **해결 뒤 초점**: 기본 보기(해결 숨김)에서 묶음을 해결하면 그 행이 목록에서 빠져 초점이 body 로 간다(`aws-flows.json` resolveConfirm.afterResolve). `ResolveConfirm` 주석이 "연 단추가 사라졌으면 되돌리지 않는다"고 정한 설계라 결함으로 세지 않았다 — 다음 행 · 표 · 상태 줄로 옮기기를 권한다(QA-1422 와 같은 부류).
2. **세션 만료 뒤 돌아오기**: 다시 로그인하면 운영 탭이 providers 로 돌아가고 편집 중인 설정 값이 사라진다(`OpsDashboard` 를 새로 만든다). 탭 · 편집을 해시나 sessionStorage 로 남기면 만료 뒤 흐름이 끊기지 않는다.
3. **오류 경계에서 ChunkLoadError 가리기**: `ErrorScreen` 이 `ChunkLoadError`(또는 `lib/chunk-probe` 의 HEAD 404)이면 LazyPart 처럼 '페이지 새로고침'을 권하게 — 지금은 '다시 시도'만(청크가 없으면 같은 오류). 함께 `next.config` `deploymentId`(버전 어긋남 감지)를 검토.
4. **시험 쪽**: `qa-sec-xss` 항공기 주입(3 s 마다 region 엔트리 다시 싣기)이 A 의 수집기 발행과 경쟁해 검색이 DB 항목(호출부호 없음)을 먼저 받을 수 있다 — 1회차 실패 까닭(`regress-e2e-qa-run1.log` "—0a5ec1<i id=qr>R</i>—db"). 실시간 항목을 기다린 뒤 검색하게. `qa-ops-logs` 의 공급자 단계(opensky → fixture 모드에서 없음) · 표 단계(검색어 뒤 빈 목록)도 고칠 것.
5. 로그 표에서 Enter 로 상세를 연 뒤 Esc 는 QA-1423 으로 올렸다 — 고칠 때 `/ops` 실행 목록 · 재생 상세와 함께 `opener` 를 넘기면 된다.

## 앞선 QA 와 같음(다시 결함으로 올리지 않음)
- 익명 `/ops` · `/logs` 를 열면 `GET /api/v1/ops/session` 404 가 콘솔 오류 한 줄로 남는다 — 익명 운영 호출은 404 로 답하는 설계(R-12 · 계약), 앞선 QA 스윕에도 같은 줄.
- 세션 만료 때 15 s 새로고침이 7개 탭 요청을 한꺼번에 보내 404 콘솔 줄 8개 — 같은 설계(`useOpsTabs`).

## 더한 · 고친 시험 코드(제품 코드는 고치지 않음)
- 새 spec: `apps/web/e2e/qa/qa-1420-side-panel-tabs-offscreen.spec.ts` · `qa-1421-not-found-page.spec.ts` · `qa-1422-focus-lost-ops-forms.spec.ts` · `qa-1423-esc-after-keyboard-open.spec.ts` · `qa-1424-route-param-percent-encoded.spec.ts`(재현 — 지금 실패),
  `qa-aws-sweep.spec.ts` · `qa-aws-flows.spec.ts` · `qa-aws-xss.spec.ts` · `qa-aws-click-all.spec.ts`(수집 — 통과), `qa-aws-probe-{logs,ops375,ops-misc,alert404}.spec.ts`(탐색 — 초점 표시 · 로그인 초점 · 옛 청크 탐색 spec 은 지웠고 결과 JSON `aws-probe-focus.json` · `aws-probe-misc.json` 만 남김), 도우미 `qa-aws-helpers.ts`(빈 응답 막기 · 실제 알림 id).
- 고친 것: `qa-helpers.ts` — `QA_EVIDENCE_DIR`(없으면 옛 폴더 그대로) · `opsCredentials()`(옛 `{users}` · 새 `{username,password}` 두 모양) · `loginOps` 가 그것을 씀;
  `qa-sec-xss.spec.ts` · `qa-sec-csrf.spec.ts` 가 `opsCredentials` 를 씀(아이디 하드코딩 'qa-b' 제거); `qa-r2-screens.spec.ts` 증거 폴더 `QA_EVIDENCE_DIR`.
- 점검 스크립트: `tools/qa/inject_stream.py` — `WLQA_PROJECT`(없으면 `wakeline-e2e`) · `sigmet` 명령(조작 SIGMET, `--loop`).
- 검사: `cd apps/web && npx tsc --noEmit -p . && npx eslint e2e/qa/` — 깨끗.
