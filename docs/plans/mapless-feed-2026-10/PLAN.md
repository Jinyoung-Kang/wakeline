# 지도 없이도 실시간 연결 열기 — 계획 (Q4, 2026-10-19)

- **상태: 계획 · 승인 대기** — 구현 · 빌드 측정 · E2E 는 승인 뒤에 한다(구조 변경 — 전역 규칙).
- 브랜치 `feat/mapless-feed-2026-10`(`fix/improve-2026-10` 위 — 그 브랜치의 IM-21 · R9 에 기댄다. 병합은 그 브랜치 다음).
- 근거: 개선 작업 [REPORT](../../improve/REPORT.md) §5 Q4 · [PLAN §6 R9](../../improve/PLAN.md). 설계는 현재 구조를 세 갈래로 읽은 보고와, 독립된 설계안 셋을 두 심사자가 매긴 결과로 정했다(§3).

## 1. 문제
상황판(`/`)이 지도를 띄우지 못하면 실시간 연결(WS)도 열리지 않는다. 지도 실패는 두 갈래다.
- (a) **WebGL2 없음**(하드웨어 가속 끔 · GPU 차단 · VDI) — `MapView` 는 마운트되지만 지도 객체가 없다.
- (b) **받기 실패** — (b1) MapLibre(`/maplibre/<판>/`)만 실패하고 지도 조각은 받음, (b2) 지도 조각 자체를 받지 못함.

`components/map/useLiveFeed.ts` 가 `if (!map) return` 으로 WS 클라이언트 · 보간 워커를 지도와 함께만 만든다. 그래서 IM-21 로 남긴 상태 바 · 알림 패널 · 관심 대상은
실시간 자료를 받지 못하고, R9 는 그 사실('WS off · 실시간 수신 안 함')을 적는 데까지만 했다. 알림 · SIGMET · 레이더 · 피드 상태는 지도와 관계없는 자료라, 지도가 없어도 받을 수 있어야 한다.

## 2. 지금 구조에서 확인한 사실
| # | 결합 | 지도 없이 의미 | 처리 |
|---|---|---|---|
| K1 | 생성 게이트 `if (!map) return`(useLiveFeed.ts:37) | — | 지도 실패일 때만 따로 연다(§4) |
| K2 | 구독 bbox · zoom 이 지도에서 온다(:72-85) | **있다** — 서버는 subscribe 가 있어야 alerts · sigmets · radar · status 를 보낸다(WsSession.java:219 · WsHub.java:466-556). 알림은 bbox 로 거르지 않는다(:698-704) | 수요를 만들지 않는 고정 구독 |
| K3 · K4 | `mapBounds` · 스토어 `viewport`(ws.ts:290-297 — subscribe 가 늘 쓴다) | 없다 — `panIfOutside` · MapChips · ShipCard 가 '화면'으로 읽는다 | 지도 없는 구독은 viewport 를 쓰지 않는다 |
| K5 · K6 · K9 | 워커 · 항공기 렌더 · 예측선 · invalidate | 없다 | 지도에 남긴다(지도 없는 피드는 워커 없음 — 빈 대역) |
| K7 | 숨김 pause/resume(:92-96) | 있다 | 지도 없는 피드도 같게 |
| K8 | select · setLayers 전달(useSelectionTracks) | select 는 **집중 추적 수요(adsb.fi 5 s 호출)** 를 만든다(DemandService.java:287-291) | 지도 없이는 보내지 않는다 |
| K10–K12 | 선택 항적 REST · KMA 레이더 · 교통량 조회가 지도 Hook 안 | 일부 있다 | 이번 범위 밖(§10) |

서버 규칙(코드로 확인): 핫 리전 수요는 zoom ≥ 7(`HOT_MIN_ZOOM = 7` — DemandService.java:78)이고 항공기 레이어가 켜졌을 때만 생긴다(:294). 항공기 레이어를 끈 세션에는 snapshot · diff 를
보내지 않는다(WsHub.java:528-534). subscribe 의 zoom 이 없으면 서버는 7 로 읽고(WakelineWsHandler.java:204), bbox 가 2,500 deg² 를 넘으면 zoom ≤ 5 만 받는다(`max-bbox-area-sqdeg: 2500`).
연결 상한은 전체 200 · IP 당 5. `WakelineWsClient.close()` 는 스토어에 `conn: "closed", demand: null` 을 조건 없이 쓴다(ws.ts:214).

