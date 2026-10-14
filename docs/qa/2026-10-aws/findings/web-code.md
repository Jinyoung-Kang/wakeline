# web-code — apps/web 코드 수준 점검(QA 2026-10-aws)

- 대상: `apps/web` — `004f26dc`(AWS 배포본) · `29d39e38`(main) · `0e9b2075`(QA 브랜치 HEAD) 사이에 `apps/web` 차이 없음(`git diff --stat` 0줄).
- 환경 **U** = 이 Mac 의 Vitest 5.0.2(Next 16.3.8 · React 19.3.0 설치본), 최소 DOM(`tests/helpers/mini-dom`) · `renderToStaticMarkup`. 라이브 스택 · 실제 브라우저는 쓰지 않았다
  (브라우저 점검은 다른 에이전트). gate · CloudFront 의 답은 aws-deploy 코드(`gate/gate.py:439-445`)와 AWS 읽기 기록(`evidence/aws-readonly/`)의 모양 그대로 흉내 냈다.
- 기준선: `cd apps/web && npx vitest run` — 155 파일 · 1,827 통과 · 3 건너뜀. 재현 시험을 더한 뒤 160 파일 · **11 실패(모두 새 재현 시험)** · 1,829 통과(대조 2) · 3 건너뜀.
  `npx tsc --noEmit` · `npx eslint tests/qa/` 깨끗.
- 결함 5건(모두 낮음): 기능 QA-1300 – QA-1303 · 화면 · 접근성 QA-1400. 증거(명령 · 출력 전문)는 `evidence/web-code/<시험 이름>.txt`.

## QA-1300 · 낮음 · 기능(WS · AWS 앞단) — 접근 코드가 만료되면 상황판 WS 는 재접속만 되풀이하고 안내가 없다
- 환경: U · `apps/web/lib/ws.ts` · `lib/statusbar.ts` · `components/AlertPanel.tsx`
- 재현 절차: `cd apps/web && npx vitest run tests/qa/qa-1300-ws-gate-locked.test.ts`
  — 같은 출처 REST 는 모두 gate 의 401 `{"error":"locked"}`, WS 업그레이드는 브라우저처럼 열리지 않고 error → close(1006). 5분 흘린 뒤 상태 바의 연결 칩을 읽는다.
- 기대 결과: 앞단 잠금 만료(AWS 리뷰 D-5 — "화면마다 안내", 이 QA 계획 §3.2 "잠금 만료 때 REST · ETag 조회 · **WS** 의 안내")를 상황판 기본 화면에서도 알린다 —
  접근 코드가 만료됐으니 새로고침하라고. (REST 는 이미 `ACCESS_LOCKED` · "접근 코드가 만료됨 — 새로고침하면…" — 같은 시험의 대조가 통과.)
- 실제 결과: 5분 동안 소켓 14개(1 → 2 → 4 → … → 30 s 백오프, 끝없음), 칩은 `WS closed · retry 14` · 제목 "연결 끊김 — 14번째 재연결을 기다리는 중(지수 백오프, 최대 30 s)".
  알림 패널은 "연결 끊김 — 마지막으로 받은 목록 · 갱신 안 됨 · ETA 멈춤". 기본 화면(알림 탭 · 기본 레이어 — 교통량 · 수신 범위 · 공역 끔, 감시 공항 조회기의
  오류는 화면에 안 나옴)에서 실패를 보이는 곳은 이 둘뿐이고 어느 쪽도 접근 코드를 말하지 않는다. 새로고침 전에는 저절로 풀리지 않는다(쿠키는 잠금 화면에서만 다시 받는다).
