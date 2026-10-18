# ADR-041 지도를 띄우지 못해도 실시간 연결은 연다 — 워커 없는 '지도 없는 피드', 서버 수요는 만들지 않는다

**상태** 채택 · 2026-10-19 · 사용자 승인 — Q4 계획의 권장안("Q-A 조건부 포함 · Q-B 집중 추적 안 함 · Q-C 미리 받기 · Q-D 그대로 · Q-E ADR-041 · Q-F 이 브랜치") ·
계획 [PLAN](../plans/mapless-feed-2026-10/PLAN.md) · [VERIFICATION](../VERIFICATION.md) #148 · 측정 [PERF §21](../PERF.md) · 함께 보는 기록: [ADR-013](ADR-013-demand-driven-tracking.md)(수요 기반 추적) ·
[ADR-026](ADR-026-first-screen-js-budget.md)(첫 화면 JS 예산) · [ADR-029](ADR-029-web-data-access.md) §3(실시간 피드는 지도와 함께 — 이 ADR 로 개정) · 개선 작업 [REPORT](../improve/REPORT.md) §5 Q4 · R9

## 맥락
- 상황판(`/`)의 실시간 피드(`components/map/useLiveFeed`)는 WS 클라이언트와 보간 워커를 **지도와 함께만** 만든다(`if (!map) return`). 지도를 띄우지 못하는 경우는 둘이다:
  (a) WebGL2 없음(하드웨어 가속 끔 · GPU 차단 · VDI — `MapView` 는 마운트되지만 지도 객체가 없다), (b) 받기 실패 — (b1) MapLibre(`/maplibre/<판>/`)만, (b2) 지도 조각 자체.
- 그래서 개선 작업(IM-21)이 남긴 상태 바 · 알림 패널 · 관심 대상이 지도 없이는 실시간 자료를 받지 못했고, R9 는 그 사실('WS off · 실시간 수신 안 함')을 적는 데까지만 했다.
  알림 · SIGMET · 레이더 · 피드 상태는 지도와 관계없는 자료다.
- 서버 규칙(코드로 확인): subscribe 가 있어야 alerts · sigmets · radar · status 를 보낸다(`WsSession.subscribed()`). 핫 리전 수요는 zoom ≥ 7(`HOT_MIN_ZOOM`)이고 항공기 레이어를
  켰을 때만 생기고, zoom 이 없으면 7 로 읽는다. bbox 가 2,500 deg² 를 넘으면 zoom ≤ 5 만 받는다. `select` 는 레이어와 관계없이 집중 추적(FOCUS — adsb.fi 5 s 조회) 수요를 만든다.

## 결정
1. **지도 없는 피드**((a) · (b1)): 같은 `WakelineWsClient` 를 **워커 없이**(아무것도 하지 않는 받는 쪽) 하나 연다 — `components/map/useMaplessFeed`(`useMaplessFeed(on)` · `MaplessFeed`).
   구독은 `lib/ws subscribeWithoutMap()`: 두 레이어를 끄고(`layers{aircraft:false, ships:false}`) 고정 영역 `NO_MAP_BBOX [127,36,128,37]`(1 deg²)를 `NO_MAP_ZOOM 5` 로 구독한다.
   보내는 것은 hello → layers → subscribe 뿐이고, 받는 것은 alerts(전체) · alerts_batch · sigmets · radar · status · demand · ping 이다(snapshot · diff · ships_* · selected 는 오지 않는다).
2. **서버 수요 0**: 레이어 끔과 zoom 5(< 7) 두 겹으로 핫 리전을 막고, 지도 없는 클라이언트는 `select` · `selectShip` 을 **보내지 않는다**(Q-B — 집중 추적 안 함).
   `subscribeWithoutMap()` 이 그 클라이언트의 선택도 비워, 먼저 불린 select 가 welcome 에서 다시 나가지 않는다(호출 순서에 기대지 않는다 — 독립 리뷰 F4).
   수집기의 외부 호출은 늘지 않는다. 웹 상수는 시험이 api 코드(`DemandService` 의 `HOT_MIN_ZOOM` · `WakelineWsHandler` 의 zoom 상한 · `application.yml` 의 면적 상한)를 읽어 고정하고,
   api 시험(`DemandServiceTest`)이 같은 프레임의 세션에 초기 세트 [welcome, alerts, sigmets, radar, status] · 빈 임대를 고정한다.