## 3. 검토한 설계와 고른 것
| 안 | 요지 | 심사 1 | 심사 2 |
|---|---|---|---|
| **A fallback-feed(채택)** | `useLiveFeed` 는 그대로. 지도를 띄우지 못했을 때만 같은 `WakelineWsClient` 를 워커 없이 열어, 두 레이어를 끈 구독 · zoom 5 로 알림 · 상태만 받는다 | **46** | **45** |
| B page-feed | WS 클라이언트를 페이지 수준 Hook 으로 올리고 지도는 생기면 붙는다(워커 · 렌더) | 40 | 42 |
| C rest-fallback | 지도가 없으면 WS 대신 `/m` 처럼 REST 폴링 | 35 | 34 |

- 고른 까닭: 정상 경로(지도 있음)의 동작이 그대로다. 서버 수요가 0이다. 첫 화면 JS 증가가 가장 작다(추정 +243–302 B — 여유 773 B 안).
  바꾸는 곳이 작아 시험으로 고정하기 쉽다.
- B 는 구조는 가장 깔끔하지만 여유 773 B 안에 드는지 불확실하다. 또 MapView 를 마운트하는 시험 11개 · 페이지 원문 시험 · 워커 시계 넘겨받기를 모두 다시 써야 한다.
- C 는 알림이 30 s 폴링이라 '실시간'이 아니고, 새 조각 · 새 화면 규칙이 생긴다.
- B 에서 가져온 것: 서버 상수를 읽어 웹 상수를 고정하는 언어 사이 시험 · 보낸 프레임을 정확히 고정하는 시험 · 지도 없음을 칩 하나로 밝히는 문구 · 카드 문구.
  C 에서 가져온 것: 지도 없음이 정해지면 관심 대상 실행기를 곧바로 받는다.

## 4. 바꾸는 것(채택안)
### 4.1 `lib/ws.ts` — 구독 규칙(React 없는 lib, ADR-029)
- `subscribeWithoutMap()` 을 더한다: `setLayers(false, false)` → 지도 없음 표시(`screen = false`) → `subscribe(NO_MAP_BBOX, NO_MAP_ZOOM)`.
  `NO_MAP_BBOX = [127, 36, 128, 37]`(1 deg² — 서버 bbox 검사 통과), `NO_MAP_ZOOM = 5`(< `HOT_MIN_ZOOM` 7 · ≤ 5). 두 레이어를 끈 세션에서 bbox 는 서버 어디서도 쓰이지 않는다 — 근거를 주석에.
- `subscribe()` 는 지도 구독일 때만 스토어 `viewport` 를 쓴다(기본 `screen = true` — 지도 경로 동작 그대로). welcome · resume 의 다시 구독도 같은 규칙.
- 지도 없는 클라이언트는 `select` · `selectShip` 을 **보내지 않는다**(필수 방어 — 집중 추적 수요를 만들지 않는다).
- `close()` 가 스토어의 연결 상태를 **자기 것일 때만** 지운다(작은 소유 표시): (b1) 에서 지도 없는 피드를 닫고 지도 피드를 여는 순서가 엇갈려도 새 연결의 `conn` · `demand` 를 덮지 않는다.

### 4.2 `components/map/useMaplessFeed.ts`(새 Hook) · `MapView` · `useMapLifecycle`
- `useMaplessFeed(on)`: on 이면 `new WakelineWsClient({ postMessage() {} })`(워커 없음) → `subscribeWithoutMap()` → 스토어 `mapless: true` → `connect()`.
  숨김이면 `pause()`, 다시 보이면 `resume()`. 정리: 리스너 제거 → `close()` → `mapless: false`. `new Worker` 는 쓰지 않는다(공개 워커 목록 그대로).
  같은 파일에서 `MaplessFeed`(그것만 부르는 빈 컴포넌트)도 내보낸다 — (b1) 에서 페이지가 쓴다.
- (a) `MapView` 가 `useMaplessFeed(noWebgl)` 를 부른다. `useMapLifecycle` 의 `setNoLiveFeed()` 는 뺀다('off' 가 잠깐 보였다 바뀌는 깜박임 방지).
- 지도 없음이 정해지면 관심 대상 실행기 조각(`WatchRunnerPart.preload()`)을 곧바로 받는다. 지금은 지도 'load' 뒤에 받는데, 지도가 없으면 60 s 재시도에만 기댄다.