- 실제로 생기는 때: 평일 낮에 잠금을 푼 탭을 열어 둔 채 정지(18:00)를 넘기면, 다음 날 스택이 뜰 때 쿠키(12 h)는 이미 만료 — 그 탭의 WS 재접속은 모두 401.
- 증거: `evidence/web-code/qa-1300-ws-gate-locked.txt` — `QA-1300 sockets=14 conn=closed retry=14 chip="WS closed · retry 14"` ·
  `AssertionError: expected 'WS closed · retry 14 연결 끊김 — 14번째 재연결…' to contain '접근 코드'`
- 의심 원인: 브라우저 WebSocket API 는 업그레이드 응답(401)을 보여 주지 않는다(close 1006 만). `lib/ws.ts:165-167` 은 닫힘 코드만 넘기고 `:198-211`(connectionDown)은
  까닭을 가리지 않고 재접속을 예약한다 — 잠금을 알아볼 경로(예: 열린 적 없는 실패가 이어지면 같은 출처 GET 한 번으로 401 locked 확인)가 없다.
  `lib/api.ts:35-37 gateLockedText` 는 REST · ETag 조회기만 쓴다. 표시: `lib/statusbar.ts:199-209 connChip` · `components/AlertPanel.tsx:77`.
- 재현 시험: `apps/web/tests/qa/qa-1300-ws-gate-locked.test.ts` — 1 실패(대조 1 통과)

## QA-1301 · 낮음 · 기능(AWS 앞단) — 잠금 만료 안내(D-5)가 자기 문구를 쓰는 화면에 빠졌다
- 환경: U · `lib/format.ts` · `lib/replay.ts` · `app/alerts/[id]/page.tsx` · `components/AirportList.tsx`
- 재현 절차: `cd apps/web && npx vitest run tests/qa/qa-1301-gate-locked-own-text-screens.test.ts`
  — 실제 전송 경로(`apiGet`)가 gate 의 401 locked 로 만든 오류(`ApiError` · code `ACCESS_LOCKED`)를 각 화면의 문구 함수 · 화면에 넣는다.
- 기대 결과: D-5 의 뜻대로 어느 화면이든 "접근 코드가 만료됨 — 새로고침…"(또는 같은 뜻)을 보인다.
- 실제 결과(오류 메시지를 그대로 보이는 ErrorNote · errorLine 화면 — 통계 · 카드 · `/m` · 관심 탭 — 은 안내가 나온다. 아래는 status 만 보고 문구를 고르는 곳):
  | 화면 | 지금 보이는 글 |
  |---|---|
  | `/airports/[icao]` | "기상 이력을 불러오지 못했습니다(HTTP 401)." |
  | `/replay`(프레임 오류) | "기록을 불러오지 못함(HTTP 401)" |
  | `/alerts/[id]`(공유 링크로 여는 근거 화면) | "알림 근거를 받지 못함" — HTTP 상태 · 까닭 · 다시 시도 모두 없음(429 · 503 도 같은 글) |
  | 상황판 공항 탭 목록 | "공항 목록을 불러오지 못했습니다 — 지도에서 공항을 클릭하세요."(지도 클릭도 같은 잠금에 막힌다) |
  - 같은 부류(시험 밖): 조각 청크 확인(`lib/chunk-probe.ts:68`)은 HEAD 401 을 "서버가 청크를 주지 못함(HTTP 401)"으로 적고 처음에는 '다시 시도'만 권한다(HEAD 라 본문으로 잠금을 가릴 수 없다).
- 증거: `evidence/web-code/qa-1301-gate-locked-own-text-screens.txt` — 4 실패, 출력 줄 `QA-1301 … → "…"` 이 위 표의 글.
- 의심 원인: `lib/format.ts:317-323 airportErrorText` · `lib/replay.ts:215-229 replayErrorText`(:227) · `app/alerts/[id]/page.tsx:20-22` ·
  `components/AirportList.tsx:14`(오류 객체를 버리고 state 'error' 만) · `:38`. D-5 수정(`lib/api.ts:35-48`)은 메시지에만 안내를 싣고 code `ACCESS_LOCKED` 를 읽는 화면이 없다.
