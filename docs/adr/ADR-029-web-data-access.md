# ADR-029 웹 데이터 접근: 전송은 lib/api 하나, 엔드포인트는 lib/endpoints, 화면 효과는 작은 Hook — 늦은 답은 열쇠로 버리고 끊는다

**상태** 채택 · 2026-10-01 · CTO 리뷰 2026-10 [PLAN](../review/cto-2026-10/PLAN.md) Phase 3C · 4 · 5(승인된 계획 — 사용자 결정 §5-2 '숨은 탭은 멈춤') ·
근거 [web-review](../review/cto-2026-10/web-review.md) §1 · §3 · §4 · 측정 [PERF §11](../PERF.md)

## 맥락
- 리뷰 기준(`e0e1eba`)에서 컴포넌트 · 페이지 20여 곳이 `useEffect` 안에서 엔드포인트 경로를 직접 만들어 `apiGet` · `apiSend` 를 불렀다. 서버가 준 값을 경로에 그대로
  넣었고(B11), REST 본문은 검증 없이 형 변환했다(B10 — 레이더 본문 하나가 상황판 전체를 오류 화면으로 바꿨다).
- 늦게 온 답을 버리는 방식이 세 가지(`live` 플래그 · `seq` · 열쇠 결과)로 갈렸고, 요청을 끊는(AbortController) 곳은 검색 · 재생 두 곳뿐이었다. 그 틈에서 버그가 났다:
  앞 공항의 오류가 다음 공항 아래에 남음(B5 · B17), 앞 검색 선택이 지도를 옮김(B3), 같은 쪽이 두 번 붙음(B1), 응답이 멈추면 주기 요청이 쌓임(B9), 숨은 탭에서도 폴링(B12).
- `MapView` 는 728줄이었고 한 effect(지도 · 워커 · WS · 폴링 · 팝업)가 263줄이었다. '이미 그림' 기록이 지도보다 오래 살아 StrictMode 에서 SIGMET 이 그려지지 않았다(B8).
- 첫 화면 JS 는 예산 550,000 B 에 여유 약 6.5 KB(ADR-026) — 런타임 라이브러리를 더할 자리가 거의 없다.

## 결정
1. **전송은 `lib/api.ts` 하나**(`apiGet` · `apiSend` · `ApiError` · CSRF 머리 · 요청 id). 엔드포인트 경로 · 파싱은 여기 두지 않는다. 시험의 `vi.mock("@/lib/api")` 가
   그대로 가로채도록 다른 모듈은 늘 `@/lib/api` 에서 가져온다(`lib/api/` 폴더로 나누지 않는다 — 모의가 빗나가고 읽는 사람에게 모호하다).
   전송을 따로 갖는 셋은 그대로 둔다: 조건부 GET(304)의 `lib/etag-poller`, keepalive 오류 보고 `lib/errorReport`, HEAD 조각 확인 `lib/chunk-probe`.
2. **엔드포인트는 영역마다 `lib/endpoints/*.ts`**(aircraft · tracks · ship-detail · weather · stats · replay · ops · logs, 검색 둘은 `lib/search`). 함수마다
   - **타입**이 있고, **`{ signal?: AbortSignal }`** 를 받아 그대로 넘긴다.
   - **서버가 준 값은 `lib/endpoints/path.ts pathSegment` 로만 경로 조각이 된다**: 인코딩하고, 쓸 수 없는 값(빈 값 · "." · "..")은 던진다 — 함수가 `async` 라 요청을
     보내지 않고 거절된 약속이 되어 부른 쪽이 오류로 보인다(`tests/path-params.test.ts`). 링크도 같은 규칙(`isRefusedSegment` — 공항 카드의 '이력').
   - **파서가 있으면 파싱한 값을 돌려준다**(예: `parseKrRadar` · `parseShipDetail` · `parseLogPage`) — 모양이 틀리면 null 이나 거절, 모르는 값을 지어내지 않는다.
   - 캐시 · 클래스 · 재시도 정책을 두지 않는다(그것은 부르는 쪽 Hook 의 일).