### 4.3 `app/page.tsx` — (b1) MapLibre 만 실패
- 지도 dynamic loader 의 catch 가 **같은 모듈** `import("@/components/MapView")` 를 기다려 `MaplessFeed` 를 받는다. 이미 받은 모듈이라 새 청크 · 새 preload 대상이 아니다(Next 문서 lazy-loading — dynamic 안의 import() 는 preload 대상).
  받으면 실패 자리 옆에 `<MaplessFeed/>` 를 두고, 다시 시도로 지도가 뜨면 내린다. 받지 못하면(b2) 지금처럼 `setNoLiveFeed()` — 'off'(R9).
- 시험이 고정한 원문(`dynamic(() => afterFirstPaint().then(() => Promise.all([import("@/components/MapView")` 앞부분 · `<MapView onFirstLoad={prefetchDashboardPartsWhenIdle} />`)은 그대로 둔다.
- **이 단계는 조건부**: 넘겨받기 순서 시험(동시에 열린 클라이언트 ≤ 1 · 새 연결 상태를 덮지 않음)과 바이트 측정을 통과할 때만 넣는다. 아니면 빼고 (b1) 은 'off' 로 둔다.

### 4.4 정직성 — 화면 글(제품 규칙: 받지 않는 값을 받는 척하지 않는다)
- 스토어 `mapless` 플래그(기본 false).
- 상태 바 연결 칩: 'WS <실제 상태> · 지도 없음'. title: '지도 없이 연 연결 — 알림 · SIGMET · 레이더 · 피드 상태만 받고 항공기 · 선박 위치는 받지 않음(서버 수요를 만들지 않는 구독)'.
  항공기 수는 '—'(이미 `aircraftCount` null)이고 title 은 '지도 없음 — 항공기 위치를 받지 않음'.
- 지도 자리 칩: 선박 칩을 '수신 대기'로 두지 않고, 칩 하나로 '지도 없음 — 항공기 · 선박 위치를 받지 않음'을 적는다.
- 나중에 받는 조각(첫 화면 바이트 0):
  - 항공기 카드는 '지도 없음 — 선택을 서버에 알리지 않음(집중 추적 안 함) · 위치는 REST 상세 30 s'. '집중 추적 상태 수신 전'은 보이지 않는다.
  - 선박 목록은 '지도 없음 — 선박 위치를 받지 않음', 선박 카드 항적 줄은 '지도 없음 — 항적을 받지 않음'.
- (b2) 'WS off · 실시간 수신 안 함 — 지도를 띄우지 못해…' 문구는 그대로다. 이 경우에도 맞는 말이고, 시험 셋이 그 문구를 고정한다.

## 5. 서버 · 수요 영향
- 새로 생기는 것: 지도를 띄우지 못한 탭마다 WS 세션 하나(전에는 0). 연결 상한 · edge 제한에는 지도 탭과 똑같이 하나로 센다.
- 보내는 순서: hello → welcome → `layers{aircraft:false, ships:false}` → `subscribe{bbox:[127,36,128,37], zoom:5, detail:"lite"}`.
- 받는 것: alerts(전체) · alerts_batch · sigmets · radar · status(30 s) · demand(hot · focus null) · ping.
- 받지 않는 것: snapshot · diff · ships_* · selected.
- **수요 0**: 레이어를 끄고 zoom 을 5 로 두어 두 겹으로 막는다(DemandService.java:294 · :78). select 를 보내지 않으니 FOCUS 도 없다. 수집기의 외부 호출은 늘지 않는다.
- api · collector · schemas · 프로토콜은 바꾸지 않는다. 쓰는 것은 기존 `layers` · `subscribe` 메시지뿐이라 change-contract §G 는 쓰지 않는다(§12 Q-E 에서 확인).

## 6. 첫 화면 JS(ADR-026 — 예산 550,000 B, 지금 549,227 B · 여유 773 B)
- 지도 없는 피드 코드는 이미 첫 화면으로 세는 지도 조각(lib/ws · useLiveFeed 와 같은 곳)과 entry(상태 바)에 들어간다. 새 `import()` · `lazy()` · `dynamic` · 워커는 없다.
- 추정(빌드 아님 — 빌드 사본에 줄인 코드를 넣어 이 Mac zlib 으로 잼): (a) 만 ≈ +243 B, (a)+(b1) ≈ +302 B. 남는 여유 ≈ 470–530 B.
- 확정: `npm run build && npm run check:first-js -- --in-image` 전후(웹 이미지 Node). 넘거나 빠듯하면 (b1) 을 뺀다(≈ −60 B). 결과는 ADR-026 결과 수치 · PERF 새 절에 적는다.
- 정상 경로 바이트는 이만큼 는다. 0 으로 하려면 지도 없는 코드를 조각으로 빼야 하는데, 그러면 새 lazy 자리 · 그 조각의 받기 실패 처리가 생긴다. 줄어드는 양은 수십 B 라 하지 않는다.