- 재현 시험: `apps/web/tests/qa/qa-1301-gate-locked-own-text-screens.test.ts` — 4 실패(대조 1 통과)

## QA-1302 · 낮음 · 기능(AWS 앞단) — 정지 시간의 CloudFront 오프라인 HTML 503 을 받은 화면이 "503 (HTTP 503)" 만 보인다
- 환경: U · `lib/api.ts` · `lib/etag-poller.ts`
- 재현 절차: `cd apps/web && npx vitest run tests/qa/qa-1302-offline-503-html.test.ts` — 응답은 CloudFront 오류 응답(502 · 504 → `/_offline/index.html` 503, 배포판 전체 —
  `evidence/aws-readonly/describe-2026-10-14T0330KST.md`)의 모양: `503` · `text/html` · 오프라인 안내 HTML.
- 기대 결과: 무엇이 일어났는지(서버에 닿지 못함 · 데모 운영 시간 밖일 수 있음)를 사람 말로. api 의 503 은 problem+json(code · Retry-After)이고 edge 도 /api 오류를
  problem+json 으로 준다(`infra/edge/problem_pages.conf:12-14`) — /api 경로에서 JSON 이 아닌 503 은 앞단(CloudFront)이 원본에 닿지 못했다는 뜻뿐이다.
- 실제 결과: `apiGet` → `ApiError(503, "503")` · `errorLine` "503 (HTTP 503)"(통계 · 카드 · `/m` · 관심 탭에 그대로), ETag 조회기(특보 · 교통량 · 수신 범위 · 공역) "HTTP 503".
  잠금 401 의 "401 (HTTP 401)"을 고친 D-5 와 같은 부류이다.
- 증거: `evidence/web-code/qa-1302-offline-503-html.txt` — `QA-1302 apiGet → status=503 code=null message="503" errorLine="503 (HTTP 503)"` · `EtagPoller error → "HTTP 503"`
- 의심 원인: `lib/api.ts:40-48`(본문을 JSON 으로 못 읽으면 detail = 상태 숫자, Content-Type 을 보지 않는다) · `lib/etag-poller.ts:92`(401 locked 밖은 `HTTP ${status}`).
- 재현 시험: `apps/web/tests/qa/qa-1302-offline-503-html.test.ts` — 2 실패

## QA-1303 · 낮음 · 기능(/stats) — 날짜 칸에 하한이 없어 api 가 받지 않는 날(1970 앞)을 묻고 "응답을 받지 못함 · 다시 시도"라고 한다
- 환경: U · `app/stats/page.tsx` · `lib/stats.ts`
- 재현 절차: `cd apps/web && npx vitest run tests/qa/qa-1303-stats-day-before-1970.test.ts` — 날짜 칸에 `1969-12-31` 입력. api 의 답은 코드 그대로 흉내
  (`platform.web.TimeParams.MIN_DAY` 1970-01-01 → `ProblemAdvice.badRequest` 400 "invalid parameter: day — out of the supported range 1970-01-01 – 9999-12-31").
- 기대 결과: 미래 날짜(QA-309)처럼 묻지 않고 되돌리거나(칸에 `min`), 적어도 '자료가 있을 수 없는 날'이라고 말한다.
- 실제 결과: `statsPickDay("1969-12-31")` → `{"day":"1969-12-31","clamped":false}`, 칸에 `min` 없음, `/api/v1/stats/traffic?day=1969-12-31` 을 보냄 → 패널 "조회 실패 — invalid
  parameter: day — out of the supported range …(HTTP 400 · BAD_REQUEST) … 응답을 받지 못해 자료가 있는지 알 수 없습니다(‘자료 없음’이 아님). 다시 시도" — 서버는 답했고,
  다시 시도해도 같다(영어 서버 문구도 그대로).
