# QA 2026-10 — 화면 · UX · 접근성(WCAG 2.1 AA) 찾기 결과(계획 §3.3 · §3.6)

- 범위: 8 경로(`/` · `/replay` · `/stats` · `/airports/RKSI`(+ 모르는 코드 `ZZZZ` · 형식 오류 `abc` · 소문자 `rksi`) · `/ops`(로그인 폼 → 탭 7) · `/logs`(목록 · 묶음 · 상세 · 필터 · 더 보기 · 새 항목 · AIS 수신 공백) · `/about` · `/guide`)
- 환경: 격리 스택 A(`wakeline-e2e`, http://localhost:8701, fixture 모드) — 이미지 `wakeline-*:local`(웹 `730a801bc7ff`, main `359a3eac` 배포본), 시험 코드 `qa-ui`(기준 `a71b302b`),
  Playwright 1.63 · Chromium(HeadlessChrome 153.0.8010.12) headless, 브라우저 시간대 **UTC**(화면이 브라우저 시간대가 아니라 KST 로 그리는지 드러나게) · 언어 ko-KR,
  폭 1440×900 · 768×1024 · 375×812(+ 200 % = 640×400, 400 % = 320×256 · 320×640), axe-core 4.13.0(wcag2a · wcag2aa · wcag21a · wcag21aa)
- **외부 호스트는 모두 막았다**(`page.route` / `context.route` — localhost · 127.0.0.1 밖은 `abort`): 막힌 것은 `tiles.openfreemap.org`(배경지도 스타일 · 타일) ·
  `tilecache.rainviewer.com`(레이더 타일) 둘뿐. 그래서 **배경지도(육지 · 바다 · 지명)와 레이더 그림은 보지 못했다** — 상황판은 R-01 대체 스타일(검은 바탕)로 그렸고,
  지도 위 글자 대비는 칠하는 색 값으로 계산했다(아래 '확인했고 문제없음'). 그 차단이 재생 지도의 결함(QA-301)을 드러냈다.
- 쓰기(스택 A 공유 — 곧바로 되돌림): 설정 `sigmet_poll_s` 300 → 301 → 300(감사 `SETTING_UPDATE` 2행), 공급자 `opensky` 끄기 → 켜기(세 번 — 매번 곧바로 켬, 마지막 v10 · 켜짐),
  브라우저 오류 1건(`POST /api/v1/client-errors` "QA-ui probe — 새 항목 확인(무해)" — '새 항목' 단추 확인용). 끝난 뒤 API 로 확인: `sigmet_poll_s`=300, opensky 켜짐, 해결 표시 0.
- 운영 로그인은 실제 로그인 폼으로 `qa-b` — 비밀번호는 0600 자격 증명 파일에서 스크립트 안에서만 읽었다(출력 · 기록 · 스크린샷 없음, 흔적(trace) 끔, 증거 파일에 없음을 검사함).
- 시험 · 점검 코드: `apps/web/e2e/qa/`(설정 `playwright.qa.config.ts` — 기존 `make e2e` 와 따로, 기존 설정은 `e2e/qa/` 를 빼도록 한 줄 고침 — 목록 43건 그대로),
  수집기 재현 시험 `apps/collector/tests/qa/test_qa_312_callsign_at_fill.py`. 증거: `docs/qa/2026-10/evidence/ui-a11y/`.

```bash
cd apps/web && npx playwright test -c e2e/qa/playwright.qa.config.ts                 # 전부(점검 6 + 재현 13개 파일)
cd apps/web && npx playwright test -c e2e/qa/playwright.qa.config.ts qa-sweep        # 경로 × 폭 훑기 → sweep-<폭>.json
cd apps/web && npx playwright test -c e2e/qa/playwright.qa.config.ts "qa-3"          # 재현 시험만(고치기 전에는 실패)
cd apps/collector && uv run --offline pytest tests/qa -q
```

## 요약
| 구분 | 수 |
|---|---|
| 결함 | 13 — 치명 0 · 높음 0 · **보통 3**(QA-301 · 302 · 307) · 낮음 10 |
| 미확인 | 4 |
| 개선 제안 | 7 |

## axe 위반 요약(WCAG 2.1 A · AA 태그, 69번 실행 — 경로 × 3 폭 30 + 조작 상태 39)
같은 규칙은 묶었다. 이 두 규칙 말고 위반은 없었다(사람이 본 것은 아래 결함 · '확인했고 문제없음').

| 규칙 | 영향 | WCAG | 위반 상태 · 노드 수 | 예시 선택자 | 결함 |
|---|---|---|---|---|---|
| `scrollable-region-focusable` | serious | 2.1.1(A) · 2.1.3 | 10 상태 · 20 노드 — /about(1440 · 768 · 375) 1씩, /airports/RKSI(375) 1, /guide(375) 6 ×2, 지도 범례 1, 운영 quality · audit · pipeline 1씩 | `.overflow-y-auto` · `#map-legend` · `#dashboard-legend > .g-table` · `.overflow-auto` | QA-305 |
| `color-contrast` | serious | 1.4.3(AA) | 2 상태 · 5 노드 — 지도 범례 4(4.19:1), 로그 고른 줄 1(4.41:1) | `span[title="0 ft · 0 m"] > .text-fg-3\/80` · `#log-row-… > td:nth-child(2) > .bad.badge` | QA-306 |

## 결함

### QA-301 · 보통 · 화면(재생) — 배경지도 스타일을 받지 못하면 재생 지도에 아무것도 그려지지 않고 알림도 없다
- 환경: 스택 A · Chromium 1440×900 · 외부 호스트 차단(배경지도 서버 장애 · 방화벽 · 오프라인과 같은 조건)
- 재현 절차: `cd apps/web && npx playwright test -c e2e/qa/playwright.qa.config.ts qa-301` — 또는 외부 호스트를 막은 브라우저로 `/replay` 를 연다.
- 기대 결과: 상황판처럼(R-01 — `useMapLifecycle` 의 대체 스타일 · `STYLE_LOAD_TIMEOUT_MS` · "배경지도를 불러오지 못함") 로컬 대체 스타일로 지도를 띄워 그 시각의 항공기 · SIGMET 을 그리거나, 적어도 그릴 수 없다고 알린다.
- 실제 결과: 상태 줄은 "110 aircraft · 24 SIGMET"(재생 API 는 정상 응답)인데 지도는 빈 검은 화면 — 항공기 · SIGMET · 조회 상자가 없고 배경지도 실패 알림도 없다.
  MapLibre `load` 가 오지 않아 레이어를 만드는 처리기가 돌지 않는다(그 처리기가 붙이는 출처 컨트롤 `.maplibregl-ctrl-attrib` 0개). 같은 조건의 상황판은 대체 스타일로 그리고 알린다(대조 시험 통과).
  목록(`목록` 단추)은 그 시각의 항목 64개를 보여 주므로 데이터는 있다.
- 증거: `evidence/ui-a11y/sweep-desktop-replay.png`(빈 지도 + "110 aircraft · 24 SIGMET") · `pages-steps.json` "replay: open" → `map attrib control (load fired)=0 basemap notice=0` ·
  `sweep-desktop-dashboard.png`(같은 조건의 상황판 — 대체 스타일 + 알림)
- 의심 원인: `apps/web/components/ReplayMap.tsx:31`(`style: STYLE_URL` 만 — `error` 처리기 · 시간 제한 · `FALLBACK_STYLE` 없음), `:72`(항공기 · SIGMET · 조회 상자 레이어와 첫 조회 영역 보고는 `map.on("load")` 안에서만), `:111` · `:128`(그림 · 레이더도 `once("load")`).
- 재현 시험: `apps/web/e2e/qa/qa-301-replay-basemap-fallback.spec.ts` — 실패:
  `expect(locator).toHaveCount(expected) failed · Expected: 1 · Received: 0 · Timeout: 25000ms — getByTestId('replay-map').locator('.maplibregl-ctrl-attrib')` (대조 시험 "dashboard map falls back" 은 통과)

### QA-302 · 보통 · 화면(운영, 모바일) — 375 px 이하에서 운영 탭 audit · dlq · pipeline(320 px 는 settings 도)이 화면 밖이다
- 환경: 스택 A · Chromium 375×812 · 320×640 · `qa-b` 로그인(재현 시험은 운영 API 를 계약 모양 값으로 대신 줌)
- 재현 절차: `npx playwright test -c e2e/qa/playwright.qa.config.ts qa-302` — 또는 375 px 폭에서 `/ops` 로그인 뒤 탭 줄을 본다.
- 기대 결과: 좁은 화면에서 탭 줄이 줄바꿈되거나 가로로 스크롤되어 탭 일곱 모두 누를 수 있다(헤더 메뉴는 그렇게 한다 — `Shell.tsx` R-39).
- 실제 결과: 탭 줄(`flex gap-1`, 폭 502 px)이 화면 밖으로 넘친다: 375 px 에서 `ops-tab-audit` right 383 · `ops-tab-dlq` x 386–433 · `ops-tab-pipeline` x 436–511,
  320 px 에서 settings(right 321)부터 화면 밖. dlq · pipeline 은 단추 전체가 화면 밖이고 body 가 `overflow hidden` 이라 페이지도 밀리지 않아 터치로는 열 수 없다(WCAG 1.4.10 재배치). 문서 폭 529 px.
- 증거: `evidence/ui-a11y/ops-mobile-providers.png`(PROVIDERS … AUDIT 까지만 보임) · `a11y-extra.json` `ops-signed-in-375.tabs` / `ops-signed-in-320.clipped` · `ops-logs-steps.json` "ops mobile 375: providers"
- 의심 원인: `apps/web/app/ops/page.tsx:208`(`<div className="flex gap-1" role="group" aria-label="운영 탭">` — `flex-wrap` · `overflow-x-auto` 없음)
- 재현 시험: `apps/web/e2e/qa/qa-302-ops-tabs-mobile.spec.ts` — 실패(375 · 320 둘 다): `expect(unreachable).toEqual([])` — Received `["ops-tab-audit (right 383 > 375)", "ops-tab-dlq (right 433 > 375)", "ops-tab-pipeline (right 511 > 375)"]` /
  320: `["ops-tab-settings (right 321 > 320)", "ops-tab-audit (right 383 > 320)", "ops-tab-dlq (right 433 > 320)", "ops-tab-pipeline (right 511 > 320)"]`

### QA-303 · 낮음 · 화면(공통, 모바일) — 하단 출처 줄이 좁은 화면에서 잘려 출처 링크 둘이 화면 밖
- 환경: 스택 A · Chromium 375×812 · 320×256 · 모든 경로
- 재현 절차: `npx playwright test -c e2e/qa/playwright.qa.config.ts qa-303`
- 기대 결과: 컴포넌트 주석("폭이 좁으면 줄바꿈 — 잘리거나 가로 스크롤 밖으로 밀려나지 않는다")과 FR-20 · NFR-15 '상시 노출'대로 모든 출처가 화면 안에 보인다.
- 실제 결과: 묶음마다 `inline-block whitespace-nowrap` 이라 가장 긴 묶음('연안 교통량 한국해양교통안전공단 MTIS … · 해양수산부 해양격자 4단계 (공공데이터포털)', 519 px)이
  줄바꿈되지 않고 오른쪽이 잘린다. 문서 폭 529 px(375 · 320 px 모든 경로), '해양수산부 해양격자 4단계'(right 457) · 'OpenStreetMap contributors'(320 px 에서 right 338)가 화면 밖.
- 증거: `evidence/ui-a11y/sweep-mobile-dashboard.png`(맨 아래 "· 해양수"에서 잘림) · `reflow-reflow-320x256-about.png` · `sweep-mobile.json` 모든 경로 `overflow.scrollWidth 529`
- 의심 원인: `apps/web/components/AttributionFooter.tsx:12`(`<span className="inline-block whitespace-nowrap">` — 묶음 안 줄바꿈 금지)
- 재현 시험: `apps/web/e2e/qa/qa-303-footer-reflow.spec.ts` — 실패: `expect(r.cut).toEqual([])` — 375: Received `["해양수산부 해양격자 4단계"]`, 320: `["해양수산부 해양격자 4단계", "OpenStreetMap contributors"]`

### QA-304 · 낮음 · 접근성(키보드 · 초점) — 패널 내용이 바뀌면 초점이 `<body>` 로 떨어진다
- 환경: 스택 A · Chromium 1440×900 · 키보드만
- 재현 절차: `npx playwright test -c e2e/qa/playwright.qa.config.ts qa-304` — 또는 상황판 `sigmet` 탭 → 목록 항목에 초점 → Enter → `document.activeElement`.
- 기대 결과: 카드를 열면 초점이 카드(제목이나 '닫기')로, 닫으면 연 자리(목록 항목 · 탭 · 검색)로 간다(WCAG 2.4.3 초점 순서). 화면 읽기 프로그램이 위치를 잃지 않는다.
- 실제 결과: 다음 조작 뒤 초점이 `body` 다(`dashboard-steps.json` · `keyboard.json` · `ops-logs-steps.json` · `pages-steps.json` 의 focus 기록):
  항공기 카드 '닫기' · SIGMET 목록 Enter → 카드 · SIGMET 카드 '닫기' · 공항 목록 Enter → 카드 · 공항 카드 '닫기' · 선박 목록 Enter → 카드 · 선박 카드 '닫기' · '선박 켜기' ·
  알림 근거 '항공기 카드 · 지도에서 보기' · 재생 상세 '닫기' · 운영 실행 '더 보기' · 설정 save 뒤(단추가 disabled 로 바뀜) · 로그 상세 '닫기' · 로그 '새 항목 N건' · 로그 '목록으로' · 로그인 성공 · sign out.
  Chromium 은 다음 Tab 을 지운 요소 자리에서 이어 간다(카드 닫은 뒤 Tab → 'RainViewer', Shift+Tab → 마지막 알림 줄) — 그래서 막히지는 않지만 화면 읽기 프로그램은 '문서'로 돌아간다.
  (검색으로 고를 때는 초점이 입력에 남고 상태 라이브 영역이 "KAL2065 선택 — 지도 이동" 을 알린다 — 그 길은 괜찮다.)
- 증거: `evidence/ui-a11y/keyboard.json` `coreTask.afterClose = body` · `sigmetFromList.afterOpen = body` · `dashboard-steps.json` 각 단계 `focus.tag`
- 의심 원인: `apps/web/components/SidePanel.tsx:32-37`(탭 내용을 갈아 끼움 — 초점 처리 없음), `AircraftCard.tsx:195` · `SigmetCard.tsx:43` · `AirportCard.tsx:36` · `ShipCard.tsx:138`('닫기' = 선택만 지움),
  `SigmetList.tsx:30` · `AirportList.tsx:28`(누른 단추가 사라짐), `ShipCard.tsx:233`, `AlertPanel.tsx:106`, `app/replay/page.tsx:119`, `components/logs/LogDetail.tsx:86`, `LogsDashboard.tsx:304`
- 재현 시험: `apps/web/e2e/qa/qa-304-focus-loss.spec.ts` — 실패: `Error: focus after opening the card from the list — expect(received).toBe(expected) · Expected: false · Received: true`,
  `Error: focus after closing the aircraft card — Expected: false · Received: true`

### QA-305 · 낮음 · 접근성(키보드) — 내용 스크롤 상자에 키보드 초점이 없다(axe `scrollable-region-focusable`, serious, WCAG 2.1.1)
- 환경: 스택 A · Chromium · 1440 · 768 · 375
- 재현 절차: `npx playwright test -c e2e/qa/playwright.qa.config.ts qa-305` — 또는 `/about` 에서 Tab(본문으로 건너뛰기) → Enter → PageDown · End.
- 기대 결과: 건너뛰기 뒤 키보드로 본문을 읽을 수 있다(스크롤 상자가 초점을 받거나 tabindex=0 · 이름이 있다).
- 실제 결과: body 가 `overflow hidden` 이고 본문은 안쪽 `div.overflow-y-auto` 가 스크롤한다. 건너뛰기(#main, tabindex −1) 뒤 PageDown · Space · ↓ · End 로 `scrollTop` 0/486 그대로.
  Chromium 153 은 초점 없는 스크롤 상자 자체를 Tab 정지점으로 만들어(키보드 초점 스크롤러) 몇 번 더 Tab 하면 스크롤되지만, 그렇지 않은 브라우저에서는 읽을 길이 없다.
  axe 위반 위치: `/about` 본문(모든 폭) · `/airports/RKSI`(375) · 설명서 범례 표 6개(375 — `.g-table`) · 지도 범례(`#map-legend`) · 운영 quality · audit · pipeline 탭 본문(글자만 있을 때).
- 증거: `sweep-desktop.json` · `sweep-tablet.json` · `sweep-mobile.json` 의 axe · `dashboard-steps.json`("legend open") · `ops-logs-steps.json`("ops tab ops-tab-quality/audit/pipeline") ·
  `pages-steps.json` "about: keyboard scroll" → `scrollTop after keys=0 · focus can enter scroller=true`
- 의심 원인: `apps/web/app/about/page.tsx:22` · `app/airports/[icao]/page.tsx:34` · `components/MapLegend.tsx:126` · `app/ops/page.tsx:224` · `app/globals.css:149`(`.g-table`)
- 재현 시험: `apps/web/e2e/qa/qa-305-scroll-region-keyboard.spec.ts` — 실패: `expect(received).toBeGreaterThan(expected) · Expected: > 0 · Received: 0`,
  `expect(...).toEqual([])` — Received `[".overflow-y-auto"]`(axe scrollable-region-focusable)

### QA-306 · 낮음 · 접근성(대비) — 글자 대비 4.5:1 미만 두 곳(WCAG 1.4.3)
- 환경: 스택 A · Chromium 1440×900
- 재현 절차: `npx playwright test -c e2e/qa/playwright.qa.config.ts qa-306`
- 기대 결과: 작은 글자(9–10 px)도 4.5:1 이상(저장소의 다른 보조 글자는 `--color-fg-3` 로 4.6–6.2:1 을 맞춘다 — globals.css 주석).
- 실제 결과: ① 지도 범례의 고도 m 보조 표기(`0 m` · `3,048 m` · `7,620 m` · `12,192 m+`, 9 px) `#727982` / `#111418` = **4.19:1**(fg-3 에 80 % 불투명).
  ② 로그 목록에서 고른 줄(배경 `#1c2a3f`)의 `ERROR` 배지(`#ef5d62`, 10 px) = **4.41:1**(고르지 않은 줄 `#111418` 위에서는 5.64:1).
- 증거: `evidence/ui-a11y/dashboard-legend-open.png` · `logs-detail.png` · `dashboard-steps.json` "legend open"(color-contrast 4) · `ops-logs-steps.json` "logs: open first row (click) → detail"(color-contrast 1)
- 의심 원인: `apps/web/components/MapLegend.tsx:137`(`text-fg-3/80`) · `components/logs/LogsDashboard.tsx:350`(고른 줄 `bg-[#1c2a3f]`) · `:352`(`badge bad`)
- 재현 시험: `apps/web/e2e/qa/qa-306-contrast.spec.ts` — 실패: `Element has insufficient color contrast of 4.19 (foreground color: #727982, background color: #111418, font size: 6.8pt (9px) …)` ×4,
  `Element has insufficient color contrast of 4.41 (foreground color: #ef5d62, background color: #1c2a3f, font size: 7.5pt (10px) …)`

### QA-307 · 보통 · 화면(운영 · 감사) — 감사 탭이 최근 50건만 보이고 그 앞 기록으로 갈 방법이 없다
- 환경: 스택 A · `qa-b` 로그인
- 재현 절차: `npx playwright test -c e2e/qa/playwright.qa.config.ts qa-307`; 실제 응답 확인 — `tools/qa/qa_session.py` 로 `GET /api/v1/ops/audit` → `items 50 · next_cursor 67`, `?cursor=67` → `items 50 · next_cursor 17`.
- 기대 결과: api 가 다음 쪽(next_cursor)을 주면 '더 보기'(운영 실행 목록 · 로그처럼) 또는 적어도 "더 있음 — 최근 50건만"을 보인다. 감사 기록은 누가 언제 무엇을 바꿨는지 보는 곳이다.
- 실제 결과: 표는 첫 50건만 그리고 next_cursor 를 버린다 — '더 보기' 도, 잘렸다는 표시도 없다. 로그인 · 로그아웃마다 2행이 쌓여 격리 스택 A 에서는 약 45분 만에 50건이 차
  설정 변경(`SETTING_UPDATE`) · 해결(`RESOLVE`/`UNRESOLVE`) 기록이 화면에서 밀려 사라진다(api 로만 볼 수 있다).
- 증거: `evidence/ui-a11y/ops-ops-tab-audit.png`(50행, 아래에 더 보기 없음) · 위 API 응답
- 의심 원인: `apps/web/app/ops/page.tsx:325-326`(audit 표 — `audit.items` 만), `apps/web/lib/endpoints/ops.ts:37`(감사 경로에 커서 인자 없음 — 실행 drill 은 `runsDrill(…, cursor)` 가 있다)
- 재현 시험: `apps/web/e2e/qa/qa-307-audit-paging.spec.ts` — 실패: `expect(locator).toBeVisible() failed · Expected: visible · Timeout: 3000ms · Error: element(s) not found`(50행은 그림)

### QA-308 · 낮음 · UX 정직성(통계) — 7일 패널이 응답의 날짜별 집계 여부를 읽지 않아 "구분할 수 없습니다"라고 한다
- 환경: 스택 A · `/stats`
- 재현 절차: `npx playwright test -c e2e/qa/playwright.qa.config.ts qa-308`; 실제: `curl -s 'http://localhost:8701/api/v1/stats/sigmet?group=fir'` →
  `{"group":"fir","items":[],"days":[{"day":"2026-09-25","aggregated":true},…,{"day":"2026-10-01","aggregated":true},{"day":"2026-10-02","aggregated":false}],"day_zone":"Asia/Seoul",…}`
- 기대 결과: 머리말("빈 칸은 집계 전·자료 없음을 구분해 표시")대로, 지난 7일이 모두 집계됐으면 "최근 7일 자료가 없습니다(집계됨 · 해당 기록 없음)"(lib/stats.ts 에 이미 있는 문구).
- 실제 결과: SIGMET by FIR · by hazard · Alerts 세 패널 모두 "자료 없음 — 집계 전인지 기록이 없는지 이 응답으로는 구분할 수 없습니다" — 응답이 날짜별로 구분해 주는데도.
  화면은 최상위 `aggregated` 만 읽는데, 7일 응답에는 그 필드가 없다(REST 계약 `tools/rest_contract_check.py:1245` · `:1262` — `days` 만). 기존 E2E(`e2e/stats-states.spec.ts:20`)의 가짜 응답은
  api 가 주지 않는 최상위 `aggregated` 를 넣어 이 길을 덮는다.
- 증거: `evidence/ui-a11y/sweep-desktop-stats.png` · `pages-steps.json` "stats: panel texts" · 위 응답
- 의심 원인: `apps/web/app/stats/page.tsx:41`(`flagOf(fir.load)` …) → `lib/stats.ts:35`(`aggregatedFlag` — 최상위만), `lib/endpoints/stats.ts:12`(`StatsItems` 에 `days` 없음)
- 재현 시험: `apps/web/e2e/qa/qa-308-stats-days-aggregated.spec.ts` — 실패: `expect(locator).not.toContainText(expected) failed · Expected substring: not "구분할 수 없습니다" ·
  Received string: "SIGMET by FIR (7d, top 24)자료 없음 — 집계 전인지 기록이 없는지 이 응답으로는 구분할 수 없습니다(집계는 매일 03:30 KST)."`

### QA-309 · 낮음 · UX 정직성(통계) — 미래 날짜를 넣으면 그 날로 조회하고 "다음 집계 뒤 채워집니다"라고 약속한다
- 환경: 스택 A · `/stats` · 날짜 칸(집계 날짜(KST), max = 어제)
- 재현 절차: `npx playwright test -c e2e/qa/playwright.qa.config.ts qa-309` — 또는 날짜 칸에서 ↑ 두 번(월 칸) · 직접 입력으로 2026-11-01.
- 기대 결과: max(어제)보다 뒤는 받지 않거나(되돌리거나 오류 표시), 적어도 "아직 끝나지 않은 날 · 미래"라고 말한다.
- 실제 결과: `GET /api/v1/stats/traffic?day=2026-11-01` 을 보내고 "아직 집계되지 않았습니다 — 다음 03:30 KST 집계 뒤 채워집니다(놓친 최근 7일은 3시간마다 따라잡기)."(한 달 뒤 날짜에).
- 증거: `evidence/ui-a11y/qa-309-stats-future-day.png` · `pages-steps.json` "stats: date + 2 days (beyond max?)" → `now=2026-11-01 max=2026-10-01`
- 의심 원인: `apps/web/app/stats/page.tsx:63`(`onChange={(e) => { if (e.target.value) setDay(e.target.value); }}` — max 검사 없음), `lib/stats.ts:64-87`(`statsEmptyText` 가 미래 날을 가르지 않음)
- 재현 시험: `apps/web/e2e/qa/qa-309-stats-future-day.spec.ts` — 실패: `Error: requested days after typing 2026-11-01 (max 2026-10-01) — expect(received).not.toContain(expected) · Expected value: not "2026-11-01" · Received array: ["2026-11-01"]`

### QA-310 · 낮음 · UX(단위) — 분 · 초 단위가 대문자로 바뀐다("9M 55S", "15M 38S 전")
- 환경: 스택 A · 상황판 알림 목록 · `/airports/RKSI`
- 재현 절차: `npx playwright test -c e2e/qa/playwright.qa.config.ts qa-310`
- 기대 결과: 단위는 쓴 그대로(`9m 55s`). 같은 화면에서 `m` 은 미터(고도 "9,449 m")라 대문자 `M` 은 단위를 헷갈리게 한다(제품 규칙 '단위를 적는다').
- 실제 결과: `.badge` · `.label` 의 `text-transform: uppercase` 가 예측 ETA 배지("추정 ETA 9M 55S" · "31S")와 공항 METAR 줄("METAR · 10-02 03:00:00 KST · 35M 19S 전 · FIXTURE")을 바꾼다.
  브라우저 접근성 트리 이름도 "추정 ETA 9M 41S"(CDP `Accessibility.getFullAXTree`) — 화면 읽기 프로그램도 그렇게 읽는다.
- 증거: `evidence/ui-a11y/airport-rksi.png` · 재현 시험 출력 · 접근성 트리 이름(탐색 기록: `button: EOK385 , TS EMBD , ZYSH , 진입 시 고도 추정 FL224 6,835 m , 추정 ETA 9M 41S`)
- 의심 원인: `apps/web/app/globals.css:33`(`.label` uppercase) · `:40`(`.badge` uppercase), `components/AlertPanel.tsx:162`(EtaBadge `badge est`), `app/airports/[icao]/page.tsx:42`(`label` 안의 `fmtDuration`)
- 재현 시험: `apps/web/e2e/qa/qa-310-unit-case.spec.ts` — 실패: `Expected pattern: /ETA ((\d+m )?\d+s|—)$/ · Received string: "추정 ETA 31S"`,
  `Expected pattern: /\d+(m|s|h)( \d+(m|s))? 전/ · Received string: "METAR · 10-02 03:00:00 KST · 35M 19S 전 · FIXTURE"`

### QA-311 · 낮음 · UX(KST 규칙) — 감사의 before · after 칸이 UTC 시각이 든 원본 JSON 인데 '원본' 표시가 없다
- 환경: 스택 A · `/ops` audit 탭(실제 행: `UNRESOLVE provider_error:opensky` — 다른 QA 영역이 만든 해결 · 되돌림)
- 재현 절차: `npx playwright test -c e2e/qa/playwright.qa.config.ts qa-311`; KST 훑기 `qa-kst` → `kst-scan.json` "/ops audit".
- 기대 결과: 같은 화면의 다른 원본 칸(격리 detail · DLQ payload head · 실행 오류 글자)처럼 `data-raw` + 머리글 "(raw)" + 툴팁("‘…Z’ 는 KST 보다 9시간 이르다")으로 KST 규칙의 예외임을 알린다.
- 실제 결과: 머리글 "before" · "after", 칸에 `{"id": 3, …, "upto": "2026-10-01T17:54:22Z", "resolved_at": "2026-10-01T17:56:09.181606Z", …}` 그대로 — 원본 표시가 없다.
  (다른 모든 화면 · 탭에서는 브라우저 시간대 UTC 인데도 UTC 로 그린 시각이 없었다 — 아래 '확인했고 문제없음'.)
- 증거: `evidence/ui-a11y/ops-ops-tab-audit.png`(맨 아래 행) · `kst-scan.json`
- 의심 원인: `apps/web/app/ops/page.tsx:327`(머리글 `<th>before</th><th>after</th>`) · `:328`(칸 `String(a.before)` · `String(a.after)` — `data-raw` · title 없음)
- 재현 시험: `apps/web/e2e/qa/qa-311-audit-raw-utc.spec.ts` — 실패: `expect(locator).toHaveCount(expected) failed · Expected: 1 · Received: 0 — …locator('xpath=self::*[@data-raw] | .//*[@data-raw]')`

### QA-312 · 낮음 · UX 정직성(데이터) — ADS-B 호출부호 '@@@@@@@@'(값 없음 채움)를 호출부호로 보인다
- 환경: 스택 A(fixture = 공급자 실제 응답 녹화) · 상황판 알림 목록 · 지도 라벨 · 검색 · 항공기 카드 · API
- 재현 절차: `cd apps/collector && uv run --offline pytest tests/qa/test_qa_312_callsign_at_fill.py -q`; 화면: 검색 `a2fad1` → 호출부호 칸 `@@@@@@@@`;
  API: `curl -s http://localhost:8701/api/v1/aircraft/a2fad1` → `"callsign":"@@@@@@@@"`.
- 기대 결과: '@' 채움(ADS-B 6-bit 문자 0 = 값 없음)은 값 없음 → 화면은 `—`(제품 규칙 "모르면 —"). AIS 는 같은 채움을 걷어 낸다(`ais/parse.py:169`).
- 실제 결과: 공급자 응답(`fixtures/adsb_fi_region.json:43` · `:60`, `adsb_lol_region.json:66` — `"flight":"@@@@@@@@"`)이 그대로 호출부호가 되어 알림 목록("@@@@@@@@, TS EMBD, RKRR …"),
  검색 결과, 카드 'Callsign' 에 보인다. (노선 조회도 이 글자로 할 수 있다 — 확인하지 않음.)
- 증거: `evidence/ui-a11y/qa-312-search-at-callsign.png` · `qa-312-card-at-callsign.png`
- 의심 원인: `apps/collector/wakeline_collector/normalize.py:36-40`(`_str` 은 공백만 걷음) · `:184`(`callsign=_str(ac.get("flight"), 8)`)
- 재현 시험: `apps/collector/tests/qa/test_qa_312_callsign_at_fill.py` — 실패: `AssertionError: assert '@@@@@@@@' is None`

### QA-313 · 낮음 · 접근성(언어) — 영어 제목 · 문구에 lang 표시가 없다(WCAG 3.1.2)
- 환경: 스택 A · 모든 경로(문서 `lang="ko"` 는 모든 화면에 있음 — 확인)
- 재현 절차: `npx playwright test -c e2e/qa/playwright.qa.config.ts qa-313`
- 기대 결과: 영어 구절(제목 · 단추 이름)은 `lang="en"` 으로 표시해 음성이 영어로 읽는다.
- 실제 결과: h1 "Statistics" · "Data sources · licenses" · "Airport weather · RKSI", 로그인 "Operator sign-in" · "Sign in", 'sign out' · 'save' · 'latest' 등 — 화면 전체에서 `[lang^=en]` 0개.
- 증거: `evidence/ui-a11y/a11y-extra.json` `lang`
- 의심 원인: `apps/web/app/stats/page.tsx:53` · `app/about/page.tsx:23` · `app/airports/[icao]/page.tsx:35` · `components/OpsLogin.tsx:30`
- 재현 시험: `apps/web/e2e/qa/qa-313-lang-of-parts.spec.ts` — 실패(3): `Expected pattern: /^en/ · Received string: "ko"`

## 미확인(의심했지만 재현 · 판정하지 못함)
- **알림 배너 라이브 영역의 낭독 글자가 붙는다**: 배너(`AlertPanel.tsx` EventBanner — role=status, aria-live polite)의 글자가 `<span>` 사이에 공백 없이 이어져 DOM 글자가
  "LEFT이탈 · GTI349SIGMETTS EMBD · ZSHA · 수신 03:13:13 KST" 가 된다("SIGMET" + "TS EMBD"). 실제 화면 읽기 프로그램(VoiceOver · NVDA)이 붙여 읽는지는 이 환경에서 확인하지 못했다(헤드리스 · 화면 읽기 프로그램 없음).
  1분 동안 바뀜 2번 — 너무 잦지는 않다. 해본 것: MutationObserver 로 60 s 기록(`live.cjs` 탐색), CDP 접근성 트리.
- **WS `selected` 가 같은 내용으로 두 번 온다**: 항공기를 고른 동안 40 s 에 `selected` 13번 중 2쌍이 `seen_at` 까지 같은 내용(예: `18:26:22.251Z` ×2, `18:27:03.202Z` ×2). 화면에는 해가 없다(같은 값).
  WS 계약 · 집중 추적 주기는 기능 영역이라 원인은 보지 않았다.
- **운영 공급자 표에 실행한 적 있는 공급자만 나온다**: fixture 스택에서 `provider_switch` 는 11개인데 표는 2행(opensky · fixture) — 나머지 9개는 화면에서 켜고 끌 수 없다.
  운영 스택에서는 모든 공급자가 실행되어 행이 있을 것이라 fixture 한정일 수 있다(운영 스택은 보지 않는다 — 규칙).
- **오프라인 에뮬레이션에서 WS 가 닫히지 않음**: `context.setOffline(true)` 45 s 동안 WS 가 열린 채 "WS OPEN" — Chromium 오프라인 에뮬레이션이 열린 WS 를 끊지 않는 탓으로 보인다.
  대신 `routeWebSocket` 으로 서버 메시지를 버려 '조용한 연결'을 만들어 확인했다(아래 '확인했고 문제없음') — 제품 결함 아님으로 본다.

## 개선 제안(결함 수에 넣지 않음)
1. **Esc 로 닫기가 화면마다 다르다**: 상태 상세(Esc 닫기 · 초점 복귀)와 검색은 되지만 지도 범례 · 항공기 · 선박 · SIGMET · 공항 카드 · 운영 실행 목록(drill) · 로그 상세는 Esc 로 닫히지 않는다(설명서는 약속하지 않음 — 결함 아님).
   겹쳐 뜨는 범례 · 상세부터 Esc 를 같은 규칙으로.
2. **누르면 이름이 바뀌는 토글**: 레이더 '애니메이션 ▶/정지'(`aria-label` 이 "재생"↔"정지" 로 바뀌면서 `aria-pressed` 도 바뀜) · 재생 '재생/정지' — WAI-ARIA 작성 지침은 aria-pressed 를 쓰면 이름을 고정하라고 한다("정지, 눌림"으로 읽힌다).
3. **맥락 없는 같은 이름 단추**: 운영 설정의 `save` ×10 · 공급자 `enable/disable` · 로그 묶음 `목록으로` · `묶음 복사` — 해결 단추처럼(`aria-label="해결 처리: 지문 …"`) 대상 이름을 넣으면 단추 목록으로 탐색할 때 구분된다.
4. **오류 문구의 '로그 보기' 링크가 미리 받기(prefetch)를 한다**: `/airports/ZZZZ` 를 열면 `GET /logs?_rsc=…` 가 나간다(`components/logs/ErrorNote.tsx` 의 `Link` — 헤더 메뉴는 edge 양동이 때문에 `prefetch={false}`, VERIFICATION #30). 같은 규칙으로.
5. **운영 화면은 보이는 탭과 상관없이 15 s 마다 엔드포인트 7개를 모두 부른다**(문서화된 동작 — `useOpsTabs`). 열린 운영 화면 하나가 분당 28 요청으로 edge 의 IP당 양동이를 쓴다. 보이는 탭만 주기로, 나머지는 탭을 열 때 받는 방식을 검토.
6. **로그인 안 된 `/ops` · `/logs` 는 콘솔에 404 오류를 남긴다**(`GET /api/v1/ops/session` → 404 — 운영 경로를 숨기는 설계). 사용자에게는 보이지 않지만 콘솔 오류 0 을 기준으로 삼는 점검에서 늘 걸린다.
7. **상황판 첫 화면의 긴 작업**: 헤드리스 소프트웨어 GL 에서 longtask 17개 · 최대 1,874 ms(1440) — 성능 단계(Lighthouse)에서 실제 GPU 로 다시 볼 것(여기서는 판단하지 않음).

## 확인했고 문제없음(범위 증거)
- **모든 경로 × 3 폭 첫 화면**(`sweep-<폭>.json`): 페이지 오류 0, 콘솔 오류는 막은 외부 호스트(타일 · 스타일)와 설계된 404(`/ops/session` 비로그인 · `/airports/ZZZZ` · `/airports/abc` 400) 뿐,
  첫 10 s 의 중복 요청(같은 method+URL 1.5 s 안) 0, 1440 · 768 에서 가로 넘침 0(375 는 QA-303), 문서 `lang="ko"` · 화면마다 다른 `<title>`.
- **axe(WCAG 2.1 A · AA)**: 상황판(첫 화면 · 항공기 카드 · 선박 목록 · 선박 카드 · SIGMET · 공항 목록과 카드 · 알림 근거 · 기상청 레이더 · 범례·정합 · 상태 상세) · 재생(목록 · 상세) · 통계 · 공항(정상 · 모르는 코드 · 형식 오류) ·
  운영(로그인 폼 · 탭 7 · 설정 오류 · 모바일) · 로그(목록 · 상세 · 묶음 · 요청 id 오류 · AIS 수신 공백 · 모바일) · 설명서(목차 select) · 출처에서 위반은 QA-305 · QA-306 의 두 규칙뿐.
- **키보드**(`keyboard.json`): 경로마다 Tab 한 바퀴(상황판 83 · 재생 52 · 통계 31 · 공항 27 · 설명서 83 · 운영 로그인 30 · 운영 38 · 로그 54 정지점) — 초점 표시(2 px accent outline) 모두 보임,
  화면 밖 초점 0, 갇힘 0(문서 끝에서 브라우저로 나감). 날짜 · 시각 입력의 초점도 보인다(`focus-…` 확인). 건너뛰기 링크: 첫 Tab = '본문으로 건너뛰기' → Enter → `#main`.
  검색: `/` 초점 · ↑↓ · Enter 선택 · Esc 닫기 → 두 번째 Esc 는 글자 지움(설명서대로). 운영 로그인 폼: label 연결(`username` · `password (8자 이상)`) · autocomplete · 빈 제출 → 아이디 칸 초점 + `aria-invalid` + role=alert.
  로그 표(grid): ↑↓ · Enter 로 상세, `aria-activedescendant` 갱신. 레이더 슬라이더 `aria-valuetext` = 프레임 시각 KST(값과 일치).
- **모든 조작**(`dashboard-steps.json` · `ops-logs-steps.json` · `pages-steps.json`): 헤더 메뉴 7개 클릭(aria-current · 제목 갱신), 레이어 9개 켜고 끔, 범례, 오른쪽 탭 5, 알림 범위 · 근거, 레이더 출처(기상청 HSR 은 fixture 에서 "수집 전" — disabled · 까닭 title) ·
  재생 · 정지 · 슬라이더 · latest · 범례·정합, 상태 상세, 지도 확대 · 축소, 선박 목록 필터 · 정렬 6열(aria-sort) · 카드 · 항적 6/12/24 h, 선박 검색 → 선택(선박 레이어 켜짐), 재생(재생 · 속도 5 · ±1h/10m/1m · 시각 입력 · 슬라이더 · 레이더 · 목록 · 상세),
  운영(탭 7 · 해결된 오류 포함 · 실행 목록 · 더 보기 · 설정 저장 · 클라이언트 검증 · 공급자 끄고 켬(0.3 s 안에 표 갱신) · 새로고침 · sign out → 세션 404 확인), 로그(서비스 4 · 수준 3 · 기간 4 · 해결 보기 · 글자 검색 · 요청 id 검사 · 초기화 · 묶음 · 목록으로 · 새 항목 · AIS 수신 공백).
  단계마다 페이지 오류 0 · 5xx 0 · 중복 요청 0(429 1건은 다른 QA 에이전트와 같은 IP 의 api 제한을 나눠 써서 — 화면은 "조회 실패 — HTTP 429" 로 정직하게 보임).
- **요청 패턴**: 상황판은 WS 로 받고 REST 주기는 `/api/v1/radar/kr` 60 s · 감시 공항 5분뿐(30 s 가만히: API 0건). `/radar/kr` 의 두 번째부터는 `If-None-Match` → 304(페이지의 fetch 는 304 를 받는다 — Chromium 은 이를 `ERR_ABORTED` 로 알려 처음에 실패로 보였음, 확인 뒤 제외).
  재생 10× 는 1초에 1요청(겹침 없음), 로그는 15 s 확인 1건, 날짜를 바꾸면 늦은 응답을 끊는다(통계 `ERR_ABORTED` = 의도).
- **조용한 WS · 지난 값**(`routeWebSocket` 으로 서버 메시지를 버림): 45 s 뒤 "WS open · 수신 없음" · 알림 "수신 없음(연결은 열림) — 마지막으로 받은 목록 · 갱신 안 됨 · ETA 멈춤" · ETA "—",
  60 s 뒤 region "lag 75s STALE", 75 s 뒤 다시 연결 → 회복(`ws-silent-60s.png`). 지난 값을 실시간처럼 두지 않는다(R-58 기준값대로).
- **KST**(`kst-scan.json`, 브라우저 UTC): 상황판(카드 · 근거 · 상태 상세) · 재생 · 통계 · 공항 · 설명서 · 운영 탭 7 · 로그(목록 · 상세)에서 UTC 로 그린 시각 · 'UTC' 표기 0(감사 원본 JSON 만 — QA-311). 원문(METAR · TAF · 로그 원문)은 `data-raw` 로 그대로.
- **200 % 확대(640×400)**: 모든 경로 가로 넘침 0 · 잘린 조작 0. 400 %(320×256): 출처 줄(QA-303)과 상황판 탭 'airport' 오른쪽 21 px 잘림 외에 없음(지도는 2차원 배치 예외).
- **라이브 영역**: 검색 상태(결과 수 · "KAL2065 선택 — 지도 이동"), 노선 조회 · 집중 추적, 배경지도 실패, 수요 · 선박 칩, 운영 설정 · 공급자 결과(role=status), 오류(role=alert). 알림 배너 1분 2번.
- **지도 위 글자 대비(계산)**: 라벨 `#cfd4da`/`#a3aab4`/`#b18cf5`/`#9fb3c8` + halo `#0b0d10` 1 px — 대체 바탕 `#0b0d10` 에서 13.05/8.31/7.36/9.04:1, 육지 `#2e3239` 4.87–8.63:1, 바다 `#040a12` 7.51–13.32:1.
  지도 위 HTML(레이어 단추 · 칩 · 알림 · 출처 ⓘ)은 불투명 또는 88–90 % 어두운 바탕 — 배경지도 실패 알림 `#f2b33d`/`#111418` 9.93:1, 출처 `#8a929d` 5.87:1.
- **정직성**: 모르는 값 '—'(공급자 표 · 카드 · 검색 등록번호), 추정 표시(DEAD RECKONING · 추정 ETA · 점선), 출처(FIXTURE · 공급자), 단위 이중 표기(ft · m, kt · km/h) — QA-310 · QA-312 외에 어긋남 없음.

## 확인하지 못한 것과 까닭
- 배경지도 · 레이더 그림(외부 호스트 차단 — 브리프 지시). 실제 OpenFreeMap 위의 대비는 `lib/basemap.ts` 단위 시험이 본다.
- 화면 읽기 프로그램의 실제 낭독(VoiceOver · NVDA 없음 — 헤드리스). 접근성 트리 · 라이브 영역 DOM 으로만 판단.
- Safari · Firefox(Chromium 만 설치) — QA-305 의 브라우저별 차이는 Chromium 동작과 axe 규칙으로만 말한다.
- 실제 터치 기기(375 폭은 뷰포트 에뮬레이션, `isMobile` 아님).
- 성능 · Lighthouse · 30 fps(성능 단계).
- fixture 의 METAR 원문 날짜(`270730Z`)와 표시 관측 시각(오늘)이 다른 것 — fixture 가 시각을 오늘로 옮긴다. 운영 공급자 응답으로는 보지 않았다(운영 스택 금지).