## 7. 시험 · 검증(승인 뒤 — 실패하는 시험 먼저)
1. `tests/ws-client.test.ts`
   - connect 전에 `subscribeWithoutMap()` 을 불러도 welcome 뒤 보낸 프레임이 정확히 [layers{false,false}, subscribe{zoom:5}] 다.
   - 그 뒤 setUi · select · selectShip 을 불러도 프레임이 늘지 않는다.
   - viewport 는 null 그대로다. snapshot 이 와도 항공기는 비고, alerts · status 는 반영된다.
   - 숨김 → resume 에도 viewport 를 쓰지 않는다.
   - 늦은 `close()` 가 다른 클라이언트의 conn · demand 를 덮지 않는다.
2. **언어 사이 고정**: vitest 가 `DemandService.java` 의 `HOT_MIN_ZOOM` 과 `application.yml` 의 `max-bbox-area-sqdeg` 를 읽는다.
   `NO_MAP_ZOOM < HOT_MIN_ZOOM` · `NO_MAP_ZOOM ≤ 5` · `NO_MAP_BBOX` 면적 ≤ 상한을 고정한다 — 서버 규칙이 바뀌면 CI 가 잡는다.
3. `tests/map-load-failure.test.ts` 기대를 뒤집는다.
   - (a) 연결 1 · 워커 0 · 'WS connecting · 지도 없음' · `mapless` true. 선택해도 select 0. 정리하면 close 1 · `mapless` false.
   - (b1) 다시 시도 성공 때 순서가 [지도 없음 연결, 지도 없음 닫기, 지도 연결]이고 동시에 열린 수 ≤ 1.
   - (b2) `vi.doMock` 으로 MapView 받기 실패 → 연결 0 · 'off' 그대로.
4. `tests/statusbar.test.ts`: 연결 칩 · 항공기 칩의 지도 없음 글. 소스 시험(useMaplessFeed 의 `document.hidden` → `client.pause()`)도 더한다.
5. `tests/first-screen-js.test.ts`: `new Worker(` 는 `useLiveFeed.ts` 에만 있다. `first-screen-lazy` · `parts-prefetch` · `alert-panel` · `mapview-*` 는 그대로 통과한다.
   MapView 를 마운트하는 시험의 `@/lib/ws` 가짜 클래스에는 메서드만 더한다.
6. 카드 렌더 시험(AircraftCard · ShipCard · ShipList): 지도 없음 글.
7. api(gradle — 이웃 시험 하나): 두 레이어 끔 + subscribe zoom 5 → 초기 세트에 snapshot · ships_* 가 없고 임대가 비었다.
8. 전체 웹 검사(eslint · tsc · vitest · build · first-js in-image).
9. E2E 한 건: 격리 스택 8701 에서 `addInitScript` 로 WebGL2 를 끈다.
   - 'WS open · 지도 없음' · 알림 목록이 보이는지 본다.
   - `page.on('websocket')` 로 보낸 프레임이 [hello, layers{false,false}, subscribe{zoom:5}] 이고, 알림 행에서 항공기 카드를 열어도 select 가 없는지 본다.
   - `make e2e` 는 `wakeline-*:local` 을 덮으므로 `:mainsafe` 절차를 따른다.

## 8. 단계 · 커밋(작게 — 리팩터링과 기능을 나눈다)
1. `refactor(web)`: `subscribe()` 의 viewport 쓰기를 `screen` 표시로 감싼다(기본 true — 동작 불변) + `close()` 소유 표시(동작 불변 — 클라이언트 하나일 때 같다).
2. `feat(web)`: `subscribeWithoutMap` · select 방어 + 시험 1 · 2.
3. `feat(web)`: `useMaplessFeed` · MapView (a) · 스토어 `mapless` · 상태 바 · 지도 자리 칩 · 관심 대상 미리 받기 + 시험 3(a) · 4 · 5.
4. `feat(web)`: 카드 · 목록 문구 + 시험 6.
5. (조건부) `feat(web)`: (b1) 페이지 catch + 시험 3(b1 · b2).
6. `test(api)`: 시험 7.
7. `docs`: ADR-041 · ADR-029 §3 개정 줄 · ADR-026 결과 수치 · PERF 새 절 · VERIFICATION #148 · README(ADR 41건).
8. 측정 · E2E: 커밋마다 웹 검사, 끝에 E2E · 보안 게이트.