- 증거: `evidence/web-code/qa-1303-stats-day-before-1970.txt`
- 의심 원인: `lib/stats.ts:61-64 statsPickDay`(위쪽만 자른다) · `app/stats/page.tsx:68`(`max` 만).
- 재현 시험: `apps/web/tests/qa/qa-1303-stats-day-before-1970.test.ts` — 2 실패

## QA-1400 · 낮음 · 접근성(WCAG 3.1.2) — 상황판 탭 단추 · 패널 머리의 영어에 lang 표시가 아직 없다(QA-313 의 남은 곳)
- 환경: U · `components/SidePanel.tsx` 외
- 재현 절차: `cd apps/web && npx vitest run tests/qa/qa-1400-lang-of-parts-remaining.test.ts`
- 기대 결과: 문서가 `lang="ko"` 이므로 영어 낱말 · 구절은 `lang="en"`(QA-313 이 'sign out' · 'save' · 'latest' 같은 단추 낱말까지 그렇게 고쳤다). 약어 · 전문 용어(SIGMET · wx · METAR)는 예외.
- 실제 결과: 상황판 오른쪽 패널의 탭 단추(주 탐색) `alerts` · `aircraft` · `ship` · `airport` · `watch` 와 머리 `Alerts`, 그리고 `Watchlist` · `Weather warnings` · `Radar` ·
  `Sources`(모든 화면 하단) · `Active alerts` · `Ship` · `History (latest 24)` · `Replay` · `Contents` · 머리말 `Aircraft · Ships · Hazardous Weather` 에 lang 이 없다.
- 증거: `evidence/web-code/qa-1400-lang-of-parts-remaining.txt`
- 의심 원인: `components/SidePanel.tsx:108-110` · `components/AlertPanel.tsx:56` 외 시험의 목록. `tests/lang-of-parts.test.ts` 는 QA-313 때 찾은 목록만 본다.
- 재현 시험: `apps/web/tests/qa/qa-1400-lang-of-parts-remaining.test.ts` — 2 실패

## 미확인 · 판단(결함 수에 넣지 않음)
| 내용 | 판단 · 까닭 |
|---|---|
| 공개 데모 오류 화면이 스택을 보인다(`components/logs/ErrorScreen.tsx:99`) | **결함 아님으로 판단** — 운영 빌드에서 서버 컴포넌트 오류는 Next 가 메시지를 일반 문구 + digest 로 바꾼다(`node_modules/next/dist/docs/…/error.md` "Errors forwarded from Server Components show a generic message"). 보이는 스택은 브라우저 쪽 오류의 것이라 이미 공개된 `/_next/static` 청크 경로뿐이다. 운영 빌드 · 브라우저에서는 보지 않았다(브라우저 담당) |
| `/airports/[icao]` 에 형식 검사 없이 api 로 보냄 · 긴 값 · 조작 문자열 | **결함 아님** — `lib/endpoints/path.ts pathSegment` 가 인코딩하고 ""·"."·".." 은 보내지 않는다, api 는 400, React 가 글자를 이스케이프한다, 8 KB 넘는 주소는 edge 414. Next 가 동적 조각을 디코딩해 주는지(이중 인코딩 여부)는 서버 없이 확인하지 못했다 — 어느 쪽이든 400 "형식이 올바르지 않습니다". `/alerts/[id]` 는 숫자 1–18자리만, 재생 URL 은 `lib/replay-url` 이 값마다 검증(없는 날짜 · 범위 밖 · 넓은 bbox 는 안내 글) — 문제를 찾지 못함 |
| 실제 브라우저 + Caddy forward_auth 에서 WS 업그레이드가 401 → close 1006 인지 | WHATWG WebSocket 규격(연결 실패 = 1006)과 gate 코드로 판단 — 앞단 리허설(R)에서 보지 않았다 |
| 영업 시간 중 api 재시작 · 배포 때 edge 의 502/504(problem+json · Retry-After 10)를 CloudFront 가 "지금은 데모 운영 시간이 아닙니다" HTML 503 으로 바꿔 Retry-After 도 사라질 수 있다 | CloudFront 오류 응답이 배포판 전체 · 상태 502/504 기준이라 그렇게 될 것으로 추정 — AWS 앞단 담당 영역, 로컬에서 재현할 수 없다 |
| 재생(▶) 중 숨은 탭에서도 1 s 마다 `/api/v1/replay` 요청 — 코드 읽기, 시험하지 않음(`app/replay/page.tsx:78-82` — 재생 틱 setInterval, ReplayLoader 는 Retry-After 다시 부르기만 숨김을 기다림) | ADR-029 §5 '주기 요청'에 드는지(사용자가 누른 재생) 문서로 정할 수 없어 결함으로 올리지 않음 → 개선 제안 3 |
| 브라우저 오류 보고 상한(같은 글 60 s · 분당 5)이 브라우저에만 있다(`lib/errorReport.ts:115-145`) | 새로고침 · 직접 POST 로 넘긴다 — 서버 상한은 api-sec 담당. 코드 읽기로는 브라우저 시계를 뒤로 돌리면 `now - prev < 60 s` 가 참으로 남아 그동안 보고가 '중복'으로 막힐 수 있다(드문 조건 — 시험하지 않음) |