3. **화면 구독이 아니다**: 지도 없는 구독은 스토어 `viewport` 를 쓰지 않는다(`screen` 표시 — 지도 경로는 기본값 그대로). `panIfOutside` · 지도 자리 칩 · 선박 카드가 그것을 '화면'으로 읽는다.
4. **경로마다**
   - (a) `MapView` 가 `useMaplessFeed(noWebgl)` 를 부른다. `useMapLifecycle` 는 더 이상 conn 'off' 를 적지 않는다(잠깐 'off' 였다 바뀌는 깜박임이 없다).
   - (b1) `app/page.tsx` 의 지도 loader 가 실패하면 **같은 모듈** `import("@/components/MapView")` 의 `MaplessFeed` 를 실패 자리 옆에 두고, 다시 시도로 지도 조각을 받으면(`useLoaded`) 내린다.
     순서는 [지도 없는 연결, 지도 없는 닫기, 지도 연결]이고 동시에 열린 연결은 1개 이하다(시험이 고정한다). 새 청크 · 새 preload 대상은 없다(빌드 결과 '/' 의 항목 그대로).
   - (b2) 지도 조각을 받지 못하면(피드 코드가 그 조각에 있다) 지금처럼 conn 'off'(R9) — **'off' 는 이 경우에만 남는다**. 이때 페이지는 받지 못한 지도 조각을 다시 받지 않고 곧바로 'off' 와 실패 자리를 보인다(첫 `import()` 의 거절 표시 `markMapViewFailed` — Turbopack 런타임은 받지 못한 청크를 기억하지 않아, 다시 `import()` 하면 처음부터(내장 재시도 포함) 다시 받았다 · 독립 리뷰 F1). 받는 중인 청크는 런타임이 같은 약속을 돌려주므로, MapLibre 가 먼저 실패해도 (b1) 을 (b2) 로 잘못 보지 않는다.
   - 숨은 탭에서는 멈추고(pause) 다시 보이면 잇는다(지도 피드와 같다). 지도 없음이 정해지면 관심 대상 실행기 조각을 곧바로 받는다(Q-C — 지도 'load' 뒤 미리 받기가 오지 않는다).
5. **스토어 연결 상태의 주인**: `close()` 는 마지막으로 connect 한 클라이언트일 때만 conn · demand 를 지운다(`connectTurn`). (b1) 처럼 앞 클라이언트를 늦게 닫아도 새 연결의 상태를 덮지 않는다.
   이 보호는 **지도 없음 → 지도 방향의 `close()` 만**이다 — `useLiveFeed` 정리의 conn 쓰기와 지도 없는 피드 정리의 `mapless: false` 는 조건 없이 쓴다. 지금은 지도 → 지도 없음 전환이 없어
   (noWebgl 은 지도를 만들 때만 정해진다) 문제가 되지 않는다. 그런 전환(WebGL 문맥 잃음 처리 · Activity 아래 MapView)을 더하면 그 쓰기도 주인 검사에 묶는다.
6. **화면 글(제품 규칙 — 받지 않는 값을 받는 척하지 않는다)**: 스토어 `mapless`.
   - 상태 바 연결 칩 'WS <상태> · 지도 없음' + title '지도 없이 연 연결 — 알림 · SIGMET · 레이더 · 피드 상태만 받고 항공기 · 선박 위치는 받지 않음(서버 수요를 만들지 않는 구독)'.
     항공기 수는 '—'이고 title 과 상세 표 출처가 '지도 없음 — 항공기 위치를 받지 않음'.
   - 지도 자리는 칩 하나 '지도 없음 — 항공기 · 선박 위치를 받지 않음'(수요 칩 · 선박 '수신 대기' 칩을 그리지 않는다).
   - 나중에 받는 조각: 항공기 카드 수요 줄 '지도 없음 — 선택을 서버에 알리지 않음(집중 추적 안 함) · 위치는 REST 상세 30 s' — 그리고 지도에 그리는 것(항적 선 · 집중 추적 점 · 예측 점선)을
     설명하는 아래 문단은 보이지 않는다(그릴 지도도 select 도 없어 모든 문장이 사실이 아니다). 선박 목록 '지도 없음 — 선박 위치를 받지 않음', 선박 카드 항적 줄 '지도 없음 — 항적을 받지 않음'.
   - 'off' 의 title 괄호는 '(지도 코드를 받지 못함)'이다(전에는 'WebGL2 없음' 도 적었다 — 이제 그 경우는 'off' 가 아니다). 시험이 고정한 '지도를 띄우지 못해' · '실시간 수신 안 함' 은 그대로.