## 9. 효과
- WebGL2 를 쓸 수 없는 브라우저에서도 상황판의 알림 · SIGMET · 레이더 · 피드 상태 · 관심 대상 알림이 실시간으로 온다. (b1) 을 넣으면 MapLibre 받기만 실패한 경우도 같다.
- 그 탭은 서버 수요 · 외부 호출을 만들지 않는다. 항공기 · 선박 위치는 받지 않는다고 화면에 적는다.

## 10. 하지 않을 것
- WS 를 페이지 수준으로 올리는 구조 변경(안 B) — 예산 · 시험 영향이 크고, 이번 목표에는 안 A 로 충분하다.
- 지도 없이 항공기 · 선박 위치를 받기 — 지도 없는 화면에서 쓸 곳이 없고, 수요 · 대역폭만 는다.
- (b2) 지도 조각 자체를 받지 못한 경우 — 클라이언트 코드가 그 조각에 있다. 덮으려면 lib/ws(≈ 9 KB gz)를 entry 로 옮겨야 해 예산 · ADR-026 과 부딪친다. 'off'(R9)로 정직하게 둔다.
- 지도 Hook 안의 다른 결합 — 선택 항적 REST · KMA 레이더 조회 · 교통량 조회(K10–K12)는 이번 범위 밖이다.
- 지도 없을 때 레이어 단추 · 레이더 재생 조작 숨기기 — 동작하지 않을 뿐 사용을 막지는 않는다. 제안으로만 남긴다.

## 11. 위험
- **바이트 추정**: 실제 Turbopack 출력 · 웹 이미지 zlib 에서는 수십 B 다를 수 있다 — 측정 전까지 확정이 아니다. 여유는 뒤에 올 작업 몫까지 줄어든다.
- **(b1) 넘겨받기 순서**: 커밋 안 effect 순서와 `useLoaded` 갱신의 선후는 분석으로 얻은 추정이다. 소유 표시 · 시험으로 막고, 안 되면 (b1) 을 뺀다.
- **연결 하나 더**: 실패 모드 탭도 연결을 하나 쓴다(전에는 0) — 탭이 많은 사용자는 IP 당 5 상한(1013)에 조금 더 일찍 닿는다.
- **R9 의 뜻 변화**: 'off' 는 (b2) 에만 남는다 — store · statusbar · AlertPanel 주석과 ADR-029 를 함께 고친다.
- **병합 순서**: 이 브랜치는 `fix/improve-2026-10` 위에 있다. 그 브랜치가 main 에 먼저 들어가야 한다.

## 12. 결정할 것(권장안 먼저)
| # | 결정 | 권장 |
|---|---|---|
| Q-A | (b1) MapLibre 만 실패한 경우도 넣을까 | **넣되 조건부** — 넘겨받기 시험과 바이트 측정을 통과할 때만, 아니면 빼고 (a) 만 |
| Q-B | 지도 없이 항공기 카드를 열 때 select 를 보내 집중 추적(adsb.fi 5 s 호출)을 쓸까 | **보내지 않는다** — 지도 없는 탭이 서버 수요를 만들지 않는 것을 원칙으로(카드는 REST 30 s · '집중 추적 안 함' 표기) |
| Q-C | 지도 없음이 정해지면 관심 대상 실행기를 곧바로 받을까 | **받는다**(지금은 60 s 재시도에만 기댐) |
| Q-D | 지도 없을 때 레이어 단추 · 레이더 재생을 숨길까 | **이번에는 그대로**(제안으로 남김) |
| Q-E | 기록 위치 | **새 ADR-041**(채택안 · 버린 안 · 감수한 단점) + ADR-029 §3 개정 줄 · ADR-026 결과 수치. 메시지 · API 변경이 아니라 change-contract §G 는 쓰지 않는다 |
| Q-F | 브랜치 | **이 브랜치(`fix/improve-2026-10` 위)에서 구현**하고 그 브랜치 다음에 병합 — 또는 improve 를 먼저 병합한 뒤 main 에서 다시 만든다 |