## 개선 제안
1. **앞단 응답 분류를 한 곳에**: `lib/api` 에 401 locked · 비-JSON 5xx(앞단이 원본에 닿지 못함)를 code 로 분류하는 함수를 두고 apiError · EtagPoller · chunk-probe · 화면 문구 함수(airportErrorText · replayErrorText · 알림 근거 · 공항 목록)가 code 로 고르게 — 지금은 메시지에만 실려 자기 문구를 쓰는 화면이 놓친다(QA-1301 · 1302).
2. **WS 의 앞단 확인**: 열린 적 없는 실패가 몇 번 이어지면 같은 출처 GET 한 번으로 잠금 · 정지를 가려 상태 바 · 알림 패널에 알리고, 잠금이면 재접속을 멈춘다(새로고침만이 푼다 — QA-1300).
3. 재생(▶) 틱을 숨은 탭에서 멈출지(ADR-029 §5) 결정 — 지금은 숨어도 기본 10× 재생이 끝날 때까지 1 s 마다 요청한다.
4. `/alerts/[id]` 의 실패 글에 HTTP 상태 · 까닭 · '다시 시도'(다른 화면과 같게) · `/airports/[icao]` 에 `/alerts/[id]` 같은 형식 검사(보낼 필요 없는 400 한 번을 아낀다).
5. 영어 이름표용 작은 컴포넌트(`<En>`)나 시험(렌더한 화면의 라틴 낱말에 lang 이 있는지)으로 QA-313 · QA-1400 부류가 다시 생기지 않게.

## 앞선 QA 와 같음(다시 결함으로 올리지 않음 — 지금도 남아 있음)
- `useWatchRunner` 의 `seenAlerts` 가 알림 id 를 계속 쌓는다(`components/watch/useWatchRunner.ts:37,107-119`) — QA 2026-10-release 개선 제안 5.
- 관심 탭이 `/watch` 의 `meta.db_unavailable` 을 읽지 않는다(`lib/watch.ts parseWatch` · `rg db_unavailable` 에 관심 탭 없음) — 같은 보고 개선 제안 10.
- `WatchButton` 의 `aria-pressed` 와 바뀌는 이름("관심 대상" ↔ "관심 해제")을 함께 씀(`components/watch/WatchButton.tsx:11-13`) — 같은 보고 개선 제안 2.
- 공개 데모의 설명서 운영 · 로그 절 · 스크린샷, `/ops` · `/logs` 레이아웃의 `demo={false}`, `app/global-error.tsx` 가 공개 데모 문구 밖 — ADR-039 덧붙임(2026-10-11)의 결정 · '남는 것' 그대로.