3. **화면의 효과는 작은 Hook 으로** — 일반 둘과 화면 셋:
   - `lib/use-api-resource.ts useApiResource(key, load, { refreshMs })`: REST 자원 하나. 결과를 그 요청의 **열쇠와 함께** 두고 지금 열쇠의 것만 돌려준다
     (열쇠가 바뀌면 그 즉시 loading — 앞 열쇠의 값 · 오류 · 요청 id 를 보이지 않는다), 열쇠가 바뀌거나 떠나면 **끊는다**, `refreshMs` 주기는 **요청이 떠 있으면 건너뛰고**
     (겹쳐 보내지 않는다 — 주기보다 느린 답도 반영) **숨은 탭에서는 보내지 않는다**. 쓰는 곳: 통계 패널 넷 · 항공기 카드(30 s) · 공항 카드 · 공항 이력 · 공항 목록 ·
     SIGMET 카드 · AIS 수신 공백 · 로그 상세 둘.
   - `lib/use-visible-interval.ts useVisibleInterval(fn, ms)`: 숨은 탭에서는 부르지 않고, 숨긴 동안 한 번이라도 걸렀으면 다시 보이는 순간 곧바로 부른다. `fn` 은 React 19.3
     `useEffectEvent` 라 바뀌어도 주기를 다시 걸지 않는다(B13).
   - `components/ops/useOpsSession` (/ops · /logs 의 세션 확인 — 401 · 404 만 로그인, 그 밖은 오류와 다시 시도), `components/ops/useOpsTabs` (운영 탭 일곱의 값 ·
     `RequestOrder` · 15 s 주기 · 탭마다의 실패), `components/logs/useLogFeed` (로그 목록 · 묶음 · 새 항목 대기열 · 더 보기 · 15 s 자동 확인). 페이지는 그리기만 한다.
   - 상황판 지도는 `components/map/` 의 Hook 여섯(지도 수명 · 실시간 피드 · 포인터 · 기상 레이어 · 선박 레이어 · 선택 항적)이고 `MapView` 는 그것을 잇기만 한다.
     지도는 상황판 지도 손잡이(`lib/map-ready useDashboardMap`)로 받고, **'이 지도에 그린 것'의 기록은 그리는 Hook 이 그 지도와 함께 둔다**(다른 지도면 빈 기록 —
     StrictMode · Activity 의 두 번째 마운트에도 그린다). 실시간 피드(WS 클라이언트 · 워커)는 지도와 함께 만들고 지운다.
4. **늦은 답의 규칙 — 화면에 있는 조건의 답만 쓴다. 열쇠 결과는 대체된 요청을 끊고, 순번 흐름은 늦은 답을 버린다(끊지 않는다 — 운영 탭 · 로그).** 새 코드는 둘 중 하나로 쓴다:
   - **열쇠 결과**(조건이 열쇠로 표현되는 읽기 — `useApiResource`): 결과에 열쇠를 붙이고 지금 열쇠와 같을 때만 보인다 + 열쇠가 바뀌면 `AbortSignal` 로 끊는다.
   - **순번**(같은 열쇠에서 요청이 겹치는 흐름): 운영 탭은 `RequestOrder`(기준 요청 — 쓰기 뒤 · 토글 · 새로고침 단추 — 전에 떠난 답은 버리고, 주기 요청보다 느린 답은
     더 새 답이 없으면 쓴다), 로그는 불러오기 번호(`useLogFeed`) · 상세 열기 번호 · 다시 읽기 번호, 검색 선택은 선택 번호. 쓰기 단추는 진행 중이면 다시 보내지 않고
     `disabled` · `aria-busy` 를 보인다(B1 · B2).
   - 효과의 정리는 늘 요청을 끊는다(항적 둘 · 선박 카드 상세 · 세션 확인 · 재생 · 검색). `live` 플래그만으로 버리는 새 코드는 쓰지 않는다.
5. **주기 요청의 규칙**: 숨은 탭에서는 보내지 않고 다시 보이면 곧바로(사용자 결정 §5-2 — WS · 워커 · 조회기와 같다), 요청이 떠 있으면 그 주기는 건너뛴다(쌓지 않는다),
   실패하면 마지막 값을 두고 실패를 따로 보인다(지우지 않는다). 조건부 GET 은 `EtagPoller`(세대 번호 + 멈추면 끊음 — B6), 그 밖은 `useVisibleInterval` · `useApiResource`.
6. **React 없는 모듈은 `lib/*`**: 규칙 · 변환 · 파서 · 경로(엔드포인트 포함) · 전송 · 조회기 · WS 클라이언트는 React 를 import 하지 않는다 — 단위 시험이 DOM 없이 본다.
   `lib` 의 Hook 은 화면과 상관없는 일반 Hook(`use-api-resource` · `use-visible-interval` · `clock` · `store` 의 구독 · `map-ready` · 포커스를 잃지 않게 하는 `use-focus-rescue` · 넘칠 때만 키보드로 닿는 스크롤 영역 `use-scroll-focusable` — QA 2026-10 QA-304 · QA-305)뿐이고, 한 화면의 Hook 은 그 화면 곁
   (`components/ops` · `components/logs` · `components/map`)에 둔다. 컴포넌트 안의 순수 규칙은 `lib` 로 옮겨 시험한다(지도 포인터 규칙 `lib/map-pointer` 등).