7. 레이어 단추 · 레이더 재생 조작은 지도 없음에서도 그대로 둔다(Q-D — 동작하지 않을 뿐 막지 않는다. 숨기기는 제안으로 남긴다).

## 버린 대안
- **WS 를 페이지 수준으로 올리기**(B — 지도는 생기면 워커 · 렌더로 붙는다): 구조는 가장 깔끔하다. 그러나 첫 화면 여유 773 B 안에 드는지 불확실했고, MapView 를 마운트하는 시험 11개 ·
  페이지 원문 시험 · 워커 시계 넘겨받기를 모두 다시 써야 했다. 심사 둘의 점수 40 · 42(채택안 46 · 45).
- **지도가 없으면 REST 폴링**(C — `/m` 처럼): 알림이 30 s 폴링이라 '실시간'이 아니고 새 조각 · 새 화면 규칙이 생긴다(34 · 35). 가져온 것: 관심 대상 실행기를 곧바로 받기.
- **지도 없이 항공기 · 선박 위치 받기**: 지도 없는 화면에서 쓸 곳이 없고 수요 · 대역폭만 는다.
- **지도 없이 select 를 보내 집중 추적**: 지도 없는 탭이 외부 호출(adsb.fi 5 s)을 만들게 된다 — 카드는 REST 상세 30 s 로 충분하다(Q-B).
- **(b2) 도 덮기**: 클라이언트 코드(lib/ws ≈ 9 KB gz)를 entry 로 옮겨야 해 ADR-026 과 부딪친다.
- **지도 없는 코드를 조각으로 빼 정상 경로 바이트 0**: 새 lazy 자리와 그 조각의 받기 실패 처리가 생기는데 줄어드는 양은 수백 B 다.

## 결과 · 감수한 단점
- WebGL2 를 쓸 수 없거나 MapLibre 만 받지 못한 상황판에서도 알림 · SIGMET · 레이더 · 피드 상태 · 관심 대상 알림이 실시간으로 온다. 그 탭은 서버 수요 · 외부 호출을 만들지 않는다.
- 시험: `ws-client`(보낸 프레임 · select 방어(먼저 불린 select 포함) · viewport · 주인 검사 · api 상수 대조) · `map-load-failure`((a) · (b1) 순서 · (b2) · (b2) 받기 1번 · (b1) 경쟁 — MapLibre 가 먼저 실패) · `mapless-feed`(StrictMode 두 번 마운트 · 숨김 pause/resume · 리스너 해제) ·
  `statusbar` · `first-screen-js`(`new Worker(` 는 useLiveFeed 에만) · `ships-demand`(카드 · 목록 글) · api `DemandServiceTest`(관심 지역을 도쿄로 옮긴 세션 — 기본 원이 이 bbox 를 덮으면
  '임대 없음'이 겉보기로만 성립한다) · E2E `mapless-feed.spec`(WebGL2 를 끈 Chromium — 소켓 1개 · 보낸 프레임 셋 · select 없음 · 받는 종류).
- **첫 화면 JS**: 549,227 → 549,724 B(+497 B, 여유 276 B — 단계별은 PERF §21). 계획 추정 +302 B 보다 컸다(대부분 한국어 화면 글과 Hook 코드).
  여유가 줄어 뒤의 작업(maplibre 6.12 — 개선 작업 Q2)은 더 빠듯하다.
- **연결 하나 더**: 지도를 띄우지 못한 탭도 WS 세션을 하나 쓴다(전에는 0) — 탭이 많은 사용자는 IP 당 5 상한(1013)에 조금 더 일찍 닿는다.
- **R9 'off' 의 뜻이 좁아졌다**: (b2) 에만 남는다(ADR-029 §3 개정).
- 남은 것: (b2) 에서 다시 시도로 지도 조각은 받았는데 MapLibre 가 또 실패하면 지도 없는 피드는 열리지 않고 'off' 로 남는다. 상세 표의 연결 행은 탭이 숨겨진 동안 '지도 없음'을 적지 않는다.
  지도 Hook 안의 다른 결합(선택 항적 REST · KMA 레이더 조회 · 교통량 조회)과 지도 없을 때 쓸모없는 조작(레이어 단추 · 레이더 재생 · 선박 카드의 항적 기간 단추)은 이번 범위 밖이다.
- 되돌리기: 프로토콜 · api · collector · schemas 는 바꾸지 않았다(기존 `layers` · `subscribe` 메시지만 — 계약 §G 없음). 웹만 되돌리면 된다.