7. **첫 화면 규칙(ADR-026 과 함께)**: 나중에 받는 조각(카드 · 목록)에서만 쓰는 함수 · 엔드포인트는 **조각 전용 모듈**(`lib/ship-card` · `lib/aircraft-card` ·
   `lib/airport-list` · `lib/airport-wx` · `lib/endpoints/ship-detail` · `lib/endpoints/weather`)에 두고 `tests/first-screen-lazy.test.ts` 의 `CARRIED_BY_PARTS` 에
   까닭과 함께 적는다 — 첫 화면에서 정적으로 닿으면 그 시험이 실패한다. 첫 화면이 쓰는 엔드포인트(검색 · 지도의 항적)는 작게 따로 둔다(`lib/search` · `lib/endpoints/tracks`).
   모듈을 나누는 값은 거의 없다(지도 포인터 Hook 을 `MapView.tsx` 안에 둔 판 24,542 B · 따로 둔 판 24,543 B — 커밋 `760010e`) — 크기는 옮긴 코드가 정한다.
8. **성능은 잰 것만 바꾼다**(PERF §11): 횟수(Profiler 커밋 · 다시 계산)를 CI 가 보는 결정적 시험으로, 시간은 `WAKELINE_PERF=1` 일 때만 재는 같은 파일의 측정이나
   `vitest bench`(`tests/perf/*.bench.ts` — `vitest run` 이 집지 않는다)로 적는다. 이득이 재어지지 않으면 바꾸지 않고 그 수를 적는다(범례 선택자 — P6).

## 대안
- **react-query · SWR 같은 라이브러리**: 호출 자리 약 20곳에 WS 스토어가 실시간 값을 이미 갖고 있고, 첫 화면 여유가 6.5 KB 였다. 질의 캐시는 `lib/store` 와 겹치고
  검색 · 지도가 첫 화면이라 그 몇 KB 가 첫 화면에 실린다. 필요한 것(열쇠 결과 · 끊기 · 주기 · 숨은 탭)은 저장소의 작은 부품(`useApiResource` 70줄 남짓 · `RequestOrder` ·
  `EtagPoller` · `ReplayLoader`)으로 된다 — 쓰지 않았다(사용자 원칙: 필요가 입증되지 않은 런타임 라이브러리를 들이지 않는다).
- **`lib/api/` 폴더로 전송과 엔드포인트를 한 곳에**: `vi.mock("@/lib/api")` 를 쓰는 시험(리뷰 때 7개 · 지금 12개)이 엔드포인트가 부르는 전송을 가로채지 못하게 된다 — 버렸다.
- **스토어 선택자마다 이름 붙은 Hook**(`useAlerts()` · `useShips()` …): 동작 없이 간접만 늘린다 — 하지 않았다. 같은 이유로 이미 순수한 것을 감싸는 Hook,
  잘 나뉜 곳(선박 카드의 다시 읽기 규칙 · 상태 바 · 재생 · 해결 확인 · 지연 조각 · 설명서 목차)은 그대로 두었다.
- **`live` 플래그를 그대로**: 화면을 떠나는 경우는 맞지만 끊지 않고, 주기 요청의 진행 중 막기가 없으며, 같은 일을 세 방식으로 했다 — 위 4 로 모았다.
- **지도 effect 하나에 정리 순서를 맞춰 두기**(B8 을 정리 때 기록을 비워 고침): 고쳐지지만 기록이 그 기록을 쓰는 코드와 떨어져 있다 — 기록을 그리는 Hook 으로 옮기고
  지도로 열쇠를 삼았다.

## 결과
- 화면의 REST 읽기는 모두 `lib/endpoints` · `lib/search` 를 거친다. 서버 값이 든 경로는 `pathSegment` 하나로만 만든다 — 새 엔드포인트도 그것을 쓴다(시험이 본다).
- 앞 조건의 답 · 오류가 다음 조건 아래 보이지 않고(B5 · B17), 대체된 요청은 끊기며, 주기 요청은 쌓이지 않고 숨은 탭에서 쉰다(B9 · B12). 이것은 위 Hook 과 각 시험이 지킨다.
- `MapView.tsx` 728(리뷰 기준) → 28줄, `components/map/` Hook 여섯 779줄. StrictMode 에서 살아남은 지도 하나에만 그리고 피드 · 조회기도 하나씩임을 `tests/mapview-strict.test.ts` 가 본다.
  운영 페이지 498 → 414줄, `LogsDashboard` 516 → 413줄(이 작업 직전 기준 — 옮긴 것은 각 Hook).
- 첫 화면 JS: 이 구조 작업(엔드포인트 · Hook · 지도 분할 · 성능) 뒤 545,180 B(여유 4,820 B — PLAN 기준 543,507 B 에서 버그 수정 · 검증 · 분할 포함 +1,673 B).
- 새 화면 코드의 규칙: 경로는 엔드포인트 함수로, 읽기는 `useApiResource`(열쇠 결과) 또는 순번으로, 주기는 `useVisibleInterval`, 효과의 정리는 끊기, React 없는 것은 `lib`,
  조각 전용은 조각 전용 모듈 + `CARRIED_BY_PARTS`, 성능 변경은 전후 수와 함께.
- 되돌리기: 이 ADR 은 코드 구조의 규칙이다 — 데이터 · 계약 · URL 을 바꾸지 않았다(공개 API · 화면 주소 그대로).
